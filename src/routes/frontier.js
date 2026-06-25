// E15.B2 — POST /api/graphs/:gid/frontier. The re-verification frontier: the
// confidence-bearing nodes that are LOAD-BEARING (high importance) AND either
// STALE (verified_at older than staleDays, or never verified) OR LOW-CONFIDENCE.
// Complements /tasks/ready: instead of "what's next to do", it answers "what
// established knowledge most needs re-checking". Read-guarded; never mutates.
//
// Importance = OUT-degree counting `required for` + `supports` edges. Our edge
// direction is source(prereq) → target(dependent), so a node that many things
// REST ON has high out-degree — exactly the foundation we want to re-verify
// first. (The umbrella's older "in-degree" wording is backwards under this
// direction and would surface terminal leaves instead of foundations.)
// Importance is derived on demand from edges, never stored.

import { Router } from 'express';
import pool from '../db.js';

const router = Router({ mergeParams: true });

const DEFAULTS = { minImportance: 2, staleDays: 90, lowConfidenceBelow: 0.5, maxResults: 50 };
const MAX_RESULTS_CAP = 500;

function num(value, name, dflt, { min, max, integer }) {
  if (value === undefined || value === null) return { value: dflt };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${name} must be a number` };
  if (integer && !Number.isInteger(value)) return { error: `${name} must be an integer` };
  if (min !== undefined && value < min) return { error: `${name} must be >= ${min}` };
  if (max !== undefined && value > max) return { error: `${name} must be <= ${max}` };
  return { value };
}

router.post('/', async (req, res, next) => {
  const b = req.body || {};
  const { gid } = req.params;

  const minImportance = num(b.minImportance, 'minImportance', DEFAULTS.minImportance, { min: 0, integer: true });
  const staleDays = num(b.staleDays, 'staleDays', DEFAULTS.staleDays, { min: 0 });
  const lowConfidenceBelow = num(b.lowConfidenceBelow, 'lowConfidenceBelow', DEFAULTS.lowConfidenceBelow, { min: 0, max: 1 });
  const maxResults = num(b.maxResults, 'maxResults', DEFAULTS.maxResults, { min: 1, max: MAX_RESULTS_CAP, integer: true });
  for (const r of [minImportance, staleDays, lowConfidenceBelow, maxResults]) {
    if (r.error) return res.status(400).json({ error: r.error });
  }

  try {
    // Importance via a correlated out-degree count over the load-bearing
    // purposes. Staleness uses NOW() so "older than staleDays" is server-clock
    // relative; an absent verified_at is treated as never-verified = stale.
    // Fetch maxResults+1 so we can flag truncation without a second COUNT.
    const { rows } = await pool.query(
      `WITH imp AS (
         SELECT t.id,
                (SELECT count(*) FROM edges e
                  WHERE e.source_id = t.id AND e.graph_id = $1
                    AND e.purpose IN ('required for', 'supports')) AS importance
           FROM tasks t WHERE t.graph_id = $1
       )
       SELECT t.id,
              t.meta->>'title'        AS title,
              t.meta->>'status'       AS status,
              t.meta->>'type'         AS type,
              (t.meta->>'confidence')::numeric AS confidence,
              t.meta->>'verified_at'  AS verified_at,
              i.importance,
              (t.meta->>'verified_at' IS NULL
                OR (t.meta->>'verified_at')::timestamptz < NOW() - ($3 || ' days')::interval) AS stale,
              (t.meta->>'confidence' IS NOT NULL
                AND (t.meta->>'confidence')::numeric < $4) AS low_confidence
         FROM tasks t
         JOIN imp i ON i.id = t.id
        WHERE t.graph_id = $1
          AND (t.meta->>'confidence' IS NOT NULL OR t.meta->>'type' = 'reference')
          AND i.importance >= $2
          AND (
                t.meta->>'verified_at' IS NULL
                OR (t.meta->>'verified_at')::timestamptz < NOW() - ($3 || ' days')::interval
                OR (t.meta->>'confidence' IS NOT NULL AND (t.meta->>'confidence')::numeric < $4)
          )
        ORDER BY i.importance DESC, (t.meta->>'verified_at') ASC NULLS FIRST, t.id ASC
        LIMIT $5`,
      [gid, minImportance.value, String(staleDays.value), lowConfidenceBelow.value, maxResults.value + 1],
    );

    const truncated = rows.length > maxResults.value;
    const frontier = rows.slice(0, maxResults.value).map((r) => ({
      id: r.id,
      title: r.title ?? '',
      status: r.status ?? 'todo',
      type: r.type ?? null,
      importance: Number(r.importance),
      confidence: r.confidence != null ? Number(r.confidence) : null,
      verified_at: r.verified_at ?? null,
      stale: r.stale === true,
      lowConfidence: r.low_confidence === true,
    }));

    res.json({
      frontier,
      truncated,
      params: {
        minImportance: minImportance.value,
        staleDays: staleDays.value,
        lowConfidenceBelow: lowConfidenceBelow.value,
        maxResults: maxResults.value,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
