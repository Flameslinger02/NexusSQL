'use strict';

// ─── STATE ───────────────────────────────────────────────────
const state = {
  profiles: {},      // profileId -> saved { id, name, host, port, user, password, database, ssl } (persisted)
  profilePool: {},   // profileId -> live pool id (conn_N) for this session only
  activeProfile: null, // current saved-profile id
  activeConn: null,  // current live pool id (used by all db-* calls)
  activeDB: null,    // selected database name
  pingTimer: null,   // periodic keepalive/refresh interval
  tabs: {},
  currentTab: null,
  tabCounter: 0,
  treeExpanded: {},
  treeLoaded: {},    // track which nodes have been loaded
  queryHistory: [],
  lastResult: null,
  lastExplain: null,
  lastEditTarget: null,  // { db, table, pkCols, allCols, colIndexByName, schema } when result is editable
  draftRow: false,       // whether an unsaved "add row" is open
  sortCol: null,
  sortDir: 1,
  aiSettings: { provider: 'anthropic', anthropicModel: 'claude-sonnet-4-6', openaiModel: 'gpt-5-mini', effort: 'medium', anthropicKey: '', openaiKey: '' },
  undoStack: [],         // inverse ops for the last few structured edits (cap 3)
  varsTarget: null,      // { db, table, columns } shown in the Variables tab
  varsDraft: false,      // whether an unsaved "add column" row is open
};

// ─── INIT ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  newTab('-- Welcome to NexusSQL\n-- Connect to a MySQL/MariaDB server using "+ Connection"\n-- Then select a database and run your queries\n\nSELECT 1 + 1 AS result;', 'welcome.sql');
  updateLines();
  bindMenuEvents();
  bindResizers();
  bindModeButtons();
  loadSavedConnections();
  loadAISettings();
  // Editor starts hidden — Ctrl+E toggles the bottom query drawer
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); toggleEditor(); }
  });
});

// ─── EDITOR DRAWER ───────────────────────────────────────────
function toggleEditor(force) {
  const drawer = document.getElementById('editorDrawer');
  const resizer = document.getElementById('editorResizer');
  const btn = document.getElementById('editorToggleBtn');
  const willOpen = typeof force === 'boolean' ? force : !drawer.classList.contains('open');
  drawer.classList.toggle('open', willOpen);
  resizer.classList.toggle('open', willOpen);
  btn.classList.toggle('active', willOpen);
  if (willOpen) { updateLines(); document.getElementById('editor').focus(); }
}

function bindMenuEvents() {
  if (!window.api) return;
  window.api.onMenuNewTab(() => { newTab(); toggleEditor(true); });
  window.api.onMenuRun(() => runQuery());
  window.api.onMenuFormat(() => formatSQL());
  window.api.onMenuKill(() => {});
  window.api.onFileOpened(({ content, filePath }) => {
    const name = filePath.replace(/\\/g, '/').split('/').pop();
    newTab(content, name);
    toggleEditor(true);
  });
  window.api.onSaveRequested(async (filePath) => {
    await window.api.saveFile(filePath, getEditorValue());
    if (state.tabs[state.currentTab]) state.tabs[state.currentTab].unsaved = false;
    renderTabBar();
  });
}

// ─── CONNECTIONS ─────────────────────────────────────────────
// Doubles as the editor: pass a profileId to edit that saved connection in
// place. Editing must keep the same id — a delete-and-recreate would mint a new
// one and silently drop the connection out of the MCP allowlist.
function openConnDialog(profileId) {
  const editing = !!(profileId && state.profiles[profileId]);
  state.editingProfile = editing ? profileId : null;
  const cfg = editing ? state.profiles[profileId] : {};

  document.getElementById('connModalTitle').textContent = editing
    ? 'Edit Connection — ' + (cfg.name || '')
    : 'New MySQL / MariaDB Connection';
  document.getElementById('connSaveBtn').textContent = editing ? 'Save Changes' : 'Connect';

  document.getElementById('ci-name').value = cfg.name || '';
  document.getElementById('ci-host').value = cfg.host || '127.0.0.1';
  document.getElementById('ci-port').value = cfg.port || '3306';
  document.getElementById('ci-user').value = cfg.user || 'root';
  document.getElementById('ci-pass').value = cfg.password || '';
  document.getElementById('ci-db').value = cfg.database || '';
  document.getElementById('ci-ssl').checked = !!cfg.ssl;

  const note = document.getElementById('connTestResult');
  if (editing && cfg.passwordFailed) {
    note.style.color = 'var(--amber)';
    note.textContent = '⚠ The saved password could not be decrypted — re-enter it below.';
  } else {
    note.style.color = '';
    note.textContent = '';
  }
  document.getElementById('connModal').style.display = 'flex';
}

function closeConnDialog() {
  document.getElementById('connModal').style.display = 'none';
  state.editingProfile = null;
}

function getConnFormValues() {
  return {
    name: document.getElementById('ci-name').value.trim() || (document.getElementById('ci-host').value + ':' + document.getElementById('ci-port').value),
    host: document.getElementById('ci-host').value.trim(),
    port: document.getElementById('ci-port').value.trim() || '3306',
    user: document.getElementById('ci-user').value.trim(),
    password: document.getElementById('ci-pass').value,
    database: document.getElementById('ci-db').value.trim() || null,
    ssl: document.getElementById('ci-ssl').checked,
  };
}

async function testConnection() {
  const resultEl = document.getElementById('connTestResult');
  resultEl.style.color = 'var(--amber)';
  resultEl.textContent = '⟳ Testing…';
  const cfg = getConnFormValues();
  const res = await window.api.dbConnect(cfg);
  if (res.ok) {
    resultEl.style.color = 'var(--green)';
    resultEl.textContent = '✓ Connected to ' + res.server;
    await window.api.dbDisconnect(res.id);
  } else {
    resultEl.style.color = 'var(--red)';
    resultEl.textContent = '✕ ' + res.error;
  }
}

function genProfileId() {
  return 'p_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e4).toString(36);
}

// Load saved profiles from disk on startup (passwords decrypted in main process).
async function loadSavedConnections() {
  if (!window.api) return;
  const res = await window.api.loadConnections();
  if (!res || !res.ok) return;
  res.profiles.forEach(p => {
    if (!p.id) p.id = genProfileId();
    state.profiles[p.id] = p;
  });
  refreshConnPicker();
}

async function persistConnections() {
  if (!window.api) return;
  await window.api.saveConnections(Object.values(state.profiles));
}

// Rebuilt wholesale rather than appended to, so renames and deletes show up.
function refreshConnPicker() {
  const picker = document.getElementById('connPicker');
  const keep = state.activeProfile || picker.value;
  picker.innerHTML = '<option value="">— no connection —</option>';
  Object.values(state.profiles).forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    picker.appendChild(opt);
  });
  picker.value = (keep && state.profiles[keep]) ? keep : '';
}

// Keep the titlebar badge and status bar in step after a rename or host change.
function refreshActiveConnLabel() {
  const cfg = state.profiles[state.activeProfile];
  if (!cfg) return;
  const statusEl = document.getElementById('connStatus');
  statusEl.className = 'conn-badge';
  statusEl.innerHTML = `<div class="conn-dot"></div>${esc(cfg.name)}`;
  document.getElementById('sbServer').textContent = cfg.host + ':' + cfg.port;
}

// Write a profile to disk, reusing `profileId` when editing so the id stays
// stable. Any pool the profile already had is dropped — its credentials may
// have just changed underneath it.
async function saveProfileRecord(profileId, cfg, poolId) {
  const id = profileId || genProfileId();
  const stale = state.profilePool[id];
  if (stale && stale !== poolId) {
    await window.api.dbDisconnect(stale);
    delete state.profilePool[id];
  }
  const prev = state.profiles[id];
  const rec = { id, ...cfg };
  // Keep the "unreadable password" mark until the user actually types a new one,
  // so main.js knows not to overwrite the stored blob with an empty string.
  if (!cfg.password && prev && prev.passwordFailed) rec.passwordFailed = true;
  state.profiles[id] = rec;
  if (poolId) state.profilePool[id] = poolId;
  await persistConnections();           // save to disk (encrypted password)
  refreshConnPicker();
  return id;
}

async function saveConnection() {
  const resultEl = document.getElementById('connTestResult');
  const cfg = getConnFormValues();
  const editingId = state.editingProfile;

  if (!cfg.host) {
    resultEl.style.color = 'var(--red)';
    resultEl.textContent = '✕ Host is required';
    return;
  }

  resultEl.style.color = 'var(--amber)';
  resultEl.textContent = '⟳ Connecting…';
  const res = await window.api.dbConnect(cfg);

  // A server being down doesn't make the profile wrong — offer to keep it.
  if (!res.ok) {
    resultEl.style.color = 'var(--red)';
    resultEl.textContent = '✕ ' + res.error;
    const keep = confirm(
      'Could not reach the server:\n\n' + res.error +
      '\n\nSave this connection anyway?\nYou can connect to it later from 🗂 Saved.'
    );
    if (!keep) return;
    const id = await saveProfileRecord(editingId, cfg, null);
    closeConnDialog();
    if (state.activeProfile === id) refreshActiveConnLabel();
    if (isConnManagerOpen()) renderConnManager();
    setStatus('Saved “' + cfg.name + '” without connecting', 'ok');
    return;
  }

  const id = await saveProfileRecord(editingId, cfg, res.id);
  closeConnDialog();
  if (isConnManagerOpen()) renderConnManager();
  document.getElementById('connPicker').value = id;
  await activateProfile(id);
}

