import { TFile } from "obsidian";
import { SyncEngine } from "../src/sync";
import { EngramApi } from "../src/api";
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
	ping: jest.fn().mockResolvedValue({ ok: true }),
	pushAttachment: jest.fn().mockResolvedValue({ attachment: {} }),
	getAttachment: jest.fn().mockResolvedValue({
		path: "Assets/image.png",
		content_base64: "AQID",
		mime_type: "image/png",
		size_bytes: 3,
		mtime: 1709345678,
		created_at: "2026-03-01T12:00:00Z",
		updated_at: "2026-03-01T12:00:00Z",
	}),
	deleteAttachment: jest.fn().mockResolvedValue({ deleted: true, path: "" }),
	getAttachmentChanges: jest.fn().mockResolvedValue({ changes: [], server_time: "2026-01-01T00:00:00Z" }),
} as unknown as EngramApi;

// Mock the Obsidian App
const mockApp = {
	vault: {
		read: jest.fn().mockResolvedValue("# Test\n\nContent"),
		readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(3)),
		getMarkdownFiles: jest.fn().mockReturnValue([]),
		getFiles: jest.fn().mockReturnValue([]),
		getAbstractFileByPath: jest.fn().mockReturnValue(null),
		modify: jest.fn().mockResolvedValue(undefined),
		modifyBinary: jest.fn().mockResolvedValue(undefined),
		create: jest.fn().mockResolvedValue(undefined),
		createBinary: jest.fn().mockResolvedValue(undefined),
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

	test("hardcoded ignores cannot be overridden by clearing user patterns", () => {
		const emptyEngine = createEngine({ ignorePatterns: "" });
		expect(emptyEngine.shouldIgnore(".obsidian/config.json")).toBe(true);
		expect(emptyEngine.shouldIgnore(".trash/old-note.md")).toBe(true);
		expect(emptyEngine.shouldIgnore(".git/HEAD")).toBe(true);
	});

	test("user-defined patterns still work alongside hardcoded ignores", () => {
		const customEngine = createEngine({ ignorePatterns: "drafts/\nsecret.md" });
		// Hardcoded still work
		expect(customEngine.shouldIgnore(".obsidian/plugins/foo.js")).toBe(true);
		// User patterns also work
		expect(customEngine.shouldIgnore("drafts/wip.md")).toBe(true);
		expect(customEngine.shouldIgnore("secret.md")).toBe(true);
		// Normal files still pass
		expect(customEngine.shouldIgnore("Notes/Hello.md")).toBe(false);
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

describe("SyncEngine.isFirstSync", () => {
	test("returns true when no lastSync is set", () => {
		const engine = createEngine();
		expect(engine.isFirstSync()).toBe(true);
	});

	test("returns false after setLastSync", () => {
		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");
		expect(engine.isFirstSync()).toBe(false);
	});

	test("returns false after a pull sets lastSync", async () => {
		const engine = createEngine();

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-01T00:00:00Z",
		});

		await engine.pull();
		expect(engine.isFirstSync()).toBe(false);
	});
});

describe("SyncEngine.countSyncableFiles", () => {
	test("counts syncable files excluding ignored paths", () => {
		(mockApp.vault.getFiles as jest.Mock).mockReturnValueOnce([
			new TFile("Notes/A.md"),
			new TFile("Notes/B.md"),
			new TFile(".obsidian/plugins.md"),
			new TFile("Drafts/C.md"),
			new TFile("Assets/image.png"),
			new TFile("data.json"),
		]);

		const engine = createEngine({ ignorePatterns: "Drafts/" });
		// A.md, B.md, image.png — .obsidian hardcoded, Drafts/ user-defined, data.json not syncable
		expect(engine.countSyncableFiles()).toBe(3);
	});

	test("returns 0 for empty vault", () => {
		(mockApp.vault.getFiles as jest.Mock).mockReturnValueOnce([]);
		const engine = createEngine();
		expect(engine.countSyncableFiles()).toBe(0);
	});
});

describe("SyncEngine.getStatus + onStatusChange", () => {
	test("initial status is idle with no pending", () => {
		const engine = createEngine();
		const status = engine.getStatus();
		expect(status.state).toBe("idle");
		expect(status.pending).toBe(0);
		expect(status.lastSync).toBe("");
		expect(status.error).toBeUndefined();
	});

	test("status shows pending count during debounce", () => {
		const engine = createEngine({ debounceMs: 5000 });
		const file1 = new TFile("Notes/A.md");
		const file2 = new TFile("Notes/B.md");

		engine.handleModify(file1);
		engine.handleModify(file2);

		const status = engine.getStatus();
		expect(status.pending).toBe(2);
	});

	test("onStatusChange fires when modify queues a file", () => {
		const engine = createEngine({ debounceMs: 5000 });
		const statuses: string[] = [];
		engine.onStatusChange = (s) => statuses.push(s.state);

		engine.handleModify(new TFile("Notes/A.md"));

		expect(statuses.length).toBeGreaterThanOrEqual(1);
	});

	test("status shows syncing during pull", async () => {
		// Use a slow getChanges to catch the syncing state
		let resolveChanges: (v: any) => void;
		(mockApi.getChanges as jest.Mock).mockImplementationOnce(
			() => new Promise((r) => { resolveChanges = r; }),
		);

		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		const statuses: string[] = [];
		engine.onStatusChange = (s) => statuses.push(s.state);

		const pullPromise = engine.pull();

		// Should have emitted syncing
		expect(statuses).toContain("syncing");

		// Resolve the pull
		resolveChanges!({ changes: [], server_time: "2026-03-01T00:00:00Z" });
		await pullPromise;

		// Last emitted status should be idle
		expect(statuses[statuses.length - 1]).toBe("idle");
	});

	test("status shows error after failed pull", async () => {
		(mockApi.getChanges as jest.Mock).mockRejectedValueOnce(new Error("network error"));

		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		await engine.pull();

		const status = engine.getStatus();
		expect(status.state).toBe("error");
		expect(status.error).toBe("Pull failed: network error");
	});

	test("status shows offline after failed push (change queued for retry)", async () => {
		(mockApi.pushNote as jest.Mock).mockRejectedValueOnce(new Error("500"));

		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("Notes/Fail.md", Date.now());

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 100));

		const status = engine.getStatus();
		expect(status.state).toBe("offline");
		expect(status.queued).toBe(1);
	});

	test("error clears on next successful sync", async () => {
		(mockApi.getChanges as jest.Mock).mockRejectedValueOnce(new Error("fail"));

		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		await engine.pull();
		expect(engine.getStatus().state).toBe("error");

		// Successful pull clears error
		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-01T00:00:00Z",
		});

		await engine.pull();
		expect(engine.getStatus().state).toBe("idle");
		expect(engine.getStatus().error).toBeUndefined();
	});
});

