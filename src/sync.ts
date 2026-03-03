/**
 * Sync engine — handles push/pull logic, debouncing, and ignore patterns.
 */
import { App, TFile, TAbstractFile, Notice, normalizePath } from "obsidian";
import { EngramApi, arrayBufferToBase64, base64ToArrayBuffer } from "./api";
import { AttachmentChange, EngramSyncSettings, ConflictChoice, ConflictInfo, NoteChange, NoteStreamEvent, QueueEntry, SyncStatus } from "./types";
import { OfflineQueue } from "./offline-queue";

/** How long (ms) after a push completes to suppress SSE echoes for that path. */
const ECHO_COOLDOWN_MS = 5000;

/** How often (ms) to check connectivity when offline. */
const HEALTH_CHECK_INTERVAL_MS = 30_000;

/** Paths that are always ignored regardless of user settings. */
const ALWAYS_IGNORED = [".obsidian/", ".trash/", ".git/"];

/** Binary file extensions that sync as attachments. */
const BINARY_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "bmp", "svg", "webp",
	"pdf",
	"mp3", "wav", "ogg", "m4a", "webm", "flac",
	"mp4", "mov",
	"zip",
]);

/** All syncable extensions (text + binary). Canvas files are text (JSON). */
const TEXT_EXTENSIONS = new Set(["md", "canvas"]);

/** MIME types by extension. */
const MIME_TYPES: Record<string, string> = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
	gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml", webp: "image/webp",
	pdf: "application/pdf",
	mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
	m4a: "audio/mp4", flac: "audio/flac",
	mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
	zip: "application/zip",
	canvas: "application/json",
};

export class SyncEngine {
	private debounceTimers: Map<string, ReturnType<typeof setTimeout>> =
		new Map();
	private ignorePatterns: string[] = [];
	private pushing: Set<string> = new Set();
	private recentlyPushed: Map<string, ReturnType<typeof setTimeout>> =
		new Map();
	private pulling: boolean = false;
	private lastSync: string = "";
	private lastError: string = "";
	private offline: boolean = false;
	private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
	readonly queue: OfflineQueue = new OfflineQueue();

	/** Called whenever sync status changes (for status bar updates). */
	onStatusChange: ((status: SyncStatus) => void) | null = null;

	/** Called when a conflict is detected. Return the user's resolution choice.
	 *  If null, conflicts are auto-resolved as keep-remote (legacy behavior). */
	onConflict: ((info: ConflictInfo) => Promise<ConflictChoice>) | null = null;

	constructor(
		private app: App,
		private api: EngramApi,
		private settings: EngramSyncSettings,
		private saveData: (data: { lastSync: string }) => Promise<void>,
	) {
		this.parseIgnorePatterns();
	}

	updateSettings(settings: EngramSyncSettings): void {
		this.settings = settings;
		this.parseIgnorePatterns();
	}

	setLastSync(timestamp: string): void {
		this.lastSync = timestamp;
	}

	getLastSync(): string {
		return this.lastSync;
	}

	/** Get current sync status snapshot. */
	getStatus(): SyncStatus {
		const isSyncing = this.pulling || this.pushing.size > 0;
		let state: SyncStatus["state"];
		if (this.offline) {
			state = "offline";
		} else if (this.lastError) {
			state = "error";
		} else if (isSyncing) {
			state = "syncing";
		} else {
			state = "idle";
		}
		return {
			state,
			pending: this.debounceTimers.size,
			queued: this.queue.size,
			lastSync: this.lastSync,
			error: this.lastError || undefined,
		};
	}

	/** Whether the engine is currently offline. */
	isOffline(): boolean {
		return this.offline;
	}

	/** Emit current status to listener. */
	private emitStatus(): void {
		this.onStatusChange?.(this.getStatus());
	}

	// --- Ignore pattern matching ---

	private parseIgnorePatterns(): void {
		this.ignorePatterns = this.settings.ignorePatterns
			.split("\n")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
	}

	shouldIgnore(path: string): boolean {
		// Hardcoded ignores — always enforced, cannot be overridden
		for (const pattern of ALWAYS_IGNORED) {
			if (path.startsWith(pattern) || path.includes("/" + pattern)) {
				return true;
			}
		}
		return this.ignorePatterns.some((pattern) => {
			if (pattern.endsWith("/")) {
				return path.startsWith(pattern) || path.includes("/" + pattern);
			}
			return path === pattern || path.endsWith("/" + pattern);
		});
	}

	isMarkdown(file: TAbstractFile): boolean {
		return file instanceof TFile && file.extension === "md";
	}