// Make sure a saved profile has a live pool; (re)connect on demand.
async function ensurePool(profileId) {
  if (state.profilePool[profileId]) return state.profilePool[profileId];
  const cfg = state.profiles[profileId];
  if (!cfg) return null;
  setStatus('Connecting…', 'running');
  const res = await window.api.dbConnect(cfg);
  if (!res.ok) {
    setStatus('Connect failed', 'err');
    // Don't let an unreadable stored password masquerade as "access denied".
    showError(cfg.passwordFailed
      ? 'Connection failed: the saved password for “' + cfg.name + '” could not be decrypted, so it was sent blank.\n\n' +
        'Open 🗂 Saved → ✎ Edit and re-enter the password.\n\nServer said: ' + res.error
      : 'Connection failed: ' + res.error);
    return null;
  }
  state.profilePool[profileId] = res.id;
  setStatus('Connected', 'ok');
  return res.id;
}

async function activateProfile(profileId) {
  const cfg = state.profiles[profileId];
  if (!cfg) return;
  const poolId = await ensurePool(profileId);
  if (!poolId) return;

  state.activeProfile = profileId;
  state.activeConn = poolId;
  state.activeDB = null;
  document.getElementById('connPicker').value = profileId;

  refreshActiveConnLabel();
  document.getElementById('sbDb').textContent = '—';

  await loadDatabases(poolId);
  if (cfg.database) await selectDatabase(cfg.database);
  startPing();
}

function switchConnection(profileId) {
  if (!profileId || !state.profiles[profileId]) return;
  activateProfile(profileId);
}

// Disconnect the active connection but KEEP the saved profile on disk.
async function disconnectCurrent() {
  stopPing();
  const profileId = state.activeProfile;
  if (profileId && state.profilePool[profileId]) {
    await window.api.dbDisconnect(state.profilePool[profileId]);
    delete state.profilePool[profileId];
  }
  state.activeProfile = null;
  state.activeConn = null;
  state.activeDB = null;
  document.getElementById('connStatus').className = 'conn-none';
  document.getElementById('connStatus').textContent = 'No connection';
  document.getElementById('sbServer').textContent = '—';
  document.getElementById('sbDb').textContent = '—';
  document.getElementById('sbVersion').textContent = 'MySQL';
  document.getElementById('dbPicker').innerHTML = '<option value="">— select —</option>';
  document.getElementById('dbTree').innerHTML = '<div class="tree-empty">Connect to a database<br>to browse its schema.</div>';
  document.getElementById('connPicker').value = '';
}

// Permanently remove a saved connection from disk. Without an argument it
// targets whatever the sidebar picker has selected (the 🗑 button).
async function deleteSavedConnection(profileId) {
  const picker = document.getElementById('connPicker');
  const id = profileId || picker.value || state.activeProfile;
  if (!id || !state.profiles[id]) { setStatus('Select a saved connection to delete', 'err'); return; }
  const cfg = state.profiles[id];
  if (!confirm(`Delete saved connection "${cfg.name}"?\n\nThis removes it from disk permanently.`)) return;

  if (state.profilePool[id]) {
    await window.api.dbDisconnect(state.profilePool[id]);
    delete state.profilePool[id];
  }
  const wasActive = state.activeProfile === id;
  delete state.profiles[id];
  await persistConnections();
  await mcpForgetProfile(id);        // don't leave a dead id in the MCP allowlist
  refreshConnPicker();
  if (wasActive) await disconnectCurrent();
  if (isConnManagerOpen()) renderConnManager();
  setStatus('Deleted saved connection', 'ok');
}

// ─── SAVED CONNECTIONS MANAGER ───────────────────────────────
function isConnManagerOpen() {
  const el = document.getElementById('connManagerModal');
  return !!el && el.style.display === 'flex';
}

function openConnManager() {
  renderConnManager();
  document.getElementById('connManagerModal').style.display = 'flex';
}
function closeConnManager() { document.getElementById('connManagerModal').style.display = 'none'; }

function newConnFromManager() { closeConnManager(); openConnDialog(); }

function renderConnManager() {
  const box = document.getElementById('connMgrList');
  const list = Object.values(state.profiles);
  if (!list.length) {
    box.innerHTML = '<div class="mcp-list-empty">No saved connections yet. Use “+ New Connection” below.</div>';
    return;
  }
  box.innerHTML = list.map(p => {
    const active    = state.activeProfile === p.id;
    const connected = !!state.profilePool[p.id];
    const stateCls  = active ? 'active' : (connected ? 'connected' : '');
    const stateTxt  = active ? 'Active' : (connected ? 'Connected' : 'Saved');
    return `
      <div class="conn-mgr-row ${stateCls}">
        <div class="conn-mgr-info">
          <div class="conn-mgr-name">
            <span class="conn-mgr-dot"></span>${esc(p.name)}
            <span class="mcp-pill ${stateCls}">${stateTxt}</span>
            ${p.passwordFailed ? '<span class="mcp-pill danger" title="The stored password could not be decrypted. Click ✎ and re-enter it.">⚠ password</span>' : ''}
          </div>
          <div class="conn-mgr-sub">
            ${esc(p.user || '')}@${esc(p.host || '')}:${esc(String(p.port || 3306))}${p.database ? ' · ' + esc(p.database) : ''}${p.ssl ? ' · SSL' : ''}
          </div>
        </div>
        <div class="conn-mgr-actions">
          <button class="tb-btn mini" onclick="connectFromManager('${p.id}')" ${active ? 'disabled' : ''}>${active ? 'In use' : 'Connect'}</button>
          <button class="icon-btn" title="Edit"      onclick="editConnFromManager('${p.id}')">✎</button>
          <button class="icon-btn" title="Duplicate" onclick="duplicateConn('${p.id}')">⧉</button>
          <button class="icon-btn" title="Delete"    onclick="deleteSavedConnection('${p.id}')">🗑</button>
        </div>
      </div>`;
  }).join('');
}

async function connectFromManager(profileId) {
  closeConnManager();
  document.getElementById('connPicker').value = profileId;
  await activateProfile(profileId);
}

function editConnFromManager(profileId) {
  closeConnManager();
  openConnDialog(profileId);
}

async function duplicateConn(profileId) {
  const src = state.profiles[profileId];
  if (!src) return;
  const copy = { ...src, name: src.name + ' (copy)' };
  delete copy.id;
  const id = genProfileId();
  state.profiles[id] = { id, ...copy };
  await persistConnections();
  refreshConnPicker();
  renderConnManager();
  setStatus('Duplicated “' + src.name + '”', 'ok');
}

// ─── KEEPALIVE / PING ────────────────────────────────────────
function startPing() {
  stopPing();
  pingNow();
  state.pingTimer = setInterval(pingNow, 30000);  // refresh every 30s
}

function stopPing() {
  if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; }
  const el = document.getElementById('sbPing');
  if (el) { el.textContent = ''; el.removeAttribute('style'); }
}

async function pingNow() {
  if (!state.activeConn) return;
  const el = document.getElementById('sbPing');
  const t0 = performance.now();
  const res = await window.api.dbServerInfo(state.activeConn);
  const ms = Math.round(performance.now() - t0);
  if (res.ok) {
    document.getElementById('sbVersion').textContent = 'MySQL ' + res.version;
    if (el) { el.textContent = `● ${ms}ms · ${res.threads} conns`; el.style.color = 'var(--green)'; }
  } else if (el) {
    el.textContent = '● connection lost'; el.style.color = 'var(--red)';
  }
}

// ─── DATABASE TREE ───────────────────────────────────────────
async function loadDatabases(connId) {
  const tree = document.getElementById('dbTree');
  tree.innerHTML = '<div class="tree-loading">Loading databases…</div>';
  const res = await window.api.dbListDatabases(connId);
  if (!res.ok) {
    tree.innerHTML = `<div class="tree-empty" style="color:var(--red);">Error: ${res.error}</div>`;
    return;
  }

  // Populate db picker
  const picker = document.getElementById('dbPicker');
  picker.innerHTML = '<option value="">— select —</option>';
  res.databases.forEach(db => {
    const opt = document.createElement('option');
    opt.value = db;
    opt.textContent = db;
    picker.appendChild(opt);
  });

  // Build tree
  tree.innerHTML = '';
  const cfg = state.profiles[state.activeProfile] || { name: 'Server' };
  const serverRow = makeTreeRow({ label: cfg.name, icon: '🖥', cls: 'tree-server', hasArrow: true, expanded: true });
  tree.appendChild(serverRow);

  res.databases.forEach(db => {
    const dbKey = connId + '_' + db;
    const row = makeTreeRow({ label: db, icon: '🗄', cls: 'tree-db', hasArrow: true, expanded: false });
    row.dataset.db = db;
    row.addEventListener('click', () => toggleDatabase(connId, db, row));
    tree.appendChild(row);
  });
}

