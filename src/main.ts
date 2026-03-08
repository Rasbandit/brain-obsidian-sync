/**
 * Engram Sync — Obsidian plugin for bidirectional sync with Engram.
 *
 * Pushes vault changes to Engram for indexing/search.
 * Pulls MCP-created notes and changes from other devices.
 */
import { Notice, Plugin } from "obsidian";
import { EngramApi } from "./api";
import { EngramSyncSettings, DEFAULT_SETTINGS, SyncStatus } from "./types";
import { SyncEngine } from "./sync";
import { EngramSyncSettingTab } from "./settings";
import { NoteStream } from "./stream";
import { FirstSyncModal } from "./first-sync-modal";
import { ConflictModal } from "./conflict-modal";
import { SearchModal } from "./search-modal";
import { SearchView, SEARCH_VIEW_TYPE } from "./search-view";

import { QueueEntry } from "./types";
import { initDevLog, destroyDevLog, devLog } from "./dev-log";

interface PluginData {
	settings: EngramSyncSettings;
	lastSync: string;
	offlineQueue?: QueueEntry[];
}

export default class EngramSyncPlugin extends Plugin {
	settings: EngramSyncSettings = DEFAULT_SETTINGS;
	api: EngramApi = new EngramApi("", "");
	syncEngine: SyncEngine = null!;
	private syncInterval: ReturnType<typeof setInterval> | null = null;
	noteStream: NoteStream | null = null;
	private statusBarEl: HTMLElement | null = null;
	private sseConnected: boolean = false;

