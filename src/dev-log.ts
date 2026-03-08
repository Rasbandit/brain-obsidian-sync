/**
 * Dev-only diagnostic logger — ring buffer queryable via CDP.
 *
 * In production builds, DEV_MODE is replaced with `false` by esbuild,
 * and tree-shaking eliminates all logging code.
 *
 * Usage from CDP console:
 *   __engramLog.dump()       — all entries
 *   __engramLog.dump(20)     — last 20 entries
 *   __engramLog.filter('pull') — entries matching substring
 *   __engramLog.stats()      — heap + queue + sync state snapshot
 *   __engramLog.clear()      — reset buffer
 */

declare const DEV_MODE: boolean;

interface LogEntry {
	t: string;    // ISO timestamp
	ms: number;   // epoch ms (for duration math)
	cat: string;  // category: pull, push, queue, sse, error, lifecycle
	msg: string;
}

const MAX_ENTRIES = 500;

class DevLogBuffer {
	private entries: LogEntry[] = [];

	log(cat: string, msg: string): void {
		const now = Date.now();
		this.entries.push({
			t: new Date(now).toISOString(),
			ms: now,
			cat,
			msg,
		});
		if (this.entries.length > MAX_ENTRIES) {
			this.entries.splice(0, this.entries.length - MAX_ENTRIES);
		}
		console.debug(`[engram:${cat}]`, msg);
	}

	dump(n?: number): LogEntry[] {
		if (n) return this.entries.slice(-n);
		return [...this.entries];
	}

	filter(substring: string): LogEntry[] {
		const lower = substring.toLowerCase();
		return this.entries.filter(
			e => e.cat.includes(lower) || e.msg.toLowerCase().includes(lower)
		);
	}

	stats(): Record<string, unknown> {
		const mem = (performance as any).memory;
		return {
			heapMB: mem ? Math.round(mem.usedJSHeapSize / 1024 / 1024) : "N/A",
			heapLimitMB: mem ? Math.round(mem.jsHeapSizeLimit / 1024 / 1024) : "N/A",
			entries: this.entries.length,
			lastEntry: this.entries.length > 0 ? this.entries[this.entries.length - 1] : null,
		};
	}

	clear(): void {
		this.entries.length = 0;
	}
}

/** No-op logger for production — all methods are empty, tree-shaken away. */
const noopLog = {
	log(_cat: string, _msg: string): void {},
	dump(_n?: number): LogEntry[] { return []; },
	filter(_s: string): LogEntry[] { return []; },
	stats(): Record<string, unknown> { return {}; },
	clear(): void {},
};

export type DevLog = DevLogBuffer | typeof noopLog;

let instance: DevLog = noopLog;

export function initDevLog(): DevLog {
	if (DEV_MODE) {
		instance = new DevLogBuffer();
		(globalThis as any).__engramLog = instance;
	}
	return instance;
}

export function devLog(): DevLog {
	return instance;
}

export function destroyDevLog(): void {
	if (DEV_MODE) {
		delete (globalThis as any).__engramLog;
	}
	instance = noopLog;
}
