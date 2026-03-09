import {
	computeDiff,
	groupIntoHunks,
	buildMergedContent,
	DiffLine,
} from "../src/diff";

describe("computeDiff", () => {
	it("returns empty array for identical texts", () => {
		const result = computeDiff("hello\nworld", "hello\nworld");
		expect(result.every((l) => l.type === "equal")).toBe(true);
		expect(result.map((l) => l.content)).toEqual(["hello", "world"]);
	});

	it("detects a single added line", () => {
		const result = computeDiff("a\nc", "a\nb\nc");
		const types = result.map((l) => l.type);
		expect(types).toEqual(["equal", "add", "equal"]);
		expect(result[1].content).toBe("b");
		expect(result[1].newLineNo).toBe(2);
	});

	it("detects a single removed line", () => {
		const result = computeDiff("a\nb\nc", "a\nc");
		const types = result.map((l) => l.type);
		expect(types).toEqual(["equal", "remove", "equal"]);
		expect(result[1].content).toBe("b");
		expect(result[1].oldLineNo).toBe(2);
	});

	it("detects a modification (remove + add)", () => {
		const result = computeDiff("a\nold\nc", "a\nnew\nc");
		const types = result.map((l) => l.type);
		expect(types).toEqual(["equal", "remove", "add", "equal"]);
		expect(result[1].content).toBe("old");
		expect(result[2].content).toBe("new");
	});

	it("handles empty old text", () => {
		const result = computeDiff("", "a\nb");
		const types = result.map((l) => l.type);
		// Empty string splits to [""], so we get a remove of "" and adds
		expect(result.some((l) => l.type === "add")).toBe(true);
	});

	it("handles empty new text", () => {
		const result = computeDiff("a\nb", "");
		expect(result.some((l) => l.type === "remove")).toBe(true);
	});

	it("handles multi-line changes", () => {
		const old = "line1\nline2\nline3\nline4\nline5";
		const nw = "line1\nchanged2\nchanged3\nline4\nline5";
		const result = computeDiff(old, nw);
		const types = result.map((l) => l.type);
		expect(types).toEqual([
			"equal",
			"remove",
			"remove",
			"add",
			"add",
			"equal",
			"equal",
		]);
	});

	it("assigns correct line numbers", () => {
		const result = computeDiff("a\nb\nc", "a\nx\nc");
		// equal a (old:1, new:1), remove b (old:2), add x (new:2), equal c (old:3, new:3)
		expect(result[0]).toMatchObject({
			type: "equal",
			oldLineNo: 1,
			newLineNo: 1,
		});
		expect(result[1]).toMatchObject({ type: "remove", oldLineNo: 2 });
		expect(result[1].newLineNo).toBeUndefined();
		expect(result[2]).toMatchObject({ type: "add", newLineNo: 2 });
		expect(result[2].oldLineNo).toBeUndefined();
		expect(result[3]).toMatchObject({
			type: "equal",
			oldLineNo: 3,
			newLineNo: 3,
		});
	});
});

describe("groupIntoHunks", () => {
	it("returns empty array when no changes", () => {
		const lines: DiffLine[] = [
			{ type: "equal", content: "a", oldLineNo: 1, newLineNo: 1 },
			{ type: "equal", content: "b", oldLineNo: 2, newLineNo: 2 },
		];
		expect(groupIntoHunks(lines)).toEqual([]);
	});

	it("creates a single hunk with context", () => {
		const lines = computeDiff(
			"1\n2\n3\n4\n5\n6\n7\n8\n9",
			"1\n2\n3\n4\nX\n6\n7\n8\n9",
		);
		const hunks = groupIntoHunks(lines, 2);
		expect(hunks).toHaveLength(1);
		// Should include 2 context lines before and after the change
		expect(hunks[0].lines.length).toBeGreaterThanOrEqual(5); // 2 before + remove + add + 2 after
		expect(hunks[0].choice).toBe("remote");
	});

	it("merges overlapping hunks", () => {
		// Changes at line 3 and line 5 with context=2 should merge
		const lines = computeDiff(
			"1\n2\n3\n4\n5\n6\n7",
			"1\n2\nA\n4\nB\n6\n7",
		);
		const hunks = groupIntoHunks(lines, 2);
		expect(hunks).toHaveLength(1); // should merge since they're close
	});

	it("keeps separate hunks for distant changes", () => {
		// Changes far apart should produce 2 hunks
		const old = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join(
			"\n",
		);
		const lines = old.split("\n");
		lines[1] = "CHANGED2";
		lines[18] = "CHANGED19";
		const diff = computeDiff(old, lines.join("\n"));
		const hunks = groupIntoHunks(diff, 2);
		expect(hunks).toHaveLength(2);
	});

	it("assigns sequential IDs", () => {
		const old = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join(
			"\n",
		);
		const lines = old.split("\n");
		lines[1] = "A";
		lines[18] = "B";
		const diff = computeDiff(old, lines.join("\n"));
		const hunks = groupIntoHunks(diff, 2);
		expect(hunks.map((h) => h.id)).toEqual([0, 1]);
	});
});

describe("buildMergedContent", () => {
	it("produces remote version when all hunks choose remote", () => {
		const oldText = "a\nold\nc";
		const newText = "a\nnew\nc";
		const diff = computeDiff(oldText, newText);
		const hunks = groupIntoHunks(diff);
		// Default choice is "remote"
		const merged = buildMergedContent(diff, hunks);
		expect(merged).toBe(newText);
	});

	it("produces local version when all hunks choose local", () => {
		const oldText = "a\nold\nc";
		const newText = "a\nnew\nc";
		const diff = computeDiff(oldText, newText);
		const hunks = groupIntoHunks(diff);
		hunks.forEach((h) => (h.choice = "local"));
		const merged = buildMergedContent(diff, hunks);
		expect(merged).toBe(oldText);
	});

	it("merges per-hunk choices correctly", () => {
		// Two separate hunks, choose differently
		const old = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join(
			"\n",
		);
		const newLines = old.split("\n");
		newLines[1] = "REMOTE2";
		newLines[18] = "REMOTE19";
		const newText = newLines.join("\n");
		const diff = computeDiff(old, newText);
		const hunks = groupIntoHunks(diff, 2);

		expect(hunks).toHaveLength(2);
		hunks[0].choice = "local"; // keep old line2
		hunks[1].choice = "remote"; // take new line19

		const merged = buildMergedContent(diff, hunks);
		const mergedLines = merged.split("\n");
		expect(mergedLines[1]).toBe("line2"); // kept local
		expect(mergedLines[18]).toBe("REMOTE19"); // took remote
	});

	it("handles fully identical texts (no hunks)", () => {
		const text = "a\nb\nc";
		const diff = computeDiff(text, text);
		const hunks = groupIntoHunks(diff);
		const merged = buildMergedContent(diff, hunks);
		expect(merged).toBe(text);
	});
});