async function toggleDatabase(connId, db, rowEl) {
  const key = connId + '_' + db;
  const isExpanded = state.treeExpanded[key];

  if (isExpanded) {
    // Collapse — remove children
    state.treeExpanded[key] = false;
    rowEl.classList.remove('expanded');
    let next = rowEl.nextSibling;
    while (next && next.dataset && next.dataset.parentDb === db) {
      const toRemove = next;
      next = next.nextSibling;
      toRemove.remove();
    }
    return;
  }

  // Expand
  state.treeExpanded[key] = true;
  rowEl.classList.add('expanded');

  // Show loading placeholder
  const placeholder = document.createElement('div');
  placeholder.className = 'tree-loading';
  placeholder.dataset.parentDb = db;
  placeholder.textContent = 'Loading tables…';
  rowEl.after(placeholder);

  const res = await window.api.dbListTables(connId, db);
  placeholder.remove();

  if (!res.ok) {
    const errRow = document.createElement('div');
    errRow.className = 'tree-loading';
    errRow.dataset.parentDb = db;
    errRow.style.color = 'var(--red)';
    errRow.textContent = 'Error: ' + res.error;
    rowEl.after(errRow);
    return;
  }

  // Insert table rows after db row. Tables no longer expand to columns —
  // clicking a table loads its data AND its columns (the Variables tab).
  let insertAfter = rowEl;
  res.tables.forEach(({ name, type }) => {
    const isView = type === 'VIEW';
    const tblRow = makeTreeRow({
      label: name,
      icon: isView ? '👁' : '📋',
      cls: 'tree-table' + (isView ? ' tree-view' : ''),
      hasArrow: false,
    });
    tblRow.dataset.parentDb = db;
    tblRow.dataset.table = name;
    tblRow.addEventListener('click', () => loadTable(connId, db, name, tblRow));
    insertAfter.after(tblRow);
    insertAfter = tblRow;
  });
}

// Click a table → select its DB, load its data into the Data tab, and load
// its columns into the Variables tab.
async function loadTable(connId, db, name, rowEl) {
  document.getElementById('dbPicker').value = db;
  await selectDatabase(db);
  document.querySelectorAll('.tree-table.selected').forEach(el => el.classList.remove('selected'));
  if (rowEl) rowEl.classList.add('selected');
  await loadVariables(db, name);
  await runQuery('SELECT * FROM `' + db + '`.`' + name + '` LIMIT 1000;');
}

// Fetch a table's column definitions for the Variables tab.
async function loadVariables(db, table) {
  const res = await window.api.dbDescribeTable(state.activeConn, db, table);
  state.varsTarget = res.ok ? { db, table, columns: res.columns } : null;
  state.varsDraft = false;
  updateVarsUI();
  if (isResTabActive('rtVars')) renderVariables();
}

function makeTreeRow({ label, icon, cls, hasArrow, expanded = false, badge = null }) {
  const div = document.createElement('div');
  div.className = `tree-item ${cls}${expanded ? ' expanded' : ''}`;
  div.innerHTML = `${hasArrow ? '<span class="expand-arrow">▶</span>' : '<span style="width:10px;display:inline-block"></span>'}<span class="icon" style="font-size:12px;">${icon}</span><span class="lbl">${label}</span>${badge ? `<span class="badge">${badge}</span>` : ''}`;
  return div;
}

function filterTree(val) {
  const items = document.querySelectorAll('.tree-table');
  items.forEach(item => {
    const lbl = item.querySelector('.lbl')?.textContent || '';
    item.style.display = (!val || lbl.toLowerCase().includes(val.toLowerCase())) ? '' : 'none';
  });
}

async function refreshTree() {
  if (!state.activeConn) return;
  // Clear loaded state
  state.treeExpanded = {};
  await loadDatabases(state.activeConn);
  if (state.activeDB) {
    document.getElementById('dbPicker').value = state.activeDB;
  }
}

async function selectDatabase(db) {
  if (!db) return;
  state.activeDB = db;
  const picker = document.getElementById('dbPicker');
  if (picker.value !== db) picker.value = db;
  document.getElementById('sbDb').textContent = db;
}

// ─── TABS ─────────────────────────────────────────────────────
function newTab(sql = '-- New query\n', name = null) {
  state.tabCounter++;
  const id = state.tabCounter;
  const tabName = name || `query_${id}.sql`;
  state.tabs[id] = { id, name: tabName, sql, unsaved: false };
  renderTabBar();
  activateTab(id);
  setEditorValue(sql);
  return id;
}

function activateTab(id) {
  if (state.currentTab && state.tabs[state.currentTab]) {
    state.tabs[state.currentTab].sql = getEditorValue();
  }
  state.currentTab = id;
  renderTabBar();
  if (state.tabs[id]) setEditorValue(state.tabs[id].sql);
  updateLines();
  document.getElementById('editor').focus();
}

function closeTab(id, e) {
  e.stopPropagation();
  delete state.tabs[id];
  const ids = Object.keys(state.tabs).map(Number);
  if (!ids.length) { newTab(); return; }
  if (state.currentTab === id) activateTab(ids[ids.length - 1]);
  renderTabBar();
}

function renderTabBar() {
  const bar = document.getElementById('tabsBar');
  bar.innerHTML = '<div class="new-tab-btn" onclick="newTab()" title="Ctrl+T">+</div>';
  Object.values(state.tabs).reverse().forEach(tab => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === state.currentTab ? ' active' : '');
    el.onclick = () => activateTab(tab.id);
    el.innerHTML = `${tab.unsaved ? '<span class="unsaved">●</span> ' : ''}${tab.name} <span class="tab-close" onclick="closeTab(${tab.id},event)">✕</span>`;
    bar.insertBefore(el, bar.firstChild);
  });
}

// ─── EDITOR ──────────────────────────────────────────────────
function getEditorValue() { return document.getElementById('editor').value; }
function setEditorValue(v) { document.getElementById('editor').value = v; updateLines(); }

function onEditorInput() {
  updateLines();
  if (state.tabs[state.currentTab]) state.tabs[state.currentTab].unsaved = true;
}

function updateLines() {
  const ed = document.getElementById('editor');
  const count = ed.value.split('\n').length;
  document.getElementById('lineNums').innerHTML = Array.from({ length: Math.max(count, 1) }, (_, i) => i + 1).join('<br>');
  document.getElementById('lineNums').scrollTop = ed.scrollTop;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('editor').addEventListener('scroll', () => {
    document.getElementById('lineNums').scrollTop = document.getElementById('editor').scrollTop;
  });
});

function handleEditorKey(e) {
  if (e.key === 'Tab') {
    e.preventDefault();
    const ed = e.target, s = ed.selectionStart, end = ed.selectionEnd;
    ed.value = ed.value.slice(0, s) + '  ' + ed.value.slice(end);
    ed.selectionStart = ed.selectionEnd = s + 2;
    updateLines();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); }
}

function updateCursor() {
  const ed = document.getElementById('editor');
  const lines = ed.value.substr(0, ed.selectionStart).split('\n');
  document.getElementById('sbCursor').textContent = `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`;
  const sel = Math.abs(ed.selectionEnd - ed.selectionStart);
  document.getElementById('sbSelection').textContent = sel > 0 ? `${sel} selected` : '';
}

function toggleComment() {
  const ed = document.getElementById('editor');
  const s = ed.selectionStart, end = ed.selectionEnd;
  const lines = ed.value.split('\n');
  let pos = 0, startLine = 0, endLine = 0;
  lines.forEach((l, i) => {
    if (pos <= s) startLine = i;
    if (pos <= end) endLine = i;
    pos += l.length + 1;
  });
  const allCommented = lines.slice(startLine, endLine + 1).every(l => l.trimStart().startsWith('--'));
  for (let i = startLine; i <= endLine; i++) {
    lines[i] = allCommented ? lines[i].replace(/^(\s*)-- ?/, '$1') : '-- ' + lines[i];
  }
  ed.value = lines.join('\n');
  updateLines();
}

function formatSQL() {
  const ed = document.getElementById('editor');
  const kws = ['SELECT','FROM','WHERE','GROUP BY','ORDER BY','HAVING','LIMIT','OFFSET','LEFT JOIN','RIGHT JOIN','INNER JOIN','FULL OUTER JOIN','CROSS JOIN','JOIN','ON','AND','OR','NOT','IN','BETWEEN','LIKE','IS NULL','IS NOT NULL','DISTINCT','AS','INSERT INTO','VALUES','UPDATE','SET','DELETE FROM','CREATE TABLE','DROP TABLE','ALTER TABLE','TRUNCATE','UNION ALL','UNION','WITH'];
  let sql = ed.value;
  kws.forEach(k => { sql = sql.replace(new RegExp('\\b' + k + '\\b', 'gi'), k); });
  ed.value = sql;
  updateLines();
  setStatus('Formatted', 'ok');
}

