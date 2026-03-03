/** Plugin settings stored in data.json */
export interface EngramSyncSettings {
	/** Engram base URL (e.g. "http://10.0.20.214:8000") */
	apiUrl: string;
	/** Bearer token for Engram (e.g. "engram_abc123...") */
	apiKey: string;
	/** Glob patterns to ignore (one per line). Defaults: .obsidian/, .trash/, .git/ */
	ignorePatterns: string;
	/** Pull interval in minutes (0 = manual only) */
	syncIntervalMinutes: number;
	/** Debounce delay in ms for modify events */
	debounceMs: number;
	/** Enable SSE live sync for near-instant remote change notifications */
	liveSyncEnabled: boolean;
	/** Maximum file size in MB for binary attachments (images, PDFs, etc.) */
	maxFileSizeMB: number;
}

export const DEFAULT_SETTINGS: EngramSyncSettings = {
	apiUrl: "",
	apiKey: "",
	ignorePatterns: "",
	syncIntervalMinutes: 5,
	debounceMs: 2000,
	liveSyncEnabled: false,
	maxFileSizeMB: 5,
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
	kind?: "note" | "attachment";
}

/** A queued change waiting to be pushed when connectivity returns. */
export interface QueueEntry {
	path: string;
	action: "upsert" | "delete";
	/** Note content (only for text upserts). */
	content?: string;
	/** Base64 content (only for attachment upserts). */
	contentBase64?: string;
	/** MIME type (only for attachment upserts). */
	mimeType?: string;
	/** File mtime in seconds (only for upserts). */
	mtime?: number;
	/** When this entry was queued (epoch ms). */
	timestamp: number;
	/** Whether this is a note or attachment. */
	kind?: "note" | "attachment";
}

/** Sync engine status for UI updates. */
export type SyncState = "idle" | "syncing" | "error" | "offline";

export interface SyncStatus {
	state: SyncState;
	/** Number of files waiting in debounce queue. */
	pending: number;
	/** Number of changes queued for retry (offline queue). */
	queued: number;
	/** Last sync ISO timestamp, or empty string if never synced. */
	lastSync: string;
	/** Error message when state is "error". */
	error?: string;
}

/** Info passed to conflict resolution UI. */
export interface ConflictInfo {
	path: string;
	localContent: string;
	localMtime: number;
	remoteContent: string;
	remoteMtime: number;
}

/** User's choice for resolving a sync conflict. */
export type ConflictChoice = "keep-local" | "keep-remote" | "keep-both" | "skip";

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

/** Attachment metadata as returned by POST /attachments */
export interface AttachmentResponse {
	attachment: {
		id: number;
		user_id: string;
		path: string;
		mime_type: string;
		size_bytes: number;
		mtime: number;
		created_at: string;
		updated_at: string;
	};
}

/** Full attachment as returned by GET /attachments/{path} */
export interface AttachmentDetail {
	id: number;
	path: string;
	content_base64: string;
	mime_type: string;
	size_bytes: number;
	mtime: number;
	created_at: string;
	updated_at: string;
}

/** A change entry from GET /attachments/changes */
export interface AttachmentChange {
	path: string;
	mime_type: string;
	size_bytes: number;
	mtime: number;
	updated_at: string;
	deleted: boolean;
}

/** Response from GET /attachments/changes */
export interface AttachmentChangesResponse {
	changes: AttachmentChange[];
	server_time: string;
}
