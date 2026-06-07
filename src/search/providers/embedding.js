// EmbeddingProvider adapters — Tier 1 dense leg's model backend (graph task
// #194, P2.1; contract in #173 §10). The pipeline depends only on the
// EmbeddingProvider PORT (types.js); this is the adapter the assembler injects
// from config. A `none` backend returns null so the dense stage stays off and
// lexical still answers (graceful degradation, #173 §11).
//
// `http` is the one real backend — it covers BOTH a local TEI server and Modal,
// which differ only by url/model/auth (#173 §10). `local-onnx` is an optional
// in-process dev path deferred to the P2.3 local track (transformers.js is not
// a dependency yet), so selecting it fails loudly rather than silently no-op.

import { authHeaders, postJson, l2normalize } from './http.js';

const DEFAULT_BATCH = 64; // TEI caps server-side batch; keep requests bounded.

// All HTTP-contract backends route to the same client; the value only changes
// which auth header authHeaders() emits, driven by the configured credential.
const HTTP_BACKENDS = new Set(['http', 'local', 'modal', 'api']);

/**
 * @param {{backend?:string, url?:string, model?:string, dim?:number,
 *          token?:string, modalKey?:string, modalSecret?:string,
 *          batchSize?:number, timeoutMs?:number, retries?:number}} [cfg]
 * @param {{fetchImpl?:Function}} [deps]
 * @returns {import('../types.js').EmbeddingProvider | null}
 */
export function createEmbeddingProvider(cfg = {}, deps = {}) {
  const backend = cfg.backend || 'none';
  if (backend === 'none') return null;
  if (HTTP_BACKENDS.has(backend)) return createHttpEmbeddingProvider(cfg, deps);
  if (backend === 'local-onnx') {
    throw new Error("embedding backend 'local-onnx' is not wired yet (optional in-process dev path; lands with the P2.3 local track)");
  }
  throw new Error(`unknown embedding backend "${backend}"`);
}

function createHttpEmbeddingProvider(cfg, { fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (!cfg.url) throw new Error('http embedding provider requires a url (EMBEDDING_URL)');
  const url = cfg.url;
  const modelId = cfg.model || '';
  const headers = authHeaders(cfg);
  const batchSize = cfg.batchSize ?? DEFAULT_BATCH;
  const opts = { timeoutMs: cfg.timeoutMs, retries: cfg.retries };
  // dim may be known from config up front, else learned from the first response
  // (and part of the index version — a change invalidates stored vectors).
  let resolvedDim = cfg.dim ?? null;

  return {
    modelId,
    get dim() { return resolvedDim; },
    async embed(texts) {
      if (!Array.isArray(texts)) throw new Error('embed(texts) expects an array of strings');
      if (texts.length === 0) return [];
      const out = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const data = await postJson(fetchFn, url, { texts: batch, model: modelId }, headers, opts);
        const embeddings = data && data.embeddings;
        if (!Array.isArray(embeddings)) throw new Error('embedding response missing "embeddings" array');
        if (embeddings.length !== batch.length) {
          throw new Error(`embedding count mismatch: sent ${batch.length}, got ${embeddings.length}`);
        }
        if (resolvedDim == null && Number.isInteger(data.dim)) resolvedDim = data.dim;
        for (const vec of embeddings) out.push(l2normalize(vec));
      }
      if (resolvedDim == null && out[0]) resolvedDim = out[0].length;
      return out;
    },
  };
}

export default { createEmbeddingProvider };
