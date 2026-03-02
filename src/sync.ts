/**
 * Sync engine — handles push/pull logic, debouncing, and ignore patterns.
 */
import { App, TFile, TAbstractFile, Notice, normalizePath } from "obsidian";
import { BrainApi } from "./api";
import { BrainSyncSettings, NoteChange, NoteStreamEvent } from "./types";

/** How long (ms) after a push completes to suppress SSE echoes for that path. */
const ECHO_COOLDOWN_MS = 5000;

export class SyncEngine {
	private debounceTimers: Map<string, ReturnType<typeof setTimeout>> =
		new Map();
	private ignorePatterns: string[] = [];
	private pushing: Set<string> = new Set();
	private recentlyPushed: Map<string, ReturnType<typeof setTimeout>> =
		new Map();
	private pulling: boolean = false;
	private lastSync: string = "";

	constructor(
		private app: App,
		private api: BrainApi,
		private settings: BrainSyncSettings,
		private saveData: (data: { lastSync: string }) => Promise<void>,
	) {
		this.parseIgnorePatterns();
	}

	updateSettings(settings: BrainSyncSettings): void {
		this.settings = settings;
		this.parseIgnorePatterns();
	}

	setLastSync(timestamp: string): void {
		this.lastSync = timestamp;
	}

	getLastSync(): string {
		return this.lastSync;
	}

	// --- Ignore pattern matching ---

	private parseIgnorePatterns(): void {
		this.ignorePatterns = this.settings.ignorePatterns
			.split("\n")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
	}

	shouldIgnore(path: string): boolean {
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

	// --- Push: local → brain-api ---

	/** Handle a vault modify/create event with debounce. */
	handleModify(file: TAbstractFile): void {
		if (!this.isMarkdown(file)) return;
		if (this.shouldIgnore(file.path)) return;

		// Clear existing debounce timer for this file
		const existing = this.debounceTimers.get(file.path);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(async () => {
			this.debounceTimers.delete(file.path);
			await this.pushFile(file as TFile);
		}, this.settings.debounceMs);

		this.debounceTimers.set(file.path, timer);
	}

	/** Handle a vault delete event. */
	async handleDelete(file: TAbstractFile): Promise<void> {
		if (!this.isMarkdown(file)) return;
		if (this.shouldIgnore(file.path)) return;

		// Cancel any pending push for this file
		const existing = this.debounceTimers.get(file.path);
		if (existing) {
			clearTimeout(existing);
			this.debounceTimers.delete(file.path);
		}

		try {
			await this.api.deleteNote(file.path);
		} catch (e) {
			console.error(`Brain Sync: failed to delete ${file.path}`, e);
		}
	}

	/** Handle a vault rename event. */
	async handleRename(
		file: TAbstractFile,
		oldPath: string,
	): Promise<void> {
		if (!this.isMarkdown(file)) return;

		// Delete old path if it wasn't ignored
		if (!this.shouldIgnore(oldPath)) {
			try {
				await this.api.deleteNote(oldPath);
			} catch (e) {
				console.error(
					`Brain Sync: failed to delete old path ${oldPath}`,
					e,
				);
			}
		}

		// Push new path if it isn't ignored
		if (!this.shouldIgnore(file.path)) {
			await this.pushFile(file as TFile);
		}
	}

	/** Push a single file to brain-api. */
	private async pushFile(file: TFile): Promise<void> {
		if (this.pushing.has(file.path)) return;
		this.pushing.add(file.path);

		try {
			const content = await this.app.vault.read(file);
			const mtime = file.stat.mtime / 1000; // Obsidian uses ms, brain-api uses seconds
			await this.api.pushNote(file.path, content, mtime);
		} catch (e) {
			console.error(`Brain Sync: failed to push ${file.path}`, e);
		} finally {
			this.pushing.delete(file.path);
			// Keep path suppressed for a cooldown period after push completes.
			// SSE events often arrive after the push finishes, and without this
			// the echo suppression in handleStreamEvent would miss them.
			this.markRecentlyPushed(file.path);
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

	// --- Pull: brain-api → local vault ---

	/** Pull remote changes and apply to vault. */
	async pull(): Promise<number> {
		if (this.pulling) return 0;
		if (!this.lastSync) {
			// First sync — use epoch
			this.lastSync = "1970-01-01T00:00:00Z";
		}

		this.pulling = true;
		try {
			const resp = await this.api.getChanges(this.lastSync);
			let applied = 0;

			for (const change of resp.changes) {
				await this.applyChange(change);
				applied++;
			}

			// Update last sync to server_time
			this.lastSync = resp.server_time;
			await this.saveData({ lastSync: this.lastSync });

			return applied;
		} catch (e) {
			console.error("Brain Sync: pull failed", e);
			return 0;
		} finally {
			this.pulling = false;
		}
	}

	/** Handle an SSE stream event (upsert or delete). */
	async handleStreamEvent(event: NoteStreamEvent): Promise<void> {
		if (this.shouldIgnore(event.path)) return;

		// Echo suppression — skip events for notes we're currently pushing
		// or have recently finished pushing (SSE events arrive after push completes)
		if (this.pushing.has(event.path)) return;
		if (this.recentlyPushed.has(event.path)) return;

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
			} catch (e) {
				console.error(`Brain Sync: failed to fetch note for SSE event ${event.path}`, e);
			}
		}
	}

	/** Apply a single remote change to the vault. */
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
			// Check if remote is newer than local
			const localMtime = existing.stat.mtime / 1000;
			if (change.mtime > localMtime) {
				await this.app.vault.modify(existing, change.content);
			}
		} else {
			// Ensure parent folders exist
			const folder = normalized.includes("/")
				? normalized.substring(0, normalized.lastIndexOf("/"))
				: "";
			if (folder) {
				await this.ensureFolder(folder);
			}
			await this.app.vault.create(normalized, change.content);
		}
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

	/** Push all markdown files that have been modified since last sync. */
	private async pushModifiedFiles(): Promise<number> {
		if (!this.lastSync) return 0;

		const sinceMs = new Date(this.lastSync).getTime();
		const files = this.app.vault.getMarkdownFiles();
		let pushed = 0;

		// Batch in groups of 10
		const toSync = files.filter(
			(f) => !this.shouldIgnore(f.path) && f.stat.mtime > sinceMs,
		);

		for (let i = 0; i < toSync.length; i += 10) {
			const batch = toSync.slice(i, i + 10);
			await Promise.all(batch.map((f) => this.pushFile(f)));
			pushed += batch.length;
		}

		return pushed;
	}

	/** Push ALL markdown files (initial import). */
	async pushAll(): Promise<number> {
		const files = this.app.vault.getMarkdownFiles();
		const toSync = files.filter((f) => !this.shouldIgnore(f.path));
		let pushed = 0;

		new Notice(`Brain Sync: pushing ${toSync.length} files...`);

		for (let i = 0; i < toSync.length; i += 10) {
			const batch = toSync.slice(i, i + 10);
			await Promise.all(batch.map((f) => this.pushFile(f)));
			pushed += batch.length;

			if (pushed % 100 === 0) {
				new Notice(
					`Brain Sync: pushed ${pushed}/${toSync.length} files...`,
				);
			}
		}

		new Notice(`Brain Sync: initial push complete (${pushed} files)`);
		return pushed;
	}

	/** Cancel all pending debounce and cooldown timers. */
	destroy(): void {
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		for (const timer of this.recentlyPushed.values()) {
			clearTimeout(timer);
		}
		this.recentlyPushed.clear();
	}
}
