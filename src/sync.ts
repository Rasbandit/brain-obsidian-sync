/**
 * Sync engine — handles push/pull logic, debouncing, and ignore patterns.
 */
import { App, TFile, TFolder, TAbstractFile, Notice, normalizePath } from "obsidian";
import { EngramApi, arrayBufferToBase64, base64ToArrayBuffer } from "./api";
import { AttachmentChange, EngramSyncSettings, ConflictInfo, ConflictResolution, NoteChange, NoteStreamEvent, QueueEntry, SyncStatus } from "./types";
import { OfflineQueue } from "./offline-queue";
import { devLog } from "./dev-log";

/** Check if an error is an HTTP response with the given status code.
 *  Obsidian's requestUrl() throws objects with a `status` property on non-2xx. */
function isHttpStatus(e: unknown, status: number): boolean {
	return typeof e === "object" && e !== null && (e as { status?: number }).status === status;
}

/** How long (ms) after a push completes to suppress SSE echoes for that path. */
const ECHO_COOLDOWN_MS = 5000;

/** How often (ms) to check connectivity when offline. */
const HEALTH_CHECK_INTERVAL_MS = 30_000;

/** Paths that are always ignored regardless of user settings. */
const ALWAYS_IGNORED = [".obsidian/", ".trash/", ".git/"];

