# CLAUDE.md

Obsidian plugin for bidirectional sync with Engram. This is Phase 2 of the Engram project.

## What This Plugin Does

A thin TypeScript sync client (~300-500 lines). It does NOT parse markdown, generate embeddings, or talk to Qdrant — Engram handles all of that. The plugin just pushes/pulls notes via REST.

### Responsibilities

1. **Watch vault events** — `app.vault.on("create")`, `on("modify")`, `on("delete")`, `on("rename")`
2. **Push changes to Engram** — POST /notes with file content + metadata
3. **Pull changes from Engram** — GET /notes/changes on startup and periodically
4. **Write remote changes to vault** — files created/edited via MCP or other devices
5. **Settings panel** — Engram URL, API key, ignore patterns, sync interval

### Does NOT

- Parse markdown or chunk text (Engram does this)
- Generate embeddings (Engram does this via Ollama)
- Talk to Qdrant (Engram does this)
- Handle search (Engram does this)
- Manage auth/users (Engram does this)

## Testing

**Tests are the spec. If a test fails, fix the app — not the test.**

```bash
npm test           # Run unit tests
npm run build      # Build the plugin
```

## Engram Endpoints Used

All endpoints require `Authorization: Bearer <api_key>`. All data scoped by user.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/notes` | Upsert note. Body: `{path, content, mtime}`. Stores in PG + indexes in Qdrant. |
| `GET` | `/notes/{path}` | Get full note content from PostgreSQL. |
| `GET` | `/notes/changes?since=<iso>` | Notes changed since timestamp. Returns `{changes, server_time}`. |
| `DELETE` | `/notes/{path}` | Soft-delete note. |
| `GET` | `/folders` | Folder tree with note counts. |
| `GET` | `/health` | Health check (no auth required). |

### POST /notes Request/Response

```json
// Request
{"path": "2. Knowledge Vault/Health/Omega Oils.md", "content": "---\ntags: [health]\n---\n# Omega Oils\n...", "mtime": 1709234567.0}

// Response
{"note": {"id": 1, "path": "...", "title": "Omega Oils", "folder": "2. Knowledge Vault/Health", "tags": ["health"], ...}, "chunks_indexed": 3}
```

### GET /notes/changes Response

```json
{
  "changes": [
    {"path": "...", "title": "...", "content": "...", "folder": "...", "tags": [...], "mtime": 1709345678.0, "updated_at": "2026-02-28T14:30:00Z", "deleted": false},
    {"path": "Old Note.md", "content": "...", "updated_at": "...", "deleted": true}
  ],
  "server_time": "2026-02-28T15:00:00Z"
}
```

Plugin uses `server_time` as `since` for the next sync — no missed changes even with clock drift.

## Build & Install

```bash
npm install
npm run build

# Copy to Obsidian vault
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/engram-sync/
```

## Architecture

```
Plugin Startup
    │
    ├── Read last_sync from plugin data
    ├── GET /notes/changes?since=last_sync
    │   ├── New/modified remote notes → write to vault
    │   └── Deleted remote notes → move to trash
    ├── Scan vault for locally modified files since last_sync
    │   └── POST /notes for each modified file
    └── Save server_time as new last_sync

Ongoing (vault open)
    │
    ├── on("modify") → debounce 2s → POST /notes
    ├── on("create") → POST /notes
    ├── on("delete") → DELETE /notes/{path}
    ├── on("rename") → DELETE old + POST new
    └── Every N minutes → pull remote changes
```

## Key Technical Details

- **HTTP client:** `requestUrl()` — Obsidian's built-in, bypasses CORS, works on mobile
- **Debounce:** 2 seconds on modify events to avoid flooding during typing
- **Batch push:** On startup reconciliation, push modified files in batches of 10
- **Ignore patterns:** Configurable. Defaults: `.obsidian/`, `.trash/`, `.git/`
- **Conflict handling:** Last-write-wins by mtime (Phase 4 may add manual merge)
- **Sync interval:** Configurable pull interval (default: 5 minutes)

## Infrastructure

- **Engram**: FastRaid (10.0.20.214:8000) — the sync hub, note store, indexer, search engine
- **Dev/test**: `docker compose up` in edi-brain repo starts Engram + postgres locally on :8000
