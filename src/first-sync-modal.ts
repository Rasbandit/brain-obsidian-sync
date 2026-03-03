/**
 * Confirmation modal shown on first sync to prevent accidental bulk push.
 */
import { App, Modal } from "obsidian";

export type FirstSyncChoice = "push-all" | "pull-only" | "cancel";

export class FirstSyncModal extends Modal {
	private resolve: (choice: FirstSyncChoice) => void = () => {};
	private localCount: number;

	constructor(app: App, localCount: number) {
		super(app);
		this.localCount = localCount;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Engram Sync — First Sync" });

		contentEl.createEl("p", {
			text: `Your vault has ${this.localCount} markdown files. How would you like to sync?`,
		});

		const btnContainer = contentEl.createDiv({ cls: "engram-sync-modal-buttons" });
		btnContainer.style.display = "flex";
		btnContainer.style.gap = "8px";
		btnContainer.style.marginTop = "16px";

		const pushBtn = btnContainer.createEl("button", { text: "Push All", cls: "mod-warning" });
		pushBtn.addEventListener("click", () => {
			this.resolve("push-all");
			this.close();
		});

		const pullBtn = btnContainer.createEl("button", { text: "Pull Only" });
		pullBtn.addEventListener("click", () => {
			this.resolve("pull-only");
			this.close();
		});

		const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => {
			this.resolve("cancel");
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** Show the modal and return the user's choice. */
	waitForChoice(): Promise<FirstSyncChoice> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}
}
