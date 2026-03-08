## Engram Obsidian Sync — Internals Quick Reference

### Source Map

| File | Lines | Purpose |
|------|-------|---------|
| `src/main.ts` | ~320 | Plugin lifecycle, vault event wiring, commands, status bar, settings I/O |
| `src/sync.ts` | ~900 | Core sync engine: push, pull, fullSync, debounce, offline queue, conflicts, request pacer |
| `src/api.ts` | ~195 | HTTP client wrapping `requestUrl()` for all Engram REST calls |
| `src/dev-log.ts` | ~80 | Dev-only diagnostic ring buffer (compile-time stripped in production) |
| `src/types.ts` | ~175 | All interfaces: settings, API responses, queue entries, sync status |
| `src/settings.ts` | ~178 | Settings tab UI (PluginSettingTab) |
| `src/offline-queue.ts` | ~80 | Persistent offline retry queue (Map-based, dedupes by path, debounced persistence) |
| `src/stream.ts` | ~132 | SSE client for `/notes/stream` (fetch + ReadableStream, not EventSource) |
| `src/first-sync-modal.ts` | ~62 | First-sync confirmation modal (Push All / Pull Only / Cancel) |
| `src/conflict-modal.ts` | ~126 | Conflict resolution modal (Keep Local / Keep Remote / Keep Both / Skip) |
| `src/search-modal.ts` | ~140 | Quick search modal (Mod+Shift+S) — semantic search with debounce, arrow nav |
| `src/search-view.ts` | ~180 | Sidebar search view (ItemView) — persistent search panel with preview pane |
| `tests/sync.test.ts` | ~1750 | Unit tests for SyncEngine (Jest + ts-jest) — 107 tests |
| `tests/search.test.ts` | ~120 | Unit tests for search API + debounce |
| `tests/__mocks__/obsidian.ts` | — | Mock Obsidian API for tests |

### Class Relationships

```
EngramSyncPlugin (main.ts)
├── api: EngramApi (api.ts)
│   └── getRateLimit() → GET /rate-limit
├── syncEngine: SyncEngine (sync.ts)
│   ├── api: EngramApi (shared instance)
│   ├── queue: OfflineQueue (offline-queue.ts, debounced persistence)
│   ├── ready gate: events suppressed until setReady()
│   ├── push semaphore: max 5 concurrent (acquirePushSlot/releasePushSlot)
│   ├── request pacer: sliding window from configureRateLimit()
│   └── onConflict: (path, local, remote) → ConflictChoice (wired to ConflictModal)
├── noteStream: NoteStream (stream.ts)
├── SearchModal (search-modal.ts) — opened via Mod+Shift+S command
├── SearchView (search-view.ts) — registered as "engram-search-view" ItemView
├── devLog: DevLogBuffer (dev-log.ts) — globalThis.__engramLog (dev builds only)
└── statusBarEl: HTMLElement
```

### Settings Defaults

```typescript
{ apiUrl: "", apiKey: "", ignorePatterns: "", syncIntervalMinutes: 5,
  debounceMs: 2000, liveSyncEnabled: false, maxFileSizeMB: 5 }
```

### API Endpoints (beyond CLAUDE.md)

CLAUDE.md covers note endpoints. These are also used:

| Method | Path | Body/Params | Response |
|--------|------|-------------|----------|
| `POST` | `/attachments` | `{path, content_base64, mime_type, mtime}` | `{attachment}` |
| `GET` | `/attachments/{path}` | — | `{id, path, content_base64, mime_type, size_bytes, mtime, ...}` |
| `GET` | `/attachments/changes?since={iso}` | — | `{changes[], server_time}` |
| `DELETE` | `/attachments/{path}` | — | `{deleted, path}` |
| `POST` | `/search` | `{query, limit?, tags?}` | `{query, results[{text, title?, heading_path?, source_path?, tags[], wikilinks[], score, vector_score, rerank_score}]}` |
| `GET` | `/notes/stream` | SSE stream, `Authorization` header | `event: note_change\ndata: {event_type, path, timestamp, kind?}` |
| `GET` | `/rate-limit` | — | `{requests_per_minute}` (0 = unlimited) |

Path encoding: all URL path params use `encodeURIComponent()`.

### Sync Algorithm — Key Flows

**fullSync() (startup + periodic):**
1. `ping()` → `GET /folders` (validates auth, throws on 401/403)
2. `configureRateLimit()` → `GET /rate-limit` (sets pacer, applies 10% safety margin)
3. Snapshot `prePullSync = lastSync` (critical — pull updates lastSync)
4. `pull()` → fetch note + attachment changes since lastSync, apply each
5. `pushModifiedFiles(prePullSync)` → push local files modified since the OLD lastSync

**pull():**
1. Parallel fetch: `GET /notes/changes` + `GET /attachments/changes`
2. Apply each change via `applyChange()` / `applyAttachmentChange()`
3. Update `lastSync` to later of the two `server_time` values
4. If no lastSync exists, defaults to `"1970-01-01T00:00:00Z"`

**applyChange() conflict detection:**
- Conflict = local file exists AND local mtime > lastSync AND remote mtime > lastSync AND content differs
- Resolution choices: `skip` | `keep-local` (push ours) | `keep-remote` (overwrite) | `keep-both` (copy as `name (conflict YYYY-MM-DD).md`)

**Push pipeline:**
1. Vault event → `handleModify/Create/Delete/Rename` (suppressed until `setReady()`)
2. Modify: debounce timer per-file (configurable, default 2s)
3. Timer fires → `acquirePushSlot()` (max 5 concurrent) → `paceRequest()` → read content → POST to API
4. On failure → `enqueueChange()` with path only (content-free) → offline queue
5. Batch operations (pushAll, pushModifiedFiles): chunks of 10, sequential batches

