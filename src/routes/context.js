// POST /api/graphs/:gid/context — the context-pack / neighborhood endpoint
// (E13, graph #457; spec finalized on #458). The cohesive knowledge-base move:
// one call returns a query- OR node-seeded k-hop `related` subgraph WITH bodies,
// so the agent gets the local neighborhood in a single round-trip instead of
// search → /graph → N body fetches. /search and /graph stay as the composable
// primitives; this sits ON TOP of them.
//
// Mounted under requireGraph('read') in app.js (mirrors /search): it READS the
// graph and never mutates, so a viewer can call it. The query-seeded path reuses
// the ONE pooled SearchService (getDefaultService / pooledAdHocDeps) so we never
// load a second ONNX copy into the serving process (#436 OOM incident).
//
// The selection algorithm is pure (search/contextPack.js) — this router is the
// IO shell: validate the body, resolve seeds (search or explicit), load edges,
// run buildNeighborhood, hydrate bodies. Defaults (hops/maxNodes/alpha) match
// the spec and are tuned against the data in #463.

import { Router } from 'express';
import pool from '../db.js';
import { parseMarkdown } from '../markdown.js';
import { EDGE_TYPES } from '../search/types.js';
import { buildNeighborhood } from '../search/contextPack.js';
import { getDefaultService, pooledAdHocDeps } from './search.js';
import { SearchService } from '../search/service.js';

const router = Router({ mergeParams: true });

// Defaults + ranges (spec #458, tuned in #463). The #463 sweep on the stock
// graph chose hops=2, maxNodes=30, alpha=0.5: that operating point clears the
// multi-hop bar (gap-closure 0.625 >= 0.60) with no direct regression, and
// alpha=0.5 (proximity-leaning) beat relevance-leaning since the bridge nodes
// are structurally close but not lexically relevant. Ranges are guardrails so a
// request can't ask the box to dump the world.
const DEFAULTS = { hops: 2, maxNodes: 30, maxBodyChars: 1500, seedTopK: 3, alpha: 0.5 };
const RANGES = {
  hops: [1, 3],
  maxNodes: [1, 100],
  maxBodyChars: [0, 20000],
  seedTopK: [1, 20],
};

function intInRange(value, name, [lo, hi], dflt) {
  if (value === undefined || value === null) return { value: dflt };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < lo || value > hi) {
    return { error: `${name} must be an integer in [${lo}, ${hi}]` };
  }
  return { value };
}

function validateBody(body) {
  const b = body || {};
  const out = {};

  const hasQuery = typeof b.query === 'string' && b.query.trim() !== '';
  const hasSeeds = Array.isArray(b.seeds) && b.seeds.length > 0;
  if (!hasQuery && !hasSeeds) return { error: 'query or seeds is required' };
  out.query = hasQuery ? b.query : null;

  if (b.seeds !== undefined && b.seeds !== null) {
    if (!Array.isArray(b.seeds)) return { error: 'seeds must be an array of node ids' };
    const seeds = [];
    for (const s of b.seeds) {
      if (typeof s !== 'number' || !Number.isInteger(s) || s <= 0) {
        return { error: 'seeds must be positive integer node ids' };
      }
      seeds.push(s);
    }
    out.seeds = seeds;
  } else {
    out.seeds = [];
  }

  // edgeTypes: undefined → default ['related']; null → all types; array → subset.
  if (b.edgeTypes === undefined) {
    out.edgeTypes = ['related'];
  } else if (b.edgeTypes === null) {
    out.edgeTypes = null;
  } else if (Array.isArray(b.edgeTypes) && b.edgeTypes.length
    && b.edgeTypes.every((t) => EDGE_TYPES.includes(t))) {
    out.edgeTypes = [...new Set(b.edgeTypes)];
  } else {
    return { error: `edgeTypes must be null or a non-empty subset of ${JSON.stringify(EDGE_TYPES)}` };
  }

  for (const [name, range] of Object.entries(RANGES)) {
    const r = intInRange(b[name], name, range, DEFAULTS[name]);
    if (r.error) return { error: r.error };
    out[name] = r.value;
  }

  // alpha is a tuning dial (#463), not a public guardrail — accept [0,1].
  if (b.alpha === undefined || b.alpha === null) {
    out.alpha = DEFAULTS.alpha;
  } else if (typeof b.alpha !== 'number' || b.alpha < 0 || b.alpha > 1) {
    return { error: 'alpha must be a number in [0, 1]' };
  } else {
    out.alpha = b.alpha;
  }

  out.config = b.config;
  return { value: out };
}

