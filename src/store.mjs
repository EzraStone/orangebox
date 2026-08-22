// §09 — SQLite layer: schema, transactions, queries, plus the redaction (§12.2)
// and truncation (§14.2) that every payload passes through on its way to disk.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

export const SCHEMA_VERSION = '2';

/** Max size of a single stored JSON blob before string leaves get trimmed (§14.2). */
export const MAX_BLOB_BYTES = 2 * 1024 * 1024;

/** Request headers we are willing to persist. Everything else is dropped (§12.2). */
const HEADER_ALLOWLIST = new Set(['content-type', 'anthropic-version', 'user-agent']);

/** Belt-and-braces: never store a header that smells like a credential, even if allowlisted by mistake. */
const CREDENTIAL_HEADER = /auth|key|token|secret|cookie/i;

export function defaultDbPath() {
  return path.join(os.homedir(), '.orangebox', 'orangebox.db');
}

/** Sortable, dependency-free id (§7.1). */
export function newId() {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  source        TEXT NOT NULL CHECK (source IN ('explicit','header','gap')),
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  call_count    INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL    NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  unknown_cost_count INTEGER NOT NULL DEFAULT 0,
  tags_json     TEXT    NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS calls (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  provider         TEXT NOT NULL,
  endpoint         TEXT NOT NULL,
  model            TEXT,
  status           INTEGER,
  error_type       TEXT,
  streamed         INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER NOT NULL,
  first_token_at   INTEGER,
  ended_at         INTEGER,
  latency_ms       INTEGER,
  ttft_ms          INTEGER,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  stop_reason      TEXT,
  cost_usd         REAL,
  request_json     TEXT NOT NULL,
  response_json    TEXT,
  truncated        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_calls_run ON calls(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at);

CREATE TABLE IF NOT EXISTS tool_events (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  call_id      TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('tool_use','tool_result')),
  tool_name    TEXT,
  tool_use_id  TEXT,
  is_error     INTEGER NOT NULL DEFAULT 0,
  content_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_tools_run ON tool_events(run_id);
CREATE INDEX IF NOT EXISTS idx_tools_use ON tool_events(tool_use_id);
-- call_id is an ON DELETE CASCADE target. Without an index SQLite scans the
-- whole tool_events table once per deleted call, which turns deleting a run
-- into O(calls x events): 534 ms for 2000 calls, versus 27 ms with it.
CREATE INDEX IF NOT EXISTS idx_tools_call ON tool_events(call_id);
`;

const MIGRATIONS = new Map([
  [
    '1',
    {
      to: '2',
      sql: `
        ALTER TABLE runs ADD COLUMN unknown_cost_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE runs ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
        UPDATE runs SET unknown_cost_count = (
          SELECT COUNT(*) FROM calls WHERE calls.run_id = runs.id AND calls.cost_usd IS NULL
        );
      `
    }
  ]
]);

const CALL_SUMMARY_COLUMNS = `
  id, run_id, seq, provider, endpoint, model, status, error_type, streamed,
  started_at, first_token_at, ended_at, latency_ms, ttft_ms,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  stop_reason, cost_usd, truncated
`;

export class Store {
  constructor(dbPath) {
    this.path = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');

    try {
      this.db.exec(SCHEMA);
    } catch (err) {
      if (String(err?.code).startsWith('SQLITE_BUSY')) {
        throw new Error(
          'another orangebox is already recording to this database — is one running?'
        );
      }
      throw err;
    }

    this.#migrate();

    this.#prepare();
  }

  #migrate() {
    const getVersion = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    const setVersion = this.db.prepare(
      `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );

    let version = getVersion.get('schema_version')?.value ?? null;
    if (version === null) {
      setVersion.run(SCHEMA_VERSION);
      return;
    }
    if (Number(version) > Number(SCHEMA_VERSION)) {
      throw new Error(
        `database schema ${version} is newer than this orangebox supports (${SCHEMA_VERSION})`
      );
    }

    while (version !== SCHEMA_VERSION) {
      const migration = MIGRATIONS.get(version);
      if (!migration) {
        throw new Error(`no database migration from schema ${version} to ${SCHEMA_VERSION}`);
      }
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        setVersion.run(migration.to);
      })();
      version = migration.to;
    }
  }

  #prepare() {
    const db = this.db;
    this.q = {
      insertRun: db.prepare(
        `INSERT INTO runs (id, name, source, started_at) VALUES (@id, @name, @source, @started_at)`
      ),
      getRun: db.prepare('SELECT * FROM runs WHERE id = ?'),
      endRun: db.prepare('UPDATE runs SET ended_at = ? WHERE id = ? AND ended_at IS NULL'),
      renameRun: db.prepare('UPDATE runs SET name = ? WHERE id = ?'),
      updateRun: db.prepare('UPDATE runs SET name = @name, tags_json = @tags_json WHERE id = @id'),
      deleteRun: db.prepare('DELETE FROM runs WHERE id = ?'),
      listRuns: db.prepare('SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?'),
      countRuns: db.prepare('SELECT COUNT(*) AS n FROM runs'),
      // Most recent gap-created run, used by the idle-gap heuristic (§06.4).
      latestImplicitRun: db.prepare(
        `SELECT r.id, r.started_at, COALESCE(MAX(c.ended_at), MAX(c.started_at), r.started_at) AS last_activity
           FROM runs r LEFT JOIN calls c ON c.run_id = r.id
          WHERE r.source = 'gap'
          GROUP BY r.id
          ORDER BY r.started_at DESC
          LIMIT 1`
      ),
      insertCall: db.prepare(`
        INSERT INTO calls (
          id, run_id, seq, provider, endpoint, model, status, error_type, streamed,
          started_at, first_token_at, ended_at, latency_ms, ttft_ms,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          stop_reason, cost_usd, request_json, response_json, truncated
        ) VALUES (
          @id, @run_id, @seq, @provider, @endpoint, @model, @status, @error_type, @streamed,
          @started_at, @first_token_at, @ended_at, @latency_ms, @ttft_ms,
          @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
          @stop_reason, @cost_usd, @request_json, @response_json, @truncated
        )`),
      getCall: db.prepare('SELECT * FROM calls WHERE id = ?'),
      callSummaries: db.prepare(
        `SELECT ${CALL_SUMMARY_COLUMNS} FROM calls WHERE run_id = ? ORDER BY seq ASC`
      ),
      fullCalls: db.prepare('SELECT * FROM calls WHERE run_id = ? ORDER BY seq ASC'),
      nextSeq: db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM calls WHERE run_id = ?'
      ),
      lastCallOfRun: db.prepare(
        'SELECT * FROM calls WHERE run_id = ? ORDER BY seq DESC LIMIT 1'
      ),
      bumpRunAggregates: db.prepare(`
        UPDATE runs SET
          call_count    = call_count + 1,
          input_tokens  = input_tokens + @input_tokens,
          output_tokens = output_tokens + @output_tokens,
          cost_usd      = cost_usd + @cost_usd,
          error_count   = error_count + @is_error,
          unknown_cost_count = unknown_cost_count + @unknown_cost
        WHERE id = @run_id`),
      insertToolEvent: db.prepare(`
        INSERT INTO tool_events (id, run_id, call_id, kind, tool_name, tool_use_id, is_error, content_json)
        VALUES (@id, @run_id, @call_id, @kind, @tool_name, @tool_use_id, @is_error, @content_json)`),
      toolEventsForRun: db.prepare(
        `SELECT t.* FROM tool_events t
           JOIN calls c ON c.id = t.call_id
          WHERE t.run_id = ?
          ORDER BY c.seq ASC, t.rowid ASC`
      ),
      // Every request re-sends the whole message history, so the same
      // tool_result appears in call N, N+1, N+2… Record each one once (§07.4).
      recordedToolResultIds: db.prepare(
        `SELECT tool_use_id FROM tool_events
          WHERE run_id = ? AND kind = 'tool_result' AND tool_use_id IS NOT NULL`
      ),
      clearRuns: db.prepare('DELETE FROM runs'),
      clearCalls: db.prepare('DELETE FROM calls'),
      clearTools: db.prepare('DELETE FROM tool_events'),
      oldRuns: db.prepare('SELECT id FROM runs WHERE started_at < ?')
    };

    // One transaction per call: call row + tool events + run aggregate bump (§09).
    this.txInsertCall = this.db.transaction((call, toolEvents) => {
      this.q.insertCall.run(call);
      for (const ev of toolEvents) this.q.insertToolEvent.run(ev);
      this.q.bumpRunAggregates.run({
        run_id: call.run_id,
        input_tokens: call.input_tokens ?? 0,
        output_tokens: call.output_tokens ?? 0,
        cost_usd: call.cost_usd ?? 0,
        is_error: call.error_type ? 1 : 0,
        unknown_cost: call.cost_usd === null || call.cost_usd === undefined ? 1 : 0
      });
    });
  }

  // ---------------------------------------------------------------- runs

  createRun({ id = newId(), name = null, source, started_at = Date.now() }) {
    this.q.insertRun.run({ id, name, source, started_at });
    return this.getRun(id);
  }

  getRun(id) {
    return normalizeRun(this.q.getRun.get(id) ?? null);
  }

  listRuns({
    limit = 50,
    offset = 0,
    search = '',
    model = '',
    tool = '',
    error = '',
    minLatency = null,
    minCost = null,
    from = null,
    to = null
  } = {}) {
    const where = [];
    const params = { limit, offset };
    if (search) {
      where.push('(COALESCE(r.name, \'\') LIKE @search OR r.id LIKE @search OR r.tags_json LIKE @search)');
      params.search = `%${search}%`;
    }
    if (model) {
      where.push('EXISTS (SELECT 1 FROM calls c WHERE c.run_id = r.id AND c.model LIKE @model)');
      params.model = `%${model}%`;
    }
    if (tool) {
      where.push('EXISTS (SELECT 1 FROM tool_events t WHERE t.run_id = r.id AND t.tool_name LIKE @tool)');
      params.tool = `%${tool}%`;
    }
    if (error === 'errors') where.push('r.error_count > 0');
    if (error === 'clean') where.push('r.error_count = 0');
    if (Number.isFinite(minLatency)) {
      where.push('EXISTS (SELECT 1 FROM calls c WHERE c.run_id = r.id AND c.latency_ms >= @minLatency)');
      params.minLatency = minLatency;
    }
    if (Number.isFinite(minCost)) {
      where.push('r.cost_usd >= @minCost');
      params.minCost = minCost;
    }
    if (Number.isFinite(from)) {
      where.push('r.started_at >= @from');
      params.from = from;
    }
    if (Number.isFinite(to)) {
      where.push('r.started_at <= @to');
      params.to = to;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const runs = this.db
      .prepare(`SELECT r.* FROM runs r ${clause} ORDER BY r.started_at DESC, r.id DESC LIMIT @limit OFFSET @offset`)
      .all(params)
      .map(normalizeRun);
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM runs r ${clause}`).get(params).n;
    return {
      runs,
      total
    };
  }

  countRuns() {
    return this.q.countRuns.get().n;
  }

  endRun(id, at = Date.now()) {
    return this.q.endRun.run(at, id).changes > 0;
  }

  renameRun(id, name) {
    return this.q.renameRun.run(name, id).changes > 0;
  }

  updateRun(id, { name, tags = [] }) {
    const current = this.getRun(id);
    if (!current) return null;
    const cleanTags = [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 20);
    this.q.updateRun.run({
      id,
      name: name === undefined ? current.name : String(name || '').trim() || null,
      tags_json: JSON.stringify(cleanTags)
    });
    return this.getRun(id);
  }

  deleteRun(id) {
    return this.q.deleteRun.run(id).changes > 0;
  }

  /**
   * §06.4 — resolve the run a call belongs to, in priority order:
   * path-scoped → header → idle-gap heuristic.
   * Returns { run, created } so the caller can publish `run.created` (§10.1).
   */
  resolveRun({ explicitRunId, headerRunId, gapSeconds, now = Date.now() }) {
    if (explicitRunId) {
      const existing = this.getRun(explicitRunId);
      if (existing) return { run: existing, created: false };
      return { run: this.createRun({ id: explicitRunId, source: 'explicit', started_at: now }), created: true };
    }

    if (headerRunId) {
      const existing = this.getRun(headerRunId);
      if (existing) return { run: existing, created: false };
      return { run: this.createRun({ id: headerRunId, source: 'header', started_at: now }), created: true };
    }

    const latest = this.q.latestImplicitRun.get();
    if (latest && now - latest.last_activity < gapSeconds * 1000) {
      return { run: this.getRun(latest.id), created: false };
    }

    // A newer implicit run supersedes the previous one, so close that one out lazily.
    if (latest) this.endRun(latest.id, latest.last_activity);

    return {
      run: this.createRun({ source: 'gap', name: autoRunName(now), started_at: now }),
      created: true
    };
  }

  // --------------------------------------------------------------- calls

  nextSeq(runId) {
    return this.q.nextSeq.get(runId).seq;
  }

  lastCallOfRun(runId) {
    return this.q.lastCallOfRun.get(runId) ?? null;
  }

  insertCall(call, toolEvents = []) {
    const row = {
      first_token_at: null,
      ended_at: null,
      latency_ms: null,
      ttft_ms: null,
      model: null,
      status: null,
      error_type: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      stop_reason: null,
      cost_usd: null,
      response_json: null,
      streamed: 0,
      truncated: 0,
      ...call
    };
    this.txInsertCall(row, toolEvents);
    return row;
  }

  getCall(id) {
    return this.q.getCall.get(id) ?? null;
  }

  callSummaries(runId) {
    return this.q.callSummaries.all(runId);
  }

  fullCalls(runId) {
    return this.q.fullCalls.all(runId);
  }

  toolEvents(runId) {
    return this.q.toolEventsForRun.all(runId);
  }

  recordedToolResultIds(runId) {
    return new Set(this.q.recordedToolResultIds.all(runId).map((r) => r.tool_use_id));
  }

  // ------------------------------------------------------------ lifecycle

  clearAll() {
    this.db.transaction(() => {
      this.q.clearTools.run();
      this.q.clearCalls.run();
      this.q.clearRuns.run();
    })();
  }

  /** --retain <days>: drop runs that started before the cutoff. Returns count removed. */
  retain(days) {
    if (!days || days <= 0) return 0;
    const cutoff = Date.now() - days * 86400_000;
    const ids = this.q.oldRuns.all(cutoff).map((r) => r.id);
    this.db.transaction(() => {
      for (const id of ids) this.q.deleteRun.run(id);
    })();
    return ids.length;
  }

  sizeBytes() {
    if (this.path === ':memory:') return 0;
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        total += fs.statSync(this.path + suffix).size;
      } catch {
        /* missing sidecar files are normal */
      }
    }
    return total;
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

function normalizeRun(row) {
  if (!row) return null;
  let tags = [];
  try {
    tags = JSON.parse(row.tags_json ?? '[]');
  } catch {
    tags = [];
  }
  const { tags_json: _tagsJson, ...run } = row;
  return { ...run, tags: Array.isArray(tags) ? tags : [] };
}

export function openStore(dbPath = defaultDbPath()) {
  return new Store(dbPath);
}

export function autoRunName(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `run ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ============================================================ redaction (§12.2)

/**
 * Reduce request headers to the allowlist. Anything that could carry a
 * credential is dropped regardless of the allowlist.
 */
export function redactHeaders(headers = {}) {
  const out = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!HEADER_ALLOWLIST.has(name)) continue;
    if (CREDENTIAL_HEADER.test(name)) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

const BASE64_DATA_URI = /^data:([^;,]*);base64,/;

/**
 * §14.2 — swap inline base64 images/documents for a short placeholder. They
 * bloat the database and v1's UI cannot render them anyway.
 * Mutates a structuredClone of the input; the original is left alone.
 */
export function stripBase64(value) {
  const seen = new WeakSet();

  const walk = (node) => {
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return node;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = walk(node[i]);
      return node;
    }

    // Anthropic: { type:'image'|'document', source:{ type:'base64', media_type, data } }
    const src = node.source;
    if (src && typeof src === 'object' && src.type === 'base64' && typeof src.data === 'string') {
      src.data = placeholder(src.media_type || node.type || 'data', src.data.length);
      return node;
    }

    for (const [key, child] of Object.entries(node)) {
      if (typeof child === 'string') {
        // OpenAI: { image_url: { url: 'data:image/png;base64,…' } } and friends.
        const m = child.match(BASE64_DATA_URI);
        if (m && child.length > 512) {
          node[key] = placeholder(m[1] || 'data', child.length);
        }
      } else {
        node[key] = walk(child);
      }
    }
    return node;
  };

  return walk(value);
}

function placeholder(kind, byteLength) {
  return `[orangebox: base64 ${kind}, ${Math.max(1, Math.round(byteLength / 1024))} KB removed]`;
}

// =========================================================== truncation (§14.2)

/**
 * Serialize `value`, and if the result exceeds `limit` bytes, trim its string
 * leaves — longest first — until it fits. Structure always survives; only bulk
 * text is cut. Returns { json, truncated }.
 */
export function serializeForStorage(value, limit = MAX_BLOB_BYTES) {
  let json = safeStringify(value);
  if (Buffer.byteLength(json) <= limit) return { json, truncated: 0 };

  // Water-filling: find the largest per-string cap whose result fits. Trimming
  // every string to a common cap is exactly "longest first" — short leaves are
  // untouched until the long ones are already at their length.
  let lo = 0;
  let hi = longestString(value);
  let best = null;

  for (let i = 0; i < 24 && lo <= hi; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = safeStringify(capStrings(structuredClone(value), mid));
    if (Buffer.byteLength(candidate) <= limit) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best === null) {
    // Even fully-trimmed strings do not fit (pathological structure): store a stub.
    best = safeStringify({
      _orangebox: { dropped: true, reason: 'payload too large to store', bytes: Buffer.byteLength(json) }
    });
  }
  return { json: best, truncated: 1 };
}

function capStrings(node, cap) {
  if (typeof node === 'string') return capOne(node, cap);
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = capStrings(node[i], cap);
    return node;
  }
  for (const [key, child] of Object.entries(node)) node[key] = capStrings(child, cap);
  return node;
}

function capOne(str, cap) {
  if (str.length <= cap) return str;
  const removed = str.length - cap;
  return `${str.slice(0, cap)}…[orangebox: truncated ${removed} bytes]`;
}

function longestString(node, max = 0) {
  if (typeof node === 'string') return Math.max(max, node.length);
  if (node === null || typeof node !== 'object') return max;
  for (const child of Object.values(node)) max = longestString(child, max);
  return max;
}

/** JSON.stringify that cannot throw — cycles and BigInts degrade to a stub. */
export function safeStringify(value) {
  try {
    return JSON.stringify(value, bigintSafe) ?? 'null';
  } catch (err) {
    return JSON.stringify({ _orangebox: { unserializable: true, reason: String(err?.message ?? err) } });
  }
}

function bigintSafe(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}
