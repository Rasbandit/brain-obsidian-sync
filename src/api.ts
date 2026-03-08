/**
 * Engram HTTP client.
 *
 * Uses Obsidian's requestUrl() which bypasses CORS and works on mobile.
 */
import { requestUrl, RequestUrlResponse } from "obsidian";
import {
	AttachmentChangesResponse,
	AttachmentDetail,
	AttachmentResponse,
	ChangesResponse,
	DeleteResponse,
	NoteDetail,
	NoteResponse,
} from "./types";

export class EngramApi {
	constructor(
		private baseUrl: string,
		private apiKey: string,
	) {}

	updateConfig(baseUrl: string, apiKey: string): void {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.apiKey = apiKey;
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
	): Promise<RequestUrlResponse> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
		};
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
		}
		return requestUrl({
			url: `${this.baseUrl}${path}`,
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
	}

	/** Health check — no auth required. */
	async health(): Promise<boolean> {
		try {
			const resp = await requestUrl({
				url: `${this.baseUrl}/health`,
				method: "GET",
			});
			return resp.status === 200;
		} catch {
			return false;
		}
	}

	/** Authenticated ping — verifies both connectivity and API key. */
	async ping(): Promise<{ ok: boolean; error?: string }> {
		try {
			await this.request("GET", "/folders");
			return { ok: true };
		} catch (e: unknown) {
			const status = (e as { status?: number }).status;
			if (status === 401 || status === 403) {
				return { ok: false, error: "Invalid API key" };
			}
			return { ok: false, error: "Connection failed" };
		}
	}

	/** Push a note to Engram. */
	async pushNote(
		path: string,
		content: string,
		mtime: number,
	): Promise<NoteResponse> {
		const resp = await this.request("POST", "/notes", {
			path,
			content,
			mtime,
		});
		return resp.json as NoteResponse;
	}

	/** Get changes since a timestamp. */
	async getChanges(since: string): Promise<ChangesResponse> {
		const encoded = encodeURIComponent(since);
		const resp = await this.request(
			"GET",
			`/notes/changes?since=${encoded}`,
		);
		return resp.json as ChangesResponse;
	}

	/** Get full note by path. */
	async getNote(path: string): Promise<NoteDetail> {
		const encoded = encodeURIComponent(path);
		const resp = await this.request("GET", `/notes/${encoded}`);
		return resp.json as NoteDetail;
	}

	/** Delete a note. */
	async deleteNote(path: string): Promise<DeleteResponse> {
		const encoded = encodeURIComponent(path);
		const resp = await this.request("DELETE", `/notes/${encoded}`);
		return resp.json as DeleteResponse;
	}

	// --- Attachment methods ---

	/** Push a binary attachment as base64. */
	async pushAttachment(
		path: string,
		contentBase64: string,
		mimeType: string,
		mtime: number,
	): Promise<AttachmentResponse> {
		const resp = await this.request("POST", "/attachments", {
			path,
			content_base64: contentBase64,
			mime_type: mimeType,
			mtime,
		});
		return resp.json as AttachmentResponse;
	}

	/** Get attachment content (base64). */
	async getAttachment(path: string): Promise<AttachmentDetail> {
		const encoded = encodeURIComponent(path);
		const resp = await this.request("GET", `/attachments/${encoded}`);
		return resp.json as AttachmentDetail;
	}

	/** Delete an attachment. */
	async deleteAttachment(path: string): Promise<DeleteResponse> {
		const encoded = encodeURIComponent(path);
		const resp = await this.request("DELETE", `/attachments/${encoded}`);
		return resp.json as DeleteResponse;
	}

	/** Get attachment changes since a timestamp. */
	async getAttachmentChanges(since: string): Promise<AttachmentChangesResponse> {
		const encoded = encodeURIComponent(since);
		const resp = await this.request(
			"GET",
			`/attachments/changes?since=${encoded}`,
		);
		return resp.json as AttachmentChangesResponse;
	}
}

/** Convert an ArrayBuffer to a base64 string. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

/** Convert a base64 string to an ArrayBuffer. */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}
