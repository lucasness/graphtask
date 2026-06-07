// DenseRetriever (Tier 1) — the semantic leg, implementing the Retriever port
// (graph task #190, P2.2). This is the IN-MEMORY form: it chunks ctx.corpus,
// embeds the chunks via the injected EmbeddingProvider, and ranks by cosine —
// no pgvector. That's the form #173 §10 calls for in the eval ("embed in-memory
// → cosine → RRF → metrics, so it isolates the model; pgvector is the production
// store"), and it's exactly what lets us get real semantic numbers before the
// pgvector store exists on the Wafer host.
//
// One node → many chunk-vectors → collapse back to the node by MAX-POOL (a node
// is as relevant as its strongest passage, #190), carrying that passage as the
// snippet. Output is ordered strongest-first so fusion (RRF) reads it by
// position, same as the lexical leg.

import { chunkParts } from '../chunking.js';
import { makeCandidate } from '../types.js';

const DEFAULT_TOPK = 50; // #173 §10: dense top-k 50 (collapsed nodes)

// Cosine == dot product because the provider returns L2-normalized vectors.
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * @param {{provider: import('../types.js').EmbeddingProvider, topK?:number,
 *          chunkOpts?:Object}} opts
 * @returns {import('../types.js').Retriever}
 */
export function createDenseRetriever({ provider, topK = DEFAULT_TOPK, chunkOpts = {} } = {}) {
  if (!provider) throw new Error('createDenseRetriever needs an EmbeddingProvider');

  // Embedding the corpus is the expensive step; the eval runs many queries over
  // the SAME corpus object, so cache the built index per corpus reference. A
  // WeakMap keyed on the corpus array means no re-embed across queries and no
  // leak across graphs. We cache the in-flight Promise so concurrent queries
  // share one build.
  const indexCache = new WeakMap();

  async function buildIndex(corpus) {
    const chunks = []; // { taskId, text }
    for (const doc of corpus) {
      const parts = chunkParts(
        { title: doc.title, description: doc.description, body: doc.body },
        chunkOpts,
      );
      for (const c of parts) chunks.push({ taskId: doc.id, text: c.text, embedText: c.embedText });
    }
    if (chunks.length === 0) return { chunks: [], vectors: [] };
    const vectors = await provider.embed(chunks.map((c) => c.embedText));
    return { chunks, vectors };
  }

  function getIndex(corpus) {
    let idx = indexCache.get(corpus);
    if (!idx) {
      idx = buildIndex(corpus);
      indexCache.set(corpus, idx);
    }
    return idx;
  }

  return {
    name: 'dense',
    async retrieve(query, ctx = {}) {
      const corpus = ctx.corpus || [];
      if (corpus.length === 0) return [];
      const { chunks, vectors } = await getIndex(corpus);
      if (chunks.length === 0) return [];

      const [qvec] = await provider.embed([query]);
      if (!qvec) return [];

      // Score every chunk, collapse to nodes by max-pool, keeping the winning
      // passage as the snippet.
      const best = new Map(); // taskId -> { score, text }
      for (let i = 0; i < chunks.length; i++) {
        const score = dot(qvec, vectors[i]);
        const cur = best.get(chunks[i].taskId);
        if (!cur || score > cur.score) best.set(chunks[i].taskId, { score, text: chunks[i].text });
      }

      const limit = ctx.denseTopK ?? topK;
      return [...best.entries()]
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, limit)
        .map(([taskId, { score, text }]) =>
          makeCandidate(taskId, score, 'dense', {
            snippet: { text, ranges: [] },
            meta: { similarity: score, distance: 1 - score },
          }),
        );
    },
  };
}

export default { createDenseRetriever };