	/** Check if a file should be synced (markdown, canvas, or binary attachment). */
	isSyncable(file: TAbstractFile): boolean {
		if (!(file instanceof TFile)) return false;
		return TEXT_EXTENSIONS.has(file.extension) || BINARY_EXTENSIONS.has(file.extension);
	}

	/** Check if a file is a binary attachment (not text). */
	isBinaryFile(file: TAbstractFile): boolean {
		if (!(file instanceof TFile)) return false;
		return BINARY_EXTENSIONS.has(file.extension);
	}

	/** Get MIME type for a file. */
	getMimeType(file: TFile): string {
		return MIME_TYPES[file.extension] || "application/octet-stream";
	}

	// --- Push: local → Engram ---

	/** Handle a vault modify/create event with debounce. */
	handleModify(file: TAbstractFile): void {
		if (!this.isSyncable(file)) return;
		if (this.shouldIgnore(file.path)) return;

		// Clear existing debounce timer for this file
		const existing = this.debounceTimers.get(file.path);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(async () => {
			this.debounceTimers.delete(file.path);
			await this.pushFile(file as TFile);
		}, this.settings.debounceMs);

		this.debounceTimers.set(file.path, timer);
		this.emitStatus();
	}

	/** Handle a vault delete event. */
	async handleDelete(file: TAbstractFile): Promise<void> {
		if (!this.isSyncable(file)) return;
		if (this.shouldIgnore(file.path)) return;

		const isBinary = this.isBinaryFile(file);

		// Cancel any pending push for this file
		const existing = this.debounceTimers.get(file.path);
		if (existing) {
			clearTimeout(existing);
			this.debounceTimers.delete(file.path);
		}

		try {
			if (isBinary) {
				await this.api.deleteAttachment(file.path);
			} else {
				await this.api.deleteNote(file.path);
			}
			this.goOnline();
		} catch (e) {
			console.error(`Engram Sync: failed to delete ${file.path}`, e);
			await this.enqueueChange({
				path: file.path,
				action: "delete",
				kind: isBinary ? "attachment" : "note",
				timestamp: Date.now(),
			});
		}
	}

	/** Handle a vault rename event. */
	async handleRename(
		file: TAbstractFile,
		oldPath: string,
	): Promise<void> {
		if (!this.isSyncable(file)) return;

		const isBinary = this.isBinaryFile(file);

		// Delete old path if it wasn't ignored
		if (!this.shouldIgnore(oldPath)) {
			try {
				if (isBinary) {
					await this.api.deleteAttachment(oldPath);
				} else {
					await this.api.deleteNote(oldPath);
				}
				this.goOnline();
			} catch (e) {
				console.error(
					`Engram Sync: failed to delete old path ${oldPath}`,
					e,
				);
				await this.enqueueChange({
					path: oldPath,
					action: "delete",
					kind: isBinary ? "attachment" : "note",
					timestamp: Date.now(),
				});
			}
		}

		// Push new path if it isn't ignored
		if (!this.shouldIgnore(file.path)) {
			await this.pushFile(file as TFile);
		}
	}

	/** Push a single file to Engram. */
	private async pushFile(file: TFile): Promise<void> {
		if (this.pushing.has(file.path)) return;
		this.pushing.add(file.path);
		this.lastError = "";
		this.emitStatus();

		const isBinary = this.isBinaryFile(file);

		try {
			const mtime = file.stat.mtime / 1000; // Obsidian uses ms, Engram uses seconds
			if (isBinary) {
				const buffer = await this.app.vault.readBinary(file);
				// Size check
				const maxBytes = this.settings.maxFileSizeMB * 1024 * 1024;
				if (buffer.byteLength > maxBytes) {
					this.lastError = `File too large: ${file.path} (${Math.round(buffer.byteLength / 1024 / 1024)}MB > ${this.settings.maxFileSizeMB}MB)`;
					this.emitStatus();
					return;
				}
				const base64 = arrayBufferToBase64(buffer);
				const mimeType = this.getMimeType(file);
				await this.api.pushAttachment(file.path, base64, mimeType, mtime);
			} else {
				const content = await this.app.vault.read(file);
				await this.api.pushNote(file.path, content, mtime);
			}
			this.goOnline();
		} catch (e) {
			console.error(`Engram Sync: failed to push ${file.path}`, e);
			// Queue for retry instead of showing per-file errors
			try {
				if (isBinary) {
					const buffer = await this.app.vault.readBinary(file);
					const base64 = arrayBufferToBase64(buffer);
					const mtime = file.stat.mtime / 1000;
					await this.enqueueChange({
						path: file.path,
						action: "upsert",
						contentBase64: base64,
						mimeType: this.getMimeType(file),
						mtime,
						kind: "attachment",
						timestamp: Date.now(),
					});
				} else {
					const content = await this.app.vault.read(file);
					const mtime = file.stat.mtime / 1000;
					await this.enqueueChange({
						path: file.path,
						action: "upsert",
						content,
						mtime,
						timestamp: Date.now(),
					});
				}
			} catch {
				// If we can't even read the file, just log
				this.lastError = `Push failed: ${file.path}`;
			}
		} finally {
			this.pushing.delete(file.path);
			// Keep path suppressed for a cooldown period after push completes.
			// SSE events often arrive after the push finishes, and without this
			// the echo suppression in handleStreamEvent would miss them.
			this.markRecentlyPushed(file.path);
			this.emitStatus();
		}
	}