// ─── QUERY EXECUTION ─────────────────────────────────────────
// `overrideSql` runs an exact statement (e.g. opening a table) without
// touching the editor; with no arg it runs the editor contents/selection.
async function runQuery(overrideSql) {
  if (!state.activeConn) {
    setStatus('No active connection', 'err');
    showMessage('Connect to a database server first using the "+ Connection" button.');
    return;
  }

  let sql;
  if (typeof overrideSql === 'string') {
    sql = overrideSql.trim();
  } else {
    sql = getEditorValue().trim();
    // Only run selected text if there is a selection
    const ed = document.getElementById('editor');
    const selText = ed.value.substring(ed.selectionStart, ed.selectionEnd).trim();
    if (selText) sql = selText;
  }
  if (!sql) return;

  // Strip trailing semicolons for single statement detection but send as-is
  const btn = document.getElementById('runBtn');
  btn.textContent = '◼ Running…';
  btn.classList.add('running');
  setStatus('Executing…', 'running');
  document.getElementById('rowCount').textContent = '';
  document.getElementById('queryTime').textContent = '';

  // Add to history
  state.queryHistory.unshift({ sql, time: new Date().toLocaleTimeString(), db: state.activeDB || '—' });
  if (state.queryHistory.length > 200) state.queryHistory.pop();

  const res = await window.api.dbQuery(state.activeConn, state.activeDB, sql);

  btn.innerHTML = '▶ Run';
  btn.classList.remove('running');

  if (!res.ok) {
    btn.classList.add('error');
    setTimeout(() => btn.classList.remove('error'), 1500);
    setStatus('Error', 'err');
    showError(res.error);
    return;
  }

  if (res.type === 'select') {
    res.sql = sql;
    state.lastResult = res;
    state.sortCol = null;
    state.draftRow = false;
    await resolveEditing(res);
    renderResultTable(res.cols, res.rows, !!state.lastEditTarget);
    updateEditUI();
    document.getElementById('rowCount').textContent = res.rows.length + ' row' + (res.rows.length !== 1 ? 's' : '');
    document.getElementById('queryTime').textContent = res.elapsed + 'ms';
    setStatus('Success', 'ok');
    switchResTab('data', document.getElementById('rtData'));
  } else {
    state.lastResult = null;
    state.lastEditTarget = null;
    state.draftRow = false;
    updateEditUI();
    const msg = `✓ Query OK — ${res.affectedRows} row(s) affected${res.insertId ? ', insert ID: ' + res.insertId : ''}. (${res.elapsed}ms)${res.info ? '\n' + res.info : ''}`;
    showExecResult(msg);
    document.getElementById('rowCount').textContent = res.affectedRows + ' affected';
    document.getElementById('queryTime').textContent = res.elapsed + 'ms';
    setStatus('Success', 'ok');
    switchResTab('messages', document.getElementById('rtMessages'));
  }

  pingNow();  // refresh keepalive/status on each query ("push")
}

async function explainQuery() {
  if (!state.activeConn) { setStatus('No connection', 'err'); return; }
  const sql = getEditorValue().trim();
  if (!sql) return;
  const res = await window.api.dbExplain(state.activeConn, state.activeDB, sql);
  if (!res.ok) { addAiMsg('ai', 'EXPLAIN error: ' + res.error, null); return; }
  state.lastExplain = res;
  renderResultTable(res.cols.map(c => ({ name: c })), res.rows);
  switchResTab('explain', document.getElementById('rtExplain'));
  setStatus('Explain plan ready', 'ok');
}

// ─── RESULTS ─────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function cellHTML(cell, r, c, editable) {
  let cls = '', val = cell == null ? 'NULL' : String(cell);
  if (cell === null) cls = 'td-null';
  else if (typeof cell === 'boolean') { cls = cell ? 'td-bool-t' : 'td-bool-f'; val = cell ? 'TRUE' : 'FALSE'; }
  else if (typeof cell === 'number') cls = 'td-num';
  else if (typeof cell === 'string' && /^\d{4}-\d{2}/.test(cell)) cls = 'td-date';
  const escaped = esc(val);
  const editAttr = editable ? ` ondblclick="startEdit(this)" oncontextmenu="cellContextMenu(event,${r},${c})" data-r="${r}" data-c="${c}"` : '';
  return `<td class="${cls}"${editAttr} title="${escaped}">${escaped}</td>`;
}

function renderResultTable(cols, rows, editable = false) {
  const grid = document.getElementById('resultsGrid');
  if (!editable && !rows.length) { grid.innerHTML = '<div class="empty-state">Query returned 0 rows</div>'; return; }

  let html = '<table class="data-table' + (editable ? ' editable' : '') + '"><thead><tr>';
  if (editable) html += '<th class="th-actions"></th>';
  cols.forEach((c, i) => {
    const name = typeof c === 'string' ? c : c.name;
    const sortCls = state.sortCol === i ? (state.sortDir > 0 ? ' asc' : ' desc') : '';
    html += `<th class="${sortCls}" onclick="sortResults(${i})">${esc(name)}</th>`;
  });
  html += '</tr></thead><tbody>';

  rows.forEach((row, r) => {
    const trAttr = editable ? ` data-r="${r}" oncontextmenu="cellContextMenu(event,${r},-1)"` : ` data-r="${r}"`;
    html += `<tr${trAttr}>`;
    if (editable) html += `<td class="td-actions"><button class="row-del" title="Delete row (or right-click the row)" onclick="deleteRow(${r})">✕</button></td>`;
    row.forEach((cell, c) => { html += cellHTML(cell, r, c, editable); });
    html += '</tr>';
  });

  if (editable && state.draftRow) {
    html += '<tr class="draft-row"><td class="td-actions"><button class="row-save" title="Save row" onclick="saveDraft()">✓</button><button class="row-del" title="Cancel" onclick="cancelDraft()">✕</button></td>';
    cols.forEach((c, i) => {
      const ph = (c.orgName || c.name || '');
      html += `<td><input class="cell-input draft-input" data-col="${i}" placeholder="${esc(ph)}" onkeydown="draftKey(event)" onmousedown="event.stopPropagation()" onclick="this.focus()"></td>`;
    });
    html += '</tr>';
  }

  if (editable && !rows.length && !state.draftRow) {
    html += `<tr><td class="td-empty" colspan="${cols.length + 1}">Empty table — click <b>➕ Add Row</b> to insert.</td></tr>`;
  }

  html += '</tbody></table>';
  grid.innerHTML = html;
}

function renderActiveResult() {
  if (state.lastResult) renderResultTable(state.lastResult.cols, state.lastResult.rows, !!state.lastEditTarget);
}

function sortResults(colIdx) {
  if (!state.lastResult) return;
  state.sortCol === colIdx ? (state.sortDir *= -1) : (state.sortCol = colIdx, state.sortDir = 1);
  state.lastResult.rows.sort((a, b) => {
    const av = a[colIdx], bv = b[colIdx];
    if (av === null) return 1; if (bv === null) return -1;
    return av < bv ? -state.sortDir : av > bv ? state.sortDir : 0;
  });
  renderActiveResult();
}

// ─── VARIABLES TAB (table columns: view + edit via ALTER TABLE) ──
function updateVarsUI() {
  const addCol = document.getElementById('addColBtn');
  if (addCol) addCol.style.display = (state.varsTarget && isResTabActive('rtVars')) ? '' : 'none';
}

function varCell(i, field, val) {
  const escaped = esc(val == null || val === '' ? '' : String(val));
  const shown = escaped || '<span class="td-null">—</span>';
  return `<td ondblclick="editVarCell(${i},'${field}')" data-vi="${i}" data-vf="${field}" title="${escaped}">${shown}</td>`;
}

function renderVariables() {
  const grid = document.getElementById('resultsGrid');
  const t = state.varsTarget;
  if (!t) { grid.innerHTML = '<div class="empty-state">Click a table in the sidebar to view and edit its columns.</div>'; return; }

  let html = `<table class="data-table editable vars-table"><thead><tr><th class="th-actions"></th>` +
    ['Column', 'Type', 'Null', 'Key', 'Default', 'Extra'].map(h => `<th>${h}</th>`).join('') +
    '</tr></thead><tbody>';

  t.columns.forEach((col, i) => {
    html += `<tr data-vi="${i}">`;
    html += `<td class="td-actions"><button class="row-del" title="Drop column" onclick="dropColumn(${i})">✕</button></td>`;
    html += varCell(i, 'Field', col.Field);
    html += varCell(i, 'Type', col.Type);
    html += `<td ondblclick="editVarNull(${i})" title="double-click to toggle">${col.Null === 'YES' ? 'YES' : 'NO'}</td>`;
    html += `<td class="td-key">${esc(col.Key || '')}</td>`;
    html += varCell(i, 'Default', col.Default == null ? '' : col.Default);
    html += `<td>${esc(col.Extra || '')}</td>`;
    html += '</tr>';
  });

  if (state.varsDraft) {
    html += `<tr class="draft-row"><td class="td-actions"><button class="row-save" title="Add column" onclick="saveNewColumn()">✓</button><button class="row-del" title="Cancel" onclick="cancelNewColumn()">✕</button></td>`;
    html += `<td><input class="cell-input" id="vc-name" placeholder="column name" onkeydown="varDraftKey(event)" onclick="this.focus()"></td>`;
    html += `<td><input class="cell-input" id="vc-type" placeholder="e.g. VARCHAR(255)" onkeydown="varDraftKey(event)" onclick="this.focus()"></td>`;
    html += `<td><select class="cell-input" id="vc-null"><option value="YES">YES</option><option value="NO">NO</option></select></td>`;
    html += `<td class="td-key">—</td>`;
    html += `<td><input class="cell-input" id="vc-default" placeholder="(none)" onkeydown="varDraftKey(event)" onclick="this.focus()"></td>`;
    html += `<td>—</td></tr>`;
  }

  html += '</tbody></table>';
  grid.innerHTML = html;
}

function editVarNull(i) {
  const t = state.varsTarget;
  if (!t) return;
  applyColumnChange(i, 'Null', t.columns[i].Null === 'YES' ? 'NO' : 'YES');
}