router.post('/', async (req, res, next) => {
  const { gid } = req.params;
  const parsed = validateBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const p = parsed.value;

  const t0 = Date.now();
  const timings = {};

  // 1. Resolve seeds + relevance signal.
  const relevanceRank = new Map();
  let seeds = p.seeds;
  if (p.query) {
    let service;
    try {
      service = p.config
        ? new SearchService({ config: p.config, pool, deps: pooledAdHocDeps(p.config) })
        : getDefaultService();
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message, errors: err.errors });
      return next(err);
    }
    let candidates;
    try {
      const sStart = Date.now();
      ({ candidates } = await service.search(p.query, { gid, user: req.user }));
      timings.search = Date.now() - sStart;
    } catch (err) {
      return next(err);
    }
    candidates.forEach((c, i) => {
      const id = Number(c.taskId);
      if (Number.isFinite(id) && !relevanceRank.has(id)) relevanceRank.set(id, i);
    });
    // Explicit seeds win; otherwise seed from the top search hits.
    if (seeds.length === 0) {
      seeds = candidates.slice(0, p.seedTopK).map((c) => Number(c.taskId)).filter(Number.isFinite);
    }
  }

  // 2. Validate explicit seeds exist in THIS graph (search-derived seeds always do).
  if (p.seeds.length) {
    const { rows } = await pool.query(
      'SELECT id FROM tasks WHERE graph_id = $1 AND id = ANY($2)',
      [gid, p.seeds],
    );
    const present = new Set(rows.map((r) => Number(r.id)));
    const missing = p.seeds.filter((id) => !present.has(id));
    if (missing.length) {
      return res.status(400).json({ error: `seed(s) not found in graph: ${missing.join(', ')}` });
    }
  }

  // No seeds resolved (e.g. query matched nothing and none were given) → empty pack.
  if (seeds.length === 0) {
    timings.total = Date.now() - t0;
    return res.json({ seeds: [], nodes: [], edges: [], timings, truncated: false });
  }

  // 3. Load edges and run the pure neighborhood selection.
  const eStart = Date.now();
  const { rows: edgeRows } = await pool.query(
    'SELECT source_id, target_id, type FROM edges WHERE graph_id = $1',
    [gid],
  );
  const { ids, dist, edges, truncated } = buildNeighborhood({
    seeds,
    edges: edgeRows,
    edgeTypes: p.edgeTypes,
    hops: p.hops,
    maxNodes: p.maxNodes,
    relevanceRank,
    alpha: p.alpha,
  });
  timings.expand = Date.now() - eStart;

  // 4. Hydrate bodies (one query), preserving the selection order from `ids`.
  const hStart = Date.now();
  const { rows: nodeRows } = await pool.query(
    'SELECT id, content FROM tasks WHERE graph_id = $1 AND id = ANY($2)',
    [gid, ids],
  );
  const byId = new Map();
  for (const row of nodeRows) {
    const { meta, body } = parseMarkdown(row.content || '');
    byId.set(Number(row.id), {
      title: meta.title != null ? String(meta.title) : '',
      status: meta.status != null ? String(meta.status) : 'todo',
      body: body || '',
    });
  }
  const nodes = ids
    .filter((id) => byId.has(id))
    .map((id) => {
      const n = byId.get(id);
      const full = n.body;
      const clipped = p.maxBodyChars >= 0 && full.length > p.maxBodyChars
        ? full.slice(0, p.maxBodyChars)
        : full;
      const node = { id, title: n.title, status: n.status, dist: dist.get(id) ?? null, body: clipped };
      if (clipped.length < full.length) node.bodyTruncated = true;
      return node;
    });
  timings.hydrate = Date.now() - hStart;
  timings.total = Date.now() - t0;

  res.json({ seeds, nodes, edges, timings, truncated });
});

export default router;
