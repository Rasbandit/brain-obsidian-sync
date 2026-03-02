/**
 * Settings tab for Brain Sync plugin.
 */
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type BrainSyncPlugin from "./main";

export class BrainSyncSettingTab extends PluginSettingTab {
	plugin: BrainSyncPlugin;

	constructor(app: App, plugin: BrainSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Brain Sync Settings" });

		new Setting(containerEl)
			.setName("Brain API URL")
			.setDesc("Full URL to your brain-api instance (e.g. http://10.0.20.214:8000)")
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
			.setDesc("Bearer token from brain-api settings page (starts with brain_)")
			.addText((text) =>
				text
					.setPlaceholder("brain_abc123...")
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
			.setDesc("Delay after editing before pushing to brain-api. Prevents flooding during typing.")
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
			.setName("Ignore patterns")
			.setDesc("Paths to skip (one per line). Folder patterns end with /")
			.addTextArea((text) =>
				text
					.setPlaceholder(".obsidian/\n.trash/\n.git/")
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
			.setDesc("Check if brain-api is reachable")
			.addButton((btn) =>
				btn.setButtonText("Test").onClick(async () => {
					const ok = await this.plugin.api.health();
					new Notice(
						ok
							? "Brain API: connected!"
							: "Brain API: connection failed",
					);
				}),
			);

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Pull remote changes and push local changes")
			.addButton((btn) =>
				btn.setButtonText("Sync").onClick(async () => {
					new Notice("Brain Sync: syncing...");
					const { pulled, pushed } =
						await this.plugin.syncEngine.fullSync();
					new Notice(
						`Brain Sync: pulled ${pulled}, pushed ${pushed}`,
					);
				}),
			);

		new Setting(containerEl)
			.setName("Push entire vault")
			.setDesc("Initial import — push all markdown files to brain-api. Only needed once.")
			.addButton((btn) =>
				btn
					.setButtonText("Push All")
					.setWarning()
					.onClick(async () => {
						const count =
							await this.plugin.syncEngine.pushAll();
						new Notice(`Brain Sync: pushed ${count} files`);
					}),
			);
	}
}
