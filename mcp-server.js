'use strict';
//
// NexusSQL — local MCP server.
//
// Exposes the app's database access to external AI clients (Claude Code, Claude
// Desktop, local agents) over the MCP "Streamable HTTP" transport, bound to
// loopback only and gated by a bearer token.
//
// This is a hand-rolled implementation of the small slice of MCP we actually
// need (initialize / tools list / tools call). It has no npm dependencies on
// purpose — the whole app ships with just mysql2.
//
// Wire format recap, so the code below is readable:
//   POST /mcp   JSON-RPC 2.0 message (or a batch array) → JSON-RPC response
//   GET  /mcp   405 — we never push server-initiated streams
//   DELETE /mcp ends the session
//
const http = require('http');
const crypto = require('crypto');

const LATEST_PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 1024 * 1024;      // 1 MB — a tool call is never bigger than this
const DEFAULT_ROW_LIMIT = 200;
const MAX_ROW_LIMIT = 1000;

// ─── READ-ONLY SQL VALIDATION ────────────────────────────────
// Used by the `run_select` tool. Comments and string literals are stripped
// first so a keyword can't be smuggled inside them, then we require an
// allow-listed leading keyword AND the absence of any mutating keyword.
function isReadOnlySQL(sql) {
  if (!sql || typeof sql !== 'string') return false;
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .trim()
    .replace(/;+\s*$/, '');
  if (!stripped) return false;
  if (/;/.test(stripped)) return false;                       // no statement chaining
  const first = (stripped.replace(/^[(\s]+/, '').split(/\s+/)[0] || '').toUpperCase();
  if (!['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH'].includes(first)) return false;
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT|REVOKE|RENAME|CALL|LOAD|HANDLER|LOCK|UNLOCK|SET|PREPARE|EXECUTE|BEGIN|COMMIT|ROLLBACK)\b/i.test(stripped)) return false;
  if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(stripped)) return false;
  return true;
}

// ─── TOOL REGISTRY ───────────────────────────────────────────
// `tier` drives the permission model:
//   read   → always available
//   write  → row-level INSERT / UPDATE / DELETE   (Limited and above)
//   schema → ALTER TABLE add/change/drop column   (Full only)
const CONN_ARG = {
  connection: {
    type: 'string',
    description: 'Saved connection name or id from list_connections. May be omitted when only one connection is available.',
  },
};

