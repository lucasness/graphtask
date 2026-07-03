// /api/graphs/:gid/report — the graph's ONE canonical human-readable report
// (E16). Mounted under requireGraphForMethod, so GET needs `read` and PUT and
// DELETE need `edit` (FIXED #5): a viewer/anon can READ a report but not write
// or remove it, and an editor-member/anon_role:'editor' CAN regenerate (edit,
// not owner-only manage). `req.graph` is already loaded by the mount guard.
//
// The report lives in its own `reports` table (one row per graph, graph_id PK)
// whose notify trigger fires kind:'report' WITHOUT bumping graphs.updated_at /
// version — so generating or updating a report has ZERO impact on the graph
// (E16.1). The write is a single-statement upsert: no withTx needed (that's
// only for the multi-statement atomicity graphPrefs.js requires). The E16.1
// trigger fires the SSE frame on its own — src/sse.js already re-broadcasts any
// graph_change notify for a subscribed graph_id regardless of `kind`.
import { Router } from 'express';
import pool from '../db.js';

const router = Router({ mergeParams: true });

// GET the report. 404 when none — the reader turns that into its empty state.
router.get('/', async (req, res) => {
  const { gid } = req.params;
  const r = await pool.query('SELECT * FROM reports WHERE graph_id = $1', [gid]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'no report yet' });
  res.json(r.rows[0]);
});

// GET /meta — a cheap, body-less existence + staleness probe (E16.6). Read-gated
// by the mount (GET→read), so a viewer can poll it. It exists as GET, NOT HEAD:
// requireGraphForMethod maps every non-GET method to `edit`, so a HEAD would
// 403 a viewer. `exists:false` (200) when there's no report; otherwise `stale`
// is computed off the already-loaded req.graph — no extra query. Staleness proxy
// is graphs.updated_at, which ANY graph write bumps (task/edge trigger OR a plain
// PATCH like rename), so any change since generation counts as stale — intended.
router.get('/meta', async (req, res) => {
  const { gid } = req.params;
  const r = await pool.query(
    'SELECT title, generated_at, updated_at, source_graph_version FROM reports WHERE graph_id = $1',
    [gid],
  );
  if (r.rows.length === 0) return res.json({ exists: false });
  const row = r.rows[0];
  const graphUpdatedAt = req.graph?.updated_at ?? null;
  const stale = graphUpdatedAt != null
    && new Date(row.generated_at).getTime() < new Date(graphUpdatedAt).getTime();
  res.json({
    exists: true,
    title: row.title,
    generated_at: row.generated_at,
    updated_at: row.updated_at,
    source_graph_version: row.source_graph_version,
    stale,
  });
});

// PUT (upsert) the report. Validates then upserts in one statement; generated_at
// is set only on INSERT (omitted from the UPDATE SET so it's preserved), and
// run_id is COALESCE'd so a later PUT that omits it keeps the original run's id.
router.put('/', async (req, res) => {
  const { gid } = req.params;
  const b = req.body ?? {};

  const title = typeof b.title === 'string' ? b.title : '';
  if (title.trim().length === 0) return res.status(400).json({ error: 'title is required' });
  if (title.length > 200) return res.status(400).json({ error: 'title must be 200 characters or fewer' });

  let description = b.description === undefined ? null : b.description;
  if (description !== null) {
    if (typeof description !== 'string') return res.status(400).json({ error: 'description must be a string or null' });
    if (description.length > 500) return res.status(400).json({ error: 'description must be 500 characters or fewer' });
  }

  // A non-string body is coerced to '' rather than rejected — the column is
  // NOT NULL DEFAULT '' and a report with no body yet is a valid state.
  const body = typeof b.body === 'string' ? b.body : '';

  let sourceGraphVersion = b.source_graph_version === undefined ? null : b.source_graph_version;
  if (sourceGraphVersion !== null && !Number.isInteger(sourceGraphVersion)) {
    return res.status(400).json({ error: 'source_graph_version must be an integer or null' });
  }

  let runId = b.run_id === undefined ? null : b.run_id;
  if (runId !== null && typeof runId !== 'string') {
    return res.status(400).json({ error: 'run_id must be a string or null' });
  }

  let meta = b.meta;
  if (meta === undefined || meta === null) meta = {};
  if (typeof meta !== 'object' || Array.isArray(meta)) {
    return res.status(400).json({ error: 'meta must be an object' });
  }

  const r = await pool.query(
    `INSERT INTO reports (graph_id, title, description, body, source_graph_version, run_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '{}'::jsonb))
     ON CONFLICT (graph_id) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       body = EXCLUDED.body,
       source_graph_version = EXCLUDED.source_graph_version,
       run_id = COALESCE(EXCLUDED.run_id, reports.run_id),
       meta = EXCLUDED.meta,
       updated_at = NOW()
     RETURNING *`,
    [gid, title, description, body, sourceGraphVersion, runId, JSON.stringify(meta)],
  );
  res.json(r.rows[0]);
});

// DELETE the report. 204 on success; 404 when there is none — same "no report
// yet" shape as GET, so a repeat DELETE reports nothing-to-delete honestly.
// The E16.1 trigger emits the kind:'report' DELETE notify for live readers.
router.delete('/', async (req, res) => {
  const { gid } = req.params;
  const r = await pool.query('DELETE FROM reports WHERE graph_id = $1 RETURNING graph_id', [gid]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'no report yet' });
  res.status(204).end();
});

export default router;
