// POST /api/graphs/:gid/search — the UI's front door to the KB search engine
// (graph #172 Cmd+F bar → #171 hybrid+graph backend). Mounted under
// requireGraph('read') in app.js: search READS the graph's nodes, so a viewer
// can run it; it never mutates. The same SearchService the eval harness uses
// runs here, so the ranking the user sees is the ranking we measure (#173 §11).
//
// Progressive rendering (#173 §7) is a CLIENT concern — the server returns the
// full computed order plus per-stage timings in one response; in P2.0 that's
// the instant lexical leg. When dense/rerank land (P2.1+), the heavy legs move
// behind a streamed/second response, but this endpoint's contract is stable:
// { query, results, timings }.

import { Router } from 'express';
import pool from '../db.js';
import { SearchService } from '../search/service.js';
import { configFromEnv } from '../search/config.js';

const router = Router({ mergeParams: true });

// One service per process for the default (env-derived) config — assembly is
// cheap but pointless to repeat per request. A request that overrides the
// config builds an ad-hoc service (validation may reject it → 400).
// Shared with the cross-graph route (searchAll.js): ONE service per process
// means ONE copy of the ONNX models — a second instance would double model
// memory AND make the first cross-graph search pay its own multi-second lazy
// load that the boot warmup below already paid for this one.
let defaultService = null;
export function getDefaultService() {
  if (!defaultService) defaultService = new SearchService({ config: configFromEnv(), pool });
  return defaultService;
}

// Boot-time model warmup. The route's service loads its ONNX models lazily, so
// without this the FIRST search after a deploy pays the load (~1.4s measured on
// one core — #198 review) and blows the interactive latency budget. A throwaway
// in-memory search exercises the exact production path (embed + rerank when
// configured); with no model backends configured it's a no-op-cheap lexical run.
export function warmupDefaultService() {
  return getDefaultService().search('warmup', {
    corpus: [{ id: 'warmup', title: 'warmup', description: '', body: 'warmup' }],
  });
}

// OOM guard (#436 incident, 2026-06-12): a per-request `config` naming a
// local-onnx backend used to make the ad-hoc SearchService load a SECOND copy
// of the ONNX models inside the serving process — on the 2.9GB box that
// OOM-killed the app mid-request. This process pools exactly one in-memory
// copy per provider (the default service's). An ad-hoc config asking for
// local-onnx gets that pooled instance when it matches the deployed identity
// (model + dtype), and a 400 when it doesn't — a different model can't be
// served from this process; use an http backend for that experiment.
export function pooledAdHocDeps(config, def = getDefaultService()) {
  const deps = {};
  const kinds = [['embedding', 'embeddingProvider'], ['rerank', 'rerankProvider']];
  for (const [kind, depKey] of kinds) {
    const requested = config?.providers?.[kind];
    if (!requested || requested.backend !== 'local-onnx') continue;
    const deployed = def.config.providers?.[kind] || {};
    const samePooledModel = deployed.backend === 'local-onnx'
      && (requested.model ?? null) === (deployed.model ?? null)
      && (requested.dtype ?? null) === (deployed.dtype ?? null);
    if (!samePooledModel) {
      const err = new Error(
        `providers.${kind}: ad-hoc local-onnx configs can only reuse the deployed model `
        + '(one pooled in-process copy; loading another risks OOM) — '
        + 'omit the override or use an http backend',
      );
      err.status = 400;
      err.errors = [err.message];
      throw err;
    }
    deps[depKey] = def.providers[kind];
  }
  return deps;
}

router.post('/', async (req, res, next) => {
  const { gid } = req.params;
  const { query, config } = req.body || {};
  if (typeof query !== 'string' || query.trim() === '') {
    return res.status(400).json({ error: 'query is required' });
  }

  let service;
  try {
    service = config ? new SearchService({ config, pool, deps: pooledAdHocDeps(config) }) : getDefaultService();
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message, errors: err.errors });
    return next(err);
  }

  try {
    const { candidates, timings } = await service.search(query, { gid, user: req.user });
    res.json({ query, results: candidates, timings });
  } catch (err) {
    next(err);
  }
});

export default router;
