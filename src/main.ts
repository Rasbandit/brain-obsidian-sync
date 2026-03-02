/**
 * Brain Sync — Obsidian plugin for bidirectional sync with brain-api.
 *
 * Pushes vault changes to brain-api for indexing/search.
 * Pulls MCP-created notes and changes from other devices.
 */
import { Notice, Plugin } from "obsidian";
import { BrainApi } from "./api";
import { BrainSyncSettings, DEFAULT_SETTINGS } from "./types";
import { SyncEngine } from "./sync";
import { BrainSyncSettingTab } from "./settings";
import { NoteStream } from "./stream";

interface PluginData {
	settings: BrainSyncSettings;
	lastSync: string;
}

export default class BrainSyncPlugin extends Plugin {
	settings: BrainSyncSettings = DEFAULT_SETTINGS;
	api: BrainApi = new BrainApi("", "");
	syncEngine: SyncEngine = null!;
	private syncInterval: ReturnType<typeof setInterval> | null = null;
	noteStream: NoteStream | null = null;
	private statusBarEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.api = new BrainApi(this.settings.apiUrl, this.settings.apiKey);

		this.syncEngine = new SyncEngine(
			this.app,
			this.api,
			this.settings,
			async (data) => {
				await this.savePluginData(data.lastSync);
			},
		);

		// Restore last sync timestamp
		const saved = await this.loadData();
		if (saved?.lastSync) {
			this.syncEngine.setLastSync(saved.lastSync);
		}

		// Register settings tab
		this.addSettingTab(new BrainSyncSettingTab(this.app, this));

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
			id: "brain-sync-now",
			name: "Sync now",
			callback: async () => {
				new Notice("Brain Sync: syncing...");
				const { pulled, pushed } =
					await this.syncEngine.fullSync();
				new Notice(
					`Brain Sync: pulled ${pulled}, pushed ${pushed}`,
				);
			},
		});

		this.addCommand({
			id: "brain-push-all",
			name: "Push entire vault",
			callback: async () => {
				const count = await this.syncEngine.pushAll();
				new Notice(`Brain Sync: pushed ${count} files`);
			},
		});

		// Start periodic sync if configured
		this.startSyncInterval();

		// Status bar
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.setText("Brain: ready");

		// SSE live sync
		this.setupNoteStream();

		// Initial sync on startup (after workspace is ready)
		this.app.workspace.onLayoutReady(async () => {
			if (this.settings.apiUrl && this.settings.apiKey) {
				try {
					const { pulled, pushed } =
						await this.syncEngine.fullSync();
					if (pulled > 0 || pushed > 0) {
						new Notice(
							`Brain Sync: pulled ${pulled}, pushed ${pushed}`,
						);
					}
				} catch (e) {
					console.error("Brain Sync: startup sync failed", e);
				}
			}
		});
	}

	onunload(): void {
		this.syncEngine?.destroy();
		this.noteStream?.disconnect();
		if (this.syncInterval) {
			clearInterval(this.syncInterval);
			this.syncInterval = null;
		}
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
	}

	private async savePluginData(lastSync: string): Promise<void> {
		await this.saveData({
			settings: this.settings,
			lastSync,
		} as PluginData);
	}

	setupNoteStream(): void {
		// Disconnect existing stream
		this.noteStream?.disconnect();
		this.noteStream = null;

		const { apiUrl, apiKey, liveSyncEnabled } = this.settings;
		if (!liveSyncEnabled || !apiUrl || !apiKey) {
			if (this.statusBarEl) this.statusBarEl.setText("Brain: ready");
			return;
		}

		this.noteStream = new NoteStream(apiUrl, apiKey);

		this.noteStream.onEvent = (event) => {
			this.syncEngine.handleStreamEvent(event);
		};

		this.noteStream.onStatusChange = (connected) => {
			if (this.statusBarEl) {
				this.statusBarEl.setText(connected ? "Brain: live" : "Brain: ready");
			}
			// Catch-up pull on reconnect to cover missed events
			if (connected) {
				this.syncEngine.pull().catch((e) => {
					console.error("Brain Sync: catch-up pull failed", e);
				});
			}
		};

		this.noteStream.connect();
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
						await this.syncEngine.pull();
					} catch (e) {
						console.error("Brain Sync: periodic pull failed", e);
					}
				},
				minutes * 60 * 1000,
			);
		}
	}
}
