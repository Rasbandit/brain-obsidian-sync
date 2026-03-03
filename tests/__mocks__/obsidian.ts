/** Minimal mock of Obsidian API for unit tests. */

export class TFile {
	path: string;
	extension: string;
	stat: { mtime: number; ctime: number; size: number };
	basename: string;

	constructor(path: string, mtime: number = Date.now(), size: number = 100) {
		this.path = path;
		this.extension = path.split(".").pop() || "";
		this.basename = path.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
		this.stat = { mtime, ctime: mtime, size };
	}
}

export class TAbstractFile {
	path: string = "";
}

export class TFolder {
	path: string;
	children: any[];

	constructor(path: string, children: any[] = []) {
		this.path = path;
		this.children = children;
	}
}

export class Notice {
	constructor(_message: string, _timeout?: number) {}
}

export class Plugin {
	app: any = {};
	async loadData(): Promise<any> {
		return {};
	}
	async saveData(_data: any): Promise<void> {}
	addSettingTab(_tab: any): void {}
	addCommand(_cmd: any): void {}
	addStatusBarItem(): any {
		return { setText: () => {} };
	}
	registerEvent(_evt: any): void {}
}

export class PluginSettingTab {
	containerEl: any = {
		empty: () => {},
		createEl: () => ({ setText: () => {} }),
	};
	constructor(_app: any, _plugin: any) {}
}

export class Setting {
	constructor(_containerEl: any) {}
	setName(_name: string): this { return this; }
	setDesc(_desc: string): this { return this; }
	addText(_cb: any): this { return this; }
	addTextArea(_cb: any): this { return this; }
	addButton(_cb: any): this { return this; }
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export async function requestUrl(_opts: any): Promise<any> {
	return { status: 200, json: {} };
}

export class Modal {
	app: any;
	contentEl: any = {
		empty: () => {},
		createEl: (_tag: string, _opts?: any) => ({
			setText: () => {},
			style: {},
		}),
		createDiv: (_opts?: any) => ({
			createEl: (_tag: string, _opts2?: any) => ({
				setText: () => {},
				addEventListener: () => {},
				style: {},
			}),
			style: {},
		}),
	};
	constructor(app: any) { this.app = app; }
	open(): void {}
	close(): void {}
}

export class App {}
