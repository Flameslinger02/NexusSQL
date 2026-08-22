'use strict';

const { app, BrowserWindow, ipcMain, Menu, dialog, safeStorage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { createMcpServer, TOOLS: MCP_TOOLS } = require('./mcp-server');

// Keep dev (`electron .`) and packaged builds on the same userData folder so
// saved connections persist across reinstalls in a predictable location.
app.setName('NexusSQL');

let mainWindow;
// Saved connection profiles live in userData (e.g. %APPDATA%/NexusSQL on Windows),
// which survives app uninstall/reinstall — it is NOT inside the app bundle.
const connectionsFile = () => path.join(app.getPath('userData'), 'connections.json');
// Use pools instead of single connections — prevents "closed state" errors
const pools = {};
const poolConfigs = {};
let connCounter = 0;

// ─── WINDOW ──────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'NexusSQL',
    backgroundColor: '#0e1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'New Query Tab', accelerator: 'CmdOrCtrl+T', click: () => mainWindow.webContents.send('menu-new-tab') },
        { label: 'Open SQL File…', accelerator: 'CmdOrCtrl+O', click: openFile },
        { label: 'Save Query…', accelerator: 'CmdOrCtrl+S', click: saveFile },
        { type: 'separator' },
        { label: 'MCP Server…', click: () => mainWindow.webContents.send('menu-mcp') },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'Query',
      submenu: [
        { label: 'Run Query', accelerator: 'CmdOrCtrl+Return', click: () => mainWindow.webContents.send('menu-run') },
        { label: 'Format SQL', accelerator: 'CmdOrCtrl+Shift+F', click: () => mainWindow.webContents.send('menu-format') },
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle DevTools', accelerator: 'F12', click: () => mainWindow.webContents.toggleDevTools() },
        { role: 'reload' }, { type: 'separator' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
}

// ─── FILE OPS ────────────────────────────────────────────────
async function openFile() {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'SQL Files', extensions: ['sql', 'txt'] }],
    properties: ['openFile']
  });
  if (filePaths?.[0]) {
    const content = fs.readFileSync(filePaths[0], 'utf8');
    mainWindow.webContents.send('file-opened', { content, filePath: filePaths[0] });
  }
}

async function saveFile() {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'SQL Files', extensions: ['sql'] }],
    defaultPath: 'query.sql'
  });
  if (filePath) mainWindow.webContents.send('save-requested', filePath);
}

ipcMain.handle('save-file', async (_, { filePath, content }) => {
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true };
});

ipcMain.handle('clip-write', (_, text) => {
  clipboard.writeText(String(text == null ? '' : text));
  return { ok: true };
});

ipcMain.handle('export-csv', async (_, { data, filename }) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: filename || 'results.csv',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  if (filePath) { fs.writeFileSync(filePath, data, 'utf8'); return { ok: true }; }
  return { ok: false };
});