function editVarCell(i, field) {
  const td = document.querySelector(`td[data-vi="${i}"][data-vf="${field}"]`);
  if (!td || td.querySelector('input')) return;
  const col = state.varsTarget.columns[i];
  const cur = field === 'Default' ? (col.Default == null ? '' : col.Default) : col[field];
  const input = document.createElement('input');
  input.className = 'cell-input';
  input.value = cur == null ? '' : String(cur);
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const v = input.value;
    if (String(cur == null ? '' : cur) === v) { renderVariables(); return; }
    applyColumnChange(i, field, v);
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); done = true; renderVariables(); }
  });
  input.addEventListener('blur', commit);
}

// Build the full target column definition (CHANGE requires it) and apply.
async function applyColumnChange(i, field, newVal) {
  const t = state.varsTarget;
  if (!t) return;
  const col = t.columns[i];
  const newName = field === 'Field' ? newVal : col.Field;
  const type = field === 'Type' ? newVal : col.Type;
  const nullable = (field === 'Null' ? newVal : col.Null) === 'YES';
  const autoIncrement = /auto_increment/i.test(col.Extra || '');  // CHANGE re-states the def — keep it
  let hasDefault, defaultVal;
  if (field === 'Default') { hasDefault = newVal !== ''; defaultVal = newVal; }
  else { hasDefault = col.Default != null; defaultVal = col.Default; }

  const summary = `ALTER TABLE \`${t.table}\`\n  CHANGE \`${col.Field}\` \`${newName}\` ${type} ${nullable ? 'NULL' : 'NOT NULL'}` +
    (hasDefault ? ` DEFAULT ${JSON.stringify(defaultVal)}` : '') + (autoIncrement ? ' AUTO_INCREMENT' : '');
  if (!confirm('Apply this schema change?\n\n' + summary + '\n\nSchema changes cannot be undone.')) { renderVariables(); return; }

  const res = await window.api.dbAlterColumn(state.activeConn, t.db, t.table, { oldName: col.Field, newName, type, nullable, hasDefault, defaultVal: hasDefault ? defaultVal : undefined, autoIncrement });
  if (!res.ok) { setStatus('ALTER failed: ' + res.error, 'err'); renderVariables(); return; }
  setStatus('Column updated', 'ok');
  await loadVariables(t.db, t.table);
  await refreshIfAffected(t.table);
}

async function dropColumn(i) {
  const t = state.varsTarget;
  if (!t) return;
  const col = t.columns[i];
  if (!confirm(`Drop column \`${col.Field}\` from \`${t.table}\`?\n\nThis permanently deletes the column and all its data. Cannot be undone.`)) return;
  const res = await window.api.dbDropColumn(state.activeConn, t.db, t.table, col.Field);
  if (!res.ok) { setStatus('Drop failed: ' + res.error, 'err'); return; }
  setStatus('Dropped column', 'ok');
  await loadVariables(t.db, t.table);
  await refreshIfAffected(t.table);
}

function addColumnDraft() {
  if (!state.varsTarget) { setStatus('Select a table first', 'err'); return; }
  state.varsDraft = true;
  renderVariables();
  const n = document.getElementById('vc-name');
  if (n) n.focus();
}
function cancelNewColumn() { state.varsDraft = false; renderVariables(); }
function varDraftKey(e) {
  if (e.key === 'Enter') { e.preventDefault(); saveNewColumn(); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelNewColumn(); }
}

async function saveNewColumn() {
  const t = state.varsTarget;
  if (!t) return;
  const name = (document.getElementById('vc-name').value || '').trim();
  const type = (document.getElementById('vc-type').value || '').trim();
  const nullable = document.getElementById('vc-null').value === 'YES';
  const defRaw = document.getElementById('vc-default').value;
  if (!name || !type) { setStatus('Column name and type are required', 'err'); return; }
  const hasDefault = defRaw !== '';

  const summary = `ALTER TABLE \`${t.table}\`\n  ADD COLUMN \`${name}\` ${type} ${nullable ? 'NULL' : 'NOT NULL'}` +
    (hasDefault ? ` DEFAULT ${JSON.stringify(defRaw)}` : '');
  if (!confirm('Add this column?\n\n' + summary)) return;

  const res = await window.api.dbAddColumn(state.activeConn, t.db, t.table, { name, type, nullable, hasDefault, defaultVal: hasDefault ? defRaw : undefined });
  if (!res.ok) { setStatus('Add column failed: ' + res.error, 'err'); return; }
  state.varsDraft = false;
  setStatus('Added column', 'ok');
  await loadVariables(t.db, t.table);
  await refreshIfAffected(t.table);
}

// ─── ROW EDITING ─────────────────────────────────────────────
// A result is editable only when every column comes from one real table
// (no joins / computed columns) and that table's full primary key is present.
async function resolveEditing(res) {
  state.lastEditTarget = null;
  const cols = res.cols;
  if (!cols.length || cols.some(c => typeof c === 'string')) return;
  const realTables = cols.map(c => c.orgTable).filter(Boolean);
  const uniq = [...new Set(realTables)];
  if (uniq.length !== 1) return;            // multi-table result
  if (cols.some(c => !c.orgTable)) return;  // a computed/aliased expression column
  const table = uniq[0];
  const db = (cols.find(c => c.db) || {}).db || state.activeDB;
  if (!db) return;

  const desc = await window.api.dbDescribeTable(state.activeConn, db, table);
  if (!desc.ok) return;
  const pkCols = desc.columns.filter(c => c.Key === 'PRI').map(c => c.Field);
  if (!pkCols.length) return;

  const allCols = cols.map(c => c.orgName || c.name);
  const colIndexByName = {};
  allCols.forEach((nm, i) => { if (!(nm in colIndexByName)) colIndexByName[nm] = i; });
  if (!pkCols.every(pk => pk in colIndexByName)) return;  // PK not selected → can't target rows

  state.lastEditTarget = { db, table, pkCols, allCols, colIndexByName, schema: desc.columns };
}

function updateEditUI() {
  const editable = !!state.lastEditTarget;
  const addBtn = document.getElementById('addRowBtn');
  const badge = document.getElementById('editBadge');
  if (addBtn) addBtn.style.display = (editable && isResTabActive('rtData')) ? '' : 'none';
  if (badge) {
    badge.style.display = state.lastResult ? '' : 'none';
    badge.textContent = editable ? '✎ editable' : '🔒 read-only';
    badge.className = 'edit-badge ' + (editable ? 'on' : 'off');
    badge.title = editable ? '' : 'Editing needs a single-table result that includes its primary key';
  }
}

function pkWhereForRow(r) {
  const t = state.lastEditTarget;
  if (!t) return null;
  const where = {};
  for (const pk of t.pkCols) {
    const idx = t.colIndexByName[pk];
    if (idx == null) return null;
    where[pk] = state.lastResult.rows[r][idx];
  }
  return where;
}

function startEdit(td) {
  if (!state.lastEditTarget || td.querySelector('input')) return;
  const r = +td.dataset.r, c = +td.dataset.c;
  const raw = state.lastResult.rows[r][c];
  const input = document.createElement('input');
  input.className = 'cell-input';
  input.value = raw == null ? '' : String(raw);
  td.classList.add('editing');
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(td, input); }
    else if (e.key === 'Escape') { e.preventDefault(); td._done = true; renderActiveResult(); }
  });
  input.addEventListener('blur', () => commitEdit(td, input));
}

async function commitEdit(td, input) {
  if (td._done) return;
  td._done = true;
  const r = +td.dataset.r, c = +td.dataset.c;
  const orig = state.lastResult.rows[r][c];
  const newVal = input.value;
  const unchanged = (orig == null && newVal === '') || (orig != null && String(orig) === newVal);
  if (unchanged) { renderActiveResult(); return; }

  const t = state.lastEditTarget;
  const column = t.allCols[c];
  const where = pkWhereForRow(r);
  if (!where) { setStatus('Cannot edit: missing primary key', 'err'); renderActiveResult(); return; }

  const res = await window.api.dbUpdateCell(state.activeConn, t.db, t.table, column, newVal, where);
  if (!res.ok) { setStatus('Update failed: ' + res.error, 'err'); renderActiveResult(); return; }
  state.lastResult.rows[r][c] = newVal;
  pushUndo({ kind: 'update', db: t.db, table: t.table, column, where: pkWhereForRow(r), value: orig });
  setStatus('Updated 1 cell', 'ok');
  renderActiveResult();
}

async function deleteRow(r) {
  const t = state.lastEditTarget;
  if (!t) return;
  const where = pkWhereForRow(r);
  if (!where) { setStatus('Cannot delete: missing primary key', 'err'); return; }
  if (!confirm('Delete this row?\n\n' + JSON.stringify(where) + '\n\nYou can undo this from the Undo button.')) return;
  // Capture the full row so the delete can be undone (re-inserted)
  const fullValues = {};
  t.allCols.forEach((col, i) => { fullValues[col] = state.lastResult.rows[r][i]; });
  const res = await window.api.dbDeleteRow(state.activeConn, t.db, t.table, where);
  if (!res.ok) { setStatus('Delete failed: ' + res.error, 'err'); return; }
  pushUndo({ kind: 'insert', db: t.db, table: t.table, values: fullValues });
  state.lastResult.rows.splice(r, 1);
  setStatus('Deleted 1 row', 'ok');
  document.getElementById('rowCount').textContent = state.lastResult.rows.length + ' rows';
  renderActiveResult();
}