const TOOLS = [
  {
    name: 'list_connections', tier: 'read',
    description: 'List the NexusSQL saved database connections you are allowed to use. Always call this first — every other tool needs a connection name. The response also states whether a connection is pinned to a single database.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_databases', tier: 'read',
    description: 'List the databases (schemas) on a connection\'s server.',
    inputSchema: { type: 'object', properties: { ...CONN_ARG } },
  },
  {
    name: 'list_tables', tier: 'read',
    description: 'List the tables and views inside one database.',
    inputSchema: {
      type: 'object',
      properties: { ...CONN_ARG, database: { type: 'string', description: 'Database name.' } },
      required: ['database'],
    },
  },
  {
    name: 'describe_table', tier: 'read',
    description: 'Show a table\'s columns: name, type, nullability, key, default and extra (e.g. auto_increment). Use this before writing to a table so you know its primary key.',
    inputSchema: {
      type: 'object',
      properties: { ...CONN_ARG, database: { type: 'string' }, table: { type: 'string' } },
      required: ['database', 'table'],
    },
  },
  {
    name: 'count_rows', tier: 'read',
    description: 'Return the exact row count of a table.',
    inputSchema: {
      type: 'object',
      properties: { ...CONN_ARG, database: { type: 'string' }, table: { type: 'string' } },
      required: ['database', 'table'],
    },
  },
  {
    name: 'run_select', tier: 'read',
    description: 'Run one read-only SQL statement (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH) and return the rows. Anything that writes is rejected — use the dedicated write tools instead. Results are capped; narrow your query rather than raising the cap.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONN_ARG,
        database: { type: 'string', description: 'Database to run against (applied as USE before the query).' },
        sql: { type: 'string', description: 'A single read-only statement. No semicolon-separated batches.' },
        limit: { type: 'integer', description: `Max rows to return (default ${DEFAULT_ROW_LIMIT}, hard cap ${MAX_ROW_LIMIT}).` },
      },
      required: ['sql'],
    },
  },
  {
    name: 'update_cell', tier: 'write',
    description: 'Set one column of one row to a new value. The row is located by its primary key, and the statement is LIMIT 1 — this can never mass-update. Call describe_table first to learn the primary key.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONN_ARG,
        database: { type: 'string' }, table: { type: 'string' },
        column: { type: 'string', description: 'Column to change.' },
        value: { description: 'New value. Use null for SQL NULL.' },
        where: { type: 'object', description: 'Primary key of the target row, as {column: value}. Every PK column must be present.' },
      },
      required: ['database', 'table', 'column', 'where'],
    },
  },
  {
    name: 'insert_row', tier: 'write',
    description: 'Insert one row. Omit `values` (or pass {}) to insert a row made entirely of column defaults. Returns the generated insert id when the table has an auto_increment key.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONN_ARG,
        database: { type: 'string' }, table: { type: 'string' },
        values: { type: 'object', description: 'Column → value map. Leave out columns that should take their default.' },
      },
      required: ['database', 'table'],
    },
  },
  {
    name: 'delete_row', tier: 'write',
    description: 'Delete exactly one row, located by primary key (LIMIT 1). There is no bulk delete — call this once per row, and confirm the row first with run_select.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONN_ARG,
        database: { type: 'string' }, table: { type: 'string' },
        where: { type: 'object', description: 'Primary key of the row to delete, as {column: value}.' },
      },
      required: ['database', 'table', 'where'],
    },
  },
  {
    name: 'add_column', tier: 'schema',
    description: 'Add a column to a table (ALTER TABLE ... ADD COLUMN). The type is validated against a strict pattern; expressions and multi-statement types are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONN_ARG,
        database: { type: 'string' }, table: { type: 'string' },
        name: { type: 'string', description: 'New column name.' },
        type: { type: 'string', description: 'Column type, e.g. VARCHAR(255), INT UNSIGNED, DATETIME.' },
        nullable: { type: 'boolean', description: 'Allow NULL. Default true.' },
        hasDefault: { type: 'boolean', description: 'Set true to attach a DEFAULT clause.' },
        defaultVal: { description: 'Default value, used when hasDefault is true. null means DEFAULT NULL.' },
      },
      required: ['database', 'table', 'name', 'type'],
    },
  },
  {
    name: 'alter_column', tier: 'schema',
    description: 'Rename and/or retype an existing column (ALTER TABLE ... CHANGE). MySQL restates the whole definition here, so pass every property you want kept — including autoIncrement — or it will be dropped. Read describe_table first.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONN_ARG,
        database: { type: 'string' }, table: { type: 'string' },
        oldName: { type: 'string', description: 'Current column name.' },
        newName: { type: 'string', description: 'New name. Pass the same as oldName to keep it.' },
        type: { type: 'string', description: 'Full column type to apply.' },
        nullable: { type: 'boolean' },
        hasDefault: { type: 'boolean' },
        defaultVal: {},
        autoIncrement: { type: 'boolean', description: 'Re-apply AUTO_INCREMENT. Set true if the column currently has it.' },
      },
      required: ['database', 'table', 'oldName', 'newName', 'type'],
    },
  },
  {
    name: 'drop_column', tier: 'schema',
    description: 'Permanently drop a column and all data in it. Irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONN_ARG,
        database: { type: 'string' }, table: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['database', 'table', 'name'],
    },
  },
  {
    name: 'execute_sql', tier: 'danger',
    description: 'Execute ANY SQL statement verbatim, including DDL and DML — CREATE, DROP, TRUNCATE, bulk UPDATE/DELETE, GRANT. There is no validation, no row cap and no undo. Only available when the user has switched on Dangerous Settings and Complete Access. Prefer the safe, targeted tools whenever they can do the job, and state plainly what a destructive statement will do before running it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONN_ARG,
        database: { type: 'string', description: 'Database to run against (applied as USE first).' },
        sql: { type: 'string', description: 'One SQL statement. Multi-statement batches are rejected by the driver.' },
      },
      required: ['sql'],
    },
  },
];

