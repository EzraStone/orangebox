// §10.7 — read a run back in from an export.
//
// `orangebox export` has always been the way to hand a recording to somebody
// else. Until now the other end had nowhere to put it: they could read the
// JSON, but not open it in the timeline, diff it, or compare it against their
// own run — which is the entire reason to send it.
//
// Importing is deliberately additive and never destructive. A run whose id is
// already present is given a new one rather than overwriting, because the
// person importing has no way to know what they would be replacing.

import { newId } from './store.mjs';

export class ImportError extends Error {}

/**
 * Validate an export payload. Returns the parts worth inserting, or throws
 * with a message aimed at whoever is holding the file.
 */
export function parseExport(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ImportError('not an orangebox export: expected a JSON object');
  }
  if (payload.orangebox_export === undefined) {
    throw new ImportError('not an orangebox export: no "orangebox_export" marker');
  }
  if (!isObject(payload.run) || typeof payload.run.id !== 'string') {
    throw new ImportError('export is missing its run');
  }
  if (!Array.isArray(payload.calls)) {
    throw new ImportError('export is missing its calls');
  }

  return {
    run: payload.run,
    calls: payload.calls,
    tools: Array.isArray(payload.tools) ? payload.tools : [],
    version: typeof payload.orangebox_version === 'string' ? payload.orangebox_version : null,
    exportedAt: Number.isFinite(payload.exported_at) ? payload.exported_at : null
  };
}

/**
 * Insert an export into a store.
 *
 * Ids are rewritten whenever they would collide, and the mapping is applied to
 * every reference — a tool event pointing at a call id that no longer exists
 * would be silently dropped by the foreign key, taking the tool timeline with
 * it.
 */
export function importRun(store, payload, { name = null, now = Date.now() } = {}) {
  const { run, calls, tools, version, exportedAt } = parseExport(payload);

  const collision = store.getRun(run.id) !== null;
  const runId = collision ? newId() : run.id;

  const callIds = new Map();
  for (const call of calls) {
    if (typeof call?.id !== 'string') throw new ImportError('a call in this export has no id');
    callIds.set(call.id, collision || store.getCall(call.id) ? newId() : call.id);
  }

  const baseName =
    name ??
    (run.name ? `${run.name} (imported)` : `imported run ${new Date(exportedAt ?? now).toISOString().slice(0, 10)}`);

  // Importing the same file twice is a reasonable thing to do, and two runs
  // sharing a name collapse into one row anywhere runs are grouped by name.
  const importedName = uniqueName(store, baseName);

  store.db.transaction(() => {
    store.createRun({
      id: runId,
      name: importedName.slice(0, 200),
      source: 'explicit',
      started_at: Number.isFinite(run.started_at) ? run.started_at : now
    });

    let seq = 0;
    for (const call of calls) {
      const id = callIds.get(call.id);
      const events = tools
        .filter((t) => t.call_id === call.id)
        .map((tool) => ({
          id: newId(),
          run_id: runId,
          call_id: id,
          kind: tool.kind,
          tool_name: tool.tool_name ?? null,
          tool_use_id: tool.tool_use_id ?? null,
          is_error: tool.is_error ? 1 : 0,
          content_json: tool.content_json ?? null
        }));

      store.insertCall({ ...call, id, run_id: runId, seq: ++seq }, events);
    }

    if (Number.isFinite(run.ended_at)) store.endRun(runId, run.ended_at);
  })();

  return {
    run_id: runId,
    name: importedName,
    calls: calls.length,
    tools: tools.length,
    renamed: collision,
    exported_by: version
  };
}

/** Append a counter only when the name is already taken. */
function uniqueName(store, base) {
  const taken = new Set(store.listRuns({ limit: 500 }).runs.map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} #${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
