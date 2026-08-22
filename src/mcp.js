'use strict';
// ═══════════════════════════════════════════════════════════════
//  MCP SERVER — renderer half (settings panel + approval prompts)
// ═══════════════════════════════════════════════════════════════
// The server itself lives in the main process (mcp-server.js). Everything here
// is the control panel and the confirm dialog it pops. Shares the global
// `state`, `esc()` and `setStatus()` from app.js.

const mcpState = {
  cfg: null,          // last config received from main
  status: null,       // { running, port, url, client }
  tools: [],          // [{ name, tier, description }]
  tokenVisible: false,
  approval: null,     // request currently on screen
  countdown: null,    // interval handle for the auto-deny timer
};

async function refreshMcp() {
  if (!window.api || !window.api.mcpGet) return null;
  const res = await window.api.mcpGet();
  if (!res || !res.ok) return null;
  mcpState.cfg = res.config;
  mcpState.status = res;
  mcpState.tools = res.tools || [];
  renderMcpLog(res.log || []);
  updateMcpDot();
  return res;
}

function updateMcpDot() {
  const dot = document.getElementById('mcpDot');
  if (dot) dot.classList.toggle('on', !!(mcpState.status && mcpState.status.running));
}

function setRadio(name, value) {
  document.querySelectorAll('input[name="' + name + '"]').forEach(r => { r.checked = (r.value === value); });
}
function getRadio(name, fallback) {
  const hit = document.querySelector('input[name="' + name + '"]:checked');
  return hit ? hit.value : fallback;
}

// ─── SETTINGS MODAL ──────────────────────────────────────────
async function openMcpSettings() {
  await refreshMcp();
  if (!mcpState.cfg) { setStatus('MCP is unavailable — restart the app', 'err'); return; }
  const c = mcpState.cfg;

  document.getElementById('mcp-port').value = c.port;
  document.getElementById('mcp-autostart').checked = !!c.autoStart;
  document.getElementById('mcp-dangerous').checked = !!c.dangerousEnabled;
  setRadio('mcpScope', c.connectionAccess);
  setRadio('mcpLevel', c.permissionLevel);
  setRadio('mcpCustomMode', c.customMode || 'whitelist');
  setRadio('mcpApproval', c.approval);

  renderMcpProfiles();
  renderMcpTools();
  onMcpDangerToggle();   // also fixes up the Complete-access radio's enabled state
  onMcpScopeChange();
  onMcpLevelChange();
  reflectMcpServerState();

  document.getElementById('mcpModal').style.display = 'flex';
}

function closeMcpSettings() { document.getElementById('mcpModal').style.display = 'none'; }

function reflectMcpServerState() {
  const s = mcpState.status || {};
  const pill = document.getElementById('mcpPill');
  pill.textContent = s.running ? 'Running' : 'Stopped';
  pill.className = 'mcp-pill' + (s.running ? ' running' : '');
  document.getElementById('mcpToggleBtn').textContent = s.running ? 'Stop' : 'Start';
  document.getElementById('mcpUrl').textContent = s.running
    ? s.url + (s.client ? '  ·  ' + s.client + ' connected' : '')
    : 'Not running';
  document.getElementById('mcp-port').disabled = !!s.running;
  renderMcpCommand();
  updateMcpDot();
}

function mcpConnectCommand(reveal) {
  const c = mcpState.cfg || {};
  const port = document.getElementById('mcp-port').value || c.port;
  const token = reveal ? (c.token || '') : '•'.repeat(24);
  return 'claude mcp add --transport http nexussql http://127.0.0.1:' + port +
         '/mcp --header "Authorization: Bearer ' + token + '"';
}

function renderMcpCommand() {
  document.getElementById('mcpCmd').textContent = mcpConnectCommand(mcpState.tokenVisible);
  document.getElementById('mcpTokenBtn').textContent = mcpState.tokenVisible ? '🙈 Hide token' : '👁 Reveal token';
}

function toggleMcpToken() { mcpState.tokenVisible = !mcpState.tokenVisible; renderMcpCommand(); }

async function copyMcpCommand() {
  await window.api.clipboardWrite(mcpConnectCommand(true));
  setStatus('Connect command copied — it contains your access token', 'ok');
}

async function regenMcpToken() {
  if (!confirm('Generate a new access token?\n\nAny AI client already configured with the old token stops working until you re-add it with the new command.')) return;
  const res = await window.api.mcpRegenToken();
  if (res.ok) {
    mcpState.cfg = res.config;
    mcpState.status = res;
    renderMcpCommand();
    setStatus('New MCP token generated', 'ok');
  }
}

