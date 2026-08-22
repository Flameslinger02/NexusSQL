# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install Electron + mysql2 driver
npm start          # launch the app (electron .)
npm run build-win  # build installer (also build-mac / build-linux); output → dist/
```

There is no test suite, linter, or dev/watch step. After editing renderer code (`src/`), reload the window with **Ctrl+R**; after editing `main.js` or `preload.js`, fully restart with `npm start`. **F12** opens DevTools for the renderer.

## Architecture

NexusSQL is an Electron desktop MySQL/MariaDB client. There is **no framework and no build step for app code** — the renderer is plain HTML/CSS/vanilla JS. Three files form the process boundary, and a single feature usually touches all three:

- **main.js** — Electron main process. Owns all real database access via `mysql2/promise`. Holds connection state and registers every `ipcMain.handle` handler. The renderer never talks to MySQL directly.
- **preload.js** — the *only* bridge between processes. Runs with `contextIsolation: true` / `nodeIntegration: false`, so the renderer has no Node access. It exposes a fixed `window.api` surface via `contextBridge`. **Any new IPC channel must be added here** or the renderer cannot call it.
- **src/app.js** — renderer. All UI logic, the global `state` object, and the AI assistant. Calls `window.api.*` for everything that needs the OS or a database.

### Connection model (important)

Connections are **pools, not single connections** (`mysql.createPool`, `connectionLimit: 5`), to avoid stale "closed state" errors. Each live pool gets a string id `conn_<n>`; `main.js` keeps `pools[id]` and `poolConfigs[id]`. Every DB handler does `getConn(id)` → query → `conn.release()` in a `finally`. Disconnecting drains the pool with `pool.end()`.

The renderer separates **saved profiles** from **live pools**: `state.profiles[profileId]` holds persisted config (stable `p_<...>` ids), `state.profilePool[profileId]` maps a profile to its current `conn_<n>` pool, `state.activeProfile` is the selected profile, and `state.activeConn` is the pool id passed to every `db-*` call (`state.activeDB` is applied per-query via `USE`). Selecting a profile lazily connects via `ensurePool()`.

**Persistence:** saved profiles live in a JSON file in `app.getPath('userData')` (`connections.json`), which survives app uninstall/reinstall. `app.setName('NexusSQL')` pins that folder for both dev and packaged builds. Passwords are encrypted at rest with Electron `safeStorage` (OS keychain / Windows DPAPI), stored as `enc:<base64>` — never plaintext on disk; a `raw:<base64>` fallback is used only when no OS keychain is available. `connections-load` decrypts and returns plaintext to the renderer (in-memory only); `connections-save` re-encrypts. Use the 🗑 button (`deleteSavedConnection`) to remove a profile from disk; ⏏ (`disconnectCurrent`) just drops the pool and keeps the profile.

**Decryption failure is not an empty password — keep these two guards.** On Windows `safeStorage` uses Chromium OSCrypt (blobs start `enc:djEw…` = `v10`) whose key lives in `userData/Local State`; if that key is regenerated, or a macOS keychain is locked/denied, previously written blobs stop decrypting. Observed for real in this project — both saved passwords became undecryptable while fresh encrypt/decrypt round-trips still worked.
1. `tryDecryptPassword()` returns `{ value, failed }` and `loadProfilesFromDisk()` surfaces `passwordFailed: true`. Never collapse this back to a bare `''` — the app would silently connect with a blank credential and blame the server.
2. `connections-save` reads the existing file first and **preserves the stored blob** when an incoming profile has `passwordFailed && !password`. Without this, any routine save (rename, duplicate, deleting a sibling) permanently destroys the credential. Typing a real password still overwrites it, and a deliberate blank still clears it.
The renderer keeps the flag on the profile until a new password is typed, shows a `⚠ password` pill in the manager, pre-warns in the edit dialog, and `ensurePool()` explains the real cause instead of surfacing a bare "access denied".

**Saved Connections manager** (`🗂 Saved` → `openConnManager`): a row per profile with Connect / ✎ Edit / ⧉ Duplicate / 🗑 Delete. `openConnDialog(profileId)` doubles as the editor and **must keep the same profile id** — ids are what the MCP allowlist references, so a delete-and-recreate silently revokes the AI's access. `saveProfileRecord()` centralizes the write and drops any stale pool, since credentials may have changed. Saving no longer requires a reachable server: a failed connect offers to save the profile anyway. `deleteSavedConnection()` calls `mcpForgetProfile()` so a dead id doesn't linger in `allowedProfiles`.

**Keepalive:** `startPing()`/`pingNow()` poll `db-server-info` every 30s while connected and after each query, updating the status-bar latency/connection-count indicator (`#sbPing`).

