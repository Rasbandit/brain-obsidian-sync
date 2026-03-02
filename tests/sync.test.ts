import { TFile } from "obsidian";
import { SyncEngine } from "../src/sync";
import { BrainApi } from "../src/api";
import { DEFAULT_SETTINGS } from "../src/types";

// Mock the API
const mockApi = {
	pushNote: jest.fn().mockResolvedValue({ note: {}, chunks_indexed: 1 }),
	getChanges: jest.fn().mockResolvedValue({ changes: [], server_time: "2026-01-01T00:00:00Z" }),
	deleteNote: jest.fn().mockResolvedValue({ deleted: true, path: "" }),
	getNote: jest.fn().mockResolvedValue({
		path: "Notes/Remote.md",
		title: "Remote Note",
		content: "# Remote\n\nFrom SSE",
		folder: "Notes",
		tags: [],
		mtime: 1709345678,
		created_at: "2026-03-01T12:00:00Z",
		updated_at: "2026-03-01T12:00:00Z",
	}),
	health: jest.fn().mockResolvedValue(true),
} as unknown as BrainApi;

// Mock the Obsidian App
const mockApp = {
	vault: {
		read: jest.fn().mockResolvedValue("# Test\n\nContent"),
		getMarkdownFiles: jest.fn().mockReturnValue([]),
		getAbstractFileByPath: jest.fn().mockReturnValue(null),
		modify: jest.fn().mockResolvedValue(undefined),
		create: jest.fn().mockResolvedValue(undefined),
		createFolder: jest.fn().mockResolvedValue(undefined),
		trash: jest.fn().mockResolvedValue(undefined),
	},
} as any;

const mockSaveData = jest.fn().mockResolvedValue(undefined);

const activeEngines: SyncEngine[] = [];

function createEngine(overrides = {}): SyncEngine {
	const engine = new SyncEngine(
		mockApp,
		mockApi,
		{ ...DEFAULT_SETTINGS, debounceMs: 10, ...overrides },
		mockSaveData,
	);
	activeEngines.push(engine);
	return engine;
}

beforeEach(() => {
	jest.clearAllMocks();
});

afterEach(() => {
	// Clean up all engines to prevent timer leaks
	for (const engine of activeEngines) {
		engine.destroy();
	}
	activeEngines.length = 0;
});

describe("SyncEngine.shouldIgnore", () => {
	const engine = createEngine();

	test("ignores .obsidian/ paths", () => {
		expect(engine.shouldIgnore(".obsidian/config.json")).toBe(true);
		expect(engine.shouldIgnore(".obsidian/plugins/foo/main.js")).toBe(true);
	});

	test("ignores .trash/ paths", () => {
		expect(engine.shouldIgnore(".trash/old-note.md")).toBe(true);
	});

	test("ignores .git/ paths", () => {
		expect(engine.shouldIgnore(".git/HEAD")).toBe(true);
	});

	test("does not ignore normal paths", () => {
		expect(engine.shouldIgnore("Notes/Hello.md")).toBe(false);
		expect(engine.shouldIgnore("2. Knowledge Vault/Health/Omega.md")).toBe(false);
	});
});

describe("SyncEngine.isMarkdown", () => {
	const engine = createEngine();

	test("accepts .md files", () => {
		const file = new TFile("Notes/Test.md");
		expect(engine.isMarkdown(file)).toBe(true);
	});

	test("rejects non-md files", () => {
		const file = new TFile("image.png");
		expect(engine.isMarkdown(file)).toBe(false);
	});
});

describe("SyncEngine.handleModify", () => {
	test("debounces and pushes after delay", async () => {
		const engine = createEngine({ debounceMs: 50 });
		const file = new TFile("Notes/Test.md", Date.now());

		engine.handleModify(file);

		// Not pushed yet (debouncing)
		expect(mockApi.pushNote).not.toHaveBeenCalled();

		// Wait for debounce
		await new Promise((r) => setTimeout(r, 100));

		expect(mockApi.pushNote).toHaveBeenCalledWith(
			"Notes/Test.md",
			"# Test\n\nContent",
			expect.any(Number),
		);
	});

	test("ignores non-markdown files", async () => {
		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("image.png");

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 50));

		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});

	test("ignores .obsidian paths", async () => {
		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile(".obsidian/workspace.md");

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 50));

		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});

	test("coalesces rapid edits", async () => {
		const engine = createEngine({ debounceMs: 50 });
		const file = new TFile("Notes/Test.md", Date.now());

		// Fire 5 modify events in rapid succession
		engine.handleModify(file);
		engine.handleModify(file);
		engine.handleModify(file);
		engine.handleModify(file);
		engine.handleModify(file);

		await new Promise((r) => setTimeout(r, 150));

		// Should only push once
		expect(mockApi.pushNote).toHaveBeenCalledTimes(1);
	});
});