function addDraftRow() {
  if (!state.lastEditTarget) { setStatus('This result is not editable', 'err'); return; }
  state.draftRow = true;
  renderActiveResult();
  const first = document.querySelector('.draft-input');
  if (first) first.focus();
}

function cancelDraft() { state.draftRow = false; renderActiveResult(); }

// Enter saves the draft row, Esc cancels it
function draftKey(e) {
  if (e.key === 'Enter') { e.preventDefault(); saveDraft(); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelDraft(); }
}

// ─── CELL / ROW CONTEXT MENU (right-click) ───────────────────
function closeContextMenu() { const m = document.getElementById('ctxMenu'); if (m) m.remove(); }

// c === -1 means the click was on the row actions cell (row-level actions only).
function cellContextMenu(e, r, c) {
  if (!state.lastEditTarget) return;  // only for editable results
  e.preventDefault();
  e.stopPropagation();                // don't let the <tr> handler fire too
  closeContextMenu();

  const items = [];
  if (c >= 0) {
    items.push({ label: '✎ Edit cell',   fn: () => editCellAt(r, c) });
    items.push({ label: '⎘ Copy value',  fn: () => copyCell(r, c) });
    items.push({ label: '∅ Set NULL',    fn: () => setCellNull(r, c) });
    items.push({ sep: true });
  }
  items.push({ label: '⧉ Duplicate row', fn: () => duplicateRow(r) });
  items.push({ label: '✕ Delete row',    danger: true, fn: () => deleteRow(r) });

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'ctxMenu';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - (items.length * 30 + 20)) + 'px';
  items.forEach(it => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); return; }
    const d = document.createElement('div');
    d.className = 'ctx-item' + (it.danger ? ' ctx-danger' : '');
    d.textContent = it.label;
    d.onclick = () => { closeContextMenu(); it.fn(); };
    menu.appendChild(d);
  });
  document.body.appendChild(menu);

  // Defer the close-listeners by a tick so the CURRENT right-click/click event
  // (still bubbling to document) does not instantly close the menu we just opened.
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
    document.addEventListener('contextmenu', closeContextMenu, { once: true });
  }, 0);
}

function editCellAt(r, c) {
  const td = document.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
  if (td) startEdit(td);
}

async function copyCell(r, c) {
  const v = state.lastResult.rows[r][c];
  const text = v == null ? '' : String(v);
  if (window.api && window.api.clipboardWrite) await window.api.clipboardWrite(text);
  else { try { await navigator.clipboard.writeText(text); } catch (_) {} }
  setStatus('Copied cell value', 'ok');
}

async function setCellNull(r, c) {
  const t = state.lastEditTarget;
  if (!t) return;
  const where = pkWhereForRow(r);
  if (!where) { setStatus('Cannot edit: missing primary key', 'err'); return; }
  const oldVal = state.lastResult.rows[r][c];
  const res = await window.api.dbUpdateCell(state.activeConn, t.db, t.table, t.allCols[c], null, where);
  if (!res.ok) { setStatus('Set NULL failed: ' + res.error, 'err'); return; }
  state.lastResult.rows[r][c] = null;
  pushUndo({ kind: 'update', db: t.db, table: t.table, column: t.allCols[c], where: pkWhereForRow(r), value: oldVal });
  setStatus('Set NULL', 'ok');
  renderActiveResult();
}

async function duplicateRow(r) {
  const t = state.lastEditTarget;
  if (!t) return;
  const values = {};
  t.allCols.forEach((col, i) => {
    const def = t.schema.find(s => s.Field === col) || {};
    if (/auto_increment/i.test(def.Extra || '')) return;  // let a new id generate
    const v = state.lastResult.rows[r][i];
    if (v !== null && v !== undefined) values[col] = v;
  });
  const res = await window.api.dbInsertRow(state.activeConn, t.db, t.table, values);
  if (!res.ok) { setStatus('Duplicate failed: ' + res.error, 'err'); return; }
  const undoWhere = await derivePkForUndo(t.table, values, res.insertId);
  if (undoWhere) pushUndo({ kind: 'delete', db: t.db, table: t.table, where: undoWhere });
  setStatus('Duplicated row', 'ok');
  await rerunLast();
}

async function saveDraft() {
  const t = state.lastEditTarget;
  if (!t) return;
  const inputs = document.querySelectorAll('.draft-input');
  const values = {};
  inputs.forEach(inp => {
    const col = t.allCols[+inp.dataset.col];
    const v = inp.value;
    const def = t.schema.find(c => c.Field === col) || {};
    const optional = /auto_increment/i.test(def.Extra || '') || def.Default !== null || def.Null === 'YES';
    if (v === '' && optional) return;  // let the DB supply auto-increment / default / NULL
    values[col] = v;
  });
  // An empty draft is allowed: main inserts a defaults-only row (INSERT … () VALUES ())
  const res = await window.api.dbInsertRow(state.activeConn, t.db, t.table, values);
  if (!res.ok) { setStatus('Insert failed: ' + res.error, 'err'); return; }
  const undoWhere = await derivePkForUndo(t.table, values, res.insertId);
  if (undoWhere) pushUndo({ kind: 'delete', db: t.db, table: t.table, where: undoWhere });
  state.draftRow = false;
  setStatus('Inserted 1 row', 'ok');
  await rerunLast();
}

// Re-run the last SELECT so generated ids / defaults / triggers are reflected
async function rerunLast() {
  if (!state.lastResult || !state.lastResult.sql) { renderActiveResult(); return; }
  const sql = state.lastResult.sql;
  const res = await window.api.dbQuery(state.activeConn, state.activeDB, sql);
  if (!res.ok || res.type !== 'select') { renderActiveResult(); return; }
  res.sql = sql;
  state.lastResult = res;
  await resolveEditing(res);
  renderActiveResult();
  updateEditUI();
  document.getElementById('rowCount').textContent = res.rows.length + ' rows';
}

function showError(msg) {
  document.getElementById('resultsGrid').innerHTML = `<div class="error-state">✕ ${msg}</div>`;
}

function showMessage(msg) {
  document.getElementById('resultsGrid').innerHTML = `<div class="empty-state">${msg}</div>`;
}

function showExecResult(msg) {
  document.getElementById('resultsGrid').innerHTML = `<div class="exec-result">${msg}</div>`;
}

function isResTabActive(id) {
  const el = document.getElementById(id);
  return !!(el && el.classList.contains('active'));
}

