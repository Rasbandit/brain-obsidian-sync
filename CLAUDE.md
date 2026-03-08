# CLAUDE.md

Obsidian plugin for bidirectional sync with Engram. This is Phase 2 of the Engram project.

## Life OS
project: engram-obsidian-sync
goal: income
value: financial-freedom

For detailed internals (class map, sync algorithm, type definitions, quirks), read `docs/internals.md`.
For debugging and operations (logs, SSH, curl, DB queries, deploy), read `docs/engram-ops.md`.

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
- Perform search indexing (Engram does this — plugin provides the search UI via `POST /search`)
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
| `POST` | `/search` | Semantic search. Body: `{query, limit?, tags?}`. Returns `{query, results[]}`. |
| `GET` | `/rate-limit` | Server's rate limit (RPM). Returns `{requests_per_minute}`. 0 = unlimited. |
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

## Local Dev Credentials

`.env` has the API key for testing against production Engram (gitignored):

```bash
source .env
curl -X POST "$ENGRAM_API_URL/search" \
  -H "Authorization: Bearer $ENGRAM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"test"}'
```

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
- **Request pacer:** Queries `GET /rate-limit` on startup, applies 10% safety margin, sliding window delays pushes at capacity
- **Ready gate:** Event handlers suppressed until layout ready + initial sync completes (prevents OOM from startup event storms)
- **Push concurrency:** Max 5 concurrent push requests via semaphore
- **Content-free queue:** Failed pushes queue path/action only (no content), re-read from vault on flush

## MCP Servers (Project-Scoped)

This project has an `obsidian-devtools` MCP server configured in `~/.claude.json` (project section). It connects to Obsidian's Chrome DevTools Protocol endpoint for runtime inspection, DOM snapshots, console access, and JS evaluation.

| MCP Server | Port | Scope | Purpose |
|------------|------|-------|---------|
| `obsidian-devtools` | 9222 | Project (engram-obsidian-sync) | CDP access to running Obsidian instance |
| `chrome-devtools` | 9224 | Global | CDP access to headless Chrome |

**Quirk:** When launching Obsidian from an SSH or headless shell, you must set `DISPLAY=:0` or CDP won't bind. The desktop launcher inherits this from the graphical session automatically. The `--remote-debugging-port=9222` flag works as expected — Obsidian binds to the specified port.

**Quirk:** This machine is a SPICE VM with a QXL paravirtual GPU. Obsidian **must** be launched with `--disable-gpu` or Electron's GPU compositor stalls on QXL's incomplete GL, freezing the renderer and all CDP commands. Full launch command:
```bash
DISPLAY=:0 obsidian --no-sandbox --remote-debugging-port=9222 --remote-allow-origins=* --disable-gpu &
```

**Quirk:** V8 heap OOM (~2GB) when engram-sync runs alongside other community plugins (linter, code-styler, excalidraw, etc.). Each plugin alone is stable. Likely a vault event feedback loop — other plugins modify files on startup, flooding engram-sync's handlers. Investigation incomplete; see AI memory file `cdp-oom-investigation.md` for bisection data and next steps. **Always restart Obsidian after deploying plugin files.**

### CDP Timeout Triage (Quick Reference)

1. `curl -s --max-time 3 http://localhost:9222/json/version` — CDP reachable?
2. `ss -tnp | grep 9222` — MCP server connected?
3. Test a browser-side command (`Target.getTargets`) — if that works but `Runtime.evaluate` hangs → renderer is frozen → restart Obsidian

## Infrastructure

- **Engram**: FastRaid (10.0.20.214:8000) — the sync hub, note store, indexer, search engine
- **Dev/test**: `docker compose up` in edi-brain repo starts Engram + postgres locally on :8000

## Engram Backend Reference

The backend repo lives at `/home/open-claw/documents/code-projects/engram/`. Python 3.12, FastAPI, v2.3.0.

### Production Containers (FastRaid: 10.0.20.214)

| Container | Port | Purpose |
|-----------|------|---------|
| `engram` | 8000 | Main FastAPI service (4 uvicorn workers) |
| `engram-postgres` | 5432 | PostgreSQL — notes, attachments, users, API keys |
| `engram-redis` | 6379 | Cache — API key validation, rate limiting |

Docker network: `ai` (external, shared with ollama, qdrant, jina-reranker)
Volume: `engram_pg_data` (external, persistent)
Logging: max-size 50MB, max-file 1

### Accessing Logs

```bash
# Recent logs
ssh root@10.0.20.214 "docker logs engram --tail 100"

# Follow in real-time
ssh root@10.0.20.214 "docker logs engram -f --tail 20"

# Filter for errors
ssh root@10.0.20.214 "docker logs engram --tail 500 2>&1" | grep -i "error\|traceback\|500"

# Filter for a specific endpoint
ssh root@10.0.20.214 "docker logs engram --tail 500 2>&1" | grep "POST /search"

# Container status
ssh root@10.0.20.214 "docker ps --filter name=engram"

# Restart
ssh root@10.0.20.214 "docker restart engram"
```

### Database Queries

```bash
ssh root@10.0.20.214 "docker exec engram-postgres psql -U engram -d engram -c 'SELECT ...'"
```

**Tables:** `users` (id, email, password_hash, display_name), `api_keys` (id, user_id FK, key_hash SHA256, name), `notes` (id, user_id text, path, title, content, folder, tags text[], mtime, created_at, updated_at, deleted_at), `attachments` (id, user_id, path, content bytea, mime_type, size_bytes, mtime, created_at, updated_at, deleted_at)

