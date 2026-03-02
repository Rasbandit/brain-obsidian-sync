/**
 * brain-api HTTP client.
 *
 * Uses Obsidian's requestUrl() which bypasses CORS and works on mobile.
 */
import { requestUrl, RequestUrlResponse } from "obsidian";
import { ChangesResponse, DeleteResponse, NoteDetail, NoteResponse } from "./types";

export class BrainApi {
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

	/** Push a note to brain-api. */
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
}