describe("SyncEngine.handleDelete", () => {
	test("calls API to delete note", async () => {
		const engine = createEngine();
		const file = new TFile("Notes/Old.md");

		await engine.handleDelete(file);

		expect(mockApi.deleteNote).toHaveBeenCalledWith("Notes/Old.md");
	});

	test("cancels pending push on delete", async () => {
		const engine = createEngine({ debounceMs: 200 });
		const file = new TFile("Notes/Test.md");

		engine.handleModify(file); // Start debounce
		await engine.handleDelete(file); // Delete should cancel

		await new Promise((r) => setTimeout(r, 300));

		// Push should NOT have been called
		expect(mockApi.pushNote).not.toHaveBeenCalled();
		expect(mockApi.deleteNote).toHaveBeenCalledWith("Notes/Test.md");
	});
});

describe("SyncEngine.handleRename", () => {
	test("deletes old path and pushes new path", async () => {
		const engine = createEngine();
		const file = new TFile("Notes/Renamed.md", Date.now());

		await engine.handleRename(file, "Notes/Original.md");

		expect(mockApi.deleteNote).toHaveBeenCalledWith("Notes/Original.md");
		expect(mockApi.pushNote).toHaveBeenCalledWith(
			"Notes/Renamed.md",
			expect.any(String),
			expect.any(Number),
		);
	});
});

describe("SyncEngine.pull", () => {
	test("applies remote changes and updates lastSync", async () => {
		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: "Notes/Remote.md",
					title: "Remote Note",
					content: "# Remote\n\nFrom MCP",
					folder: "Notes",
					tags: [],
					mtime: 1709345678,
					updated_at: "2026-03-01T12:00:00Z",
					deleted: false,
				},
			],
			server_time: "2026-03-01T12:00:01Z",
		});

		const pulled = await engine.pull();

		expect(pulled).toBe(1);
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			"Notes/Remote.md",
			"# Remote\n\nFrom MCP",
		);
		expect(engine.getLastSync()).toBe("2026-03-01T12:00:01Z");
	});

	test("trashes locally deleted notes from remote", async () => {
		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		const existingFile = new TFile("Notes/ToDelete.md");
		(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValueOnce(existingFile);

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: "Notes/ToDelete.md",
					title: "",
					content: "",
					folder: "",
					tags: [],
					mtime: 0,
					updated_at: "2026-03-01T12:00:00Z",
					deleted: true,
				},
			],
			server_time: "2026-03-01T12:00:01Z",
		});

		await engine.pull();

		expect(mockApp.vault.trash).toHaveBeenCalledWith(existingFile, true);
	});
});

describe("SyncEngine.handleStreamEvent", () => {
	test("upsert event fetches note and applies change", async () => {
		const engine = createEngine();

		(mockApi.getNote as jest.Mock).mockResolvedValueOnce({
			path: "Notes/SSE.md",
			title: "SSE Note",
			content: "# SSE\n\nCreated via MCP",
			folder: "Notes",
			tags: [],
			mtime: 1709345678,
			created_at: "2026-03-01T12:00:00Z",
			updated_at: "2026-03-01T12:00:00Z",
		});

		await engine.handleStreamEvent({
			event_type: "upsert",
			path: "Notes/SSE.md",
			timestamp: 1709345678,
		});

		expect(mockApi.getNote).toHaveBeenCalledWith("Notes/SSE.md");
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			"Notes/SSE.md",
			"# SSE\n\nCreated via MCP",
		);
	});

	test("delete event trashes local file", async () => {
		const engine = createEngine();
		const existingFile = new TFile("Notes/ToRemove.md");
		(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValueOnce(existingFile);

		await engine.handleStreamEvent({
			event_type: "delete",
			path: "Notes/ToRemove.md",
			timestamp: 1709345678,
		});

		expect(mockApp.vault.trash).toHaveBeenCalledWith(existingFile, true);
		expect(mockApi.getNote).not.toHaveBeenCalled();
	});

	test("ignores events for ignored paths", async () => {
		const engine = createEngine();

		await engine.handleStreamEvent({
			event_type: "upsert",
			path: ".obsidian/workspace.md",
			timestamp: 1709345678,
		});

		expect(mockApi.getNote).not.toHaveBeenCalled();
		expect(mockApp.vault.create).not.toHaveBeenCalled();
	});

	test("skips events for paths currently being pushed (echo suppression)", async () => {
		// Use a slow pushNote to keep the path in the pushing set
		(mockApi.pushNote as jest.Mock).mockImplementation(
			() => new Promise((r) => setTimeout(r, 500)),
		);

		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("Notes/Active.md", Date.now());

		// Trigger push (debounce fires after 10ms, pushFile starts)
		engine.handleModify(file);

		// Wait for debounce to fire but not for push to complete
		await new Promise((r) => setTimeout(r, 50));

		// Now the file is in the pushing set — SSE event should be suppressed
		await engine.handleStreamEvent({
			event_type: "upsert",
			path: "Notes/Active.md",
			timestamp: Date.now(),
		});

		// getNote should NOT have been called (echo suppression)
		expect(mockApi.getNote).not.toHaveBeenCalled();

		// Wait for push to finish
		await new Promise((r) => setTimeout(r, 500));

		// Clean up cooldown timers
		engine.destroy();
	}, 10000);

	test("suppresses SSE events after push completes (post-push cooldown)", async () => {
		// Fast push — completes quickly
		(mockApi.pushNote as jest.Mock).mockResolvedValue({ note: {}, chunks_indexed: 1 });

		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("Notes/Cooldown.md", Date.now());

		// Trigger push and wait for it to complete
		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 50));

		// Push is complete — path is no longer in pushing set
		// But should still be in recentlyPushed cooldown
		expect(engine.isRecentlyPushed("Notes/Cooldown.md")).toBe(true);

		// SSE event arriving after push should still be suppressed
		await engine.handleStreamEvent({
			event_type: "upsert",
			path: "Notes/Cooldown.md",
			timestamp: Date.now(),
		});

		// getNote should NOT have been called (cooldown suppression)
		expect(mockApi.getNote).not.toHaveBeenCalled();

		// Clean up cooldown timers
		engine.destroy();
	});
});