Key constraints: `UNIQUE(user_id, path)` on notes and attachments. All deletes are soft (set `deleted_at`).

### All Backend Endpoints

The plugin uses a subset (listed in "Engram Endpoints Used" above). Full list:

**Notes:** `POST /notes` (upsert), `GET /notes/{path}` (read), `DELETE /notes/{path}` (soft-delete), `GET /notes/changes?since=` (sync), `POST /notes/rename` ({old_path, new_path}), `POST /notes/append` ({path, text})

**Search:** `POST /search` ({query, limit?, tags?} — rate limited), `GET /tags` (tag counts), `GET /folders` (folder tree), `GET /folders/list?folder=` (notes in folder), `POST /folders/search` ({query, limit} — folder suggestions), `POST /folders/reindex` (rebuild folder vectors), `POST /folders/rename` (rename folder + notes)

**Attachments:** `POST /attachments` (upsert base64), `GET /attachments/{path}` (read base64), `DELETE /attachments/{path}` (soft-delete), `GET /attachments/changes?since=` (sync)

**Live Sync:** `GET /notes/stream` (SSE — `event: connected` then `event: note_change`)

**Auth:** `POST /register`, `POST /login` (→ JWT), `GET /logout`, `POST /api-keys` (create `engram_` + 32 chars), `GET /api-keys` (list), `DELETE /api-keys/{id}` (revoke)

**System:** `GET /health`, `GET /health/deep` (checks PG, Qdrant, Ollama, Redis), `GET /user/storage` (used/max bytes), `GET /rate-limit` ({requests_per_minute}, 0=unlimited)

**MCP:** `POST /mcp` (SSE transport, Bearer auth via MCPAuthMiddleware)

**Web UI:** `GET /login`, `GET /register`, `GET /search`, `GET /search/results?query=&tags=`

### Search Pipeline

```
Query → embed(query) via Ollama (nomic-embed-text, 768d)
  → Qdrant query_points (4x limit candidates, cosine similarity, filtered by user_id + tags)
  → Jina /rerank (optional — graceful fallback to vector-only if Jina unavailable)
  → Blend: 0.4 * vector_score + 0.6 * rerank_score
  → Sort, return top N
```

SearchResult: `{text, title, heading_path, source_path, tags[], wikilinks[], score, vector_score, rerank_score}`

### Indexing Pipeline

```
POST /notes → note_store.upsert_note() (PostgreSQL)
  → parse_markdown_content() (heading-aware chunking, max 512 tokens, 50 overlap)
  → embed each chunk (Ollama)
  → qdrant_store.upsert_chunks() (obsidian_notes collection)
  → event_bus.publish() (PostgreSQL NOTIFY → SSE fan-out)
  → folder_index rebuild (if folder set changed)
```

### Auth System

- API keys: `engram_` + `secrets.token_urlsafe(32)`, stored as SHA256 hash in `api_keys` table
- Validation path: Redis cache (5-min TTL) → DB fallback → local dict cache
- Session auth (web UI): JWT in `engram_session` cookie (HS256, 7-day expiry)
- All data scoped by `user_id` in WHERE clauses (multi-tenant)
- MCP auth: MCPAuthMiddleware validates Bearer, sets `_current_user_id` contextvar

### MCP Tools (8 tools at /mcp)

`search_notes`, `get_note`, `list_tags`, `list_folders`, `list_folder`, `suggest_folder`, `delete_note`, `rename_note`

### Configuration (Key Env Vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `DATABASE_URL` | — | PostgreSQL connection |
| `QDRANT_URL` | `http://localhost:6333` | Vector store |
| `OLLAMA_URL` | `http://localhost:11434` | Embeddings |
| `JINA_URL` | `http://localhost:8082` | Reranker (optional) |
| `REDIS_URL` | (empty=in-memory) | Cache/queue |
| `JWT_SECRET` | — | Auth signing |
| `EMBED_MODEL` | `nomic-embed-text` | Embedding model |
| `EMBED_DIMS` | `768` | Vector dimensions |
| `RATE_LIMIT_RPM` | `120` | Requests/min per user |
| `ASYNC_INDEXING` | `false` | Background indexing |

### Key Backend Source Files

| File | Purpose |
|------|---------|
| `api/main.py` | FastAPI app, all endpoints, lifespan |
| `api/note_store.py` | Note CRUD, folder ops |
| `api/search.py` | Two-stage search (Qdrant + Jina) |
| `api/indexing.py` | Parse → embed → upsert |
| `api/mcp_tools.py` | MCP tool definitions |
| `api/parsers/markdown.py` | Heading-aware chunking |
| `api/db.py` | Auth DB, API key validation |
| `api/events.py` | PostgreSQL LISTEN/NOTIFY EventBus |
| `api/stores/qdrant_store.py` | Qdrant vector CRUD |
| `api/routes/stream.py` | SSE endpoint |

### Notable Backend Patterns

- **Soft deletes** — `deleted_at` timestamp, never hard-delete
- **4x oversampling** — Qdrant fetches 4x limit, then reranks to limit
- **Graceful Jina fallback** — search works without reranker (vector scores only)
- **LISTEN/NOTIFY** — PostgreSQL native pub/sub for SSE fan-out across workers
- **Throttled last_used** — API key `last_used` updates only every 60 seconds

@/home/open-claw/documents/code-projects/ops-agent/docs/self-updating-docs.md
