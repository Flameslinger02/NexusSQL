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
// Used by the `run_select` tool.
//
// Order matters: comments, string literals AND backtick-quoted identifiers are
// blanked first, so a keyword can only be seen where it could actually execute.
// Then the leading keyword must be allow-listed, and no mutating keyword may
// appear anywhere.
//
// Deliberately ALLOWED:
//   SELECT 'insert into x'            keyword inside a string literal
//   SELECT id AS `update` FROM t      keyword as a quoted identifier
//   -- drop table x                   keyword inside a comment
//   SHOW CREATE TABLE t               SHOW cannot mutate, so the deny-list is
//                                     skipped for it (this is the only skip)
//   WITH c AS (SELECT 1) SELECT * FROM c
//
// Deliberately BLOCKED:
//   SELECT 1; DROP TABLE t            statement chaining
//   EXPLAIN ANALYZE DELETE FROM t     EXPLAIN ANALYZE really executes the DML
//                                     on MySQL 8.0.18+/MariaDB, so EXPLAIN is
//                                     still fully scanned
//   SELECT * FROM t INTO OUTFILE ...  writes files
//   CREATE TABLE / UPDATE / DELETE / GRANT / SET / CALL / LOAD ...
function isReadOnlySQL(sql) {
  if (!sql || typeof sql !== 'string') return false;
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, '``')      // quoted identifiers are not keywords
    .trim()
    .replace(/;+\s*$/, '');
  if (!stripped) return false;
  if (/;/.test(stripped)) return false;                       // no statement chaining

  const first = (stripped.replace(/^[(\s]+/, '').split(/\s+/)[0] || '').toUpperCase();
  if (!['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH'].includes(first)) return false;

  // Every SHOW variant is read-only, including SHOW CREATE TABLE — whose
  // CREATE would otherwise trip the deny-list below.
  if (first === 'SHOW') return true;

  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT|REVOKE|RENAME|CALL|LOAD|HANDLER|LOCK|UNLOCK|SET|PREPARE|EXECUTE|BEGIN|COMMIT|ROLLBACK)\b/i.test(stripped)) return false;
  if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(stripped)) return false;
  return true;
}

// ─── ARGUMENT VALIDATION ─────────────────────────────────────
// Coercing a missing argument sends the model chasing a table literally named
// "undefined". Fail loudly with the parameter name instead.
function requireArgs(tool, args, profile) {
  const required = (tool.inputSchema && tool.inputSchema.required) || [];
  for (const key of required) {
    // A connection pinned to one database supplies it implicitly, so demanding
    // it back from the caller would be wrong.
    if (key === 'database' && profile && profile.database) continue;
    const v = args[key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      throw new RpcError(-32602, `Missing required parameter: ${key} (tool "${tool.name}")`);
    }
  }
}