### Query result serialization

`db-query` runs with `rowsAsArray: true` and manually serializes cells before returning them across IPC: `Date` → ISO-ish string, `Buffer` → hex, `bigint` → string, `null` stays `null`. SELECTs return `{ type: 'select', cols, rows }`; other statements return `{ type: 'exec', affectedRows, insertId, ... }`. The renderer branches on `res.type`.

### SQL identifier handling

Database/table names are interpolated directly into queries wrapped in backticks (e.g. `` 'SHOW FULL TABLES FROM `' + database + '`' `` in `main.js`). User SQL from the editor is sent verbatim. This is the existing pattern for the **read/browse** paths — be aware they are not parameterized.

The **row-editing write path is different and must stay that way**: `db-update-cell`, `db-insert-row`, and `db-delete-row` in `main.js` build SQL with mysql2 placeholders only — `??` for identifiers (db/table/column) and `?` for values. Never switch these to string concatenation; cell values are arbitrary user input.

### Editable results

A SELECT result is editable only when `resolveEditing()` (renderer) confirms it came from **one real table** (every column's `orgTable` matches, no computed/expression columns) and the result includes that table's full **primary key**. To support this, `db-query` returns rich column metadata (`orgName`, `orgTable`, `db`) and the renderer fetches the PK via `dbDescribeTable`. When editable, cells are double-click editable (→ UPDATE keyed by PK), rows get a delete button (→ DELETE), and "Add Row" opens a draft (→ INSERT, then the last SELECT is re-run so generated ids/defaults appear; an empty draft inserts a defaults-only row). Right-click a cell for `cellContextMenu` (Edit / Copy value / Set NULL / Duplicate row / Delete row). Otherwise the grid is read-only. The WHERE clause always uses the row's *original* PK values held in `state.lastResult.rows`.

Context-menu gotcha: the menu's close-listeners (`click`/`contextmenu` on `document`) **must** be registered inside a `setTimeout(…, 0)` — registering them synchronously makes them fire on the same event that's still bubbling to `document`, instantly closing the menu (the bug that made right-click appear dead). Clipboard writes go through the `clip-write` IPC channel (Electron `clipboard.writeText`), not the renderer Clipboard API.

### Variables tab (schema editing)

The sidebar tree is now **databases → tables only** — tables no longer expand to columns. Clicking a table calls `loadTable()`, which loads its data into the Data tab (`runQuery(overrideSql)` — note `runQuery` takes an optional SQL string so opening a table doesn't clobber the editor) **and** its columns into the **Variables** tab (`loadVariables()` → `state.varsTarget`). The results area now has a `Variables` res-tab beside Data; `renderVariables()` shows an editable column grid. Editing a cell (name/type/null/default), the per-row drop button, and "Add Column" all build `ALTER TABLE` statements that run via `db-alter-column` / `db-add-column` / `db-drop-column` **after a `confirm()`** (apply-directly-with-confirm; schema changes are **not** in the undo stack). Identifiers use `??`; DEFAULT values use `?`; the column **type** is raw DDL validated by `isSafeColumnType()` in `main.js` (rejects `;`, backtick, `--`). After any ALTER, `loadVariables()` re-describes and `refreshIfAffected()` re-runs the data query.

### AI assistant

`sendAI()` in `src/app.js` runs a small **agentic loop** (max 6 steps) and calls the model **directly from the renderer** via `fetch`. It is **dual-provider**: `callLLM()` dispatches to `callAnthropic()` (`/v1/messages`, `anthropic-dangerous-direct-browser-access: 'true'`, `thinking:{type:'adaptive'}` + `output_config.effort`) or `callOpenAI()` (`/v1/chat/completions`, `max_completion_tokens`). Provider, models, effort, and **per-provider API keys** are stored in `state.aiSettings`, persisted to `settings.json` in userData with keys encrypted via `safeStorage` (same mechanism as connection passwords). The settings modal (⚙ in the AI header) edits them.

The loop uses a provider-agnostic **JSON-action protocol** instead of native tool-calling: the system prompt (`buildAISystemPrompt()`) tells the model to emit a single ```` ```action ```` block with one JSON object. `parseAction()` extracts it. Action types: `query` (read-only — validated by `isReadOnlySQL()`, capped to 100 rows, run via `db-query`), and `update_cell`/`insert_row`/`delete_row` (each routed through `confirmAIEdit()` → a confirm card with Apply/Reject, then `applyAIEdit()` executes via the parameterized write IPCs). Each step's result is fed back as an `OBSERVATION` user message. A response with no action block is the final answer; ```` ```sql ```` in it becomes click-to-insert.

Two CSP entries must stay in `src/index.html`: `connect-src https://api.anthropic.com https://api.openai.com`. Dropping either silently breaks that provider.

### Undo

`state.undoStack` holds up to **3** inverse operations. Every structured edit (manual cell edit, set-NULL, delete, insert, duplicate, **and** AI-applied edits) calls `pushUndo()` with an inverse op (`update`→restore old value, `insert`→`delete` by PK, `delete`→`insert` full row). `undoLastEdit()` (↶ Undo button in the data toolbar) pops and replays the inverse through the same write IPCs. To capture old values for AI edits whose row isn't on screen, `db-get-row` fetches the row by PK (parameterized); `derivePkForUndo()` resolves an inserted row's PK from the supplied values or `insertId`. Raw SQL run from the editor is **not** undoable.

### Local MCP server

`mcp-server.js` (main process) lets an **external** AI — Claude Code, Claude Desktop, a local agent — drive the app's databases over MCP. It is a **hand-rolled Streamable HTTP + JSON-RPC implementation with zero npm dependencies**; do not add the MCP SDK for it. Verified working against real Claude Code (`claude mcp list` → ✓ Connected).

- **Transport:** `POST /mcp` (JSON-RPC, replies as plain JSON — never SSE), `GET /mcp` → 405, `DELETE /mcp` ends the session, plus an unauthenticated `GET /health` probe. Bound to **127.0.0.1 only**. Methods: `initialize`, `ping`, `tools/list`, `tools/call`, and empty `resources/list` / `prompts/list` so probing clients don't error.
- **Auth:** `Authorization: Bearer <token>`, compared with `crypto.timingSafeEqual`. Requests carrying a non-localhost `Origin` are rejected (DNS-rebinding guard). The token is generated on first load and **persisted immediately** — if it only lived in memory every restart would mint a new one and silently break the user's configured client.
- **Config:** `userData/mcp.json`, token encrypted with the same `safeStorage` helpers as connection passwords (`enc:` / `raw:` fallback). Shape: `{ autoStart, port, token, connectionAccess, allowedProfiles, permissionLevel, customMode, customTools, approval, dangerousEnabled }`.
- **Permission levels** → tool tiers: `read` → read tools; `limited` → + row writes; `full` → + column DDL; `complete` → + `execute_sql`; `custom` → explicit whitelist/blacklist over all tools.
- **`dangerousEnabled` is the only thing that unlocks the `danger` tier** (`execute_sql`, arbitrary unvalidated SQL). It is enforced in **three** places — `allowedToolNames()` filters the tier out, `effectiveLevel()` degrades `complete` → `full`, and `loadMcpConfig()` / `mcp-save` rewrite the level — so a hand-edited `mcp.json` or a custom whitelist cannot smuggle it in. Keep all three.
- **Connection scope:** `connectionAccess: 'all' | 'selected'`. A profile saved with a `database` **confines MCP to that database** (`resolveDatabase()` throws on any other), so sharing one connection never exposes the rest of the server.
- **Approvals:** `always` / `writes` / `never`. `requestApproval()` in `main.js` sends `mcp-approval-request`, focuses the window, and **auto-denies after 60s**; the renderer answers with `allow` / `allow-session` / `deny`. `allow-session` grants that one tool until the server stops. Denials and timeouts return a JSON-RPC error worded so the model reports rather than retries.
- **Shared code path:** MCP calls the *same* `dbUpdateCell` / `dbInsertRow` / `dbDeleteRow` / `db*Column` functions the UI does, so the `??`/`?` parameterization and `isSafeColumnType()` apply automatically. `db-*` IPC handlers are now thin delegates to these named functions — keep that split. `run_select` adds `isReadOnlySQL()` (strips comments/strings first, then allow-lists the leading keyword and deny-lists mutating ones) and a 200-row default / 1000-row cap.
- **Pools:** MCP owns its own pools keyed by profile id (`mcpPools`, `connectionLimit: 3`) rather than borrowing the renderer's, so it works whether or not the UI is connected. Saving settings drops them.
- Renderer half is **`src/mcp.js`** (loaded after `app.js`, shares `state` / `esc()` / `setStatus()`): the settings modal, the activity log, and the approval dialog.

### UI conventions

`src/app.js` uses a single mutable `state` object and renders by rebuilding DOM/innerHTML strings — there is no virtual DOM or reactivity. Menu accelerators (Ctrl+T new tab, Ctrl+Enter run, Ctrl+S save, Ctrl+O open) are defined in `main.js` and dispatched to the renderer as `menu-*` IPC events wired up in `bindMenuEvents()`. The schema sidebar lazy-loads databases → tables on expand (tracked in `state.treeExpanded`); columns are shown in the Variables tab, not the tree.