function switchResTab(name, el) {
  document.querySelectorAll('.res-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  // Tab-specific toolbar buttons
  const addRow = document.getElementById('addRowBtn');
  const addCol = document.getElementById('addColBtn');
  if (addRow) addRow.style.display = (name === 'data' && state.lastEditTarget) ? '' : 'none';
  if (addCol) addCol.style.display = (name === 'vars' && state.varsTarget) ? '' : 'none';

  if (name === 'messages') {
    showExecResult(document.getElementById('resultsGrid').querySelector('.exec-result')?.textContent || 'No messages.');
  } else if (name === 'explain') {
    if (state.lastExplain) renderResultTable(state.lastExplain.cols.map(c => ({ name: c })), state.lastExplain.rows);
    else showMessage('Run EXPLAIN to see the query execution plan.');
  } else if (name === 'vars') {
    renderVariables();
  } else {
    if (state.lastResult) renderResultTable(state.lastResult.cols, state.lastResult.rows, !!state.lastEditTarget);
    else showMessage('Run a query to see results here.');
  }
}

// ─── EXPORT ──────────────────────────────────────────────────
async function exportCSV() {
  if (!state.lastResult) { setStatus('No results to export', 'err'); return; }
  const { cols, rows } = state.lastResult;
  const header = cols.map(c => typeof c === 'string' ? c : c.name).join(',');
  const body = rows.map(r => r.map(v => v === null ? '' : `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const csv = header + '\n' + body;
  if (window.api) {
    const res = await window.api.exportCSV(csv, 'results.csv');
    if (res.ok) setStatus('Exported to CSV', 'ok');
  }
}

// ─── STATUS ──────────────────────────────────────────────────
function setStatus(msg, type) {
  const el = document.getElementById('statusOk');
  const icons = { ok: '✓', err: '✕', running: '⟳' };
  el.textContent = (icons[type] || '') + ' ' + msg;
  el.className = type;
}

// ─── MODE SWITCHING ───────────────────────────────────────────
function bindModeButtons() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      document.getElementById('queryMode').style.display = mode === 'query' ? 'flex' : 'none';
      document.getElementById('historyMode').style.display = mode === 'history' ? 'flex' : 'none';
      if (mode === 'history') renderHistory();
    });
  });
}

// ─── HISTORY ─────────────────────────────────────────────────
function renderHistory() {
  const list = document.getElementById('historyList');
  document.getElementById('historyCount').textContent = '(' + state.queryHistory.length + ')';
  if (!state.queryHistory.length) { list.innerHTML = '<div class="empty-state">No history yet.</div>'; return; }
  list.innerHTML = state.queryHistory.map((h, i) => `
    <div class="history-item" ondblclick="loadHistory(${i})">
      <div class="hi-meta"><span>${h.time}</span><span>${h.db}</span></div>
      <div class="hi-sql">${h.sql.slice(0, 300).replace(/</g,'&lt;')}</div>
    </div>`).join('');
}

function loadHistory(i) {
  const h = state.queryHistory[i];
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.mode-btn[data-mode="query"]').classList.add('active');
  document.getElementById('queryMode').style.display = 'flex';
  document.getElementById('historyMode').style.display = 'none';
  setEditorValue(h.sql);
}

// ─── RESIZERS ────────────────────────────────────────────────
function bindResizers() {
  let draggingH = false, draggingSidebar = false;
  const editorResizer = document.getElementById('editorResizer');

  editorResizer.addEventListener('mousedown', e => {
    draggingH = true;
    editorResizer.classList.add('dragging');
    e.preventDefault();
  });

  document.getElementById('sidebarResizer').addEventListener('mousedown', e => {
    draggingSidebar = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (draggingH) {
      // Drawer is docked at the bottom — its height grows as the cursor moves up
      const queryArea = document.getElementById('queryMode');
      const rect = queryArea.getBoundingClientRect();
      const fromBottom = rect.bottom - e.clientY;
      const clamped = Math.min(Math.max(fromBottom, 120), rect.height - 100);
      document.getElementById('editorDrawer').style.height = clamped + 'px';
    }
    if (draggingSidebar) {
      const newW = e.clientX;
      if (newW >= 160 && newW <= 420) document.getElementById('sidebar').style.width = newW + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    draggingH = false;
    draggingSidebar = false;
    editorResizer.classList.remove('dragging');
  });
}

// ─── AI ASSISTANT ─────────────────────────────────────────────
function aiKeydown(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAI(); } }
function quickAsk(q) { document.getElementById('aiInput').value = q; sendAI(); }
function clearAI() { document.getElementById('aiMsgs').innerHTML = '<div class="msg msg-ai">Cleared. How can I help?</div>'; }

function addAiMsg(type, text, sql) {
  const msgs = document.getElementById('aiMsgs');
  const div = document.createElement('div');
  div.className = 'msg msg-' + type;
  div.textContent = text;
  if (sql) {
    const sqlDiv = document.createElement('div');
    sqlDiv.className = 'msg-sql';
    sqlDiv.textContent = sql;
    sqlDiv.title = 'Click to insert into editor';
    sqlDiv.onclick = () => { setEditorValue(sql); };
    const hint = document.createElement('div');
    hint.className = 'msg-sql-hint';
    hint.textContent = '↑ Click to insert into editor';
    div.appendChild(sqlDiv);
    div.appendChild(hint);
  }
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function addTyping() {
  const msgs = document.getElementById('aiMsgs');
  const div = document.createElement('div');
  div.className = 'msg msg-ai';
  div.id = 'typing-indicator';
  div.innerHTML = '<span class="typing-dot">●</span> <span class="typing-dot" style="animation-delay:.2s">●</span> <span class="typing-dot" style="animation-delay:.4s">●</span>';
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function removeTyping() { const t = document.getElementById('typing-indicator'); if (t) t.remove(); }

// ─── AI SETTINGS ─────────────────────────────────────────────
async function loadAISettings() {
  if (!window.api) return;
  const res = await window.api.loadSettings();
  if (res && res.ok && res.settings) Object.assign(state.aiSettings, res.settings);
  reflectAIProvider();
}

function reflectAIProvider() {
  const badge = document.getElementById('aiProviderBadge');
  if (badge) badge.textContent = state.aiSettings.provider === 'openai' ? 'OpenAI' : 'Claude';
}

function openAISettings() {
  const s = state.aiSettings;
  document.getElementById('set-provider').value = s.provider || 'anthropic';
  document.getElementById('set-anthropic-key').value = s.anthropicKey || '';
  document.getElementById('set-anthropic-model').value = s.anthropicModel || 'claude-sonnet-4-6';
  document.getElementById('set-openai-key').value = s.openaiKey || '';
  document.getElementById('set-openai-model').value = s.openaiModel || 'gpt-5-mini';
  document.getElementById('set-effort').value = s.effort || 'medium';
  document.getElementById('settingsModal').style.display = 'flex';
}
function closeAISettings() { document.getElementById('settingsModal').style.display = 'none'; }

async function saveAISettings() {
  state.aiSettings = {
    provider: document.getElementById('set-provider').value,
    anthropicKey: document.getElementById('set-anthropic-key').value.trim(),
    anthropicModel: document.getElementById('set-anthropic-model').value.trim() || 'claude-sonnet-4-6',
    openaiKey: document.getElementById('set-openai-key').value.trim(),
    openaiModel: document.getElementById('set-openai-model').value.trim() || 'gpt-5-mini',
    effort: document.getElementById('set-effort').value,
  };
  if (window.api) await window.api.saveSettings(state.aiSettings);
  reflectAIProvider();
  closeAISettings();
  setStatus('AI settings saved', 'ok');
}

// ─── AI ASSISTANT (agentic: read-only queries + confirm-then-apply edits) ──
function aiKeydown(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAI(); } }
function quickAsk(q) { document.getElementById('aiInput').value = q; sendAI(); }
function clearAI() { document.getElementById('aiMsgs').innerHTML = '<div class="msg msg-ai">Cleared. How can I help?</div>'; }

function addAiMsg(type, text, sql) {
  const msgs = document.getElementById('aiMsgs');
  const div = document.createElement('div');
  div.className = 'msg msg-' + type;
  div.textContent = text;
  if (sql) {
    const sqlDiv = document.createElement('div');
    sqlDiv.className = 'msg-sql';
    sqlDiv.textContent = sql;
    sqlDiv.title = 'Click to insert into editor';
    sqlDiv.onclick = () => { toggleEditor(true); setEditorValue(sql); };
    const hint = document.createElement('div');
    hint.className = 'msg-sql-hint';
    hint.textContent = '↑ Click to insert into editor';
    div.appendChild(sqlDiv);
    div.appendChild(hint);
  }
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function addTyping() {
  const msgs = document.getElementById('aiMsgs');
  const div = document.createElement('div');
  div.className = 'msg msg-ai';
  div.id = 'typing-indicator';
  div.innerHTML = '<span class="typing-dot">●</span> <span class="typing-dot" style="animation-delay:.2s">●</span> <span class="typing-dot" style="animation-delay:.4s">●</span>';
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}
function removeTyping() { const t = document.getElementById('typing-indicator'); if (t) t.remove(); }

function buildAISystemPrompt() {
  const prof = state.activeProfile ? state.profiles[state.activeProfile] : null;
  const ed = state.lastEditTarget;
  return `You are the SQL assistant built into NexusSQL, a MySQL/MariaDB desktop client. Help the user debug, write, and understand SQL, and summarize their database.
${prof ? `Connection: ${prof.host}:${prof.port} as ${prof.user}.` : 'No active connection.'}
${state.activeDB ? `Active database: \`${state.activeDB}\` — all actions operate on this database.` : 'No database selected; ask the user to pick one before querying.'}
${ed ? `The on-screen result is from table \`${ed.table}\` (primary key: ${ed.pkCols.join(', ')}).` : ''}

You may take ONE action at a time by emitting a single fenced block labelled "action" containing one JSON object, e.g.:
\`\`\`action
{"type":"query","sql":"SELECT * FROM users LIMIT 5"}
\`\`\`
Actions:
- {"type":"query","sql":"<read-only SELECT / SHOW / DESCRIBE / EXPLAIN>"} — inspect schema or sample data; you receive up to 100 rows back as an OBSERVATION.
- {"type":"update_cell","table":"t","pk":{"id":1},"column":"c","value":"new"} — change ONE cell (user must confirm).
- {"type":"insert_row","table":"t","values":{"c":"v"}} — insert ONE row (user must confirm).
- {"type":"delete_row","table":"t","pk":{"id":1}} — delete ONE row (user must confirm).

Rules:
- After emitting an action, STOP and wait for the OBSERVATION before continuing.
- Investigate with "query" before proposing edits when you are unsure of schema or values.
- Edits affect a SINGLE cell or row only. NEVER DROP/TRUNCATE/ALTER or change schema, and never touch more than one row per action.
- When you are done, reply in plain prose with NO action block.
- If the user should run SQL themselves to verify before pushing, DON'T use an action — put it in a \`\`\`sql\`\`\` block so they can review and run it.
- Be concise.

Current editor SQL:
\`\`\`sql
${getEditorValue()}
\`\`\``;
}

function parseAction(text) {
  const m = text.match(/```action\s*([\s\S]*?)```/i);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch (_) { return null; }
}
function stripCodeBlocks(text) {
  return text.replace(/```action[\s\S]*?```/gi, '').replace(/```sql\n?[\s\S]*?```/gi, '').replace(/```[\s\S]*?```/g, '').trim();
}

function isReadOnlySQL(sql) {
  const s = (sql || '').trim().replace(/;+\s*$/, '');
  if (!s || s.includes(';')) return false;
  return /^(select|show|describe|desc|explain|with)\b/i.test(s)
    && !/\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|replace|call|set|rename)\b/i.test(s);
}

async function sendAI() {
  const input = document.getElementById('aiInput');
  const msg = input.value.trim();
  if (!msg) return;
  const s = state.aiSettings;
  const key = s.provider === 'openai' ? s.openaiKey : s.anthropicKey;
  if (!key) { addAiMsg('ai', `No ${s.provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key set. Click the ⚙ button to add one.`, null); return; }

  input.value = '';
  document.getElementById('aiSend').disabled = true;
  addAiMsg('user', msg, null);
  addTyping();

  const convo = [{ role: 'user', content: msg }];
  const system = buildAISystemPrompt();

  try {
    for (let step = 0; step < 6; step++) {
      const text = await callLLM(convo, system);
      const action = parseAction(text);

      if (!action) {
        removeTyping();
        const sqlMatch = text.match(/```sql\n?([\s\S]*?)```/i);
        const display = stripCodeBlocks(text);
        addAiMsg('ai', display || text, sqlMatch ? sqlMatch[1].trim() : null);
        break;
      }

      convo.push({ role: 'assistant', content: text });
      let observation;

      if (action.type === 'query') {
        removeTyping();
        addAiMsg('ai', '🔎 Inspecting the database…', action.sql);
        addTyping();
        observation = await runAIReadQuery(action.sql);
      } else if (action.type === 'update_cell' || action.type === 'insert_row' || action.type === 'delete_row') {
        removeTyping();
        const ok = await confirmAIEdit(describeAction(action));
        addTyping();
        observation = ok ? await applyAIEdit(action) : 'The user DECLINED this change. Do not retry it; suggest an alternative or stop.';
      } else {
        observation = 'Unknown action type "' + action.type + '".';
      }

      convo.push({ role: 'user', content: 'OBSERVATION:\n' + observation });

      if (step === 5) {
        removeTyping();
        addAiMsg('ai', '(Reached the action limit for one turn — ask me to continue if needed.)', null);
      }
    }
  } catch (err) {
    removeTyping();
    addAiMsg('ai', 'AI error: ' + (err && err.message ? err.message : String(err)), null);
  }
  document.getElementById('aiSend').disabled = false;
}

// ─── PROVIDER CALLS ──────────────────────────────────────────
async function callLLM(messages, system) {
  return state.aiSettings.provider === 'openai'
    ? callOpenAI(messages, system)
    : callAnthropic(messages, system);
}

async function callAnthropic(messages, system) {
  const s = state.aiSettings;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': s.anthropicKey || '',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: s.anthropicModel || 'claude-sonnet-4-6',
      max_tokens: 8192,
      system,
      messages,
      thinking: { type: 'adaptive' },
      output_config: { effort: s.effort || 'medium' },
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('');
}

async function callOpenAI(messages, system) {
  const s = state.aiSettings;
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (s.openaiKey || ''),
    },
    body: JSON.stringify({
      model: s.openaiModel || 'gpt-5-mini',
      messages: [{ role: 'system', content: system }, ...messages],
      max_completion_tokens: 8192,
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const choice = data.choices && data.choices[0];
  return (choice && choice.message && choice.message.content) || '';
}

// ─── AI TOOLS (read query + confirmed edits) ─────────────────
async function runAIReadQuery(sql) {
  if (!state.activeConn) return 'No active database connection.';
  if (!isReadOnlySQL(sql)) return 'Refused: only single read-only SELECT/SHOW/DESCRIBE/EXPLAIN statements are allowed.';
  const res = await window.api.dbQuery(state.activeConn, state.activeDB, sql);
  if (!res.ok) return 'Query error: ' + res.error;
  if (res.type !== 'select') return 'Statement ran (no result set).';
  const cols = res.cols.map(c => (typeof c === 'string' ? c : c.name));
  const rows = res.rows.slice(0, 100);
  let out = 'columns: ' + cols.join(', ') + '\n';
  out += rows.map(r => r.map(v => (v === null ? 'NULL' : String(v))).join(' | ')).join('\n');
  if (res.rows.length > 100) out += `\n… ${res.rows.length} rows total (showing first 100)`;
  return out || '(0 rows)';
}

function describeAction(a) {
  if (a.type === 'update_cell') return `UPDATE \`${a.table}\`\n   SET \`${a.column}\` = ${JSON.stringify(a.value)}\n   WHERE ${JSON.stringify(a.pk)}`;
  if (a.type === 'insert_row') return `INSERT INTO \`${a.table}\`\n   ${JSON.stringify(a.values)}`;
  if (a.type === 'delete_row') return `DELETE FROM \`${a.table}\`\n   WHERE ${JSON.stringify(a.pk)}`;
  return JSON.stringify(a);
}

function confirmAIEdit(description) {
  return new Promise(resolve => {
    const msgs = document.getElementById('aiMsgs');
    const div = document.createElement('div');
    div.className = 'msg msg-ai ai-confirm';
    const title = document.createElement('div');
    title.className = 'ai-confirm-title';
    title.textContent = '⚠ The assistant wants to change data:';
    const body = document.createElement('div');
    body.className = 'ai-confirm-body';
    body.textContent = description;
    const btns = document.createElement('div');
    btns.className = 'ai-confirm-btns';
    const apply = document.createElement('button');
    apply.className = 'run-btn'; apply.textContent = '✓ Apply';
    const reject = document.createElement('button');
    reject.className = 'tb-btn'; reject.textContent = '✕ Reject';
    const done = (ok, label) => { apply.disabled = reject.disabled = true; div.classList.add(ok ? 'approved' : 'rejected'); title.textContent = label; resolve(ok); };
    apply.onclick = () => done(true, '✓ Applied:');
    reject.onclick = () => done(false, '✕ Rejected:');
    btns.appendChild(apply); btns.appendChild(reject);
    div.appendChild(title); div.appendChild(body); div.appendChild(btns);
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  });
}

async function fetchRowValues(db, table, pkObj) {
  if (!window.api.dbGetRow) return null;
  const res = await window.api.dbGetRow(state.activeConn, db, table, pkObj);
  return res && res.ok ? res.row : null;
}

async function derivePkForUndo(table, values, insertId) {
  const desc = await window.api.dbDescribeTable(state.activeConn, state.activeDB, table);
  if (!desc.ok) return null;
  const pkCols = desc.columns.filter(c => c.Key === 'PRI').map(c => c.Field);
  if (!pkCols.length) return null;
  if (pkCols.every(pk => values && pk in values)) {
    const w = {}; pkCols.forEach(pk => { w[pk] = values[pk]; }); return w;
  }
  if (pkCols.length === 1 && insertId) return { [pkCols[0]]: insertId };
  return null;
}

async function refreshIfAffected(table) {
  if (state.lastEditTarget && state.lastEditTarget.table === table && state.lastResult && state.lastResult.sql) await rerunLast();
}

async function applyAIEdit(action) {
  if (!state.activeConn || !state.activeDB) return 'No active database/connection.';
  const db = state.activeDB, table = action.table;
  try {
    if (action.type === 'update_cell') {
      const where = action.pk || {};
      const old = await fetchRowValues(db, table, where);
      const res = await window.api.dbUpdateCell(state.activeConn, db, table, action.column, action.value, where);
      if (!res.ok) return 'Update failed: ' + res.error;
      if (old && action.column in old) pushUndo({ kind: 'update', db, table, column: action.column, where: { ...where, [action.column]: action.value }, value: old[action.column] });
      setStatus('AI updated 1 cell', 'ok');
      await refreshIfAffected(table);
      return `Applied. ${res.affectedRows} row(s) updated.`;
    }
    if (action.type === 'insert_row') {
      const values = action.values || {};
      const res = await window.api.dbInsertRow(state.activeConn, db, table, values);
      if (!res.ok) return 'Insert failed: ' + res.error;
      const where = await derivePkForUndo(table, values, res.insertId);
      if (where) pushUndo({ kind: 'delete', db, table, where });
      setStatus('AI inserted 1 row', 'ok');
      await refreshIfAffected(table);
      return `Applied. Inserted row (insertId: ${res.insertId || 'n/a'}).`;
    }
    if (action.type === 'delete_row') {
      const where = action.pk || {};
      const full = await fetchRowValues(db, table, where);
      const res = await window.api.dbDeleteRow(state.activeConn, db, table, where);
      if (!res.ok) return 'Delete failed: ' + res.error;
      if (full) pushUndo({ kind: 'insert', db, table, values: full });
      setStatus('AI deleted 1 row', 'ok');
      await refreshIfAffected(table);
      return `Applied. ${res.affectedRows} row(s) deleted.`;
    }
  } catch (err) {
    return 'Edit error: ' + (err && err.message ? err.message : String(err));
  }
  return 'Unknown edit.';
}

// ─── UNDO (inverse-op stack, last 3 structured edits) ────────
function pushUndo(op) {
  state.undoStack.push(op);
  if (state.undoStack.length > 3) state.undoStack.shift();
  updateUndoUI();
}

function updateUndoUI() {
  const btn = document.getElementById('undoBtn');
  if (!btn) return;
  btn.style.display = state.undoStack.length ? '' : 'none';
  btn.textContent = '↶ Undo (' + state.undoStack.length + ')';
}

async function undoLastEdit() {
  const op = state.undoStack.pop();
  if (!op) return;
  let res;
  if (op.kind === 'update') res = await window.api.dbUpdateCell(state.activeConn, op.db, op.table, op.column, op.value, op.where);
  else if (op.kind === 'delete') res = await window.api.dbDeleteRow(state.activeConn, op.db, op.table, op.where);
  else if (op.kind === 'insert') res = await window.api.dbInsertRow(state.activeConn, op.db, op.table, op.values);
  if (res && !res.ok) { setStatus('Undo failed: ' + res.error, 'err'); state.undoStack.push(op); updateUndoUI(); return; }
  setStatus('Undid last change', 'ok');
  updateUndoUI();
  if (state.lastEditTarget && state.lastEditTarget.table === op.table && state.lastResult && state.lastResult.sql) await rerunLast();
  else renderActiveResult();
}