async function toggleMcpServer() {
  const running = mcpState.status && mcpState.status.running;
  if (!running) {
    await saveMcpSettings(true);          // persist the port before we bind to it
    const res = await window.api.mcpStart();
    mcpState.status = res;
    mcpState.cfg = res.config;
    if (!res.ok) setStatus('MCP start failed: ' + res.error, 'err');
    else setStatus('MCP server listening on 127.0.0.1:' + res.port, 'ok');
  } else {
    const res = await window.api.mcpStop();
    mcpState.status = res;
    mcpState.cfg = res.config;
    setStatus('MCP server stopped', 'ok');
  }
  reflectMcpServerState();
}

function renderMcpProfiles() {
  const box = document.getElementById('mcpProfileList');
  const allowed = new Set((mcpState.cfg && mcpState.cfg.allowedProfiles) || []);
  const list = Object.values(state.profiles || {});
  if (!list.length) {
    box.innerHTML = '<div class="mcp-list-empty">No saved connections yet — add one with “+ Connection” first.</div>';
    return;
  }
  box.innerHTML = list.map(p =>
    '<label class="mcp-check">' +
      '<input type="checkbox" class="mcp-prof" value="' + esc(p.id) + '"' + (allowed.has(p.id) ? ' checked' : '') + '>' +
      '<span>' + esc(p.name || p.host) + '</span>' +
      '<span class="mcp-note">' + esc(p.user || '') + '@' + esc(p.host || '') + ':' + esc(String(p.port || 3306)) +
        (p.database ? ' · ' + esc(p.database) : '') + '</span>' +
    '</label>'
  ).join('');
}

function renderMcpTools() {
  const box = document.getElementById('mcpToolList');
  if (!box) return;
  const picked = new Set((mcpState.cfg && mcpState.cfg.customTools) || []);
  const danger = document.getElementById('mcp-dangerous').checked;
  box.innerHTML = mcpState.tools.map(t => {
    const locked = t.tier === 'danger' && !danger;
    const pillCls = t.tier === 'read' ? '' : (t.tier === 'danger' ? 'danger' : 'write');
    return '<label class="mcp-check' + (locked ? ' disabled' : '') + '" title="' + esc(t.description) + '">' +
      '<input type="checkbox" class="mcp-tool" value="' + esc(t.name) + '"' +
        (picked.has(t.name) ? ' checked' : '') + (locked ? ' disabled' : '') + '>' +
      '<span class="mcp-tool-name">' + esc(t.name) + '</span>' +
      '<span class="mcp-pill ' + pillCls + '">' + esc(t.tier) + '</span>' +
    '</label>';
  }).join('');
}

function onMcpScopeChange() {
  const selected = getRadio('mcpScope', 'selected') === 'selected';
  document.getElementById('mcpProfileList').style.display = selected ? '' : 'none';
}

function onMcpLevelChange() {
  document.getElementById('mcpCustomBox').style.display = getRadio('mcpLevel', 'read') === 'custom' ? '' : 'none';
}

// The danger toggle is the only thing that unlocks Complete access / execute_sql.
function onMcpDangerToggle() {
  const on = document.getElementById('mcp-dangerous').checked;
  const row = document.getElementById('mcpCompleteRow');
  const radio = row.querySelector('input');
  radio.disabled = !on;
  row.classList.toggle('disabled', !on);
  if (!on && radio.checked) { setRadio('mcpLevel', 'full'); onMcpLevelChange(); }
  renderMcpTools();
}

async function saveMcpSettings(silent) {
  const dangerous = document.getElementById('mcp-dangerous').checked;
  let level = getRadio('mcpLevel', 'read');
  if (level === 'complete' && !dangerous) level = 'full';

  if (level === 'complete' && !silent) {
    const ok = confirm(
      'Complete access gives the AI unrestricted SQL on every connection you share with it.\n\n' +
      'It will be able to DROP tables, TRUNCATE data, and run UPDATE/DELETE with no WHERE clause. ' +
      'Nothing is validated, capped, or undoable.\n\nEnable it anyway?'
    );
    if (!ok) return;
  }

  const cfg = {
    port: parseInt(document.getElementById('mcp-port').value) || 4319,
    autoStart: document.getElementById('mcp-autostart').checked,
    dangerousEnabled: dangerous,
    connectionAccess: getRadio('mcpScope', 'selected'),
    allowedProfiles: [...document.querySelectorAll('.mcp-prof:checked')].map(el => el.value),
    permissionLevel: level,
    customMode: getRadio('mcpCustomMode', 'whitelist'),
    customTools: [...document.querySelectorAll('.mcp-tool:checked')].map(el => el.value),
    approval: getRadio('mcpApproval', 'writes'),
  };

  const res = await window.api.mcpSave(cfg);
  if (!res.ok) { setStatus('Could not save MCP settings: ' + res.error, 'err'); return; }
  mcpState.cfg = res.config;
  mcpState.status = res;
  setRadio('mcpLevel', res.config.permissionLevel);
  reflectMcpServerState();
  if (!silent) setStatus('MCP settings saved', 'ok');
}