const TOOL_NAMES = TOOLS.map(t => t.name);
const TIERS_FOR_LEVEL = {
  read:     ['read'],
  limited:  ['read', 'write'],
  full:     ['read', 'write', 'schema'],
  complete: ['read', 'write', 'schema', 'danger'],
};

// The `danger` tier (arbitrary SQL) exists only while the user has explicitly
// switched on Dangerous Settings. If that toggle is off we silently degrade
// Complete Access back to Full, and custom lists can't smuggle it in either.
function effectiveLevel(cfg) {
  if (cfg.permissionLevel === 'complete' && !cfg.dangerousEnabled) return 'full';
  return cfg.permissionLevel;
}

// Which tools the current config exposes.
function allowedToolNames(cfg) {
  const dangerOk = !!cfg.dangerousEnabled;
  const gate = names => dangerOk ? names : names.filter(n => (toolByName(n) || {}).tier !== 'danger');

  if (cfg.permissionLevel === 'custom') {
    const list = Array.isArray(cfg.customTools) ? cfg.customTools : [];
    return gate(cfg.customMode === 'blacklist'
      ? TOOL_NAMES.filter(n => !list.includes(n))
      : TOOL_NAMES.filter(n => list.includes(n)));
  }
  const tiers = TIERS_FOR_LEVEL[effectiveLevel(cfg)] || TIERS_FOR_LEVEL.read;
  return gate(TOOLS.filter(t => tiers.includes(t.tier)).map(t => t.name));
}

function toolByName(name) { return TOOLS.find(t => t.name === name); }

