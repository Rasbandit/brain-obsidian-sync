/**
 * Line-level diff engine for conflict resolution.
 *
 * Implements Myers' O(ND) diff algorithm to produce minimal edit scripts,
 * then groups changes into hunks with configurable context lines.
 */

export type DiffLineType = "equal" | "add" | "remove";

export interface DiffLine {
	type: DiffLineType;
	content: string;
	/** 1-based line number in the old (local) text. Undefined for 'add' lines. */
	oldLineNo?: number;
	/** 1-based line number in the new (remote) text. Undefined for 'remove' lines. */
	newLineNo?: number;
}

export interface DiffHunk {
	/** Stable identifier for this hunk (index in the hunk array). */
	id: number;
	/** All lines in this hunk, including surrounding context. */
	lines: DiffLine[];
	/** Which version to use for changed lines in this hunk. */
	choice: "local" | "remote";
}

/**
 * Compute a line-level diff between two texts using Myers' algorithm.
 *
 * @param oldText - The "old" (local) version
 * @param newText - The "new" (remote) version
 * @returns Array of DiffLine entries describing the transformation
 */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const editScript = myersDiff(oldLines, newLines);
	return editScript;
}

/**
 * Myers' O(ND) diff algorithm.
 * Returns a sequence of equal/add/remove operations with line numbers.
 */
function myersDiff(a: string[], b: string[]): DiffLine[] {
	const n = a.length;
	const m = b.length;
	const max = n + m;

	// V stores the furthest-reaching x for each k-diagonal.
	// Indexed by k + max to avoid negative indices.
	const v = new Int32Array(2 * max + 1);
	v.fill(-1);
	v[max + 1] = 0;

	// Trace stores V snapshots for backtracking.
	const trace: Int32Array[] = [];

	outer: for (let d = 0; d <= max; d++) {
		const vCopy = new Int32Array(v);
		trace.push(vCopy);

		for (let k = -d; k <= d; k += 2) {
			const idx = k + max;
			let x: number;

			if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
				x = v[idx + 1]; // move down (insert)
			} else {
				x = v[idx - 1] + 1; // move right (delete)
			}

			let y = x - k;

			// Follow diagonal (equal lines)
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}

			v[idx] = x;

			if (x >= n && y >= m) {
				break outer;
			}
		}
	}

	// Backtrack to build the edit script
	return backtrack(trace, a, b, max);
}

function backtrack(
	trace: Int32Array[],
	a: string[],
	b: string[],
	max: number,
): DiffLine[] {
	let x = a.length;
	let y = b.length;
	const ops: DiffLine[] = [];

	for (let d = trace.length - 1; d >= 0; d--) {
		const v = trace[d];
		const k = x - y;
		const idx = k + max;

		let prevK: number;
		if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
			prevK = k + 1; // came from insert (down)
		} else {
			prevK = k - 1; // came from delete (right)
		}

		const prevX = v[prevK + max];
		const prevY = prevX - prevK;

		// Emit diagonal (equal) lines
		while (x > prevX && y > prevY) {
			x--;
			y--;
			ops.push({
				type: "equal",
				content: a[x],
				oldLineNo: x + 1,
				newLineNo: y + 1,
			});
		}

		if (d > 0) {
			if (x === prevX) {
				// Insert: line from b
				y--;
				ops.push({
					type: "add",
					content: b[y],
					newLineNo: y + 1,
				});
			} else {
				// Delete: line from a
				x--;
				ops.push({
					type: "remove",
					content: a[x],
					oldLineNo: x + 1,
				});
			}
		}
	}

	ops.reverse();
	return ops;
}

/**
 * Group a flat diff into hunks.
 *
 * Each hunk contains the changed lines plus surrounding context lines.
 * Hunks that overlap or are separated by fewer than 2×context lines are merged.
 *
 * @param diffLines - Output from computeDiff()
 * @param contextLines - Number of context lines around each change (default: 3)
 */
