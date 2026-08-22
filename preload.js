'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Menu events
  onMenuNewTab:    (cb) => ipcRenderer.on('menu-new-tab', cb),
  onMenuRun:       (cb) => ipcRenderer.on('menu-run', cb),
  onMenuFormat:    (cb) => ipcRenderer.on('menu-format', cb),
  onMenuKill:      (cb) => ipcRenderer.on('menu-kill', cb),
  onFileOpened:    (cb) => ipcRenderer.on('file-opened', (_, d) => cb(d)),
  onSaveRequested: (cb) => ipcRenderer.on('save-requested', (_, p) => cb(p)),
  onMenuMcp:       (cb) => ipcRenderer.on('menu-mcp', cb),

  // File ops
  saveFile:  (filePath, content) => ipcRenderer.invoke('save-file', { filePath, content }),
  exportCSV: (data, filename)    => ipcRenderer.invoke('export-csv', { data, filename }),
  clipboardWrite: (text)         => ipcRenderer.invoke('clip-write', text),

  // Saved connection profiles (persisted to userData)
  loadConnections: ()         => ipcRenderer.invoke('connections-load'),
  saveConnections: (profiles) => ipcRenderer.invoke('connections-save', profiles),

  // AI settings (provider + encrypted API keys)
  loadSettings: ()  => ipcRenderer.invoke('settings-load'),
  saveSettings: (s) => ipcRenderer.invoke('settings-save', s),

  // Fetch one row by PK (for undo capture)
  dbGetRow: (id, database, table, where) => ipcRenderer.invoke('db-get-row', { id, database, table, where }),

  // Database ops
  dbConnect:       (config)              => ipcRenderer.invoke('db-connect', config),
  dbDisconnect:    (id)                  => ipcRenderer.invoke('db-disconnect', id),
  dbListDatabases: (id)                  => ipcRenderer.invoke('db-list-databases', id),
  dbListTables:    (id, database)        => ipcRenderer.invoke('db-list-tables', { id, database }),
  dbDescribeTable: (id, database, table) => ipcRenderer.invoke('db-describe-table', { id, database, table }),
  dbQuery:         (id, database, sql)   => ipcRenderer.invoke('db-query', { id, database, sql }),
  dbTableCount:    (id, database, table) => ipcRenderer.invoke('db-table-count', { id, database, table }),
  dbServerInfo:    (id)                  => ipcRenderer.invoke('db-server-info', id),
  dbExplain:       (id, database, sql)   => ipcRenderer.invoke('db-explain', { id, database, sql }),

  // Row editing
  dbUpdateCell:    (id, database, table, column, value, where) => ipcRenderer.invoke('db-update-cell', { id, database, table, column, value, where }),
  dbInsertRow:     (id, database, table, values)               => ipcRenderer.invoke('db-insert-row',  { id, database, table, values }),
  dbDeleteRow:     (id, database, table, where)                => ipcRenderer.invoke('db-delete-row',  { id, database, table, where }),

  // Schema editing (ALTER TABLE)
  dbAlterColumn:   (id, database, table, spec) => ipcRenderer.invoke('db-alter-column', { id, database, table, ...spec }),
  dbAddColumn:     (id, database, table, spec) => ipcRenderer.invoke('db-add-column',   { id, database, table, ...spec }),
  dbDropColumn:    (id, database, table, name) => ipcRenderer.invoke('db-drop-column',  { id, database, table, name }),

  // ── Local MCP server ──
  mcpGet:         ()    => ipcRenderer.invoke('mcp-get'),
  mcpSave:        (cfg) => ipcRenderer.invoke('mcp-save', cfg),
  mcpStart:       ()    => ipcRenderer.invoke('mcp-start'),
  mcpStop:        ()    => ipcRenderer.invoke('mcp-stop'),
  mcpRegenToken:  ()    => ipcRenderer.invoke('mcp-regen-token'),
  // Approval prompts: main asks, the renderer answers (or main cancels on timeout).
  onMcpApproval:       (cb) => ipcRenderer.on('mcp-approval-request', (_, d) => cb(d)),
  onMcpApprovalCancel: (cb) => ipcRenderer.on('mcp-approval-cancel', (_, d) => cb(d)),
  mcpApprovalRespond:  (reqId, decision) => ipcRenderer.send('mcp-approval-response', { reqId, decision }),
  onMcpLog:            (cb) => ipcRenderer.on('mcp-log', (_, d) => cb(d)),
});