describe("SyncEngine conflict resolution", () => {
	const makeChange = (overrides = {}): any => ({
		path: "Notes/Conflict.md",
		title: "Conflict Note",
		content: "# Remote version",
		folder: "Notes",
		tags: [],
		mtime: 1709345700,
		updated_at: "2026-03-01T12:00:00Z",
		deleted: false,
		...overrides,
	});

	// Use timestamps where lastSync < localMtime < remoteMtime
	// lastSync "2024-01-01T00:00:00Z" = 1704067200s
	// localMtime  = 1709345000s (March 2024, after lastSync)
	// remoteMtime = 1709345700s (March 2024, after lastSync)
	const LAST_SYNC = "2024-01-01T00:00:00Z";
	const LOCAL_MTIME_MS = 1709345000 * 1000;
	const REMOTE_MTIME = 1709345700;

	test("detects conflict when both local and remote changed since lastSync", async () => {
		const engine = createEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.read as jest.Mock).mockResolvedValueOnce("# Local version");

		let conflictReceived: any = null;
		engine.onConflict = async (info) => {
			conflictReceived = info;
			return "keep-remote";
		};

		await engine.applyChange(makeChange({ mtime: REMOTE_MTIME }));

		expect(conflictReceived).not.toBeNull();
		expect(conflictReceived.path).toBe("Notes/Conflict.md");
		expect(conflictReceived.localContent).toBe("# Local version");
		expect(conflictReceived.remoteContent).toBe("# Remote version");
	});

	test("no conflict when only remote changed (local unchanged since lastSync)", async () => {
		const engine = createEngine();
		// Set lastSync AFTER local mtime so local is "unchanged"
		engine.setLastSync("2024-04-01T00:00:00Z"); // 1711929600s, after localMtime

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS); // before this lastSync
		(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValueOnce(localFile);

		let conflictCalled = false;
		engine.onConflict = async () => {
			conflictCalled = true;
			return "keep-remote";
		};

		await engine.applyChange(makeChange({ mtime: 1711930000 })); // after this lastSync

		expect(conflictCalled).toBe(false);
		expect(mockApp.vault.modify).toHaveBeenCalled();
	});

	test("no conflict when content is identical", async () => {
		const engine = createEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.read as jest.Mock).mockResolvedValueOnce("# Same content");

		let conflictCalled = false;
		engine.onConflict = async () => {
			conflictCalled = true;
			return "keep-remote";
		};

		await engine.applyChange(makeChange({ content: "# Same content", mtime: REMOTE_MTIME }));

		expect(conflictCalled).toBe(false);
	});

	test("keep-local pushes local version to server", async () => {
		const engine = createEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		// Return file for both applyChange lookup and pushFile's internal check
		(mockApp.vault.getAbstractFileByPath as jest.Mock)
			.mockReturnValueOnce(localFile)  // applyChange lookup
			.mockReturnValueOnce(localFile); // pushFile doesn't call this, but be safe
		// vault.read called twice: once for conflict detection, once for pushFile
		(mockApp.vault.read as jest.Mock)
			.mockResolvedValueOnce("# Local version")
			.mockResolvedValueOnce("# Local version");

		engine.onConflict = async () => "keep-local";

		await engine.applyChange(makeChange({ mtime: REMOTE_MTIME }));

		// Should push local, not modify local file with remote
		expect(mockApi.pushNote).toHaveBeenCalledWith(
			"Notes/Conflict.md",
			"# Local version",
			expect.any(Number),
		);
		expect(mockApp.vault.modify).not.toHaveBeenCalled();
	});

	test("keep-remote overwrites local with remote content", async () => {
		const engine = createEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.read as jest.Mock).mockResolvedValueOnce("# Local version");

		engine.onConflict = async () => "keep-remote";

		await engine.applyChange(makeChange({ mtime: REMOTE_MTIME }));

		expect(mockApp.vault.modify).toHaveBeenCalledWith(localFile, "# Remote version");
	});

	test("keep-both creates a conflict copy and keeps local", async () => {
		const engine = createEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.read as jest.Mock).mockResolvedValueOnce("# Local version");

		engine.onConflict = async () => "keep-both";

		await engine.applyChange(makeChange({ mtime: REMOTE_MTIME }));

		// Local should NOT be modified
		expect(mockApp.vault.modify).not.toHaveBeenCalled();
		// A conflict copy should be created
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			expect.stringMatching(/^Notes\/Conflict \(conflict \d{4}-\d{2}-\d{2}\)\.md$/),
			"# Remote version",
		);
	});

	test("skip does nothing", async () => {
		const engine = createEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.read as jest.Mock).mockResolvedValueOnce("# Local version");

		engine.onConflict = async () => "skip";

		await engine.applyChange(makeChange({ mtime: REMOTE_MTIME }));

		expect(mockApp.vault.modify).not.toHaveBeenCalled();
		expect(mockApp.vault.create).not.toHaveBeenCalled();
		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});

	test("defaults to keep-remote when no onConflict handler set", async () => {
		const engine = createEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValueOnce(localFile);
		(mockApp.vault.read as jest.Mock).mockResolvedValueOnce("# Local version");

		// No onConflict handler — should default to keep-remote
		await engine.applyChange(makeChange({ mtime: REMOTE_MTIME }));

		expect(mockApp.vault.modify).toHaveBeenCalledWith(localFile, "# Remote version");
	});

	test("deleted remote change does not trigger conflict", async () => {
		const engine = createEngine();
		engine.setLastSync(LAST_SYNC);

		const localFile = new TFile("Notes/Conflict.md", LOCAL_MTIME_MS);
		(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValueOnce(localFile);

		let conflictCalled = false;
		engine.onConflict = async () => {
			conflictCalled = true;
			return "keep-remote";
		};

		await engine.applyChange(makeChange({ deleted: true, mtime: REMOTE_MTIME }));

		expect(conflictCalled).toBe(false);
		expect(mockApp.vault.trash).toHaveBeenCalled();
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

describe("OfflineQueue", () => {
	const { OfflineQueue } = require("../src/offline-queue");

	test("enqueue and dequeue", async () => {
		const queue = new OfflineQueue();
		await queue.enqueue({ path: "Notes/A.md", action: "upsert", content: "# A", mtime: 100, timestamp: 1 });
		expect(queue.size).toBe(1);

		await queue.dequeue("Notes/A.md");
		expect(queue.size).toBe(0);
	});

	test("deduplicates by path (newer replaces older)", async () => {
		const queue = new OfflineQueue();
		await queue.enqueue({ path: "Notes/A.md", action: "upsert", content: "v1", mtime: 100, timestamp: 1 });
		await queue.enqueue({ path: "Notes/A.md", action: "upsert", content: "v2", mtime: 200, timestamp: 2 });

		expect(queue.size).toBe(1);
		expect(queue.all()[0].content).toBe("v2");
	});

	test("all() returns entries sorted by timestamp", async () => {
		const queue = new OfflineQueue();
		await queue.enqueue({ path: "Notes/C.md", action: "upsert", content: "C", mtime: 300, timestamp: 3 });
		await queue.enqueue({ path: "Notes/A.md", action: "upsert", content: "A", mtime: 100, timestamp: 1 });
		await queue.enqueue({ path: "Notes/B.md", action: "delete", timestamp: 2 });

		const entries = queue.all();
		expect(entries.map((e: any) => e.path)).toEqual(["Notes/A.md", "Notes/B.md", "Notes/C.md"]);
	});

	test("load restores persisted entries", () => {
		const queue = new OfflineQueue();
		queue.load([
			{ path: "Notes/X.md", action: "upsert", content: "X", mtime: 100, timestamp: 1 },
			{ path: "Notes/Y.md", action: "delete", timestamp: 2 },
		]);

		expect(queue.size).toBe(2);
	});

	test("clear removes all entries", async () => {
		const queue = new OfflineQueue();
		await queue.enqueue({ path: "Notes/A.md", action: "upsert", content: "A", mtime: 100, timestamp: 1 });
		await queue.clear();
		expect(queue.size).toBe(0);
	});

	test("onPersist callback fires on enqueue/dequeue/clear", async () => {
		const queue = new OfflineQueue();
		const persisted: any[] = [];
		queue.onPersist(async (entries: any) => { persisted.push([...entries]); });

		await queue.enqueue({ path: "Notes/A.md", action: "upsert", content: "A", mtime: 100, timestamp: 1 });
		expect(persisted.length).toBe(1);

		await queue.dequeue("Notes/A.md");
		expect(persisted.length).toBe(2);
		expect(persisted[1]).toEqual([]);

		await queue.enqueue({ path: "Notes/B.md", action: "delete", timestamp: 2 });
		await queue.clear();
		expect(persisted.length).toBe(4);
		expect(persisted[3]).toEqual([]);
	});
});

describe("SyncEngine offline queue integration", () => {
	test("failed push queues the change and goes offline", async () => {
		(mockApi.pushNote as jest.Mock).mockRejectedValueOnce(new Error("network"));

		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("Notes/Offline.md", Date.now());

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 100));

		expect(engine.isOffline()).toBe(true);
		expect(engine.queue.size).toBe(1);
		const entry = engine.queue.all()[0];
		expect(entry.path).toBe("Notes/Offline.md");
		expect(entry.action).toBe("upsert");
		expect(entry.content).toBe("# Test\n\nContent");
	});

	test("failed delete queues the delete and goes offline", async () => {
		(mockApi.deleteNote as jest.Mock).mockRejectedValueOnce(new Error("network"));

		const engine = createEngine();
		const file = new TFile("Notes/Deleted.md");

		await engine.handleDelete(file);

		expect(engine.isOffline()).toBe(true);
		expect(engine.queue.size).toBe(1);
		const entry = engine.queue.all()[0];
		expect(entry.path).toBe("Notes/Deleted.md");
		expect(entry.action).toBe("delete");
	});

	test("successful push after offline goes back online", async () => {
		// First push fails
		(mockApi.pushNote as jest.Mock).mockRejectedValueOnce(new Error("network"));

		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("Notes/Recovery.md", Date.now());

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 100));
		expect(engine.isOffline()).toBe(true);

		// Next push succeeds — also mock pushNote for queue flush
		(mockApi.pushNote as jest.Mock).mockResolvedValue({ note: {}, chunks_indexed: 1 });

		const file2 = new TFile("Notes/Online.md", Date.now());
		engine.handleModify(file2);
		await new Promise((r) => setTimeout(r, 200));

		expect(engine.isOffline()).toBe(false);
	});

	test("flushQueue processes entries oldest-first", async () => {
		const engine = createEngine();

		// Pre-load queue
		engine.queue.load([
			{ path: "Notes/A.md", action: "upsert", content: "A", mtime: 100, timestamp: 1 },
			{ path: "Notes/B.md", action: "delete", timestamp: 2 },
			{ path: "Notes/C.md", action: "upsert", content: "C", mtime: 300, timestamp: 3 },
		]);

		(mockApi.pushNote as jest.Mock).mockResolvedValue({ note: {}, chunks_indexed: 1 });
		(mockApi.deleteNote as jest.Mock).mockResolvedValue({ deleted: true, path: "" });

		const flushed = await engine.flushQueue();

		expect(flushed).toBe(3);
		expect(engine.queue.size).toBe(0);

		// Verify order: A (upsert), B (delete), C (upsert)
		expect(mockApi.pushNote).toHaveBeenCalledWith("Notes/A.md", "A", 100);
		expect(mockApi.deleteNote).toHaveBeenCalledWith("Notes/B.md");
		expect(mockApi.pushNote).toHaveBeenCalledWith("Notes/C.md", "C", 300);
	});

	test("flushQueue stops on failure and goes offline", async () => {
		const engine = createEngine();

		engine.queue.load([
			{ path: "Notes/A.md", action: "upsert", content: "A", mtime: 100, timestamp: 1 },
			{ path: "Notes/B.md", action: "upsert", content: "B", mtime: 200, timestamp: 2 },
		]);

		// First succeeds, second fails
		(mockApi.pushNote as jest.Mock)
			.mockResolvedValueOnce({ note: {}, chunks_indexed: 1 })
			.mockRejectedValueOnce(new Error("network"));

		const flushed = await engine.flushQueue();

		expect(flushed).toBe(1);
		expect(engine.queue.size).toBe(1); // B still queued
		expect(engine.isOffline()).toBe(true);
	});

	test("queue status reflected in getStatus", async () => {
		const engine = createEngine();

		expect(engine.getStatus().queued).toBe(0);

		engine.queue.load([
			{ path: "Notes/A.md", action: "upsert", content: "A", mtime: 100, timestamp: 1 },
		]);

		expect(engine.getStatus().queued).toBe(1);
	});

	test("flushQueue handles attachment entries", async () => {
		const engine = createEngine();

		engine.queue.load([
			{ path: "Assets/img.png", action: "upsert", contentBase64: "AQID", mimeType: "image/png", mtime: 100, kind: "attachment", timestamp: 1 },
			{ path: "Assets/old.pdf", action: "delete", kind: "attachment", timestamp: 2 },
		]);

		(mockApi.pushAttachment as jest.Mock).mockResolvedValue({ attachment: {} });
		(mockApi.deleteAttachment as jest.Mock).mockResolvedValue({ deleted: true, path: "" });

		const flushed = await engine.flushQueue();

		expect(flushed).toBe(2);
		expect(mockApi.pushAttachment).toHaveBeenCalledWith("Assets/img.png", "AQID", "image/png", 100);
		expect(mockApi.deleteAttachment).toHaveBeenCalledWith("Assets/old.pdf");
	});
});

