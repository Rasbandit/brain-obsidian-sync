# CLAUDE.md

Obsidian plugin for bidirectional sync with Engram. This is Phase 2 of the Engram project.

## Life OS
project: engram-obsidian-sync
goal: income
value: financial-freedom

For detailed internals (class map, sync algorithm, type definitions, quirks), read `docs/internals.md`.

## What This Plugin Does

A TypeScript sync client. It does NOT parse markdown, generate embeddings, or talk to Qdrant — Engram handles all of that. The plugin just pushes/pulls notes via REST.

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
| `POST` | `/attachments` | Upsert binary file. Body: `{path, content_base64, mime_type, mtime}`. |
| `GET` | `/attachments/{path}` | Get attachment (base64-encoded content). |
| `GET` | `/attachments/changes?since=<iso>` | Attachment changes since timestamp. |
| `DELETE` | `/attachments/{path}` | Soft-delete attachment. |
| `GET` | `/notes/stream` | SSE stream for live sync (note_change events). |
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
```

## Release Process

No CI/CD — releases are manual. Full steps:

### 1. Version Bump

Update version string in all three files:

- `package.json` → `"version": "X.Y.Z"`
- `manifest.json` → `"version": "X.Y.Z"`
- `versions.json` → add `"X.Y.Z": "1.0.0"` (value = minAppVersion)

### 2. Commit, Merge, Tag

```bash
git switch main
git merge <branch> --no-edit
git tag -a vX.Y.Z -m "short description"
git push origin main --tags
```

### 3. GitHub Release

```bash
gh release create vX.Y.Z \
  main.js manifest.json styles.css \
  --title "vX.Y.Z: Short title" \
  --notes "Release notes in markdown"
```

Required assets: `main.js`, `manifest.json`, `styles.css` — Obsidian reads these from the release.

### 4. Deploy to Local Vault

```bash
npm run build
cp main.js manifest.json styles.css "/home/open-claw/Obsidian Vault/.obsidian/plugins/engram-sync/"
```

Restart Obsidian or disable/re-enable the plugin to pick up changes.

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
- **Conflict handling:** Modal with 4 choices: Keep Local, Keep Remote, Keep Both (conflict copy), Skip
- **Sync interval:** Configurable pull interval (default: 5 minutes)

## Infrastructure

- **Engram**: FastRaid (10.0.20.214:8000) — the sync hub, note store, indexer, search engine
- **Dev/test**: `docker compose up` in edi-brain repo starts Engram + postgres locally on :8000

@/home/open-claw/documents/code-projects/ops-agent/docs/self-updating-docs.md