/** Fast string hash (FNV-1a 32-bit). Not cryptographic — just for content change detection. */
function fnv1a(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

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
	private ready: boolean = false;
	private activePushCount: number = 0;
	private maxConcurrentPushes: number = 5;
	private pushWaiters: (() => void)[] = [];
	private rateLimitRPM: number = 0; // 0 = unlimited
	private requestTimestamps: number[] = [];
	readonly queue: OfflineQueue = new OfflineQueue();

	/** Content hashes of files last written by the sync engine.
	 *  Used to detect whether the user actually modified a file since
	 *  the last sync (Obsidian sets mtime to "now" on vault.modify(),
	 *  making mtime-based detection unreliable). */
	private syncedHashes: Map<string, number> = new Map();

	/** Called whenever sync status changes (for status bar updates). */
	onStatusChange: ((status: SyncStatus) => void) | null = null;

	/** Called when a conflict is detected. Return the user's resolution.
	 *  If null, conflicts are auto-resolved as keep-remote (legacy behavior). */
	onConflict: ((info: ConflictInfo) => Promise<ConflictResolution>) | null = null;

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

	/** Mark the engine as ready to handle vault events.
	 *  Called after layout is ready and initial sync completes. */
	setReady(): void {
		this.ready = true;
		devLog().log("lifecycle", "setReady — event handlers enabled");
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
		if (!this.ready) return;
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
		if (!this.ready) return;
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
			// 404 means already deleted — treat as success
			if (isHttpStatus(e, 404)) {
				this.goOnline();
				return;
			}
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
		if (!this.ready) return;
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
				// 404 means already deleted — treat as success
				if (isHttpStatus(e, 404)) {
					this.goOnline();
				} else {
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
		}

		// Push new path if it isn't ignored
		if (!this.shouldIgnore(file.path)) {
			await this.pushFile(file as TFile);
		}
	}

	/** Acquire a push slot, blocking if at max concurrency. */
	private async acquirePushSlot(): Promise<void> {
		if (this.activePushCount < this.maxConcurrentPushes) {
			this.activePushCount++;
			return;
		}
		await new Promise<void>((resolve) => {
			this.pushWaiters.push(resolve);
		});
		this.activePushCount++;
	}

	/** Release a push slot and wake the next waiter if any. */
	private releasePushSlot(): void {
		this.activePushCount--;
		const next = this.pushWaiters.shift();
		if (next) next();
	}

	/** Query the server's rate limit and configure the pacer.
	 *  Applies a 10% safety margin (e.g. 100 RPM → 90 effective). */
	async configureRateLimit(): Promise<void> {
		try {
			const serverRPM = await this.api.getRateLimit();
			if (serverRPM > 0) {
				this.rateLimitRPM = Math.floor(serverRPM * 0.9);
				devLog().log("pacer", `server limit=${serverRPM} RPM, effective=${this.rateLimitRPM} RPM`);
			} else {
				this.rateLimitRPM = 0;
				devLog().log("pacer", "server reports unlimited — pacer disabled");
			}
		} catch {
			this.rateLimitRPM = 0;
			devLog().log("pacer", "failed to query rate limit — assuming unlimited");
		}
	}

	/** Wait if needed to stay within the server's rate limit. */
	private async paceRequest(): Promise<void> {
		if (this.rateLimitRPM <= 0) return;

		const now = Date.now();
		const windowMs = 60_000;
		const cutoff = now - windowMs;

		// Prune timestamps outside the window
		this.requestTimestamps = this.requestTimestamps.filter((t) => t > cutoff);

		if (this.requestTimestamps.length < this.rateLimitRPM) {
			this.requestTimestamps.push(now);
			return;
		}

		// At capacity — wait until the oldest request exits the window
		const oldest = this.requestTimestamps[0];
		const waitMs = oldest + windowMs - now + 50; // +50ms buffer
		devLog().log("pacer", `at capacity (${this.requestTimestamps.length}/${this.rateLimitRPM}), waiting ${waitMs}ms`);
		await new Promise<void>((resolve) => setTimeout(resolve, waitMs));

		// Prune again and record
		this.requestTimestamps = this.requestTimestamps.filter((t) => t > Date.now() - windowMs);
		this.requestTimestamps.push(Date.now());
	}

	/** Push a single file to Engram. Returns true on success. */
	private async pushFile(file: TFile): Promise<boolean> {
		if (this.pushing.has(file.path)) return false;
		await this.acquirePushSlot();
		this.pushing.add(file.path);
		this.lastError = "";
		this.emitStatus();

		const isBinary = this.isBinaryFile(file);
		let success = false;
		devLog().log("push", `start ${isBinary ? "attachment" : "note"}: ${file.path} (active=${this.activePushCount})`);

		try {
			await this.paceRequest();
			const mtime = file.stat.mtime / 1000; // Obsidian uses ms, Engram uses seconds
			if (isBinary) {
				const buffer = await this.app.vault.readBinary(file);
				// Size check
				const maxBytes = this.settings.maxFileSizeMB * 1024 * 1024;
				if (buffer.byteLength > maxBytes) {
					this.lastError = `File too large: ${file.path} (${Math.round(buffer.byteLength / 1024 / 1024)}MB > ${this.settings.maxFileSizeMB}MB)`;
					this.emitStatus();
					return false;
				}
				const base64 = arrayBufferToBase64(buffer);
				const mimeType = this.getMimeType(file);
				await this.api.pushAttachment(file.path, base64, mimeType, mtime);
			} else {
				const content = await this.app.vault.read(file);
				await this.api.pushNote(file.path, content, mtime);
				this.syncedHashes.set(normalizePath(file.path), fnv1a(content));
			}
			success = true;
			devLog().log("push", `ok: ${file.path}`);
			this.goOnline();
		} catch (e) {
			console.error(`Engram Sync: failed to push ${file.path}`, e);
			devLog().log("error", `push failed: ${file.path} — ${e instanceof Error ? e.message : e}`);
			// Queue for retry — content-free to avoid O(n²) serialization.
			// Content will be re-read from vault when flushing.
			await this.enqueueChange({
				path: file.path,
				action: "upsert",
				kind: isBinary ? "attachment" : "note",
				mtime: file.stat.mtime / 1000,
				timestamp: Date.now(),
			});
		} finally {
			this.pushing.delete(file.path);
			this.releasePushSlot();
			// Keep path suppressed for a cooldown period after push completes.
			// SSE events often arrive after the push finishes, and without this
			// the echo suppression in handleStreamEvent would miss them.
			this.markRecentlyPushed(file.path);
			this.emitStatus();
		}
		return success;
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
		devLog().log("pull", `start since=${this.lastSync}`);
		try {
			// Fetch note and attachment changes in parallel
			const [noteResp, attachResp] = await Promise.all([
				this.api.getChanges(this.lastSync),
				this.api.getAttachmentChanges(this.lastSync),
			]);
			devLog().log("pull", `fetched ${noteResp.changes.length} notes, ${attachResp.changes.length} attachments`);
			let applied = 0;

			for (const change of noteResp.changes) {
				if (await this.applyChange(change)) applied++;
			}

			for (const change of attachResp.changes) {
				if (await this.applyAttachmentChange(change)) applied++;
			}

			// Use the later server_time
			const serverTime = noteResp.server_time > attachResp.server_time
				? noteResp.server_time : attachResp.server_time;
			this.lastSync = serverTime;
			await this.saveData({ lastSync: this.lastSync });

			devLog().log("pull", `done — applied ${applied}, lastSync=${this.lastSync}`);
			return applied;
		} catch (e) {
			console.error("Engram Sync: pull failed", e);
			devLog().log("error", `pull failed: ${e instanceof Error ? e.message : e}`);
			this.lastError = e instanceof Error ? `Pull failed: ${e.message}` : "Pull failed";
			return 0;
		} finally {
			this.pulling = false;
			this.emitStatus();
		}
	}

	/** Handle an SSE stream event (upsert or delete). */
	async handleStreamEvent(event: NoteStreamEvent): Promise<void> {
		if (this.shouldIgnore(event.path)) return;
		devLog().log("sse", `${event.event_type} ${event.kind ?? "note"}: ${event.path}`);

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
				await this.removeEmptyFolders(normalized);
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

	/** Apply a single remote change to the vault, with conflict detection.
	 *  Returns true when a file was actually created, modified, or trashed. */
	async applyChange(change: NoteChange): Promise<boolean> {
		if (this.shouldIgnore(change.path)) return false;

		const normalized = normalizePath(change.path);

		if (change.deleted) {
			// Delete local file if it exists
			const existing = this.app.vault.getAbstractFileByPath(normalized);
			if (existing && existing instanceof TFile) {
				await this.app.vault.trash(existing, true);
				await this.removeEmptyFolders(normalized);
				this.syncedHashes.delete(normalized);
				return true;
			}
			return false;
		}

		// Create or update the file
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing && existing instanceof TFile) {
			// Conflict detection — content-hash based.
			// Mtime is unreliable because Obsidian sets it to "now" on every
			// vault.modify(), so we track hashes of content we last wrote.
			const localContent = await this.app.vault.read(existing);
			const localHash = fnv1a(localContent);
			const lastSyncedHash = this.syncedHashes.get(normalized);

			// Local was modified by the user if its content hash differs from
			// what we last wrote during sync (or if we never wrote it).
			const localModified = lastSyncedHash === undefined
				? localContent !== change.content  // first sync: compare directly
				: localHash !== lastSyncedHash;

			if (localModified && localContent !== change.content) {
				// Both sides differ — real conflict
				const localMtime = existing.stat.mtime / 1000;

				devLog().log("pull", `conflict: ${change.path} (localHash=${localHash} syncedHash=${lastSyncedHash})`);
				const resolution = await this.resolveConflict({
					path: change.path,
					localContent,
					localMtime,
					remoteContent: change.content,
					remoteMtime: change.mtime,
				});

				if (resolution.choice === "skip") {
					return false;
				} else if (resolution.choice === "keep-local") {
					// Push local version to server
					await this.pushFile(existing);
					this.syncedHashes.set(normalized, localHash);
					return false;
				} else if (resolution.choice === "keep-both") {
					// Save remote as a conflict copy, keep local as-is
					const date = new Date().toISOString().slice(0, 10);
					const baseName = normalized.replace(/\.md$/, "");
					const conflictPath = `${baseName} (conflict ${date}).md`;
					await this.createFileWithFolders(conflictPath, change.content);
					this.syncedHashes.set(normalizePath(conflictPath), fnv1a(change.content));
					return true;
				} else if (resolution.choice === "merge" && resolution.mergedContent != null) {
					// Apply user-merged content locally and push to server
					await this.app.vault.modify(existing, resolution.mergedContent);
					this.syncedHashes.set(normalized, fnv1a(resolution.mergedContent));
					await this.pushFile(existing);
					return true;
				}
				// "keep-remote" falls through to overwrite below
			} else if (localContent === change.content) {
				// Content identical — nothing to do
				this.syncedHashes.set(normalized, localHash);
				return false;
			}

			// Apply remote change (no conflict, or keep-remote chosen)
			await this.app.vault.modify(existing, change.content);
			this.syncedHashes.set(normalized, fnv1a(change.content));
			return true;
		} else {
			// New file — create it
			await this.createFileWithFolders(normalized, change.content);
			this.syncedHashes.set(normalized, fnv1a(change.content));
			return true;
		}
	}

	/** Apply a remote attachment change to the vault.
	 *  If contentBase64 is provided (from SSE), use it directly. Otherwise fetch it.
	 *  Returns true when a file was actually created, modified, or trashed. */
	async applyAttachmentChange(change: AttachmentChange, contentBase64?: string): Promise<boolean> {
		if (this.shouldIgnore(change.path)) return false;

		const normalized = normalizePath(change.path);

		if (change.deleted) {
			const existing = this.app.vault.getAbstractFileByPath(normalized);
			if (existing && existing instanceof TFile) {
				await this.app.vault.trash(existing, true);
				await this.removeEmptyFolders(normalized);
				return true;
			}
			return false;
		}

		// Fetch content if not provided
		if (!contentBase64) {
			const detail = await this.api.getAttachment(change.path);
			contentBase64 = detail.content_base64;
		}

		const buffer = base64ToArrayBuffer(contentBase64);
		const existing = this.app.vault.getAbstractFileByPath(normalized);

		if (existing && existing instanceof TFile) {
			// Apply unconditionally — conflict detection upstream already
			// determined this change should be applied. Obsidian sets mtime
			// to "now" on write, making mtime comparison unreliable here.
			await this.app.vault.modifyBinary(existing, buffer);
			return true;
		} else {
			await this.createBinaryFileWithFolders(normalized, buffer);
			return true;
		}
	}

	/** Resolve a conflict via callback or auto-resolve as keep-remote. */
	private async resolveConflict(info: ConflictInfo): Promise<ConflictResolution> {
		if (this.onConflict) {
			return this.onConflict(info);
		}
		// No handler — default to keep-remote (legacy behavior)
		return { choice: "keep-remote" };
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

	/** Remove empty parent folders after a file deletion, walking up the tree. */
	private async removeEmptyFolders(filePath: string): Promise<void> {
		let folder = filePath.includes("/")
			? filePath.substring(0, filePath.lastIndexOf("/"))
			: "";

		while (folder) {
			const existing = this.app.vault.getAbstractFileByPath(folder);
			if (!(existing instanceof TFolder)) break;
			if (existing.children.length > 0) break;

			await this.app.vault.trash(existing, true);

			// Walk up to parent
			folder = folder.includes("/")
				? folder.substring(0, folder.lastIndexOf("/"))
				: "";
		}
	}

	// --- Full sync (startup) ---

	/** Full bidirectional sync: pull remote changes, then push local changes. */
	async fullSync(): Promise<{ pulled: number; pushed: number }> {
		devLog().log("lifecycle", "fullSync start");
		// Verify auth before syncing to give a clear error on bad API key
		const { ok, error } = await this.api.ping();
		if (!ok) {
			this.lastError = error ?? "Connection failed";
			this.emitStatus();
			devLog().log("error", `fullSync auth failed: ${this.lastError}`);
			throw new Error(this.lastError);
		}

		// Configure request pacer from server-reported rate limit
		await this.configureRateLimit();

		// Snapshot lastSync before pull — pull updates it to server_time,
		// which would cause pushModifiedFiles to miss files modified between
		// the old and new lastSync values.
		const prePullSync = this.lastSync;

		const pulled = await this.pull();
		const pushed = await this.pushModifiedFiles(prePullSync);

		devLog().log("lifecycle", `fullSync done — pulled=${pulled} pushed=${pushed}`);
		return { pulled, pushed };
	}

	/** Push all files that have been modified since last sync. */
	private async pushModifiedFiles(sinceTimestamp?: string): Promise<number> {
		const since = sinceTimestamp || this.lastSync;
		if (!since) return 0;

		const sinceMs = new Date(since).getTime();
		const files = this.app.vault.getFiles();
		let pushed = 0;

		// Batch in groups of 10
		const toSync = files.filter(
			(f: TFile) => this.isSyncable(f) && !this.shouldIgnore(f.path) && f.stat.mtime > sinceMs,
		);
		devLog().log("push", `pushModifiedFiles: ${toSync.length} files modified since ${since}`);

		for (let i = 0; i < toSync.length; i += 10) {
			const batch = toSync.slice(i, i + 10);
			const results = await Promise.all(batch.map((f: TFile) => this.pushFile(f)));
			pushed += results.filter(Boolean).length;
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
		// Verify auth before pushing to give a clear error on bad API key
		const { ok, error } = await this.api.ping();
		if (!ok) {
			this.lastError = error ?? "Connection failed";
			this.emitStatus();
			throw new Error(this.lastError);
		}

		const files = this.app.vault.getFiles();
		const toSync = files.filter((f: TFile) => this.isSyncable(f) && !this.shouldIgnore(f.path));
		let pushed = 0;

		new Notice(`Engram Sync: pushing ${toSync.length} files...`);

		for (let i = 0; i < toSync.length; i += 10) {
			const batch = toSync.slice(i, i + 10);
			const results = await Promise.all(batch.map((f: TFile) => this.pushFile(f)));
			pushed += results.filter(Boolean).length;

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
		devLog().log("lifecycle", `went offline — queue=${this.queue.size}`);
		this.emitStatus();
		this.startHealthCheck();
	}

	/** Transition back to online mode. */
	private goOnline(): void {
		if (!this.offline) return;
		this.offline = false;
		this.lastError = "";
		this.stopHealthCheck();
		devLog().log("lifecycle", `went online — flushing queue (${this.queue.size} entries)`);
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
		devLog().log("queue", `flush start — ${entries.length} entries`);

		let flushed = 0;
		for (const entry of entries) {
			try {
				await this.paceRequest();
				if (entry.action === "delete") {
					try {
						if (entry.kind === "attachment") {
							await this.api.deleteAttachment(entry.path);
						} else {
							await this.api.deleteNote(entry.path);
						}
					} catch (e) {
						// 404 means already deleted — dequeue and continue
						if (!isHttpStatus(e, 404)) throw e;
					}
				} else if (entry.kind === "attachment") {
					// Legacy entries may have content inline; new entries are content-free
					let base64 = entry.contentBase64;
					let mimeType = entry.mimeType;
					let mtime = entry.mtime;
					if (!base64) {
						const file = this.app.vault.getAbstractFileByPath(entry.path);
						if (!(file instanceof TFile)) {
							await this.queue.dequeue(entry.path);
							flushed++;
							continue;
						}
						const buffer = await this.app.vault.readBinary(file);
						base64 = arrayBufferToBase64(buffer);
						mimeType = this.getMimeType(file);
						mtime = file.stat.mtime / 1000;
					}
					await this.api.pushAttachment(entry.path, base64, mimeType!, mtime!);
				} else {
					// Note upsert — legacy entries have content; new entries are content-free
					let content = entry.content;
					let mtime = entry.mtime;
					if (content === undefined) {
						const file = this.app.vault.getAbstractFileByPath(entry.path);
						if (!(file instanceof TFile)) {
							await this.queue.dequeue(entry.path);
							flushed++;
							continue;
						}
						content = await this.app.vault.read(file);
						mtime = file.stat.mtime / 1000;
					}
					await this.api.pushNote(entry.path, content, mtime!);
				}
				await this.queue.dequeue(entry.path);
				flushed++;
			} catch {
				// Lost connectivity again — stop flushing
				this.goOffline();
				break;
			}
		}

		devLog().log("queue", `flush done — ${flushed}/${entries.length} flushed, ${this.queue.size} remaining`);
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
		this.queue.destroy();
	}
}