describe("SyncEngine.isSyncable / isBinaryFile", () => {
	const engine = createEngine();

	test("markdown files are syncable but not binary", () => {
		const file = new TFile("Notes/Test.md");
		expect(engine.isSyncable(file)).toBe(true);
		expect(engine.isBinaryFile(file)).toBe(false);
	});

	test("canvas files are syncable but not binary", () => {
		const file = new TFile("Canvases/board.canvas");
		expect(engine.isSyncable(file)).toBe(true);
		expect(engine.isBinaryFile(file)).toBe(false);
	});

	test("PNG files are syncable and binary", () => {
		const file = new TFile("Assets/image.png");
		expect(engine.isSyncable(file)).toBe(true);
		expect(engine.isBinaryFile(file)).toBe(true);
	});

	test("PDF files are syncable and binary", () => {
		const file = new TFile("docs/manual.pdf");
		expect(engine.isSyncable(file)).toBe(true);
		expect(engine.isBinaryFile(file)).toBe(true);
	});

	test("JPG files are syncable and binary", () => {
		const file = new TFile("photos/vacation.jpg");
		expect(engine.isSyncable(file)).toBe(true);
		expect(engine.isBinaryFile(file)).toBe(true);
	});

	test("unsupported extensions are not syncable", () => {
		expect(engine.isSyncable(new TFile("data.json"))).toBe(false);
		expect(engine.isSyncable(new TFile("script.js"))).toBe(false);
		expect(engine.isSyncable(new TFile("style.css"))).toBe(false);
	});
});