	/** Suppress SSE echoes for a path for ECHO_COOLDOWN_MS after push. */
	private markRecentlyPushed(path: string): void {
		const existing = this.recentlyPushed.get(path);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.recentlyPushed.delete(path);
		}, ECHO_COOLDOWN_MS);
		this.recentlyPushed.set(path, timer);
	}

	/** Check if a path was recently pushed (for echo suppression). */
	isRecentlyPushed(path: string): boolean {
		return this.recentlyPushed.has(path);
	}

	// --- Pull: Engram → local vault ---

	/** Pull remote changes and apply to vault. */
	async pull(): Promise<number> {
		if (this.pulling) return 0;
		if (!this.lastSync) {
			// First sync — use epoch
			this.lastSync = "1970-01-01T00:00:00Z";
		}

		this.pulling = true;
		this.lastError = "";
		this.emitStatus();
		try {
			// Fetch note and attachment changes in parallel
			const [noteResp, attachResp] = await Promise.all([
				this.api.getChanges(this.lastSync),
				this.api.getAttachmentChanges(this.lastSync),
			]);
			let applied = 0;

			for (const change of noteResp.changes) {
				await this.applyChange(change);
				applied++;
			}

			for (const change of attachResp.changes) {
				await this.applyAttachmentChange(change);
				applied++;
			}

			// Use the later server_time
			const serverTime = noteResp.server_time > attachResp.server_time
				? noteResp.server_time : attachResp.server_time;
			this.lastSync = serverTime;
			await this.saveData({ lastSync: this.lastSync });

			return applied;
		} catch (e) {
			console.error("Engram Sync: pull failed", e);
			this.lastError = "Pull failed";
			return 0;
		} finally {
			this.pulling = false;
			this.emitStatus();
		}
	}

	/** Handle an SSE stream event (upsert or delete). */
	async handleStreamEvent(event: NoteStreamEvent): Promise<void> {
		if (this.shouldIgnore(event.path)) return;

		// Echo suppression — skip events for notes we're currently pushing
		// or have recently finished pushing (SSE events arrive after push completes)
		if (this.pushing.has(event.path)) return;
		if (this.recentlyPushed.has(event.path)) return;

		const isAttachment = event.kind === "attachment";

		if (event.event_type === "delete") {
			const normalized = normalizePath(event.path);
			const existing = this.app.vault.getAbstractFileByPath(normalized);
			if (existing && existing instanceof TFile) {
				await this.app.vault.trash(existing, true);
			}
			return;
		}

		if (event.event_type === "upsert") {
			try {
				if (isAttachment) {
					const attachment = await this.api.getAttachment(event.path);
					await this.applyAttachmentChange({
						path: attachment.path,
						mime_type: attachment.mime_type,
						size_bytes: attachment.size_bytes,
						mtime: attachment.mtime,
						updated_at: attachment.updated_at,
						deleted: false,
					}, attachment.content_base64);
				} else {
					const note = await this.api.getNote(event.path);
					await this.applyChange({
						path: note.path,
						title: note.title,
						content: note.content,
						folder: note.folder,
						tags: note.tags,
						mtime: note.mtime,
						updated_at: note.updated_at,
						deleted: false,
					});
				}
			} catch (e) {
				console.error(`Engram Sync: failed to fetch content for SSE event ${event.path}`, e);
			}
		}
	}

	/** Apply a single remote change to the vault, with conflict detection. */
	async applyChange(change: NoteChange): Promise<void> {
		if (this.shouldIgnore(change.path)) return;

		const normalized = normalizePath(change.path);

		if (change.deleted) {
			// Delete local file if it exists
			const existing = this.app.vault.getAbstractFileByPath(normalized);
			if (existing && existing instanceof TFile) {
				await this.app.vault.trash(existing, true);
			}
			return;
		}

		// Create or update the file
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing && existing instanceof TFile) {
			const localMtime = existing.stat.mtime / 1000;

			// Conflict detection: both local and remote changed since last sync
			const lastSyncSec = this.lastSync
				? new Date(this.lastSync).getTime() / 1000
				: 0;

			if (localMtime > lastSyncSec && change.mtime > lastSyncSec && localMtime !== change.mtime) {
				// Both sides modified — resolve conflict
				const localContent = await this.app.vault.read(existing);

				// If content is identical, no real conflict
				if (localContent === change.content) {
					return;
				}

				const choice = await this.resolveConflict({
					path: change.path,
					localContent,
					localMtime,
					remoteContent: change.content,
					remoteMtime: change.mtime,
				});

				if (choice === "skip") {
					return;
				} else if (choice === "keep-local") {
					// Push local version to server
					await this.pushFile(existing);
					return;
				} else if (choice === "keep-both") {
					// Save remote as a conflict copy, keep local as-is
					const date = new Date().toISOString().slice(0, 10);
					const baseName = normalized.replace(/\.md$/, "");
					const conflictPath = `${baseName} (conflict ${date}).md`;
					await this.createFileWithFolders(conflictPath, change.content);
					return;
				}
				// "keep-remote" falls through to overwrite below
			}

			// Overwrite local with remote (last-write-wins or explicit keep-remote)
			if (change.mtime > localMtime || change.mtime === 0) {
				await this.app.vault.modify(existing, change.content);
			}
		} else {
			// New file — create it
			await this.createFileWithFolders(normalized, change.content);
		}
	}

	/** Apply a remote attachment change to the vault.
	 *  If contentBase64 is provided (from SSE), use it directly. Otherwise fetch it. */
	async applyAttachmentChange(change: AttachmentChange, contentBase64?: string): Promise<void> {
		if (this.shouldIgnore(change.path)) return;

		const normalized = normalizePath(change.path);

		if (change.deleted) {
			const existing = this.app.vault.getAbstractFileByPath(normalized);
			if (existing && existing instanceof TFile) {
				await this.app.vault.trash(existing, true);
			}
			return;
		}

		// Fetch content if not provided
		if (!contentBase64) {
			const detail = await this.api.getAttachment(change.path);
			contentBase64 = detail.content_base64;
		}

		const buffer = base64ToArrayBuffer(contentBase64);
		const existing = this.app.vault.getAbstractFileByPath(normalized);

		if (existing && existing instanceof TFile) {
			const localMtime = existing.stat.mtime / 1000;
			// Binary conflicts: timestamp-based only (no content comparison)
			if (change.mtime > localMtime || change.mtime === 0) {
				await this.app.vault.modifyBinary(existing, buffer);
			}
		} else {
			await this.createBinaryFileWithFolders(normalized, buffer);
		}
	}

	/** Resolve a conflict via callback or auto-resolve as keep-remote. */
	private async resolveConflict(info: ConflictInfo): Promise<ConflictChoice> {
		if (this.onConflict) {
			return this.onConflict(info);
		}
		// No handler — default to keep-remote (legacy behavior)
		return "keep-remote";
	}

	/** Create a text file, ensuring parent folders exist. */
	private async createFileWithFolders(normalized: string, content: string): Promise<void> {
		const folder = normalized.includes("/")
			? normalized.substring(0, normalized.lastIndexOf("/"))
			: "";
		if (folder) {
			await this.ensureFolder(folder);
		}
		await this.app.vault.create(normalized, content);
	}

	/** Create a binary file, ensuring parent folders exist. */
	private async createBinaryFileWithFolders(normalized: string, data: ArrayBuffer): Promise<void> {
		const folder = normalized.includes("/")
			? normalized.substring(0, normalized.lastIndexOf("/"))
			: "";
		if (folder) {
			await this.ensureFolder(folder);
		}
		await this.app.vault.createBinary(normalized, data);
	}

	/** Recursively create folder if it doesn't exist. */
	private async ensureFolder(path: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing) return;

		// Ensure parent first
		if (path.includes("/")) {
			const parent = path.substring(0, path.lastIndexOf("/"));
			if (parent) await this.ensureFolder(parent);
		}

		await this.app.vault.createFolder(path);
	}

	// --- Full sync (startup) ---

	/** Full bidirectional sync: pull remote changes, then push local changes. */
	async fullSync(): Promise<{ pulled: number; pushed: number }> {
		// Pull first
		const pulled = await this.pull();

		// Then push any locally modified files
		const pushed = await this.pushModifiedFiles();

		return { pulled, pushed };
	}

	/** Push all files that have been modified since last sync. */
	private async pushModifiedFiles(): Promise<number> {
		if (!this.lastSync) return 0;

		const sinceMs = new Date(this.lastSync).getTime();
		const files = this.app.vault.getFiles();
		let pushed = 0;

		// Batch in groups of 10
		const toSync = files.filter(
			(f: TFile) => this.isSyncable(f) && !this.shouldIgnore(f.path) && f.stat.mtime > sinceMs,
		);

		for (let i = 0; i < toSync.length; i += 10) {
			const batch = toSync.slice(i, i + 10);
			await Promise.all(batch.map((f: TFile) => this.pushFile(f)));
			pushed += batch.length;
		}

		return pushed;
	}

	/** Count files that would be synced (not ignored). */
	countSyncableFiles(): number {
		const files = this.app.vault.getFiles();
		return files.filter((f: TFile) => this.isSyncable(f) && !this.shouldIgnore(f.path)).length;
	}

	/** Check if this is a first sync (no prior sync state). */
	isFirstSync(): boolean {
		return !this.lastSync;
	}

	/** Push ALL syncable files (initial import). */
	async pushAll(): Promise<number> {
		const files = this.app.vault.getFiles();
		const toSync = files.filter((f: TFile) => this.isSyncable(f) && !this.shouldIgnore(f.path));
		let pushed = 0;

		new Notice(`Engram Sync: pushing ${toSync.length} files...`);

		for (let i = 0; i < toSync.length; i += 10) {
			const batch = toSync.slice(i, i + 10);
			await Promise.all(batch.map((f: TFile) => this.pushFile(f)));
			pushed += batch.length;

			if (pushed % 100 === 0) {
				new Notice(
					`Engram Sync: pushed ${pushed}/${toSync.length} files...`,
				);
			}
		}

		new Notice(`Engram Sync: initial push complete (${pushed} files)`);
		return pushed;
	}

	// --- Offline queue ---

	/** Queue a change for retry and go offline. */
	private async enqueueChange(entry: QueueEntry): Promise<void> {
		await this.queue.enqueue(entry);
		this.goOffline();
	}

	/** Transition to offline mode and start health checking. */
	private goOffline(): void {
		if (this.offline) return;
		this.offline = true;
		this.lastError = "";
		this.emitStatus();
		this.startHealthCheck();
	}

	/** Transition back to online mode. */
	private goOnline(): void {
		if (!this.offline) return;
		this.offline = false;
		this.lastError = "";
		this.stopHealthCheck();
		this.emitStatus();
		// Flush the queue now that we're online
		this.flushQueue().catch((e) => {
			console.error("Engram Sync: queue flush failed", e);
		});
	}

	/** Start periodic health checks while offline. */
	private startHealthCheck(): void {
		if (this.healthCheckTimer) return;
		this.healthCheckTimer = setInterval(async () => {
			try {
				const ok = await this.api.health();
				if (ok) {
					this.goOnline();
				}
			} catch {
				// Still offline
			}
		}, HEALTH_CHECK_INTERVAL_MS);
	}

	/** Stop periodic health checks. */
	private stopHealthCheck(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = null;
		}
	}

	/** Flush queued changes oldest-first. Stops on first failure. */
	async flushQueue(): Promise<number> {
		const entries = this.queue.all();
		if (entries.length === 0) return 0;

		let flushed = 0;
		for (const entry of entries) {
			try {
				if (entry.action === "delete") {
					if (entry.kind === "attachment") {
						await this.api.deleteAttachment(entry.path);
					} else {
						await this.api.deleteNote(entry.path);
					}
				} else if (entry.kind === "attachment" && entry.contentBase64 && entry.mimeType && entry.mtime !== undefined) {
					await this.api.pushAttachment(entry.path, entry.contentBase64, entry.mimeType, entry.mtime);
				} else if (entry.content !== undefined && entry.mtime !== undefined) {
					await this.api.pushNote(entry.path, entry.content, entry.mtime);
				}
				await this.queue.dequeue(entry.path);
				flushed++;
			} catch {
				// Lost connectivity again — stop flushing
				this.goOffline();
				break;
			}
		}

		this.emitStatus();
		return flushed;
	}

	/** Cancel all pending debounce, cooldown, and health check timers. */
	destroy(): void {
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		for (const timer of this.recentlyPushed.values()) {
			clearTimeout(timer);
		}
		this.recentlyPushed.clear();
		this.stopHealthCheck();
	}
}