// ─── ACTIVITY LOG ────────────────────────────────────────────
function mcpLogRowHtml(r) {
  const t = (r.time || '').slice(11, 19);
  const cls = r.status === 'error' ? 'err'
            : r.status === 'denied' ? 'denied'
            : r.status === 'blocked' ? 'blocked' : '';
  const tool = (r.tool && r.tool !== '—') ? r.tool + ' · ' : '';
  return '<div class="mcp-log-row ' + cls + '">' +
    '<span class="mcp-log-time">' + esc(t) + '</span>' +
    '<span class="mcp-log-msg">' + esc(tool + (r.summary || '')) + '</span></div>';
}

function renderMcpLog(rows) {
  const box = document.getElementById('mcpLog');
  if (!box) return;
  if (!rows.length) { box.innerHTML = '<div class="mcp-hint">Nothing yet.</div>'; return; }
  box.innerHTML = rows.map(mcpLogRowHtml).join('');
  box.scrollTop = box.scrollHeight;
}

// ─── APPROVAL PROMPT ─────────────────────────────────────────
function showMcpApproval(req) {
  mcpState.approval = req;

  const pill = document.getElementById('mcpApprovalTier');
  pill.textContent = req.tier;
  pill.className = 'mcp-pill ' + (req.tier === 'read' ? '' : (req.tier === 'danger' ? 'danger' : 'write'));

  document.getElementById('mcpApprovalTitle').textContent =
    req.tier === 'read'   ? 'AI wants to read data' :
    req.tier === 'danger' ? '⚠ AI wants to run raw SQL' :
                            'AI wants to change data';
  document.getElementById('mcpApprovalTool').textContent = req.tool;
  document.getElementById('mcpApprovalConn').textContent = 'on ' + (req.connection || '');
  document.getElementById('mcpApprovalSummary').textContent = req.summary || '';
  document.getElementById('mcpApprovalArgs').textContent = JSON.stringify(req.args || {}, null, 2);
  document.getElementById('mcpApprovalModal').style.display = 'flex';

  // Mirror the main process's 60s auto-deny so the countdown is honest.
  let left = Math.round((req.timeoutMs || 60000) / 1000);
  const el = document.getElementById('mcpCountdown');
  el.textContent = left + 's';
  clearInterval(mcpState.countdown);
  mcpState.countdown = setInterval(() => {
    left--;
    el.textContent = Math.max(left, 0) + 's';
    if (left <= 0) clearInterval(mcpState.countdown);
  }, 1000);
}

function hideMcpApproval() {
  clearInterval(mcpState.countdown);
  mcpState.approval = null;
  document.getElementById('mcpApprovalModal').style.display = 'none';
}

function answerMcpApproval(decision) {
  const req = mcpState.approval;
  if (!req) return;
  window.api.mcpApprovalRespond(req.reqId, decision);
  hideMcpApproval();
  if (decision === 'deny') setStatus('Denied the AI request: ' + req.tool, 'err');
}

// Called when a saved connection is deleted, so its id doesn't linger in the
// MCP allowlist. Silent no-op if the profile was never shared.
async function mcpForgetProfile(profileId) {
  if (!window.api || !window.api.mcpGet) return;
  try {
    const cur = await window.api.mcpGet();
    if (!cur || !cur.ok) return;
    const allowed = cur.config.allowedProfiles || [];
    if (!allowed.includes(profileId)) return;
    const next = { ...cur.config, allowedProfiles: allowed.filter(id => id !== profileId) };
    delete next.token;                       // main keeps the token; never round-trip it
    const res = await window.api.mcpSave(next);
    if (res && res.ok) { mcpState.cfg = res.config; mcpState.status = res; }
  } catch (_) { /* MCP is optional — never block a delete on it */ }
}

// ─── WIRING ──────────────────────────────────────────────────
function bindMcpEvents() {
  if (!window.api || !window.api.onMcpApproval) return;

  window.api.onMcpApproval(showMcpApproval);

  // Main auto-denied on timeout — drop the dialog so it can't be answered late.
  window.api.onMcpApprovalCancel(({ reqId }) => {
    if (mcpState.approval && mcpState.approval.reqId === reqId) {
      hideMcpApproval();
      setStatus('MCP request timed out and was denied', 'err');
    }
  });

  window.api.onMcpLog(row => {
    mcpState.status = mcpState.status || {};
    const box = document.getElementById('mcpLog');
    if (!box || document.getElementById('mcpModal').style.display === 'none') return;
    const placeholder = box.querySelector('.mcp-hint');
    if (placeholder) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', mcpLogRowHtml(row));
    box.scrollTop = box.scrollHeight;
  });

  if (window.api.onMenuMcp) window.api.onMenuMcp(() => openMcpSettings());
  document.getElementById('mcp-port').addEventListener('input', renderMcpCommand);

  refreshMcp();
}

document.addEventListener('DOMContentLoaded', bindMcpEvents);