// ─── SAVED CONNECTIONS (persisted to userData, passwords encrypted) ──
// On disk each profile stores `encPassword` (base64 of an OS-encrypted blob)
// instead of a plaintext `password`. We decrypt on load and hand the renderer
// plaintext only in memory.
function encryptPassword(plain) {
  if (!plain) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(plain).toString('base64');
    }
  } catch (_) {}
  return 'raw:' + Buffer.from(plain, 'utf8').toString('base64'); // fallback if no OS keychain
}
// Decryption can fail for reasons that are NOT "there is no password": the OS
// keychain may be locked or denied, or the OSCrypt key in userData/Local State
// may no longer match the one that wrote the blob. Those cases must be
// distinguishable from an empty password, or we silently connect with a blank
// credential and then overwrite the stored one with nothing.
function tryDecryptPassword(stored) {
  if (!stored) return { value: '', failed: false };
  try {
    if (stored.startsWith('enc:')) return { value: safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')), failed: false };
    if (stored.startsWith('raw:')) return { value: Buffer.from(stored.slice(4), 'base64').toString('utf8'), failed: false };
  } catch (_) {}
  return { value: '', failed: true };
}

function decryptPassword(stored) { return tryDecryptPassword(stored).value; }

// Read profiles straight off disk with passwords decrypted. Used by both the
// renderer IPC handler and the MCP server (which has no renderer state).
function loadProfilesFromDisk() {
  try {
    const profiles = JSON.parse(fs.readFileSync(connectionsFile(), 'utf8'));
    if (!Array.isArray(profiles)) return [];
    return profiles.map(p => {
      const dec = tryDecryptPassword(p.encPassword);
      return {
        id: p.id, name: p.name, host: p.host, port: p.port,
        user: p.user, database: p.database || null, ssl: !!p.ssl,
        password: dec.value,
        passwordFailed: dec.failed,   // stored but unreadable — needs re-entry
      };
    });
  } catch (_) {
    return [];
  }
}

ipcMain.handle('connections-load', async () => {
  try {
    if (!fs.existsSync(connectionsFile())) return { ok: true, profiles: [] };
    return { ok: true, profiles: loadProfilesFromDisk() };
  } catch (err) {
    return { ok: false, error: err.message, profiles: [] };
  }
});

ipcMain.handle('connections-save', async (_, profiles) => {
  try {
    // What's already on disk, so an unreadable password is never destroyed by
    // a routine save (rename, reorder, editing an unrelated field).
    const stored = {};
    try {
      const prev = JSON.parse(fs.readFileSync(connectionsFile(), 'utf8'));
      if (Array.isArray(prev)) prev.forEach(p => { if (p.id) stored[p.id] = p.encPassword || ''; });
    } catch (_) {}

    const onDisk = (profiles || []).map(p => {
      // Couldn't be decrypted and the user hasn't typed a replacement → keep the
      // original blob. A temporarily locked keychain must not wipe credentials.
      const preserve = p.passwordFailed && !p.password && stored[p.id];
      return {
        id: p.id, name: p.name, host: p.host, port: p.port,
        user: p.user, database: p.database || null, ssl: !!p.ssl,
        encPassword: preserve ? stored[p.id] : encryptPassword(p.password || ''),
      };
    });
    fs.mkdirSync(path.dirname(connectionsFile()), { recursive: true });
    fs.writeFileSync(connectionsFile(), JSON.stringify(onDisk, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── AI SETTINGS (persisted to userData; API keys encrypted) ────────
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

ipcMain.handle('settings-load', async () => {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return {
      ok: true,
      settings: {
        provider: raw.provider || 'anthropic',
        anthropicModel: raw.anthropicModel || 'claude-sonnet-4-6',
        openaiModel: raw.openaiModel || 'gpt-5-mini',
        effort: raw.effort || 'medium',
        anthropicKey: decryptPassword(raw.encAnthropicKey),
        openaiKey: decryptPassword(raw.encOpenaiKey),
      },
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, settings: null };
    return { ok: false, error: err.message, settings: null };
  }
});

ipcMain.handle('settings-save', async (_, s) => {
  try {
    const onDisk = {
      provider: s.provider || 'anthropic',
      anthropicModel: s.anthropicModel || 'claude-sonnet-4-6',
      openaiModel: s.openaiModel || 'gpt-5-mini',
      effort: s.effort || 'medium',
      encAnthropicKey: encryptPassword(s.anthropicKey || ''),
      encOpenaiKey: encryptPassword(s.openaiKey || ''),
    };
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(onDisk, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── HELPER: get a pooled connection ─────────────────────────
async function getConn(id) {
  if (!pools[id]) throw new Error('No connection pool for id: ' + id);
  return pools[id].getConnection();
}

function serializeCell(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
  if (Buffer.isBuffer(v)) return v.toString('hex');
  if (typeof v === 'bigint') return v.toString();
  return v;
}

// ─── DATABASE OPERATIONS ─────────────────────────────────────
// These are plain functions so the MCP server can call the exact same code the
// UI does — in particular the parameterized write paths below. Every one of
// them resolves to { ok, ... } rather than throwing.

async function dbConnect(config) {
  try {
    const pool = mysql.createPool({
      host: config.host,
      port: parseInt(config.port) || 3306,
      user: config.user,
      password: config.password,
      database: config.database || undefined,
      waitForConnections: true,
      connectionLimit: config.connectionLimit || 5,
      connectTimeout: 10000,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      // Keep connections alive
      enableKeepAlive: true,
      keepAliveInitialDelay: 30000,
    });

    // Test by getting and immediately releasing a connection
    const testConn = await pool.getConnection();
    await testConn.ping();
    testConn.release();

    connCounter++;
    const id = 'conn_' + connCounter;
    pools[id] = pool;
    poolConfigs[id] = config;

    return { ok: true, id, server: config.host + ':' + (config.port || 3306) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function dbDisconnect(id) {
  if (pools[id]) {
    try { await pools[id].end(); } catch (_) {}
    delete pools[id];
    delete poolConfigs[id];
  }
  return { ok: true };
}

async function dbListDatabases(id) {
  let conn;
  try {
    conn = await getConn(id);
    const [rows] = await conn.query('SHOW DATABASES');
    return { ok: true, databases: rows.map(r => Object.values(r)[0]) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

async function dbListTables(id, database) {
  let conn;
  try {
    conn = await getConn(id);
    const [rows] = await conn.query('SHOW FULL TABLES FROM `' + database + '`');
    const tables = rows.map(r => {
      const vals = Object.values(r);
      return { name: vals[0], type: vals[1] };
    });
    return { ok: true, tables };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

async function dbDescribeTable(id, database, table) {
  let conn;
  try {
    conn = await getConn(id);
    const [rows] = await conn.query('DESCRIBE `' + database + '`.`' + table + '`');
    return { ok: true, columns: rows };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

async function dbQuery(id, database, sql) {
  let conn;
  try {
    conn = await getConn(id);
    if (database) await conn.query('USE `' + database + '`');

    const start = Date.now();
    const [rows, fields] = await conn.query({ sql, rowsAsArray: true });
    const elapsed = Date.now() - start;

    if (fields && Array.isArray(fields)) {
      const cols = fields.map(f => ({
        name: f.name,
        orgName: f.orgName,
        table: f.table,
        orgTable: f.orgTable,
        db: f.db,
        type: f.type,
      }));
      const serialized = rows.map(row => row.map(serializeCell));
      return { ok: true, type: 'select', cols, rows: serialized, elapsed };
    }

    return {
      ok: true,
      type: 'exec',
      affectedRows: rows.affectedRows,
      insertId: rows.insertId ? rows.insertId.toString() : null,
      info: rows.info || '',
      elapsed,
    };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  } finally {
    if (conn) conn.release();
  }
}

async function dbExplain(id, database, sql) {
  let conn;
  try {
    conn = await getConn(id);
    if (database) await conn.query('USE `' + database + '`');
    const [rows, fields] = await conn.query({ sql: 'EXPLAIN ' + sql, rowsAsArray: true });
    const cols = fields.map(f => f.name);
    const serialized = rows.map(row => row.map(serializeCell));
    return { ok: true, cols, rows: serialized };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

async function dbServerInfo(id) {
  let conn;
  try {
    conn = await getConn(id);
    const [[ver]] = await conn.query('SELECT VERSION() as version');
    const [[uptime]] = await conn.query('SHOW STATUS LIKE "Uptime"');
    const [[threads]] = await conn.query('SHOW STATUS LIKE "Threads_connected"');
    return { ok: true, version: ver.version, uptime: uptime.Value, threads: threads.Value };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

async function dbTableCount(id, database, table) {
  let conn;
  try {
    conn = await getConn(id);
    const [rows] = await conn.query('SELECT COUNT(*) as cnt FROM `' + database + '`.`' + table + '`');
    return { ok: true, count: Number(rows[0].cnt) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

// Fetch a single row by primary key (parameterized) — used to capture
// before/after values so AI/manual edits can be reliably undone.
async function dbGetRow(id, database, table, where) {
  let conn;
  try {
    const cols = Object.keys(where || {});
    if (!cols.length) return { ok: false, error: 'no key columns' };
    conn = await getConn(id);
    const whereClause = cols.map(() => '?? = ?').join(' AND ');
    const sql = `SELECT * FROM ??.?? WHERE ${whereClause} LIMIT 1`;
    const params = [database, table, ...cols.flatMap(c => [c, where[c]])];
    const [rows] = await conn.query(sql, params);
    if (!rows.length) return { ok: true, row: null };
    const row = {};
    for (const [k, v] of Object.entries(rows[0])) row[k] = serializeCell(v);
    return { ok: true, row };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

// ─── ROW EDITING (parameterized — identifiers via ??, values via ?) ──

// Update a single cell. `where` is an object of pk column → original value.
async function dbUpdateCell(id, database, table, column, value, where) {
  let conn;
  try {
    const whereCols = Object.keys(where || {});
    if (!whereCols.length) throw new Error('No primary key to identify the row');
    conn = await getConn(id);
    const whereClause = whereCols.map(() => '?? = ?').join(' AND ');
    const sql = `UPDATE ??.?? SET ?? = ? WHERE ${whereClause} LIMIT 1`;
    const params = [database, table, column, value, ...whereCols.flatMap(c => [c, where[c]])];
    const [res] = await conn.query(sql, params);
    return { ok: true, affectedRows: res.affectedRows };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

// Insert a row. `values` is an object of column → value.
async function dbInsertRow(id, database, table, values) {
  let conn;
  try {
    const cols = Object.keys(values || {});
    conn = await getConn(id);
    let sql, params;
    if (!cols.length) {
      // No values supplied → insert a row using all column defaults
      sql = 'INSERT INTO ??.?? () VALUES ()';
      params = [database, table];
    } else {
      const placeholders = cols.map(() => '?').join(', ');
      const colList = cols.map(() => '??').join(', ');
      sql = `INSERT INTO ??.?? (${colList}) VALUES (${placeholders})`;
      params = [database, table, ...cols, ...cols.map(c => values[c])];
    }
    const [res] = await conn.query(sql, params);
    return { ok: true, affectedRows: res.affectedRows, insertId: res.insertId ? res.insertId.toString() : null };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

// Delete a row identified by its primary key.
async function dbDeleteRow(id, database, table, where) {
  let conn;
  try {
    const whereCols = Object.keys(where || {});
    if (!whereCols.length) throw new Error('No primary key to identify the row');
    conn = await getConn(id);
    const whereClause = whereCols.map(() => '?? = ?').join(' AND ');
    const sql = `DELETE FROM ??.?? WHERE ${whereClause} LIMIT 1`;
    const params = [database, table, ...whereCols.flatMap(c => [c, where[c]])];
    const [res] = await conn.query(sql, params);
    return { ok: true, affectedRows: res.affectedRows };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

// ─── SCHEMA EDITING (ALTER TABLE) ────────────────────────────
// Identifiers go through ?? placeholders; DEFAULT values through ?.
// The column TYPE is raw DDL (can't be parameterized), so validate it tightly.
function isSafeColumnType(type) {
  if (!type || typeof type !== 'string') return false;
  if (/[;`]|--/.test(type)) return false;  // block statement injection
  return /^[A-Za-z][A-Za-z0-9_]*(\s*\([^()]*\))?(\s+(unsigned|zerofill|signed))*$/i.test(type.trim());
}

function defaultClause(sql, params, hasDefault, defaultVal) {
  if (!hasDefault) return sql;
  if (defaultVal === null || defaultVal === undefined) return sql + ' DEFAULT NULL';
  params.push(defaultVal);
  return sql + ' DEFAULT ?';
}

async function dbAlterColumn(id, database, table, { oldName, newName, type, nullable, hasDefault, defaultVal, autoIncrement }) {
  let conn;
  try {
    if (!isSafeColumnType(type)) return { ok: false, error: 'Invalid or unsafe column type: ' + type };
    conn = await getConn(id);
    let sql = 'ALTER TABLE ??.?? CHANGE ?? ?? ' + type + (nullable ? ' NULL' : ' NOT NULL');
    const params = [database, table, oldName, newName];
    sql = defaultClause(sql, params, hasDefault, defaultVal);
    if (autoIncrement) sql += ' AUTO_INCREMENT';  // CHANGE re-states the full def — preserve it
    await conn.query(sql, params);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

async function dbAddColumn(id, database, table, { name, type, nullable, hasDefault, defaultVal }) {
  let conn;
  try {
    if (!isSafeColumnType(type)) return { ok: false, error: 'Invalid or unsafe column type: ' + type };
    conn = await getConn(id);
    let sql = 'ALTER TABLE ??.?? ADD COLUMN ?? ' + type + (nullable ? ' NULL' : ' NOT NULL');
    const params = [database, table, name];
    sql = defaultClause(sql, params, hasDefault, defaultVal);
    await conn.query(sql, params);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

async function dbDropColumn(id, database, table, name) {
  let conn;
  try {
    conn = await getConn(id);
    await conn.query('ALTER TABLE ??.?? DROP COLUMN ??', [database, table, name]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

// ─── DATABASE IPC ─────────────────────────────────────────────
ipcMain.handle('db-connect',        (_, config)                    => dbConnect(config));
ipcMain.handle('db-disconnect',     (_, id)                        => dbDisconnect(id));
ipcMain.handle('db-list-databases', (_, id)                        => dbListDatabases(id));
ipcMain.handle('db-list-tables',    (_, { id, database })          => dbListTables(id, database));
ipcMain.handle('db-describe-table', (_, { id, database, table })   => dbDescribeTable(id, database, table));
ipcMain.handle('db-query',          (_, { id, database, sql })     => dbQuery(id, database, sql));
ipcMain.handle('db-explain',        (_, { id, database, sql })     => dbExplain(id, database, sql));
ipcMain.handle('db-server-info',    (_, id)                        => dbServerInfo(id));
ipcMain.handle('db-table-count',    (_, { id, database, table })   => dbTableCount(id, database, table));
ipcMain.handle('db-get-row',        (_, { id, database, table, where }) => dbGetRow(id, database, table, where));

ipcMain.handle('db-update-cell', (_, { id, database, table, column, value, where }) => dbUpdateCell(id, database, table, column, value, where));
ipcMain.handle('db-insert-row',  (_, { id, database, table, values })               => dbInsertRow(id, database, table, values));
ipcMain.handle('db-delete-row',  (_, { id, database, table, where })                => dbDeleteRow(id, database, table, where));

ipcMain.handle('db-alter-column', (_, { id, database, table, ...spec }) => dbAlterColumn(id, database, table, spec));
ipcMain.handle('db-add-column',   (_, { id, database, table, ...spec }) => dbAddColumn(id, database, table, spec));
ipcMain.handle('db-drop-column',  (_, { id, database, table, name })    => dbDropColumn(id, database, table, name));

// ═══════════════════════════════════════════════════════════════
//  MCP SERVER
// ═══════════════════════════════════════════════════════════════
// Config lives in userData/mcp.json. The bearer token is encrypted at rest with
// the same safeStorage mechanism as connection passwords — it is effectively a
// key to every database the user has shared.
const mcpFile = () => path.join(app.getPath('userData'), 'mcp.json');

const MCP_DEFAULTS = {
  autoStart: false,
  port: 4319,
  token: '',
  connectionAccess: 'selected',   // 'all' | 'selected'
  allowedProfiles: [],
  permissionLevel: 'read',        // 'read' | 'limited' | 'full' | 'complete' | 'custom'
  customMode: 'whitelist',        // 'whitelist' | 'blacklist'
  customTools: [],
  approval: 'writes',             // 'always' | 'writes' | 'never'
  dangerousEnabled: false,
};

let mcpConfig = { ...MCP_DEFAULTS };
const mcpLog = [];               // ring buffer of recent activity, newest last
const mcpPools = {};             // profileId → pool id in `pools`

function newToken() { return crypto.randomBytes(24).toString('hex'); }

function loadMcpConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(mcpFile(), 'utf8'));
    mcpConfig = {
      ...MCP_DEFAULTS,
      ...raw,
      token: decryptPassword(raw.encToken) || '',
    };
    delete mcpConfig.encToken;
  } catch (_) {
    mcpConfig = { ...MCP_DEFAULTS };
  }
  // Complete Access is meaningless without the dangerous toggle — never let a
  // hand-edited config file grant it.
  if (mcpConfig.permissionLevel === 'complete' && !mcpConfig.dangerousEnabled) {
    mcpConfig.permissionLevel = 'full';
  }
  // A generated token must be written back immediately. If it only lived in
  // memory, every restart would mint a new one and silently break whatever
  // client the user had already configured.
  if (!mcpConfig.token) {
    mcpConfig.token = newToken();
    try { saveMcpConfig(mcpConfig); } catch (_) {}
  }
  return mcpConfig;
}

function saveMcpConfig(cfg) {
  const { token, ...rest } = cfg;
  const onDisk = { ...rest, encToken: encryptPassword(token || '') };
  fs.mkdirSync(path.dirname(mcpFile()), { recursive: true });
  fs.writeFileSync(mcpFile(), JSON.stringify(onDisk, null, 2), 'utf8');
}

function pushMcpLog(entry) {
  const row = { time: new Date().toISOString(), tool: '—', connection: '', status: 'ok', summary: '', ...entry };
  mcpLog.push(row);
  if (mcpLog.length > 200) mcpLog.shift();
  try { mainWindow?.webContents.send('mcp-log', row); } catch (_) {}
}

// ── approval bridge ──
// A tool call parks here until the renderer answers or 60s elapses.
const APPROVAL_TIMEOUT = 60000;
const pendingApprovals = new Map();

function requestApproval(payload) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return resolve({ allowed: false, reason: 'the NexusSQL window is not open' });
    }
    const reqId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pendingApprovals.delete(reqId);
      try { mainWindow?.webContents.send('mcp-approval-cancel', { reqId }); } catch (_) {}
      resolve({ allowed: false, reason: 'timeout' });
    }, APPROVAL_TIMEOUT);

    pendingApprovals.set(reqId, { resolve, timer });

    // Pull the window forward — the user is probably looking at their editor.
    try {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      if (process.platform === 'win32') mainWindow.flashFrame(true);
    } catch (_) {}

    mainWindow.webContents.send('mcp-approval-request', {
      reqId, timeoutMs: APPROVAL_TIMEOUT, ...payload,
    });
  });
}

ipcMain.on('mcp-approval-response', (_, { reqId, decision }) => {
  const pending = pendingApprovals.get(reqId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingApprovals.delete(reqId);
  try { if (process.platform === 'win32') mainWindow?.flashFrame(false); } catch (_) {}
  pending.resolve({
    allowed: decision === 'allow' || decision === 'allow-session',
    decision,
    reason: decision === 'deny' ? 'denied by user' : undefined,
  });
});

// ── MCP-owned connection pools ──
// The MCP server keeps its own small pools keyed by profile id rather than
// borrowing the renderer's, so it works whether or not the UI is connected.
async function poolForProfile(profile) {
  const existing = mcpPools[profile.id];
  if (existing && pools[existing]) return existing;
  const res = await dbConnect({ ...profile, connectionLimit: 3 });
  if (!res.ok) throw new Error('Could not connect to "' + profile.name + '": ' + res.error);
  mcpPools[profile.id] = res.id;
  return res.id;
}

async function dropMcpPools() {
  for (const [profileId, poolId] of Object.entries(mcpPools)) {
    await dbDisconnect(poolId);
    delete mcpPools[profileId];
  }
}

const mcpServer = createMcpServer({
  appVersion: app.getVersion(),
  getConfig: () => mcpConfig,
  getProfiles: () => loadProfilesFromDisk(),
  requestApproval,
  log: pushMcpLog,
  db: {
    poolForProfile,
    listDatabases: dbListDatabases,
    listTables: dbListTables,
    describeTable: dbDescribeTable,
    query: dbQuery,
    tableCount: dbTableCount,
    updateCell: dbUpdateCell,
    insertRow: dbInsertRow,
    deleteRow: dbDeleteRow,
    alterColumn: dbAlterColumn,
    addColumn: dbAddColumn,
    dropColumn: dbDropColumn,
  },
});

function mcpStatus() {
  const s = mcpServer.status();
  return {
    ...s,
    url: s.running ? `http://127.0.0.1:${s.port}/mcp` : null,
    config: mcpConfig,
    tools: MCP_TOOLS.map(t => ({ name: t.name, tier: t.tier, description: t.description })),
  };
}

ipcMain.handle('mcp-get', async () => ({ ok: true, ...mcpStatus(), log: mcpLog.slice(-100) }));

ipcMain.handle('mcp-save', async (_, cfg) => {
  try {
    const next = { ...mcpConfig, ...cfg };
    if (next.permissionLevel === 'complete' && !next.dangerousEnabled) next.permissionLevel = 'full';
    // Turning the danger toggle off must immediately revoke Complete Access.
    if (!next.dangerousEnabled && mcpConfig.permissionLevel === 'complete') next.permissionLevel = 'full';
    next.port = Math.min(Math.max(parseInt(next.port) || MCP_DEFAULTS.port, 1024), 65535);
    if (!next.token) next.token = newToken();
    mcpConfig = next;
    saveMcpConfig(mcpConfig);
    // Connection scope may have changed — force fresh pools next call.
    await dropMcpPools();
    mcpServer.clearSessionGrants();
    return { ok: true, ...mcpStatus() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mcp-start', async () => {
  const res = await mcpServer.start(mcpConfig.port);
  if (res.ok) pushMcpLog({ status: 'ok', summary: `Server listening on 127.0.0.1:${res.port}` });
  else pushMcpLog({ status: 'error', summary: res.error });
  return { ...res, ...mcpStatus() };
});

ipcMain.handle('mcp-stop', async () => {
  await mcpServer.stop();
  await dropMcpPools();
  pushMcpLog({ status: 'ok', summary: 'Server stopped' });
  return { ok: true, ...mcpStatus() };
});

ipcMain.handle('mcp-regen-token', async () => {
  mcpConfig.token = newToken();
  saveMcpConfig(mcpConfig);
  pushMcpLog({ status: 'ok', summary: 'Access token regenerated — existing clients must be re-added' });
  return { ok: true, ...mcpStatus() };
});

// ─── APP LIFECYCLE ───────────────────────────────────────────
app.whenReady().then(async () => {
  createWindow();
  loadMcpConfig();
  if (mcpConfig.autoStart) {
    const res = await mcpServer.start(mcpConfig.port);
    pushMcpLog(res.ok
      ? { status: 'ok', summary: `Server auto-started on 127.0.0.1:${res.port}` }
      : { status: 'error', summary: 'Auto-start failed: ' + res.error });
  }
});

app.on('window-all-closed', () => {
  mcpServer.stop();
  Object.values(pools).forEach(pool => { try { pool.end(); } catch (_) {} });
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