// Integer arg with explicit bounds. Rejects rather than coerces, because a
// silently-substituted limit is indistinguishable from one that was honoured.
function intArg(value, name, min, max, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n)) {
    throw new RpcError(-32602, `${name} must be an integer, got ${JSON.stringify(value)}`);
  }
  if (n < min || n > max) {
    throw new RpcError(-32602, `${name} must be between ${min} and ${max}, got ${n}`);
  }
  return n;
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
    description: 'List the tables and views in one database. Returns names only by default. Pass detail:"full" for approxRows and engine per table — approxRows is the optimizer estimate (free, exact for small InnoDB tables, approximate for large ones), so prefer it over count_rows when a ballpark will do.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONN_ARG,
        database: { type: 'string', description: 'Database name.' },
        detail: {
          type: 'string', enum: ['names', 'full'],
          description: "'names' (default) returns just table and view names — cheapest. 'full' adds approxRows and engine per table, which roughly triples the response size; ask for it only when you actually need sizes.",
        },
      },
      required: ['database'],
    },
  },
  {
    name: 'describe_table', tier: 'read',
    description: 'Full schema for one table: columns (name, type, nullability, key, default, extra, comment), indexes, foreign keys, and table meta (engine, collation, approxRows, current AUTO_INCREMENT). Call this before writing to a table so you know its primary key.',
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
    description: 'Run one read-only statement (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH) and return rows. SHOW CREATE TABLE works. Writes are rejected — use the dedicated write tools. Rows come back as arrays matching `columns` order, with `totalRows` giving the full match count so you can tell whether `truncated` matters. Prefer `params` over pasting literals into the SQL.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONN_ARG,
        database: { type: 'string', description: 'Database to run against (applied as USE before the query).' },
        sql: { type: 'string', description: 'A single read-only statement. No semicolon-separated batches. Use ? placeholders for values and pass them in `params`.' },
        params: { type: 'array', description: 'Values bound to ? placeholders in `sql`, in order. Safer and clearer than inlining literals.' },
        limit: { type: 'integer', description: `Max rows returned (default ${DEFAULT_ROW_LIMIT}, hard cap ${MAX_ROW_LIMIT}). Must be an integer in range — out-of-range values are rejected, not clamped.` },
      },
      required: ['sql'],
    },
  },
  {
    name: 'sample_rows', tier: 'read',
    description: 'Return the first N rows of a table so you can see what the data actually looks like. The natural next step after describe_table, and cheaper than writing a SELECT.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONN_ARG,
        database: { type: 'string' }, table: { type: 'string' },
        n: { type: 'integer', description: 'How many rows (default 10, max 100).' },
      },
      required: ['database', 'table'],
    },
  },
  {
    name: 'find_tables', tier: 'read',
    description: 'Find tables whose name matches a SQL LIKE pattern (use % as the wildcard, e.g. "%user%"). Far cheaper than listing every table when you are hunting for where something lives. Searches all non-system databases unless you pass one.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONN_ARG,
        pattern: { type: 'string', description: 'SQL LIKE pattern, e.g. "%user%".' },
        database: { type: 'string', description: 'Restrict to one database. Omit to search all non-system schemas.' },
        limit: { type: 'integer', description: 'Max matches (default 100, max 500).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'find_columns', tier: 'read',
    description: 'Find columns whose name matches a SQL LIKE pattern, across tables. Use this to locate a field like "%email%" without dumping every schema.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONN_ARG,
        pattern: { type: 'string', description: 'SQL LIKE pattern, e.g. "%email%".' },
        database: { type: 'string', description: 'Restrict to one database. Omit to search all non-system schemas.' },
        limit: { type: 'integer', description: 'Max matches (default 100, max 500).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'server_info', tier: 'read',
    description: 'Server version and flavor (MySQL vs MariaDB), character set, collation, time zone, current server time and sql_mode. Check this before relying on syntax that differs between the two.',
    inputSchema: { type: 'object', properties: { ...CONN_ARG } },
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
      case 'list_tables': {
        if (args.detail !== undefined && !['names', 'full'].includes(args.detail)) {
          throw new RpcError(-32602, `detail must be "names" or "full", got ${JSON.stringify(args.detail)}`);
        }
        const r = unwrap(await db.listTablesRich(poolId, needDb()), 'list tables');
        const full = args.detail === 'full';
        const out = { database: needDb(), tables: full ? r.tables : r.tables.map(t => t.name) };
        if (r.views.length) out.views = r.views;
        if (!full) out.tableCount = r.tables.length;
        return out;
      }
      case 'describe_table': {
        const r = unwrap(await db.tableSchema(poolId, needDb(), args.table), 'describe table');
        const out = { database: needDb(), table: args.table, columns: r.columns, meta: r.table };
        if (r.indexes.length) out.indexes = r.indexes;
        if (r.foreignKeys.length) out.foreignKeys = r.foreignKeys;
        return out;
      }
      case 'sample_rows': {
        const n = intArg(args.n, 'n', 1, 100, 10);
        const r = unwrap(await db.sampleRows(poolId, needDb(), args.table, n), 'sample rows');
        return { columns: r.columns, rows: r.rows, rowCount: r.rows.length };
      }
      case 'find_tables': {
        const limit = intArg(args.limit, 'limit', 1, 500, 100);
        const scope = profile.database || args.database || undefined;
        const r = unwrap(await db.findTables(poolId, args.pattern, scope, limit), 'find tables');
        return { pattern: args.pattern, matchCount: r.matches.length, matches: r.matches };
      }
      case 'find_columns': {
        const limit = intArg(args.limit, 'limit', 1, 500, 100);
        const scope = profile.database || args.database || undefined;
        const r = unwrap(await db.findColumns(poolId, args.pattern, scope, limit), 'find columns');
        return { pattern: args.pattern, matchCount: r.matches.length, matches: r.matches };
      }
      case 'server_info':
        return unwrap(await db.serverDetail(poolId), 'server info').info;
      case 'count_rows':
        return { count: unwrap(await db.tableCount(poolId, needDb(), args.table), 'count rows').count };
      case 'run_select': {
        if (!isReadOnlySQL(args.sql)) {
          throw new RpcError(-32602, 'Rejected: run_select accepts a single read-only statement (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH). Use update_cell, insert_row or delete_row to change data.');
        }
        const limit = intArg(args.limit, 'limit', 1, MAX_ROW_LIMIT, DEFAULT_ROW_LIMIT);
        if (args.params !== undefined && !Array.isArray(args.params)) {
          throw new RpcError(-32602, 'params must be an array of values bound to ? placeholders, in order.');
        }
        const res = unwrap(await db.query(poolId, dbName, args.sql, {
          params: args.params, timeoutSec: deps.readTimeoutSec,
        }), 'query');
        if (res.type !== 'select') return { affectedRows: res.affectedRows };
        const rows = res.rows.slice(0, limit);
        const out = {
          columns: res.cols.map(c => c.name),
          rows,
          rowCount: rows.length,
          totalRows: res.rows.length,       // so `truncated` is actionable
          elapsedMs: res.elapsed,
        };
        if (res.rows.length > limit) out.truncated = true;
        // Only worth the bytes when a column is not a plain string/number:
        // mysql2 returns DECIMAL/BIGINT as strings to preserve precision.
        const typed = res.cols.filter(c => /DECIMAL|NEWDECIMAL|LONGLONG|BIT/i.test(c.typeName || ''));
        if (typed.length) {
          out.columnTypes = {};
          for (const c of res.cols) out.columnTypes[c.name] = c.typeName;
          out.note = 'DECIMAL/BIGINT columns are returned as strings to avoid precision loss above 2^53. Parse them before doing arithmetic.';
        }
        return out;
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
        const res = unwrap(await db.query(poolId, dbName, args.sql, { timeoutSec: deps.writeTimeoutSec }), 'execute');
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
      case 'sample_rows':      return `Sample ${args.n || 10} rows from ${t}`;
      case 'find_tables':      return `Find tables matching ${args.pattern}`;
      case 'find_columns':     return `Find columns matching ${args.pattern}`;
      case 'server_info':      return 'Read server version/charset/timezone';
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
    requireArgs(tool, args, profile);
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
        return { content: [{ type: 'text', text: JSON.stringify(out) }] };
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