describe("SyncEngine binary push", () => {
	test("binary file push calls readBinary + pushAttachment", async () => {
		const mockBuffer = new ArrayBuffer(3);
		new Uint8Array(mockBuffer).set([1, 2, 3]);
		(mockApp.vault.readBinary as jest.Mock).mockResolvedValueOnce(mockBuffer);
		(mockApi.pushAttachment as jest.Mock).mockResolvedValue({ attachment: {} });

		const engine = createEngine({ debounceMs: 10 });
		const file = new TFile("Assets/photo.png", Date.now());

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 100));

		expect(mockApp.vault.readBinary).toHaveBeenCalled();
		expect(mockApi.pushAttachment).toHaveBeenCalledWith(
			"Assets/photo.png",
			expect.any(String),
			"image/png",
			expect.any(Number),
		);
		// Should NOT call pushNote for binary
		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});

	test("binary file exceeding size limit is skipped", async () => {
		// Create a buffer larger than default 5MB
		const bigBuffer = new ArrayBuffer(6 * 1024 * 1024);
		(mockApp.vault.readBinary as jest.Mock).mockResolvedValueOnce(bigBuffer);

		const engine = createEngine({ debounceMs: 10, maxFileSizeMB: 5 });
		const file = new TFile("Assets/huge.png", Date.now());

		engine.handleModify(file);
		await new Promise((r) => setTimeout(r, 100));

		expect(mockApi.pushAttachment).not.toHaveBeenCalled();
		expect(engine.getStatus().error).toContain("too large");
	});

	test("binary file delete calls deleteAttachment", async () => {
		const engine = createEngine();
		const file = new TFile("Assets/old.png");

		await engine.handleDelete(file);

		expect(mockApi.deleteAttachment).toHaveBeenCalledWith("Assets/old.png");
		expect(mockApi.deleteNote).not.toHaveBeenCalled();
	});
});

