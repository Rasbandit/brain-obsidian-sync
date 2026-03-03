/**
 * Offline queue — persists failed sync operations for retry when connectivity returns.
 *
 * Deduplicates by path: newer entries for the same path replace older ones.
 * Entries are flushed oldest-first.
 */
import { QueueEntry } from "./types";

export class OfflineQueue {
	private entries: Map<string, QueueEntry> = new Map();
	private persistFn: ((entries: QueueEntry[]) => Promise<void>) | null = null;

	/** Register a callback to persist queue state. */
	onPersist(fn: (entries: QueueEntry[]) => Promise<void>): void {
		this.persistFn = fn;
	}

	/** Load previously persisted entries (call once on startup). */
	load(entries: QueueEntry[]): void {
		this.entries.clear();
		for (const entry of entries) {
			this.entries.set(entry.path, entry);
		}
	}

	/** Add or replace a queued change for a path. */
	async enqueue(entry: QueueEntry): Promise<void> {
		this.entries.set(entry.path, entry);
		await this.persist();
	}

	/** Remove a path from the queue (after successful sync). */
	async dequeue(path: string): Promise<void> {
		this.entries.delete(path);
		await this.persist();
	}

	/** Get all entries sorted by timestamp (oldest first). */
	all(): QueueEntry[] {
		return Array.from(this.entries.values()).sort(
			(a, b) => a.timestamp - b.timestamp,
		);
	}

	/** Number of queued entries. */
	get size(): number {
		return this.entries.size;
	}

	/** Clear all entries. */
	async clear(): Promise<void> {
		this.entries.clear();
		await this.persist();
	}

	private async persist(): Promise<void> {
		await this.persistFn?.(this.all());
	}
}
