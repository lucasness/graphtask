// SearchService — the single entry point both callers use (#173 §11 "two
// callers, one pipeline"): the route (POST /api/graphs/:gid/search, progressive
// UI) and the eval harness both go through here, so what ships is exactly what
// we measure. It does two jobs the pure pipeline deliberately doesn't:
//
//   1. ASSEMBLY — map a declarative config (config.js) to concrete stage
//      instances (the registry below) and build a SearchPipeline. This is the
//      ports-&-adapters seam: dense/rerank/graphExpand slot into the registry
//      in later phases with no change to the pipeline executor.
//   2. CORPUS IO — load the graph's nodes from Postgres when the caller didn't
//      already supply a corpus (the eval supplies its own in-memory fixture).
//
// Providers (EmbeddingProvider/RerankProvider) are injected here in P2.1; for
// P2.0 only the lexical retriever exists and dense is skipped if requested.

import { validateConfig } from './config.js';
import { getJoiner } from './fusion.js';
import { SearchPipeline } from './pipeline.js';
import { createLexicalRetriever } from './retrievers/lexical.js';
import { parseMarkdown } from '../markdown.js';

// Stage registry. Each entry is a factory (deps) => instance | null. Returning
// null means "not available in this phase / not configured" — the assembler
// drops it and the pipeline degrades to the remaining stages. Dense, rerank,
// and graphExpand register here in P2.1–P2.2 and Phase 3.
const RETRIEVER_FACTORIES = {
  lexical: () => createLexicalRetriever(),
  dense: () => null, // P2.2 — needs EmbeddingProvider (P2.1) + pgvector
};

const POSTPROCESSOR_FACTORIES = {
  graphExpand: () => null, // Phase 3 — k-hop over edges (SQL, no model)
  rerank: () => null,      // Phase 3 — cross-encoder via RerankProvider
};

/**
 * Build a SearchPipeline from a validated config. Unknown-but-registered
 * stages that a phase hasn't implemented yet resolve to null and are dropped
 * (graceful), so a config naming `dense` today simply runs lexical-only.
 *
 * @param {Object} config validated config (see config.js)
 * @param {Object} [deps] injected dependencies (pool, providers — later phases)
 * @returns {SearchPipeline}
 */
export function assemblePipeline(config, deps = {}) {
  const retrievers = config.retrievers
    .map((name) => (RETRIEVER_FACTORIES[name] ? RETRIEVER_FACTORIES[name](deps, config) : null))
    .filter(Boolean);
  if (retrievers.length === 0) {
    // Never leave the pipeline legless: lexical is the always-on floor.
    retrievers.push(createLexicalRetriever());
  }

  const postprocessors = config.postprocessors
    .map((name) => (POSTPROCESSOR_FACTORIES[name] ? POSTPROCESSOR_FACTORIES[name](deps, config) : null))
    .filter(Boolean);

  return new SearchPipeline({
    retrievers,
    joiner: getJoiner(config.fusion.mode),
    fusionOpts: { k: config.fusion.k },
    postprocessors,
    topK: config.topK,
  });
}

/**
 * Load a graph's nodes as the search corpus. Parses the markdown blob into the
 * {id,title,description,body,createdAt} shape the lexical ranker expects —
 * reusing src/markdown.js so frontmatter parsing matches the rest of the app.
 */
export async function loadCorpus(pool, gid) {
  const { rows } = await pool.query(
    'SELECT id, content, created_at FROM tasks WHERE graph_id = $1',
    [gid],
  );
  return rows.map((row) => {
    const { meta, body } = parseMarkdown(row.content || '');
    return {
      id: row.id,
      title: meta.title != null ? String(meta.title) : '',
      description: meta.description != null ? String(meta.description) : '',
      body: body || '',
      createdAt: row.created_at,
    };
  });
}

export class SearchService {
  /**
   * @param {{ config?: Object, pool?: Object, deps?: Object }} [opts]
   */
  constructor({ config, pool, deps = {} } = {}) {
    const { config: validated, errors } = validateConfig(config);
    if (errors.length) {
      const err = new Error(`invalid search config: ${errors.join('; ')}`);
      err.status = 400;
      err.errors = errors;
      throw err;
    }
    this.config = validated;
    this.pool = pool;
    this.pipeline = assemblePipeline(validated, { pool, ...deps });
  }

  /**
   * Run a search. Corpus resolution order: explicit ctx.corpus (eval / tests)
   * → load from PG by gid (route). Returns the pipeline's
   * { candidates, timings } unchanged so both callers see per-stage latency.
   */
  async search(query, ctx = {}) {
    let corpus = ctx.corpus;
    if (!corpus) {
      if (!this.pool || !ctx.gid) {
        throw new Error('SearchService.search needs either ctx.corpus or (pool + ctx.gid)');
      }
      corpus = await loadCorpus(this.pool, ctx.gid);
    }
    return this.pipeline.run(query, { ...ctx, corpus });
  }
}

export default { SearchService, assemblePipeline, loadCorpus };