export function groupIntoHunks(
	diffLines: DiffLine[],
	contextLines = 3,
): DiffHunk[] {
	if (diffLines.length === 0) return [];

	// Find ranges of changed lines
	const changeIndices: number[] = [];
	for (let i = 0; i < diffLines.length; i++) {
		if (diffLines[i].type !== "equal") {
			changeIndices.push(i);
		}
	}

	if (changeIndices.length === 0) return [];

	// Build raw hunk ranges [start, end] inclusive
	const ranges: Array<[number, number]> = [];
	let rangeStart = Math.max(0, changeIndices[0] - contextLines);
	let rangeEnd = Math.min(
		diffLines.length - 1,
		changeIndices[0] + contextLines,
	);

	for (let i = 1; i < changeIndices.length; i++) {
		const newStart = Math.max(0, changeIndices[i] - contextLines);
		const newEnd = Math.min(
			diffLines.length - 1,
			changeIndices[i] + contextLines,
		);

		if (newStart <= rangeEnd + 1) {
			// Merge overlapping/adjacent ranges
			rangeEnd = newEnd;
		} else {
			ranges.push([rangeStart, rangeEnd]);
			rangeStart = newStart;
			rangeEnd = newEnd;
		}
	}
	ranges.push([rangeStart, rangeEnd]);

	return ranges.map(([start, end], id) => ({
		id,
		lines: diffLines.slice(start, end + 1),
		choice: "remote" as const,
	}));
}

/**
 * Build the merged content string from hunks and their choices.
 *
 * For equal lines, always emit them.
 * For changed lines within a hunk:
 *   - choice "local"  → emit 'remove' lines (the old/local text)
 *   - choice "remote" → emit 'add' lines (the new/remote text)
 *
 * Lines outside any hunk (equal lines between hunks) are also emitted.
 *
 * @param allDiffLines - The complete flat diff (from computeDiff)
 * @param hunks - Hunks with choices set
 */
export function buildMergedContent(
	allDiffLines: DiffLine[],
	hunks: DiffHunk[],
): string {
	// Build a map of diff-line-index → hunk for changed lines
	// We need to know which hunk each changed line belongs to.
	// Since hunks contain slices of allDiffLines, we match by reference position.

	// First, find each hunk's start index in allDiffLines
	const hunkRanges: Array<{
		start: number;
		end: number;
		choice: "local" | "remote";
	}> = [];

	let searchFrom = 0;
	for (const hunk of hunks) {
		// Find where this hunk's first line appears in allDiffLines
		const firstLine = hunk.lines[0];
		for (let i = searchFrom; i < allDiffLines.length; i++) {
			if (
				allDiffLines[i].type === firstLine.type &&
				allDiffLines[i].content === firstLine.content &&
				allDiffLines[i].oldLineNo === firstLine.oldLineNo &&
				allDiffLines[i].newLineNo === firstLine.newLineNo
			) {
				hunkRanges.push({
					start: i,
					end: i + hunk.lines.length - 1,
					choice: hunk.choice,
				});
				searchFrom = i + hunk.lines.length;
				break;
			}
		}
	}

	const result: string[] = [];
	let hunkIdx = 0;

	for (let i = 0; i < allDiffLines.length; i++) {
		const line = allDiffLines[i];

		// Check if we're inside a hunk
		const currentHunk =
			hunkIdx < hunkRanges.length &&
			i >= hunkRanges[hunkIdx].start &&
			i <= hunkRanges[hunkIdx].end
				? hunkRanges[hunkIdx]
				: null;

		// Advance hunk pointer
		if (
			hunkIdx < hunkRanges.length &&
			i > hunkRanges[hunkIdx].end
		) {
			hunkIdx++;
		}

		const choice = currentHunk?.choice ?? "remote";

		if (line.type === "equal") {
			result.push(line.content);
		} else if (line.type === "remove") {
			if (choice === "local") {
				result.push(line.content);
			}
			// If choice is "remote", skip remove lines (use the add lines instead)
		} else if (line.type === "add") {
			if (choice === "remote") {
				result.push(line.content);
			}
			// If choice is "local", skip add lines (use the remove lines instead)
		}
	}

	return result.join("\n");
}