describe("SyncEngine pull with attachments", () => {
	test("pull fetches both note and attachment changes", async () => {
		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{ path: "Notes/A.md", title: "A", content: "# A", folder: "Notes", tags: [], mtime: 100, updated_at: "2026-03-01T12:00:00Z", deleted: false },
			],
			server_time: "2026-03-01T12:00:01Z",
		});
		(mockApi.getAttachmentChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{ path: "Assets/img.png", mime_type: "image/png", size_bytes: 1000, mtime: 100, updated_at: "2026-03-01T12:00:00Z", deleted: false },
			],
			server_time: "2026-03-01T12:00:00Z",
		});
		// Mock getAttachment for the attachment pull
		(mockApi.getAttachment as jest.Mock).mockResolvedValueOnce({
			path: "Assets/img.png",
			content_base64: "AQID",
			mime_type: "image/png",
			size_bytes: 3,
			mtime: 100,
			updated_at: "2026-03-01T12:00:00Z",
		});

		const pulled = await engine.pull();

		expect(pulled).toBe(2);
		expect(mockApi.getChanges).toHaveBeenCalled();
		expect(mockApi.getAttachmentChanges).toHaveBeenCalled();
		expect(mockApp.vault.create).toHaveBeenCalled(); // note
		expect(mockApp.vault.createBinary).toHaveBeenCalled(); // attachment
	});
});

