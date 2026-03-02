/** Plugin settings stored in data.json */
export interface BrainSyncSettings {
	/** brain-api base URL (e.g. "http://10.0.20.214:8000") */
	apiUrl: string;
	/** Bearer token for brain-api (e.g. "brain_abc123...") */
	apiKey: string;
	/** Glob patterns to ignore (one per line). Defaults: .obsidian/, .trash/, .git/ */
	ignorePatterns: string;
	/** Pull interval in minutes (0 = manual only) */
	syncIntervalMinutes: number;
	/** Debounce delay in ms for modify events */
	debounceMs: number;
	/** Enable SSE live sync for near-instant remote change notifications */
	liveSyncEnabled: boolean;
}

export const DEFAULT_SETTINGS: BrainSyncSettings = {
	apiUrl: "",
	apiKey: "",
	ignorePatterns: ".obsidian/\n.trash/\n.git/",
	syncIntervalMinutes: 5,
	debounceMs: 2000,
	liveSyncEnabled: false,
};

/** A note as returned by POST /notes */
export interface NoteResponse {
	note: {
		id: number;
		user_id: string;
		path: string;
		title: string;
		folder: string;
		tags: string[];
		mtime: number;
		created_at: string;
		updated_at: string;
	};
	chunks_indexed: number;
}

/** A change entry from GET /notes/changes */
export interface NoteChange {
	path: string;
	title: string;
	content: string;
	folder: string;
	tags: string[];
	mtime: number;
	updated_at: string;
	deleted: boolean;
}

/** Response from GET /notes/changes */
export interface ChangesResponse {
	changes: NoteChange[];
	server_time: string;
}

/** Response from DELETE /notes/{path} */
export interface DeleteResponse {
	deleted: boolean;
	path: string;
}

/** A note change event from the SSE stream */
export interface NoteStreamEvent {
	event_type: "upsert" | "delete";
	path: string;
	timestamp: number;
}

/** Full note as returned by GET /notes/{path} */
export interface NoteDetail {
	path: string;
	title: string;
	content: string;
	folder: string;
	tags: string[];
	mtime: number;
	created_at: string;
	updated_at: string;
}
