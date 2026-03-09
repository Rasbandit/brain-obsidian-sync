## Plugin Debugging — CDP & Obsidian DevTools

For server ops, infrastructure, connection/auth testing, and database schema, see `../engram-workspace/docs/deployment.md`.
For cross-project debugging workflows (plugin → backend tracing), see `../engram-workspace/docs/debugging.md`.

This doc covers **plugin-specific** debugging: Obsidian's Chrome DevTools Protocol and the MCP devtools server.

### Obsidian Remote Debugging (CDP)

Obsidian exposes Chrome DevTools Protocol when launched with `--remote-debugging-port`.
A project-scoped MCP server (`obsidian-devtools`) connects to it for runtime inspection.

**Port assignments:**

| App | Debug Port | MCP Server |
|-----|-----------|------------|
| Obsidian | 9222 | `obsidian-devtools` (project-scoped) |
| Headless Chrome | 9224 | `chrome-devtools` (global) |

**Key quirk:** When launching Obsidian from an SSH or headless shell, you must set `DISPLAY=:0` or CDP won't bind. The desktop launcher inherits this from the graphical session automatically. The `--remote-debugging-port` flag works as expected — Obsidian binds to the specified port. (2026-03, corrected)

**Launch config:** `~/.local/share/applications/obsidian.desktop` has `--remote-debugging-port=9222` in the Exec line. The flag must be present to enable CDP — without it, no debug server starts.

**CLI launch:** `DISPLAY=:0 /home/open-claw/Applications/Obsidian.AppImage --no-sandbox --remote-debugging-port=9222`

**Verify it's working:**
```bash
curl -s http://127.0.0.1:9222/json/version   # Should return Chrome/Electron version info
curl -s http://127.0.0.1:9222/json/list       # Lists inspectable pages
```

**MCP config location:** `~/.claude.json` → project section for engram-obsidian-sync → `mcpServers.obsidian-devtools`

### Obsidian DevTools MCP — Capabilities

The `obsidian-devtools` MCP server exposes 27 tools for interacting with the running Obsidian instance via CDP. Grouped by use case:

#### Inspection & Snapshots

| Tool | Purpose |
|------|---------|
| `take_snapshot` | A11y-tree text snapshot of the current page — lists all elements with UIDs for interaction. **Prefer this over screenshots.** |
| `take_screenshot` | Visual screenshot (PNG/JPEG/WebP). Can target a specific element by UID or capture full page. |
| `list_pages` | List all open pages/tabs in Obsidian's Electron renderer. |
| `select_page` | Switch context to a specific page (by ID from `list_pages`). |

#### JavaScript Execution

| Tool | Purpose |
|------|---------|
| `evaluate_script` | Run arbitrary JS in Obsidian's renderer process. Access `app`, `app.vault`, `app.workspace`, plugin APIs, DOM, etc. Return value must be JSON-serializable. |

**This is the most powerful tool.** Examples:
- `() => app.vault.getFiles().length` — count vault files
- `() => app.plugins.plugins` — list loaded plugins
- `() => app.workspace.activeLeaf?.view?.getViewType()` — get active view type
- `() => app.vault.adapter.read("path/to/note.md")` — read a file via Obsidian's API
- `() => { const p = app.plugins.plugins["engram-sync"]; return p?.settings; }` — inspect plugin settings at runtime

#### UI Interaction

| Tool | Purpose |
|------|---------|
| `click` | Click an element by UID (from snapshot). Supports double-click. |
| `hover` | Hover over an element by UID. |
| `fill` | Type into an input/textarea or select from a `<select>`. |
| `fill_form` | Fill multiple form elements at once. |
| `type_text` | Type text via keyboard into a focused input. |
| `press_key` | Press keys/combos (e.g., `Enter`, `Control+P`, `Control+Shift+R`). |
| `drag` | Drag one element onto another. |
| `handle_dialog` | Accept or dismiss browser dialogs (confirm/alert/prompt). |
| `upload_file` | Upload a file through a file input element. |
| `wait_for` | Block until specified text appears on the page. |

#### Console & Debugging

| Tool | Purpose |
|------|---------|
| `list_console_messages` | List all console messages (filterable by type: log, error, warn, etc.). |
| `get_console_message` | Get details of a specific console message by ID. |

**Key for debugging:** Filter for `error` and `warn` types to catch plugin exceptions, failed API calls, or deprecation warnings at runtime.

#### Performance & Memory

| Tool | Purpose |
|------|---------|
| `performance_start_trace` | Start a Chrome performance trace (find bottlenecks, Core Web Vitals). |
| `performance_stop_trace` | Stop trace, save to `.json.gz`. |
| `performance_analyze_insight` | Drill into specific performance insights from a trace. |
| `take_memory_snapshot` | Capture a heap snapshot (`.heapsnapshot`) for memory leak debugging. |
| `lighthouse_audit` | Run Lighthouse for accessibility, SEO, best practices (not performance). |

#### Page Control

| Tool | Purpose |
|------|---------|
| `navigate_page` | Navigate to URL, go back/forward, or reload. |
| `new_page` | Open a new tab with a URL. |
| `close_page` | Close a tab by ID. |
| `resize_page` | Resize the window to specific dimensions. |
| `emulate` | Emulate dark/light mode, viewports, network throttling, CPU throttling. |

### Practical Workflows

**1. Debug plugin at runtime:**
```
take_snapshot → find plugin UI elements
evaluate_script → inspect plugin state (settings, sync status, timers)
list_console_messages(types: ["error"]) → check for exceptions
```

**2. Test plugin UI after deploy:**
```
take_snapshot → find settings tab or sync status elements
click → navigate to plugin settings
fill → change a setting value
take_screenshot → capture result for verification
```

**3. Investigate sync issues:**
```
evaluate_script → check app.plugins.plugins["engram-sync"] internals
evaluate_script → read lastSync, pending queue, connection state
list_console_messages → look for failed HTTP requests or errors
```

**4. Performance profiling:**
```
performance_start_trace → trigger sync operation → performance_stop_trace
performance_analyze_insight → identify bottlenecks
take_memory_snapshot → check for leaks during long sessions
```

### Limitations

- **Cannot reload/restart the Obsidian plugin** — user must toggle it off/on in Settings → Community Plugins (but `evaluate_script` can call `app.plugins.disablePlugin()` / `app.plugins.enablePlugin()` to automate this)
- **Cannot retrieve API keys from the database** — only SHA256 hashes are stored; user must provide the raw key
- **`evaluate_script` return values must be JSON-serializable** — cannot return functions, circular refs, or DOM nodes directly
- **Obsidian must be running with CDP enabled** — if Obsidian is closed or launched without `--remote-debugging-port`, all tools fail
- **Jina reranker may be offline** — search still works (vector-only), but scores won't have rerank component
