// Reranker postprocessor — Tier 2, the "single biggest accuracy lever" (#173
// §2/§11). Runs AFTER fusion, BEFORE the final top-K: it takes the top-M fused
// candidates, scores each (query, document) pair with a cross-encoder
// (RerankProvider — local-onnx in-process or http/Modal), and re-sorts by that
// score. The cross-encoder reads query+doc JOINTLY, which is why it beats the
// bi-encoder dense ranking on precision — at the cost of per-query compute, so
// we only rerank the top M (20–50), never the whole list.
//
// Graceful by construction: the pipeline already wraps postprocess() so a throw
// (provider down / cold-start timeout) leaves the fused order untouched. We also
// pull document text from ctx.corpus (the same corpus every stage shares), so
// reranking scores the real node text, not just the lexical snippet.

const DEFAULT_TOP_M = 50; // rerank this many fused hits; the tail passes through
// Cap doc text sent to the cross-encoder. 512 is the #198 sweet spot: sequence
// length dominates latency (2000→512 chars ≈ 3-8× faster) and the title+lead
// carries the relevance signal, so accuracy holds. Raise via RERANK_MAXCHARS
// for corpora where the signal sits deep in long bodies.
const DEFAULT_MAX_CHARS = 512;

/**
 * @param {{provider:import('../types.js').RerankProvider, topM?:number, maxChars?:number}} opts
 * @returns {import('../types.js').Postprocessor}
 */
export function createReranker({ provider, topM = DEFAULT_TOP_M, maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (!provider) throw new Error('createReranker needs a RerankProvider');

  return {
    name: 'rerank',
    async postprocess(query, candidates, ctx = {}) {
      if (!Array.isArray(candidates) || candidates.length === 0) return candidates;

      // taskId → document text, from the shared corpus. Fall back to the
      // candidate's lexical snippet, then empty, so a missing doc never throws.
      const textById = new Map();
      for (const doc of ctx.corpus || []) {
        const parts = [doc.title, doc.description, doc.body].filter(Boolean).join('\n');
        textById.set(String(doc.id), parts);
      }
      const docTextFor = (c) => {
        const t = textById.get(String(c.taskId)) ?? (c.snippet && c.snippet.text) ?? '';
        return t.length > maxChars ? t.slice(0, maxChars) : t;
      };

      const head = candidates.slice(0, topM);
      const tail = candidates.slice(topM);
      const scores = await provider.rerank(query, head.map(docTextFor));
      if (!Array.isArray(scores) || scores.length !== head.length) {
        // Defensive: a malformed provider response leaves order unchanged.
        return candidates;
      }

      const reranked = head
        .map((c, i) => ({
          ...c,
          score: scores[i],
          source: 'rerank',
          meta: { ...(c.meta || {}), rerankScore: scores[i], rerankedFrom: c.source },
        }))
        .sort((a, b) => b.score - a.score);

      return [...reranked, ...tail];
    },
  };
}

export default { createReranker };
