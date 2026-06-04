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
let defaultService = null;
function getDefaultService() {
  if (!defaultService) defaultService = new SearchService({ config: configFromEnv(), pool });
  return defaultService;
}

router.post('/', async (req, res, next) => {
  const { gid } = req.params;
  const { query, config } = req.body || {};
  if (typeof query !== 'string' || query.trim() === '') {
    return res.status(400).json({ error: 'query is required' });
  }

  let service;
  try {
    service = config ? new SearchService({ config, pool }) : getDefaultService();
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