describe("SyncEngine.pull (fresh install)", () => {
	test("defaults to epoch when lastSync is empty (fresh install pull)", async () => {
		const engine = createEngine();
		// Do NOT call setLastSync — simulates a fresh install with no saved state

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: "Notes/Existing.md",
					title: "Existing Note",
					content: "# Existing\n\nAlready on server",
					folder: "Notes",
					tags: [],
					mtime: 1709345678,
					updated_at: "2026-03-01T12:00:00Z",
					deleted: false,
				},
			],
			server_time: "2026-03-02T00:00:00Z",
		});

		const pulled = await engine.pull();

		expect(pulled).toBe(1);
		// Should have called getChanges with epoch (the default for empty lastSync)
		expect(mockApi.getChanges).toHaveBeenCalledWith("1970-01-01T00:00:00Z");
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			"Notes/Existing.md",
			"# Existing\n\nAlready on server",
		);
	});

	test("fullSync on fresh engine pulls all notes without prior setLastSync", async () => {
		const engine = createEngine();
		// Fresh engine — no setLastSync, no prior sync state

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: "Notes/A.md",
					title: "Note A",
					content: "# A",
					folder: "Notes",
					tags: [],
					mtime: 1709340000,
					updated_at: "2026-03-01T10:00:00Z",
					deleted: false,
				},
				{
					path: "Notes/B.md",
					title: "Note B",
					content: "# B",
					folder: "Notes",
					tags: [],
					mtime: 1709341000,
					updated_at: "2026-03-01T11:00:00Z",
					deleted: false,
				},
			],
			server_time: "2026-03-02T00:00:00Z",
		});

		const result = await engine.fullSync();

		expect(result.pulled).toBe(2);
		expect(mockApi.getChanges).toHaveBeenCalledWith("1970-01-01T00:00:00Z");
		expect(mockApp.vault.create).toHaveBeenCalledTimes(2);
		// lastSync should be updated for future syncs
		expect(engine.getLastSync()).toBe("2026-03-02T00:00:00Z");
	});

	test("pull updates lastSync so subsequent pulls are incremental", async () => {
		const engine = createEngine();

		// First pull — fresh install
		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: "Notes/First.md",
					title: "First",
					content: "# First",
					folder: "Notes",
					tags: [],
					mtime: 1709340000,
					updated_at: "2026-03-01T10:00:00Z",
					deleted: false,
				},
			],
			server_time: "2026-03-01T12:00:00Z",
		});

		await engine.pull();
		expect(mockApi.getChanges).toHaveBeenCalledWith("1970-01-01T00:00:00Z");
		expect(engine.getLastSync()).toBe("2026-03-01T12:00:00Z");

		// Second pull — should use the saved timestamp, not epoch
		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-02T00:00:00Z",
		});

		await engine.pull();
		expect(mockApi.getChanges).toHaveBeenCalledWith("2026-03-01T12:00:00Z");
	});
});

describe("SyncEngine.destroy", () => {
	test("clears pending timers", () => {
		const engine = createEngine({ debounceMs: 10000 });
		const file = new TFile("Notes/Test.md");

		engine.handleModify(file);
		engine.destroy();

		// No errors, timers cleaned up
	});
});