describe("SyncEngine pull accuracy", () => {
	test("updates existing file even when remote mtime < local mtime", async () => {
		const engine = createEngine();
		engine.setLastSync("2024-04-01T00:00:00Z"); // lastSync after localMtime → no conflict

		// Local file has a LATER mtime than remote (simulates Obsidian setting mtime to "now")
		const localFile = new TFile("Notes/Existing.md", Date.now());
		(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValueOnce(localFile);

		const result = await engine.applyChange({
			path: "Notes/Existing.md",
			title: "Existing",
			content: "# Updated remotely",
			folder: "Notes",
			tags: [],
			mtime: 1709345678, // older than local
			updated_at: "2026-03-01T12:00:00Z",
			deleted: false,
		});

		expect(result).toBe(true);
		expect(mockApp.vault.modify).toHaveBeenCalledWith(localFile, "# Updated remotely");
	});

	test("pull returns accurate count when changes are skipped", async () => {
		const engine = createEngine();
		engine.setLastSync("2026-01-01T00:00:00Z");

		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [
				{
					path: ".obsidian/workspace.json", // ignored path
					title: "",
					content: "{}",
					folder: ".obsidian",
					tags: [],
					mtime: 100,
					updated_at: "2026-03-01T12:00:00Z",
					deleted: false,
				},
			],
			server_time: "2026-03-01T12:00:01Z",
		});
		(mockApi.getAttachmentChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-01T12:00:00Z",
		});

		const pulled = await engine.pull();

		expect(pulled).toBe(0); // ignored path should not count
	});

	test("fullSync pushes files modified between old and new lastSync", async () => {
		const engine = createEngine();
		const oldSync = "2026-01-01T00:00:00Z";
		engine.setLastSync(oldSync);

		// Pull will update lastSync to a newer server_time
		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-01T12:00:00Z",
		});
		(mockApi.getAttachmentChanges as jest.Mock).mockResolvedValueOnce({
			changes: [],
			server_time: "2026-03-01T12:00:00Z",
		});

		// A file modified between old lastSync and new server_time
		const modifiedFile = new TFile("Notes/Modified.md", new Date("2026-02-15T00:00:00Z").getTime());
		(mockApp.vault.getFiles as jest.Mock).mockReturnValueOnce([modifiedFile]);

		await engine.fullSync();

		// pushModifiedFiles should use the OLD lastSync (prePullSync), not the new one
		// The file was modified at Feb 15, which is after Jan 1 (old lastSync)
		expect(mockApi.pushNote).toHaveBeenCalledWith(
			"Notes/Modified.md",
			expect.any(String),
			expect.any(Number),
		);
	});

	test("applyAttachmentChange updates binary regardless of mtime", async () => {
		const engine = createEngine();
		engine.setLastSync("2024-04-01T00:00:00Z");

		// Local file has LATER mtime than remote
		const localFile = new TFile("Assets/image.png", Date.now());
		(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValueOnce(localFile);

		const result = await engine.applyAttachmentChange({
			path: "Assets/image.png",
			mime_type: "image/png",
			size_bytes: 3,
			mtime: 1709345678, // older than local
			updated_at: "2026-03-01T12:00:00Z",
			deleted: false,
		}, "AQID");

		expect(result).toBe(true);
		expect(mockApp.vault.modifyBinary).toHaveBeenCalledWith(localFile, expect.any(ArrayBuffer));
	});
});

