/**
 * SSE client for live note change notifications.
 *
 * Uses fetch() + ReadableStream instead of EventSource because EventSource
 * doesn't support custom Authorization headers. Works in Electron (Obsidian).
 */
import { NoteStreamEvent } from "./types";

export class NoteStream {
	private controller: AbortController | null = null;
	private reconnectMs = 1000;
	private maxReconnectMs = 60000;
	private connected = false;
	private baseUrl: string;
	private apiKey: string;

	onEvent: ((event: NoteStreamEvent) => void) | null = null;
	onStatusChange: ((connected: boolean) => void) | null = null;

	constructor(baseUrl: string, apiKey: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.apiKey = apiKey;
	}

	updateConfig(baseUrl: string, apiKey: string): void {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.apiKey = apiKey;
	}

	async connect(): Promise<void> {
		if (this.controller) return;
		this.reconnectMs = 1000;
		await this.startStream();
	}

	disconnect(): void {
		if (this.controller) {
			this.controller.abort();
			this.controller = null;
		}
		this.setConnected(false);
	}

	isConnected(): boolean {
		return this.connected;
	}

	private setConnected(value: boolean): void {
		if (this.connected !== value) {
			this.connected = value;
			this.onStatusChange?.(value);
		}
	}

	private async startStream(): Promise<void> {
		this.controller = new AbortController();

		try {
			const resp = await fetch(`${this.baseUrl}/notes/stream`, {
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
				},
				signal: this.controller.signal,
			});

			if (!resp.ok || !resp.body) {
				throw new Error(`SSE connect failed: HTTP ${resp.status}`);
			}

			const reader = resp.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let currentEvent = "";
			let currentData = "";

			this.setConnected(true);
			this.reconnectMs = 1000;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				// Keep incomplete last line in buffer
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.startsWith("event: ")) {
						currentEvent = line.slice(7).trim();
					} else if (line.startsWith("data: ")) {
						currentData = line.slice(6);
					} else if (line === "") {
						// Empty line = end of event
						if (currentEvent === "note_change" && currentData) {
							try {
								const event = JSON.parse(currentData) as NoteStreamEvent;
								this.onEvent?.(event);
							} catch (e) {
								console.error("Brain SSE: failed to parse event", e);
							}
						}
						currentEvent = "";
						currentData = "";
					}
				}
			}
		} catch (e: unknown) {
			if (e instanceof DOMException && e.name === "AbortError") {
				// Intentional disconnect
				return;
			}
			console.error("Brain SSE: stream error", e);
		} finally {
			this.setConnected(false);
		}

		// Reconnect with exponential backoff + jitter
		if (this.controller && !this.controller.signal.aborted) {
			const jitter = Math.random() * this.reconnectMs * 0.5;
			const delay = this.reconnectMs + jitter;
			console.log(`Brain SSE: reconnecting in ${Math.round(delay)}ms`);

			this.controller = null;
			setTimeout(() => {
				this.reconnectMs = Math.min(this.reconnectMs * 2, this.maxReconnectMs);
				this.startStream();
			}, delay);
		}
	}
}
