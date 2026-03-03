/**
 * Settings tab for Engram Sync plugin.
 */
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type EngramSyncPlugin from "./main";

export class EngramSyncSettingTab extends PluginSettingTab {
	plugin: EngramSyncPlugin;

	constructor(app: App, plugin: EngramSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Engram Sync Settings" });

		new Setting(containerEl)
			.setName("Engram URL")
			.setDesc("Full URL to your Engram instance (e.g. http://10.0.20.214:8000)")
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:8000")
					.setValue(this.plugin.settings.apiUrl)
					.onChange(async (value) => {
						this.plugin.settings.apiUrl = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("Bearer token from Engram settings page (starts with engram_)")
			.addText((text) =>
				text
					.setPlaceholder("engram_abc123...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc("How often to pull remote changes. 0 = manual only.")
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.syncIntervalMinutes))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 0) {
							this.plugin.settings.syncIntervalMinutes = num;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Debounce (ms)")
			.setDesc("Delay after editing before pushing to Engram. Prevents flooding during typing.")
			.addText((text) =>
				text
					.setPlaceholder("2000")
					.setValue(String(this.plugin.settings.debounceMs))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 100) {
							this.plugin.settings.debounceMs = num;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Live sync (SSE)")
			.setDesc("Receive remote changes in near real-time via Server-Sent Events. When off, uses interval polling.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.liveSyncEnabled)
					.onChange(async (value) => {
						this.plugin.settings.liveSyncEnabled = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Max file size (MB)")
			.setDesc("Maximum size for binary attachments (images, PDFs, etc.). Files larger than this are skipped.")
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.maxFileSizeMB))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 1 && num <= 100) {
							this.plugin.settings.maxFileSizeMB = num;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Additional ignore patterns")
			.setDesc("Extra paths to skip (one per line). Folder patterns end with /. Note: .obsidian/, .trash/, and .git/ are always ignored.")
			.addTextArea((text) =>
				text
					.setPlaceholder("drafts/\nsecret.md")
					.setValue(this.plugin.settings.ignorePatterns)
					.onChange(async (value) => {
						this.plugin.settings.ignorePatterns = value;
						await this.plugin.saveSettings();
					}),
			);

		// Action buttons
		containerEl.createEl("h3", { text: "Actions" });

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Check if Engram is reachable")
			.addButton((btn) =>
				btn.setButtonText("Test").onClick(async () => {
					const ok = await this.plugin.api.health();
					new Notice(
						ok
							? "Engram: connected!"
							: "Engram: connection failed",
					);
				}),
			);

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Pull remote changes and push local changes")
			.addButton((btn) =>
				btn.setButtonText("Sync").onClick(async () => {
					new Notice("Engram Sync: syncing...");
					const { pulled, pushed } =
						await this.plugin.syncEngine.fullSync();
					new Notice(
						`Engram Sync: pulled ${pulled}, pushed ${pushed}`,
					);
				}),
			);

		new Setting(containerEl)
			.setName("Push entire vault")
			.setDesc("Initial import — push all syncable files to Engram. Only needed once.")
			.addButton((btn) =>
				btn
					.setButtonText("Push All")
					.setWarning()
					.onClick(async () => {
						const count =
							await this.plugin.syncEngine.pushAll();
						new Notice(`Engram Sync: pushed ${count} files`);
					}),
			);
	}
}