// ─── JSON-RPC PLUMBING ───────────────────────────────────────
class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Reject cross-origin browser traffic (DNS-rebinding protection). A real MCP
// client sends no Origin at all; a hostile web page always does.
function originAllowed(origin) {
  if (!origin || origin === 'null') return true;
  try {
    const h = new URL(origin).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch (_) { return false; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ─── SERVER ──────────────────────────────────────────────────
//
// deps = {
//   db,                 // database operations, supplied by main.js
//   getConfig(),        // current MCP settings
//   getProfiles(),      // saved connection profiles (with decrypted passwords)
//   requestApproval(),  // → Promise<{allowed, reason}>
//   log(entry),         // activity log sink
//   appVersion,
// }
function createMcpServer(deps) {
  let server = null;
  let sessionId = null;
  let clientInfo = null;
  const sessionGrants = new Set();   // tool names the user approved "for this session"

  const cfg = () => deps.getConfig();

  // Profiles this server is permitted to touch.
  function visibleProfiles() {
    const c = cfg();
    const all = deps.getProfiles() || [];
    if (c.connectionAccess === 'selected') {
      const allow = new Set(c.allowedProfiles || []);
      return all.filter(p => allow.has(p.id));
    }
    return all;
  }

  function resolveProfile(arg) {
    const list = visibleProfiles();
    if (!list.length) {
      throw new RpcError(-32602, 'No database connections are shared with MCP. The NexusSQL user must allow at least one connection in MCP Settings.');
    }
    if (!arg) {
      if (list.length === 1) return list[0];
      throw new RpcError(-32602, `Ambiguous connection. Pass "connection" as one of: ${list.map(p => p.name).join(', ')}`);
    }
    const needle = String(arg).toLowerCase();
    const hit = list.find(p => p.id === arg) || list.find(p => (p.name || '').toLowerCase() === needle);
    if (!hit) {
      throw new RpcError(-32602, `Connection "${arg}" is not available. Allowed: ${list.map(p => p.name).join(', ')}`);
    }
    return hit;
  }

  // A profile pinned to one database confines MCP to that database — otherwise
  // "share this one connection" would silently expose every schema on the server.
  function resolveDatabase(profile, requested) {
    if (profile.database) {
      if (requested && requested !== profile.database) {
        throw new RpcError(-32602, `Connection "${profile.name}" is pinned to database "${profile.database}"; "${requested}" is out of scope.`);
      }
      return profile.database;
    }
    return requested || undefined;
  }

  function unwrap(res, what) {
    if (!res || res.ok !== true) throw new RpcError(-32603, (res && res.error) || `${what} failed`);
    return res;
  }

  // ── tool execution ──
  async function execTool(name, args, poolId, profile) {
    const db = deps.db;
    const dbName = resolveDatabase(profile, args.database);
    const needDb = () => {
      if (!dbName) throw new RpcError(-32602, 'A "database" argument is required for this connection.');
      return dbName;
    };

    switch (name) {
      case 'list_databases': {
        if (profile.database) return { databases: [profile.database], note: 'This connection is pinned to a single database.' };
        return { databases: unwrap(await db.listDatabases(poolId), 'list databases').databases };
      }
      case 'list_tables':
        return { database: needDb(), tables: unwrap(await db.listTables(poolId, needDb()), 'list tables').tables };
      case 'describe_table':
        return { columns: unwrap(await db.describeTable(poolId, needDb(), args.table), 'describe table').columns };
      case 'count_rows':
        return { count: unwrap(await db.tableCount(poolId, needDb(), args.table), 'count rows').count };
      case 'run_select': {
        if (!isReadOnlySQL(args.sql)) {
          throw new RpcError(-32602, 'Rejected: run_select accepts a single read-only statement (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH). Use update_cell, insert_row or delete_row to change data.');
        }
        const limit = Math.min(Math.max(parseInt(args.limit) || DEFAULT_ROW_LIMIT, 1), MAX_ROW_LIMIT);
        const res = unwrap(await db.query(poolId, dbName, args.sql), 'query');
        if (res.type !== 'select') return { affectedRows: res.affectedRows };
        const rows = res.rows.slice(0, limit);
        return {
          columns: res.cols.map(c => c.name),
          rows,
          rowCount: rows.length,
          truncated: res.rows.length > limit,
          elapsedMs: res.elapsed,
        };
      }
      case 'update_cell': {
        const r = unwrap(await db.updateCell(poolId, needDb(), args.table, args.column, args.value === undefined ? null : args.value, args.where), 'update');
        if (!r.affectedRows) throw new RpcError(-32603, 'No row matched that primary key — nothing was changed.');
        return { affectedRows: r.affectedRows };
      }
      case 'insert_row': {
        const r = unwrap(await db.insertRow(poolId, needDb(), args.table, args.values || {}), 'insert');
        return { affectedRows: r.affectedRows, insertId: r.insertId };
      }
      case 'delete_row': {
        const r = unwrap(await db.deleteRow(poolId, needDb(), args.table, args.where), 'delete');
        if (!r.affectedRows) throw new RpcError(-32603, 'No row matched that primary key — nothing was deleted.');
        return { affectedRows: r.affectedRows };
      }
      case 'add_column':
        unwrap(await db.addColumn(poolId, needDb(), args.table, {
          name: args.name, type: args.type,
          nullable: args.nullable !== false, hasDefault: !!args.hasDefault, defaultVal: args.defaultVal,
        }), 'add column');
        return { ok: true };
      case 'alter_column':
        unwrap(await db.alterColumn(poolId, needDb(), args.table, {
          oldName: args.oldName, newName: args.newName, type: args.type,
          nullable: args.nullable !== false, hasDefault: !!args.hasDefault, defaultVal: args.defaultVal,
          autoIncrement: !!args.autoIncrement,
        }), 'alter column');
        return { ok: true };
      case 'drop_column':
        unwrap(await db.dropColumn(poolId, needDb(), args.table, args.name), 'drop column');
        return { ok: true };
      case 'execute_sql': {
        const res = unwrap(await db.query(poolId, dbName, args.sql), 'execute');
        if (res.type !== 'select') {
          return { affectedRows: res.affectedRows, insertId: res.insertId, info: res.info, elapsedMs: res.elapsed };
        }
        const rows = res.rows.slice(0, MAX_ROW_LIMIT);
        return {
          columns: res.cols.map(c => c.name),
          rows,
          rowCount: rows.length,
          truncated: res.rows.length > MAX_ROW_LIMIT,
          elapsedMs: res.elapsed,
        };
      }
      default:
        throw new RpcError(-32601, 'Unknown tool: ' + name);
    }
  }

  // One-line human summary shown in the approval prompt and the activity log.
  function summarize(name, args, profile) {
    const t = args.table ? `${args.database || profile.database || '?'}.${args.table}` : (args.database || '');
    switch (name) {
      case 'list_connections': return 'List shared connections';
      case 'list_databases':   return 'List databases';
      case 'list_tables':      return `List tables in ${t}`;
      case 'describe_table':   return `Describe ${t}`;
      case 'count_rows':       return `Count rows in ${t}`;
      case 'run_select':       return `Run: ${String(args.sql || '').replace(/\s+/g, ' ').slice(0, 120)}`;
      case 'update_cell':      return `Set ${t}.${args.column} = ${JSON.stringify(args.value)} where ${JSON.stringify(args.where)}`;
      case 'insert_row':       return `Insert into ${t}: ${JSON.stringify(args.values || {})}`;
      case 'delete_row':       return `DELETE from ${t} where ${JSON.stringify(args.where)}`;
      case 'add_column':       return `Add column ${args.name} ${args.type} to ${t}`;
      case 'alter_column':     return `Change ${t}.${args.oldName} → ${args.newName} ${args.type}`;
      case 'drop_column':      return `DROP column ${t}.${args.name}`;
      case 'execute_sql':      return `RAW SQL: ${String(args.sql || '').replace(/\s+/g, ' ').slice(0, 200)}`;
      default:                 return name;
    }
  }

  async function callTool(params) {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const c = cfg();
    const tool = toolByName(name);

    if (!tool) throw new RpcError(-32601, 'Unknown tool: ' + name);
    if (!allowedToolNames(c).includes(name)) {
      deps.log({ tool: name, status: 'blocked', summary: `Blocked by permission level (${effectiveLevel(c)})` });
      throw new RpcError(-32601, `Tool "${name}" is disabled by the NexusSQL user's MCP permission settings (current level: ${effectiveLevel(c)}).`);
    }

    if (name === 'list_connections') {
      const list = visibleProfiles().map(p => ({
        id: p.id, name: p.name, host: p.host, port: p.port,
        pinnedDatabase: p.database || null,
      }));
      deps.log({ tool: name, status: 'ok', summary: `Listed ${list.length} connection(s)` });
      return { connections: list, note: list.length ? undefined : 'The user has not shared any connections with MCP.' };
    }

    const profile = resolveProfile(args.connection);
    const summary = summarize(name, args, profile);

    // ── approval gate ──
    const needsApproval =
      c.approval === 'always' ? true :
      c.approval === 'writes' ? tool.tier !== 'read' :
      false;

    if (needsApproval && !sessionGrants.has(name)) {
      const verdict = await deps.requestApproval({
        tool: name, tier: tool.tier, connection: profile.name,
        summary, args,
      });
      if (verdict.decision === 'allow-session') sessionGrants.add(name);
      if (!verdict.allowed) {
        deps.log({ tool: name, connection: profile.name, status: 'denied', summary: `${summary} — ${verdict.reason || 'denied'}` });
        throw new RpcError(-32001, verdict.reason === 'timeout'
          ? 'The NexusSQL user did not respond to the approval prompt in time, so this action was denied. Ask them to approve it, or try a read-only alternative.'
          : 'The NexusSQL user denied this action. Do not retry it — explain what you wanted to do and ask them what to do instead.');
      }
    }

    const poolId = await deps.db.poolForProfile(profile);
    try {
      const out = await execTool(name, args, poolId, profile);
      deps.log({ tool: name, connection: profile.name, status: 'ok', summary });
      return out;
    } catch (err) {
      deps.log({ tool: name, connection: profile.name, status: 'error', summary: `${summary} — ${err.message}` });
      throw err;
    }
  }

  // Told to the AI client at initialize time, so it knows the rules up front.
  function buildInstructions() {
    const c = cfg();
    const names = allowedToolNames(c);
    const conns = visibleProfiles();
    const raw = names.includes('execute_sql');
    const lines = [
      'NexusSQL is a MySQL/MariaDB desktop client. These tools operate on the live databases its user has explicitly shared with you. Treat them as production data.',
      '',
      `Connections shared with you: ${conns.length ? conns.map(p => p.name + (p.database ? ` (pinned to ${p.database})` : '')).join(', ') : 'none yet'}.`,
      `Permission level: ${effectiveLevel(c)}. Enabled tools: ${names.join(', ') || 'none'}.`,
      '',
      'Rules:',
      '1. Call list_connections first, then describe_table before touching any table — you need its primary key.',
      '2. Reads are cheap; guess nothing. Confirm a row with run_select before you update or delete it.',
      raw
        ? '3. You have execute_sql, which runs arbitrary SQL with no validation and no undo. Reach for the targeted tools (update_cell / insert_row / delete_row / *_column) whenever they can do the job, and use execute_sql only for work they genuinely cannot express. Before any destructive statement — DROP, TRUNCATE, or an UPDATE/DELETE without a primary-key WHERE — say in plain language what it will affect and how many rows.'
        : '3. Writes are strictly one row at a time and are keyed by primary key. There is no bulk update, no bulk delete, and no arbitrary SQL execution — this is deliberate. If a task needs a bulk change, write the SQL out for the user to review and run themselves in the app.',
      '4. Never fabricate a result. If a tool errors or is denied, report exactly what happened.',
    ];
    if (c.approval !== 'never') {
      lines.push(`5. ${c.approval === 'always' ? 'Every' : 'Every writing'} action pops a confirmation window in the app. Batch your thinking before acting so the user is not spammed with prompts, and expect occasional denials.`);
    } else if (raw) {
      lines.push('5. Approval prompts are switched off, so nothing stands between your tool calls and the data. Be correspondingly careful.');
    }
    return lines.join('\n');
  }

  // ── JSON-RPC dispatch ──
  async function dispatch(msg) {
    const { method, params } = msg;
    switch (method) {
      case 'initialize': {
        const want = params && params.protocolVersion;
        clientInfo = (params && params.clientInfo) || null;
        sessionGrants.clear();
        deps.log({
          tool: '—', status: 'ok',
          summary: `Client connected: ${clientInfo ? `${clientInfo.name} ${clientInfo.version || ''}`.trim() : 'unknown'}`,
        });
        return {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : LATEST_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'nexussql', title: 'NexusSQL', version: deps.appVersion || '1.0.0' },
          instructions: buildInstructions(),
        };
      }
      case 'ping': return {};
      case 'tools/list': {
        const allowed = allowedToolNames(cfg());
        return {
          tools: TOOLS.filter(t => allowed.includes(t.name))
            .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        };
      }
      case 'tools/call': {
        const out = await callTool(params);
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }
      // We don't advertise these capabilities, but some clients probe anyway.
      case 'resources/list':           return { resources: [] };
      case 'resources/templates/list': return { resourceTemplates: [] };
      case 'prompts/list':             return { prompts: [] };
      default:
        throw new RpcError(-32601, 'Method not found: ' + method);
    }
  }

  async function handleMessage(msg) {
    const isRequest = msg && typeof msg === 'object' && msg.id !== undefined && msg.id !== null;
    try {
      if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        if (!isRequest) return null;
        throw new RpcError(-32600, 'Invalid Request');
      }
      const result = await dispatch(msg);
      if (!isRequest) return null;                       // notification — no reply
      return { jsonrpc: '2.0', id: msg.id, result };
    } catch (err) {
      if (!isRequest) return null;
      // A failed tools/call is reported as a tool error, not a protocol error,
      // so the model can read it and adapt instead of the client tearing down.
      if (msg.method === 'tools/call' && !(err instanceof RpcError && err.code === -32601)) {
        return {
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true },
        };
      }
      return {
        jsonrpc: '2.0', id: msg.id,
        error: { code: err instanceof RpcError ? err.code : -32603, message: err.message || 'Internal error' },
      };
    }
  }

  // ── HTTP layer ──
  function send(res, status, payload, extraHeaders) {
    const body = payload === null ? '' : JSON.stringify(payload);
    res.writeHead(status, Object.assign({
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    }, extraHeaders || {}));
    res.end(body);
  }

  async function onRequest(req, res) {
    const url = (req.url || '').split('?')[0];

    if (!originAllowed(req.headers.origin)) {
      return send(res, 403, { error: 'Forbidden origin' });
    }

    // Tiny unauthenticated liveness probe so the settings page can verify the
    // port without handing out the token.
    if (req.method === 'GET' && url === '/health') {
      return send(res, 200, { ok: true, server: 'nexussql', version: deps.appVersion });
    }

    if (url !== '/mcp') return send(res, 404, { error: 'Not found' });

    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!bearer || !timingSafeEqual(bearer, cfg().token)) {
      return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="nexussql"' });
    }

    if (req.method === 'GET')    return send(res, 405, { error: 'This server does not support server-initiated streams.' }, { Allow: 'POST, DELETE' });
    if (req.method === 'DELETE') { sessionId = null; sessionGrants.clear(); return send(res, 200, { ok: true }); }
    if (req.method !== 'POST')   return send(res, 405, { error: 'Method not allowed' }, { Allow: 'POST, DELETE' });

    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (err) {
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }

    const headers = {};
    const isInit = Array.isArray(parsed)
      ? parsed.some(m => m && m.method === 'initialize')
      : parsed && parsed.method === 'initialize';
    if (isInit) {
      sessionId = crypto.randomBytes(16).toString('hex');
      headers['Mcp-Session-Id'] = sessionId;
    }

    if (Array.isArray(parsed)) {
      const replies = (await Promise.all(parsed.map(handleMessage))).filter(Boolean);
      return replies.length ? send(res, 200, replies, headers) : send(res, 202, null, headers);
    }
    const reply = await handleMessage(parsed);
    return reply ? send(res, 200, reply, headers) : send(res, 202, null, headers);
  }

  // ── lifecycle ──
  function start(port) {
    return new Promise((resolve) => {
      if (server) return resolve({ ok: true, port: server.address().port });
      const s = http.createServer((req, res) => {
        onRequest(req, res).catch(err => {
          try { send(res, 500, { error: err.message }); } catch (_) {}
        });
      });
      s.on('error', (err) => {
        server = null;
        resolve({
          ok: false,
          error: err.code === 'EADDRINUSE'
            ? `Port ${port} is already in use. Pick a different port in MCP Settings.`
            : err.message,
        });
      });
      s.listen(port, '127.0.0.1', () => {
        server = s;
        resolve({ ok: true, port: s.address().port });
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      sessionGrants.clear();
      sessionId = null;
      clientInfo = null;
      if (!server) return resolve({ ok: true });
      const s = server;
      server = null;
      s.close(() => resolve({ ok: true }));
      s.closeAllConnections?.();
    });
  }

  function status() {
    return {
      running: !!server,
      port: server ? server.address().port : null,
      client: clientInfo ? `${clientInfo.name} ${clientInfo.version || ''}`.trim() : null,
      sessionGrants: [...sessionGrants],
    };
  }

  function clearSessionGrants() { sessionGrants.clear(); }

  return { start, stop, status, clearSessionGrants };
}

module.exports = { createMcpServer, TOOLS, TOOL_NAMES, allowedToolNames, effectiveLevel, isReadOnlySQL };
