/**
 * Conflict resolution modal — shown when both local and remote have changed
 * the same note since the last sync.
 */
import { App, Modal } from "obsidian";
import { ConflictChoice, ConflictInfo } from "./types";

export class ConflictModal extends Modal {
	private resolve: (choice: ConflictChoice) => void = () => {};
	private info: ConflictInfo;

	constructor(app: App, info: ConflictInfo) {
		super(app);
		this.info = info;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("engram-sync-conflict-modal");

		contentEl.createEl("h2", { text: "Sync Conflict" });

		contentEl.createEl("p", {
			text: `Both local and remote versions of this note have changed since the last sync:`,
		});

		const pathEl = contentEl.createEl("p", {
			text: this.info.path,
			cls: "engram-sync-conflict-path",
		});
		pathEl.style.cssText =
			"font-weight: bold; font-family: monospace; padding: 4px 8px; background: var(--background-secondary); border-radius: 4px;";

		// Metadata row
		const meta = contentEl.createDiv({ cls: "engram-sync-conflict-meta" });
		meta.style.cssText = "display: flex; gap: 24px; margin: 12px 0;";

		const localMeta = meta.createDiv();
		localMeta.createEl("strong", { text: "Local" });
		localMeta.createEl("br");
		localMeta.createEl("span", {
			text: `Modified: ${new Date(this.info.localMtime * 1000).toLocaleString()}`,
		});
		localMeta.createEl("br");
		localMeta.createEl("span", {
			text: `Size: ${this.info.localContent.length} chars`,
		});

		const remoteMeta = meta.createDiv();
		remoteMeta.createEl("strong", { text: "Remote" });
		remoteMeta.createEl("br");
		remoteMeta.createEl("span", {
			text: `Modified: ${new Date(this.info.remoteMtime * 1000).toLocaleString()}`,
		});
		remoteMeta.createEl("br");
		remoteMeta.createEl("span", {
			text: `Size: ${this.info.remoteContent.length} chars`,
		});

		// Content previews
		const previews = contentEl.createDiv({ cls: "engram-sync-conflict-previews" });
		previews.style.cssText = "display: flex; gap: 12px; margin: 12px 0; max-height: 300px;";

		const localPreview = previews.createDiv();
		localPreview.style.cssText = "flex: 1; overflow: auto;";
		localPreview.createEl("strong", { text: "Local version" });
		const localPre = localPreview.createEl("pre");
		localPre.style.cssText = "font-size: 0.85em; white-space: pre-wrap; max-height: 250px; overflow: auto; padding: 8px; background: var(--background-secondary); border-radius: 4px;";
		localPre.setText(this.info.localContent.slice(0, 2000));

		const remotePreview = previews.createDiv();
		remotePreview.style.cssText = "flex: 1; overflow: auto;";
		remotePreview.createEl("strong", { text: "Remote version" });
		const remotePre = remotePreview.createEl("pre");
		remotePre.style.cssText = "font-size: 0.85em; white-space: pre-wrap; max-height: 250px; overflow: auto; padding: 8px; background: var(--background-secondary); border-radius: 4px;";
		remotePre.setText(this.info.remoteContent.slice(0, 2000));

		// Buttons
		const btnContainer = contentEl.createDiv({ cls: "engram-sync-conflict-buttons" });
		btnContainer.style.cssText = "display: flex; gap: 8px; margin-top: 16px;";

		const keepLocalBtn = btnContainer.createEl("button", { text: "Keep Local", cls: "mod-warning" });
		keepLocalBtn.addEventListener("click", () => {
			this.resolve("keep-local");
			this.close();
		});

		const keepRemoteBtn = btnContainer.createEl("button", { text: "Keep Remote" });
		keepRemoteBtn.addEventListener("click", () => {
			this.resolve("keep-remote");
			this.close();
		});

		const keepBothBtn = btnContainer.createEl("button", { text: "Keep Both" });
		keepBothBtn.addEventListener("click", () => {
			this.resolve("keep-both");
			this.close();
		});

		const skipBtn = btnContainer.createEl("button", { text: "Skip" });
		skipBtn.addEventListener("click", () => {
			this.resolve("skip");
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		// If closed without choosing (e.g. Escape), treat as skip
		this.resolve("skip");
	}

	/** Show the modal and return the user's choice. */
	waitForChoice(): Promise<ConflictChoice> {
		return new Promise((resolve) => {
			this.resolve = (choice) => {
				// Only resolve once
				this.resolve = () => {};
				resolve(choice);
			};
			this.open();
		});
	}
}