	async onload(): Promise<void> {
		initDevLog();
		devLog().log("lifecycle", "plugin loading");
		await this.loadSettings();

		this.api = new EngramApi(this.settings.apiUrl, this.settings.apiKey);

		this.syncEngine = new SyncEngine(
			this.app,
			this.api,
			this.settings,
			async (data) => {
				await this.savePluginData(data.lastSync);
			},
		);

		this.syncEngine.onStatusChange = (status) => {
			this.updateStatusBar(status);
		};

		this.syncEngine.onConflict = async (info) => {
			const modal = new ConflictModal(this.app, info);
			return modal.waitForChoice();
		};

		// Wire up queue persistence
		this.syncEngine.queue.onPersist(async (entries) => {
			await this.savePluginData(this.syncEngine.getLastSync(), entries);
		});

		// Restore last sync timestamp and offline queue
		const saved = await this.loadData();
		if (saved?.lastSync) {
			this.syncEngine.setLastSync(saved.lastSync);
		}
		if (saved?.offlineQueue?.length) {
			this.syncEngine.queue.load(saved.offlineQueue);
		}

		// Register settings tab
		this.addSettingTab(new EngramSyncSettingTab(this.app, this));

		// Register vault events
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				this.syncEngine.handleModify(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				this.syncEngine.handleModify(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.syncEngine.handleDelete(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.syncEngine.handleRename(file, oldPath);
			}),
		);

		// Add commands
		this.addCommand({
			id: "engram-sync-now",
			name: "Sync now",
			callback: async () => {
				new Notice("Engram Sync: syncing...");
				const { pulled, pushed } =
					await this.syncEngine.fullSync();
				new Notice(
					`Engram Sync: pulled ${pulled}, pushed ${pushed}`,
				);
			},
		});

		this.addCommand({
			id: "engram-push-all",
			name: "Push entire vault",
			callback: async () => {
				const count = await this.syncEngine.pushAll();
				new Notice(`Engram Sync: pushed ${count} files`);
			},
		});

		// Register search view
		this.registerView(SEARCH_VIEW_TYPE, (leaf) => new SearchView(leaf, this.api));

		this.addCommand({
			id: "engram-search",
			name: "Semantic search",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "s" }],
			callback: () => {
				new SearchModal(this.app, this.api).open();
			},
		});

		this.addCommand({
			id: "engram-search-view",
			name: "Open search sidebar",
			callback: async () => {
				const existing = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
				if (existing.length) {
					this.app.workspace.revealLeaf(existing[0]);
					return;
				}
				const leaf = this.app.workspace.getRightLeaf(false);
				if (leaf) {
					await leaf.setViewState({ type: SEARCH_VIEW_TYPE, active: true });
					this.app.workspace.revealLeaf(leaf);
				}
			},
		});

		this.addRibbonIcon("search", "Engram Search", async () => {
			const existing = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
			if (existing.length) {
				this.app.workspace.revealLeaf(existing[0]);
				return;
			}
			const leaf = this.app.workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: SEARCH_VIEW_TYPE, active: true });
				this.app.workspace.revealLeaf(leaf);
			}
		});

		// Start periodic sync if configured
		this.startSyncInterval();

		// Status bar (click to sync)
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.setText("Engram: ready");
		this.statusBarEl.style.cursor = "pointer";
		this.statusBarEl.addEventListener("click", () => {
			if (this.settings.apiUrl && this.settings.apiKey) {
				new Notice("Engram Sync: syncing...");
				this.syncEngine.fullSync().then(({ pulled, pushed }) => {
					new Notice(`Engram Sync: pulled ${pulled}, pushed ${pushed}`);
				}).catch((e) => {
					console.error("Engram Sync: manual sync failed", e);
					new Notice("Engram Sync: sync failed");
				});
			}
		});

		// SSE live sync
		this.setupNoteStream();

		// Initial sync on startup (after workspace is ready)
		this.app.workspace.onLayoutReady(async () => {
			devLog().log("lifecycle", "layout ready — starting initial sync");
			try {
				if (this.settings.apiUrl && this.settings.apiKey) {
					await this.doSyncWithFirstSyncCheck();
				}
			} finally {
				this.syncEngine.setReady();
			}
		});
	}

	onunload(): void {
		devLog().log("lifecycle", "plugin unloading");
		this.syncEngine?.destroy();
		this.noteStream?.disconnect();
		if (this.syncInterval) {
			clearInterval(this.syncInterval);
			this.syncInterval = null;
		}
		destroyDevLog();
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			data?.settings,
		);
	}

	async saveSettings(): Promise<void> {
		this.api.updateConfig(this.settings.apiUrl, this.settings.apiKey);
		this.syncEngine.updateSettings(this.settings);
		this.startSyncInterval();
		this.setupNoteStream();
		await this.savePluginData(this.syncEngine.getLastSync());

		// Trigger sync when settings are configured (shows modal on first sync)
		if (this.settings.apiUrl && this.settings.apiKey) {
			this.doSyncWithFirstSyncCheck().catch((e) => {
				console.error("Engram Sync: sync after settings change failed", e);
			});
		}
	}

	private async savePluginData(lastSync: string, offlineQueue?: QueueEntry[]): Promise<void> {
		await this.saveData({
			settings: this.settings,
			lastSync,
			offlineQueue: offlineQueue ?? this.syncEngine.queue.all(),
		} as PluginData);
	}

	setupNoteStream(): void {
		// Disconnect existing stream
		this.noteStream?.disconnect();
		this.noteStream = null;

		const { apiUrl, apiKey, liveSyncEnabled } = this.settings;
		if (!liveSyncEnabled || !apiUrl || !apiKey) {
			this.sseConnected = false;
			this.updateStatusBar(this.syncEngine.getStatus());
			return;
		}

		this.noteStream = new NoteStream(apiUrl, apiKey);

		this.noteStream.onEvent = (event) => {
			this.syncEngine.handleStreamEvent(event);
		};

		this.noteStream.onStatusChange = (connected) => {
			this.sseConnected = connected;
			this.updateStatusBar(this.syncEngine.getStatus());
			// Catch-up pull on reconnect to cover missed events
			if (connected) {
				this.syncEngine.pull().catch((e) => {
					console.error("Engram Sync: catch-up pull failed", e);
				});
			}
		};

		this.noteStream.connect();
	}

	/** Run sync, showing first-sync modal if no prior sync state exists. */
	async doSyncWithFirstSyncCheck(): Promise<void> {
		if (this.syncEngine.isFirstSync()) {
			const localCount = this.syncEngine.countSyncableFiles();
			const modal = new FirstSyncModal(this.app, localCount);
			const choice = await modal.waitForChoice();

			if (choice === "cancel") {
				return;
			}

			// Always pull first
			const pulled = await this.syncEngine.pull();
			if (pulled > 0) {
				new Notice(`Engram Sync: pulled ${pulled} notes from server`);
			}

			if (choice === "push-all") {
				const pushed = await this.syncEngine.pushAll();
				new Notice(`Engram Sync: pushed ${pushed} files`);
			} else {
				new Notice("Engram Sync: pull complete. Local notes were not pushed.");
			}
		} else {
			try {
				const { pulled, pushed } = await this.syncEngine.fullSync();
				if (pulled > 0 || pushed > 0) {
					new Notice(`Engram Sync: pulled ${pulled}, pushed ${pushed}`);
				}
			} catch (e) {
				console.error("Engram Sync: sync failed", e);
				new Notice("Engram Sync: sync failed — check connection");
			}
		}
	}

	/** Update status bar text and tooltip based on sync state + SSE connection. */
	private updateStatusBar(status: SyncStatus): void {
		if (!this.statusBarEl) return;

		let text: string;
		let tooltip: string;

		if (status.state === "offline") {
			text = status.queued > 0
				? `Engram: offline (${status.queued} queued)`
				: "Engram: offline";
			tooltip = "Server unreachable — changes will sync when connected";
		} else if (status.state === "error") {
			text = "Engram: error";
			tooltip = status.error || "Unknown error";
		} else if (status.state === "syncing") {
			text = status.pending > 0 ? `Engram: syncing (${status.pending})` : "Engram: syncing";
			tooltip = "Sync in progress...";
		} else if (status.pending > 0) {
			text = `Engram: pending (${status.pending})`;
			tooltip = `${status.pending} file(s) queued`;
		} else if (this.sseConnected) {
			text = "Engram: live";
			tooltip = "SSE connected — real-time sync active";
		} else {
			text = "Engram: ready";
			tooltip = "Click to sync";
		}

		if (status.lastSync) {
			const date = new Date(status.lastSync);
			tooltip += `\nLast sync: ${date.toLocaleString()}`;
		}

		this.statusBarEl.setText(text);
		this.statusBarEl.setAttribute("aria-label", tooltip);
	}

	private startSyncInterval(): void {
		if (this.syncInterval) {
			clearInterval(this.syncInterval);
			this.syncInterval = null;
		}

		const minutes = this.settings.syncIntervalMinutes;
		if (minutes > 0 && this.settings.apiUrl && this.settings.apiKey) {
			this.syncInterval = setInterval(
				async () => {
					try {
						const pulled = await this.syncEngine.pull();
						if (pulled > 0) {
							new Notice(`Engram Sync: pulled ${pulled} changes`);
						}
					} catch (e) {
						console.error("Engram Sync: periodic pull failed", e);
						new Notice("Engram Sync: pull failed — check connection");
					}
				},
				minutes * 60 * 1000,
			);
		}
	}
}