**SSE echo suppression:**
- After successful push: `markRecentlyPushed(path, 5000ms)`
- SSE handler skips events for paths that are `pushing` or `recentlyPushed`
- Prevents write-back loops

**Offline cycle:**
1. Push fails → `goOffline()` → start health check every 30s
2. Health check succeeds → `goOnline()` → `flushQueue()` (oldest-first)
3. Queue flush fails → back to offline

### File Type Handling

```
isSyncable(path):  .md, .canvas, or isBinaryFile(path)
isMarkdown(path):  .md
isBinaryFile(path): .png .jpg .jpeg .gif .bmp .svg .webp .pdf
                    .mp3 .wav .ogg .m4a .webm .flac .mp4 .mov .zip
```

Binary files use `/attachments` endpoints with base64 encoding.
Text files use `/notes` endpoints with raw content string.

### Ignore Pattern Logic

```
Always ignored (hardcoded): .obsidian/, .trash/, .git/
User patterns (from settings textarea, one per line):
  - Ends with "/" → folder pattern: path.startsWith(p) or path contains "/"+p
  - No trailing "/" → file pattern: exact match or endsWith("/"+name)
```

### Internal State (SyncEngine)

| Field | Type | Purpose |
|-------|------|---------|
| `debounceTimers` | `Map<path, timeout>` | Active debounce timers per file |
| `pushing` | `Set<path>` | Files currently being pushed (prevents re-entry) |
| `recentlyPushed` | `Map<path, timeout>` | Echo suppression cooldowns (5s) |
| `lastSync` | `string` | ISO 8601 timestamp, persisted to plugin data |
| `offline` | `boolean` | Current connectivity state |
| `healthCheckTimer` | `interval` | 30s poll when offline |
| `ready` | `boolean` | Event handlers suppressed until true (ready gate) |
| `activePushCount` | `number` | Current in-flight push requests |
| `maxConcurrentPushes` | `number` | Push semaphore limit (5) |
| `pushWaiters` | `(() => void)[]` | Queued resolvers waiting for a push slot |
| `rateLimitRPM` | `number` | Server-reported RPM with 10% margin (0 = unlimited) |
| `requestTimestamps` | `number[]` | Sliding window of recent request times for pacing |

### Time Handling

- Obsidian `file.stat.mtime`: epoch **milliseconds**
- API mtime fields: epoch **seconds** (divide by 1000 when sending)
- `lastSync` / `server_time`: ISO 8601 strings
- Conflict detection compares epoch seconds

### Known Quirks

- **Obsidian resets mtime on vault.modify()** — cannot use mtime to decide whether to apply remote changes. Conflict detection uses lastSync comparison instead. (2026-03)
- **SSE uses fetch(), not EventSource** — EventSource doesn't support custom Authorization headers
- **requestUrl()** — Obsidian's built-in HTTP, bypasses CORS, required for mobile support
- **Conflict copies** — named `{stem} (conflict YYYY-MM-DD).{ext}`, not timestamped to the second

### Ready Gate (V8 OOM Prevention)

Event handlers (`handleModify`, `handleDelete`, `handleRename`) return immediately until `setReady()` is called. This prevents other plugins' startup file modifications from flooding the sync engine.

```
Plugin.onload()
  └── workspace.onLayoutReady() callback:
      1. doSyncWithFirstSyncCheck()   ← initial sync
      2. syncEngine.setReady()        ← events now flow through (in finally block)
```

### Request Pacer

Self-regulating rate limiter that queries the server's limit on startup.

```
configureRateLimit():
  1. GET /rate-limit → { requests_per_minute: N }
  2. If N > 0: effective = floor(N * 0.9)   ← 10% safety margin
  3. If N == 0 or error: pacer disabled

paceRequest():
  1. If rateLimitRPM == 0: return immediately
  2. Prune timestamps older than 60s
  3. If under limit: record timestamp, proceed
  4. At capacity: sleep until oldest timestamp exits window (+50ms buffer)
```

Called in `pushFile()` (after acquiring push slot) and `flushQueue()` (before each API call).

### Offline Queue (Debounced Persistence)

`OfflineQueue` deduplicates by path and debounces persistence writes.

- `enqueue()`: adds entry, calls `schedulePersist()` (debounced, default 1s)
- `dequeue()` / `clear()`: immediate `persistNow()`
- `destroy()`: clears pending timer
- Queue entries are **content-free** (path, action, kind, mtime only) — content re-read from vault on flush
- Legacy entries with inline `content`/`contentBase64` are still honored for backward compat

### Push Concurrency Limiter

Semaphore pattern limiting concurrent push requests to 5.

- `acquirePushSlot()`: increments counter or queues a waiter promise
- `releasePushSlot()`: decrements counter, resolves next waiter
- Prevents request flooding during bulk syncs and startup reconciliation

### Dev-Only Diagnostic Logger (`dev-log.ts`)

Compile-time gated via `DEV_MODE` constant (set in `esbuild.config.mjs`).

- **Dev builds** (`npm run dev`): ring buffer of 500 entries on `globalThis.__engramLog`
- **Production builds** (`npm run build`): all methods are no-ops, zero overhead
- Categories: `lifecycle`, `push`, `pull`, `error`, `sse`, `queue`, `pacer`
- CDP queryable: `globalThis.__engramLog.dump(50)`, `.filter("push")`, `.stats()`

### Build & Test Commands

```bash
npm test                    # Jest unit tests
npm run build               # tsc check + esbuild → main.js
npm run dev                 # esbuild watch mode with sourcemaps
node version-bump.mjs       # Bumps manifest.json + versions.json from package.json
```

Build output: `main.js` (CommonJS, ES2018 target). Externals: obsidian, electron, @codemirror/*, @lezer/*.
