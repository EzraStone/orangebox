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

/**
 * Groupings the spend view offers. A fixed map rather than an interpolated
 * column name — this string ends up inside SQL, so it must never be able to
 * come from a query parameter unchecked.
 */
// Ordering, per grouping. Interpolated into SQL like the column above, so it
// is a fixed table and never anything a caller supplies.
//
// Everything ranks by spend, because "what is costing me the most" is the
// question people open this to answer. Days are the exception: a list of dates
// in cost order is unreadable as a trend. Newest first, matching the runs list,
// so folding the chart tail drops the oldest days and not the cheapest ones.
const SPEND_ORDER = {
  day: 'key DESC',
  _default: 'cost_usd DESC, calls DESC'
};

const SPEND_GROUPS = {
  model: "COALESCE(c.model, '(no model recorded)')",
  provider: 'c.provider',
  run: "COALESCE(r.name, c.run_id)",
  day: "date(c.started_at / 1000, 'unixepoch', 'localtime')"
};

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

    // §19.9 — search inside recorded content.
    //
    // LIKE over the JSON blobs, not FTS5. A virtual table would be faster and
    // would mean a schema migration, a second copy of every prompt on disk, and
    // a tokeniser deciding what counts as a word inside JSON. For a local
    // database on one machine, scanning is the honest trade: it stays exact,
    // costs nothing to maintain, and the cap below keeps it bounded.
    this.q.searchCalls = db.prepare(`
      SELECT c.id, c.run_id, c.seq, c.provider, c.model, c.started_at,
             c.error_type, c.cost_usd, c.latency_ms,
             COALESCE(r.name, c.run_id) AS run_name,
             CASE WHEN c.request_json LIKE @like ESCAPE '\\' THEN 1 ELSE 0 END  AS in_request,
             CASE WHEN c.response_json LIKE @like ESCAPE '\\' THEN 1 ELSE 0 END AS in_response
        FROM calls c
        JOIN runs r ON r.id = c.run_id
       WHERE (c.request_json LIKE @like ESCAPE '\\' OR c.response_json LIKE @like ESCAPE '\\')
         AND c.started_at BETWEEN @since AND @until
       ORDER BY c.started_at DESC
       LIMIT @limit`);

    // The blobs themselves, fetched only for the rows being shown, so a search
    // over a large history never pulls every prompt into memory.
    this.q.callBlobs = db.prepare(
      'SELECT request_json, response_json FROM calls WHERE id = ?'
    );

    // §19.8 — tool behaviour across runs. orangebox never watches a tool run;
    // it sees the request go out and the result come back, so the only timing
    // available is the wall-clock hole between two consecutive calls.
    //
    // When a call asks for three tools, that hole covers all three and cannot
    // honestly be split. So timing is aggregated only over "solo" uses — where
    // the emitting call requested exactly one tool — and the count of those is
    // reported alongside, so a number derived from two samples out of ninety
    // is visibly that.
    this.q.toolStats = db.prepare(`
      WITH gaps AS (
        SELECT c.id AS call_id,
               c.run_id,
               (SELECT MIN(c2.started_at) FROM calls c2
                 WHERE c2.run_id = c.run_id AND c2.seq > c.seq) - c.ended_at AS gap_ms
          FROM calls c
         WHERE c.ended_at IS NOT NULL
           AND c.started_at BETWEEN @since AND @until
      ),
      per_call AS (
        SELECT call_id, COUNT(*) AS uses_in_call
          FROM tool_events
         WHERE kind = 'tool_use'
         GROUP BY call_id
      ),
      uses AS (
        SELECT t.tool_name,
               t.tool_use_id,
               t.run_id,
               g.gap_ms,
               p.uses_in_call
          FROM tool_events t
          JOIN gaps g ON g.call_id = t.call_id
          JOIN per_call p ON p.call_id = t.call_id
         WHERE t.kind = 'tool_use'
      )
      SELECT COALESCE(u.tool_name, '(unnamed tool)') AS key,
             COUNT(*)                                AS uses,
             COUNT(DISTINCT u.run_id)                AS runs,
             SUM(CASE WHEN r.is_error = 1 THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN r.tool_use_id IS NULL THEN 1 ELSE 0 END) AS unanswered,
             SUM(CASE WHEN u.uses_in_call = 1 AND u.gap_ms IS NOT NULL AND u.gap_ms >= 0
                      THEN 1 ELSE 0 END) AS timed_uses,
             SUM(CASE WHEN u.uses_in_call = 1 AND u.gap_ms IS NOT NULL AND u.gap_ms >= 0
                      THEN u.gap_ms ELSE 0 END) AS timed_total_ms,
             MAX(CASE WHEN u.uses_in_call = 1 AND u.gap_ms IS NOT NULL AND u.gap_ms >= 0
                      THEN u.gap_ms ELSE NULL END) AS slowest_ms
        FROM uses u
        LEFT JOIN tool_events r
               ON r.kind = 'tool_result'
              AND r.tool_use_id = u.tool_use_id
              AND r.run_id = u.run_id
       GROUP BY key
       ORDER BY uses DESC, key ASC`);

    // Built per grouping and memoised: the column is chosen from SPEND_GROUPS,
    // never from user input.
    const spendCache = new Map();
    this.q.spendByGroup = (column, orderBy) => {
      const cacheKey = column + '|' + orderBy;
      if (!spendCache.has(cacheKey)) {
        spendCache.set(
          cacheKey,
          db.prepare(`
            SELECT ${column} AS key,
                   COUNT(*)                        AS calls,
                   SUM(COALESCE(c.input_tokens, 0))  AS input_tokens,
                   SUM(COALESCE(c.output_tokens, 0)) AS output_tokens,
                   SUM(COALESCE(c.cost_usd, 0))      AS cost_usd,
                   SUM(CASE WHEN c.cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_calls,
                   -- Two quite different reasons a cost is null, and they need
                   -- different advice. Tokens but no cost means no rate for the
                   -- model: editing pricing.json fixes it. No tokens at all
                   -- means the call never reported usage — it errored, the
                   -- client hung up, or it streamed without include_usage — and
                   -- no amount of editing pricing.json will help.
                   SUM(CASE WHEN c.cost_usd IS NULL AND (
                         c.input_tokens IS NOT NULL OR c.output_tokens IS NOT NULL OR
                         c.cache_read_tokens IS NOT NULL OR c.cache_write_tokens IS NOT NULL
                       ) THEN 1 ELSE 0 END) AS unrated_calls,
                   SUM(CASE WHEN c.cost_usd IS NULL AND
                         c.input_tokens IS NULL AND c.output_tokens IS NULL AND
                         c.cache_read_tokens IS NULL AND c.cache_write_tokens IS NULL
                       THEN 1 ELSE 0 END) AS no_usage_calls,
                   SUM(CASE WHEN c.error_type IS NOT NULL THEN 1 ELSE 0 END) AS error_calls
              FROM calls c
              JOIN runs r ON r.id = c.run_id
             WHERE c.started_at BETWEEN @since AND @until
             GROUP BY key
             ORDER BY ${orderBy}`)
        );
      }
      return spendCache.get(cacheKey);
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
    provider = '',
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
    // Exact match, unlike model: provider names are a closed set of short
    // words and a LIKE would make 'openai' also select nothing useful while
    // risking surprise overlaps as the set grows.
    if (provider) {
      where.push('EXISTS (SELECT 1 FROM calls c WHERE c.run_id = r.id AND c.provider = @provider)');
      params.provider = provider;
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

  /**
   * §19.5 — spend, grouped. One pass over calls rather than per-group queries,
   * because the honest version has to count what it could NOT price as well as
   * what it could, and that is the same scan.
   *
   * `unpriced` is the point of this method. A dashboard that quietly drops the
   * calls it has no rate for shows a total that is confidently too low, which
   * is worse than showing nothing — you would never know to distrust it.
   */
  spend({ groupBy = 'model', since = null, until = null } = {}) {
    // Object.hasOwn, not a truthiness check: SPEND_GROUPS['constructor'] walks
    // the prototype chain and hands back Object, which is truthy enough to pass
    // a !column guard and then stringifies a whole function into the SQL.
    if (!Object.hasOwn(SPEND_GROUPS, groupBy)) throw new Error(`unknown grouping "${groupBy}"`);
    const column = SPEND_GROUPS[groupBy];
    const orderBy = Object.hasOwn(SPEND_ORDER, groupBy) ? SPEND_ORDER[groupBy] : SPEND_ORDER._default;

    const rows = this.q.spendByGroup(column, orderBy).all({
      since: since ?? 0,
      until: until ?? Number.MAX_SAFE_INTEGER
    });

    let totalCost = 0;
    let totalCalls = 0;
    let unpricedCalls = 0;
    let unratedCalls = 0;
    let noUsageCalls = 0;
    const groups = rows.map((row) => {
      totalCost += row.cost_usd ?? 0;
      totalCalls += row.calls;
      unpricedCalls += row.unpriced_calls;
      unratedCalls += row.unrated_calls;
      noUsageCalls += row.no_usage_calls;
      return {
        key: row.key ?? '(unknown)',
        calls: row.calls,
        input_tokens: row.input_tokens ?? 0,
        output_tokens: row.output_tokens ?? 0,
        cost_usd: row.cost_usd ?? 0,
        unpriced_calls: row.unpriced_calls,
        unrated_calls: row.unrated_calls,
        no_usage_calls: row.no_usage_calls,
        error_calls: row.error_calls
      };
    });

    return {
      group_by: groupBy,
      since,
      until,
      total_calls: totalCalls,
      total_cost_usd: Math.round(totalCost * 1e8) / 1e8,
      // Calls the total is missing, split by why — because the fix differs.
      // unrated: no rate for the model, so pricing.json closes the gap.
      // no_usage: the call never reported tokens (errored, aborted, or streamed
      // without usage), so nothing in pricing.json would help.
      unpriced_calls: unpricedCalls,
      unrated_calls: unratedCalls,
      no_usage_calls: noUsageCalls,
      priced_share: totalCalls === 0 ? 1 : (totalCalls - unpricedCalls) / totalCalls,
      groups
    };
  }

  /**
   * §19.8 — how each tool behaves across recorded runs.
   *
   * `timed_uses` is the honest part. Timing comes from the gap between two
   * calls, which covers every tool the earlier one requested, so only uses
   * where the call asked for exactly one tool contribute to the average. A
   * tool used ninety times but timed twice reports both numbers.
   */
  /**
   * §19.9 — find calls whose recorded prompt or response contains `query`.
   *
   * Returns a snippet around the first hit rather than the blob, because the
   * point is to see enough to recognise the call, and a 200KB prompt in a
   * results list helps nobody. Matching is literal and case-insensitive:
   * SQLite's LIKE folds ASCII case, which is what people expect when typing a
   * few words they remember.
   */
  searchCalls({ query, limit = 50, since = null, until = null, snippetChars = 160 } = {}) {
    const needle = String(query ?? '').trim();
    if (needle === '') return { query: '', total: 0, results: [] };

    const rows = this.q.searchCalls.all({
      // Escape the LIKE metacharacters, or a query containing % matches
      // everything and _ matches any character — silently wrong results
      // rather than no results, which is worse.
      like: `%${likeLiteral(needle)}%`,
      since: since ?? 0,
      until: until ?? Number.MAX_SAFE_INTEGER,
      limit: Math.max(1, Math.min(limit, 500))
    });

    const results = rows.map((row) => {
      const blobs = this.q.callBlobs.get(row.id) ?? {};
      const haystack = row.in_request ? blobs.request_json : blobs.response_json;
      return {
        id: row.id,
        run_id: row.run_id,
        run_name: row.run_name,
        seq: row.seq,
        provider: row.provider,
        model: row.model,
        started_at: row.started_at,
        error_type: row.error_type,
        cost_usd: row.cost_usd,
        latency_ms: row.latency_ms,
        where: row.in_request && row.in_response ? 'both' : row.in_request ? 'request' : 'response',
        snippet: snippetAround(haystack, needle, snippetChars)
      };
    });

    return { query: needle, total: results.length, limit, results };
  }

  toolStats({ since = null, until = null } = {}) {
    const rows = this.q.toolStats.all({
      since: since ?? 0,
      until: until ?? Number.MAX_SAFE_INTEGER
    });

    const tools = rows.map((row) => ({
      key: row.key,
      uses: row.uses,
      runs: row.runs,
      errors: row.errors,
      // A tool the model called and never got an answer to. Usually the agent
      // crashed, the loop broke, or the run was cut short mid-turn — and it is
      // invisible on a timeline unless you go looking.
      unanswered: row.unanswered,
      error_rate: row.uses === 0 ? 0 : row.errors / row.uses,
      timed_uses: row.timed_uses,
      avg_ms: row.timed_uses > 0 ? Math.round(row.timed_total_ms / row.timed_uses) : null,
      total_ms: row.timed_uses > 0 ? row.timed_total_ms : null,
      slowest_ms: row.slowest_ms ?? null
    }));

    return {
      since,
      until,
      total_uses: tools.reduce((sum, t) => sum + t.uses, 0),
      total_errors: tools.reduce((sum, t) => sum + t.errors, 0),
      total_unanswered: tools.reduce((sum, t) => sum + t.unanswered, 0),
      tools
    };
  }

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
/**
 * A window of text around the first case-insensitive hit, with ellipses where
 * it was cut. Returns null when the needle is not actually in this blob — the
 * row matched on the other one.
 */
/**
 * Make `text` match literally inside a LIKE pattern.
 *
 * Built from String.fromCharCode rather than written as escapes, because a
 * backslash in this function has survived three layers of quoting to get here
 * and silently losing one produces a search that returns everything instead of
 * one thing — which reads as working.
 *
 * The escape character is declared to SQLite with ESCAPE in the query itself;
 * the two have to agree.
 */
export const LIKE_ESCAPE = String.fromCharCode(92);

export function likeLiteral(text) {
  return String(text ?? '')
    .split(LIKE_ESCAPE).join(LIKE_ESCAPE + LIKE_ESCAPE)
    .split('%').join(LIKE_ESCAPE + '%')
    .split('_').join(LIKE_ESCAPE + '_');
}

export function snippetAround(text, needle, chars = 160) {
  if (typeof text !== 'string' || text === '') return null;
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1) return null;

  const half = Math.max(0, Math.floor((chars - needle.length) / 2));
  const start = Math.max(0, at - half);
  const end = Math.min(text.length, at + needle.length + half);

  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

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
