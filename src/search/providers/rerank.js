// RerankProvider adapters — Tier 2 cross-encoder backend (graph task #194, P2.1;
// contract in #173 §10). The interface ships now so it can be injected; the
// Reranker POSTPROCESSOR that consumes it is Phase 3. Same none/http swap and
// same auth-by-credential rule as the embedding provider — one HTTP contract,
// local TEI and Modal differ only by url/model/auth.

import { authHeaders, postJson } from './http.js';

const HTTP_BACKENDS = new Set(['http', 'local', 'modal', 'api']);

/**
 * @param {{backend?:string, url?:string, model?:string, token?:string,
 *          modalKey?:string, modalSecret?:string,
 *          timeoutMs?:number, retries?:number}} [cfg]
 * @param {{fetchImpl?:Function}} [deps]
 * @returns {import('../types.js').RerankProvider | null}
 */
export function createRerankProvider(cfg = {}, deps = {}) {
  const backend = cfg.backend || 'none';
  if (backend === 'none') return null;
  if (HTTP_BACKENDS.has(backend)) return createHttpRerankProvider(cfg, deps);
  if (backend === 'local-onnx') {
    throw new Error("rerank backend 'local-onnx' is not wired yet (optional in-process dev path; Phase 3)");
  }
  throw new Error(`unknown rerank backend "${backend}"`);
}

function createHttpRerankProvider(cfg, { fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (!cfg.url) throw new Error('http rerank provider requires a url (RERANK_URL)');
  const url = cfg.url;
  const modelId = cfg.model || '';
  const headers = authHeaders(cfg);
  const opts = { timeoutMs: cfg.timeoutMs, retries: cfg.retries };

  return {
    modelId,
    async rerank(query, docs) {
      if (typeof query !== 'string') throw new Error('rerank(query, docs) expects a string query');
      if (!Array.isArray(docs)) throw new Error('rerank(query, docs) expects an array of documents');
      if (docs.length === 0) return [];
      const data = await postJson(fetchFn, url, { query, documents: docs, model: modelId }, headers, opts);
      const scores = data && data.scores;
      if (!Array.isArray(scores)) throw new Error('rerank response missing "scores" array');
      if (scores.length !== docs.length) {
        throw new Error(`rerank score count mismatch: sent ${docs.length}, got ${scores.length}`);
      }
      return scores;
    },
  };
}

export default { createRerankProvider };