describe("SyncEngine SSE with kind routing", () => {
	test("SSE event with kind=attachment calls getAttachment", async () => {
		const engine = createEngine();

		(mockApi.getAttachment as jest.Mock).mockResolvedValueOnce({
			path: "Assets/remote.png",
			content_base64: "AQID",
			mime_type: "image/png",
			size_bytes: 3,
			mtime: 1709345678,
			updated_at: "2026-03-01T12:00:00Z",
		});

		await engine.handleStreamEvent({
			event_type: "upsert",
			path: "Assets/remote.png",
			timestamp: 1709345678,
			kind: "attachment",
		});

		expect(mockApi.getAttachment).toHaveBeenCalledWith("Assets/remote.png");
		expect(mockApi.getNote).not.toHaveBeenCalled();
		expect(mockApp.vault.createBinary).toHaveBeenCalled();
	});

	test("SSE event with kind=note (or no kind) calls getNote", async () => {
		const engine = createEngine();

		(mockApi.getNote as jest.Mock).mockResolvedValueOnce({
			path: "Notes/SSE.md",
			title: "SSE Note",
			content: "# SSE",
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
			// no kind field — should default to note behavior
		});

		expect(mockApi.getNote).toHaveBeenCalledWith("Notes/SSE.md");
		expect(mockApi.getAttachment).not.toHaveBeenCalled();
	});

	test("SSE delete with kind=attachment trashes local file", async () => {
		const engine = createEngine();
		const existingFile = new TFile("Assets/deleted.png");
		(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValueOnce(existingFile);

		await engine.handleStreamEvent({
			event_type: "delete",
			path: "Assets/deleted.png",
			timestamp: 1709345678,
			kind: "attachment",
		});

		expect(mockApp.vault.trash).toHaveBeenCalledWith(existingFile, true);
	});
});

describe("SyncEngine auth validation", () => {
	test("fullSync throws on invalid API key", async () => {
		(mockApi.ping as jest.Mock).mockResolvedValueOnce({ ok: false, error: "Invalid API key" });
		const engine = createEngine();

		await expect(engine.fullSync()).rejects.toThrow("Invalid API key");
		expect(mockApi.getChanges).not.toHaveBeenCalled();
		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});

	test("fullSync throws on connection failure", async () => {
		(mockApi.ping as jest.Mock).mockResolvedValueOnce({ ok: false, error: "Connection failed" });
		const engine = createEngine();

		await expect(engine.fullSync()).rejects.toThrow("Connection failed");
	});

	test("fullSync proceeds when auth succeeds", async () => {
		(mockApi.ping as jest.Mock).mockResolvedValueOnce({ ok: true });
		(mockApi.getChanges as jest.Mock).mockResolvedValueOnce({ changes: [], server_time: "2026-03-01T00:00:00Z" });
		(mockApi.getAttachmentChanges as jest.Mock).mockResolvedValueOnce({ changes: [], server_time: "2026-03-01T00:00:00Z" });
		const engine = createEngine();

		const result = await engine.fullSync();
		expect(result).toEqual({ pulled: 0, pushed: 0 });
		expect(mockApi.getChanges).toHaveBeenCalled();
	});

	test("pushAll throws on invalid API key", async () => {
		(mockApi.ping as jest.Mock).mockResolvedValueOnce({ ok: false, error: "Invalid API key" });
		const engine = createEngine();

		await expect(engine.pushAll()).rejects.toThrow("Invalid API key");
		expect(mockApi.pushNote).not.toHaveBeenCalled();
	});

	test("pushFile returns false on failure", async () => {
		const engine = createEngine();
		(mockApi.pushNote as jest.Mock).mockRejectedValueOnce(new Error("401"));

		const file = new TFile("Notes/Test.md");
		(mockApp.vault.read as jest.Mock).mockResolvedValueOnce("content");
		(mockApp.vault.read as jest.Mock).mockResolvedValueOnce("content");

		// Access private method via any cast
		const result = await (engine as any).pushFile(file);
		expect(result).toBe(false);
	});
});
