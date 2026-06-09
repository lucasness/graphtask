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
import { createDenseRetriever, createStoreDenseRetriever } from './retrievers/dense.js';
import { createEmbeddingProvider } from './providers/embedding.js';
import { createRerankProvider } from './providers/rerank.js';
import { createReranker } from './postprocessors/rerank.js';
import { createGraphExpander } from './postprocessors/graphExpand.js';
import { parseMarkdown } from '../markdown.js';

// Stage registry. Each entry is a factory (deps, config) => instance | null.
// Returning null means "not available / not configured" — the assembler drops
// it and the pipeline degrades to the remaining stages (lexical always answers).
const RETRIEVER_FACTORIES = {
  lexical: () => createLexicalRetriever(),
  // Dense needs an EmbeddingProvider; with backend `none` (or unconfigured) the
  // provider is null → dense drops → lexical-only. With a pool the store-backed
  // form runs (ANN over task_chunks, embedded at write time by the indexer) and
  // itself falls back to the in-memory leg (chunk ctx.corpus → embed → cosine)
  // where ANN can't apply — caller-supplied corpus, no pgvector, empty store.
  dense: (deps) => {
    if (!deps.embeddingProvider) return null;
    return deps.pool
      ? createStoreDenseRetriever({ pool: deps.pool, provider: deps.embeddingProvider })
      : createDenseRetriever({ provider: deps.embeddingProvider });
  },
};

const POSTPROCESSOR_FACTORIES = {
  // Phase 3 recall lever — k-hop BFS over `edges` (SQL/in-memory, no model).
  // Unlike rerank it has no provider to gate on: it runs whenever an edge
  // source exists (deps.pool+gid on the route, ctx.edges in eval/tests) and is
  // a graceful no-op otherwise, so the factory always returns the stage.
  graphExpand: (deps, config) => createGraphExpander({ pool: deps.pool, ...(config.graphExpand || {}) }),
  // Tier 2 cross-encoder. Needs a RerankProvider; with backend `none` (or
  // unconfigured) the provider is null → rerank drops and the fused order
  // stands (graceful). topM caps how many fused hits get scored (cost knob).
  rerank: (deps, config) => {
    if (!deps.rerankProvider) return null;
    return createReranker({
      provider: deps.rerankProvider,
      topM: config.providers?.rerank?.topM,
      maxChars: config.providers?.rerank?.maxChars,
    });
  },
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
  // Adapters from config: build the embedding provider once and inject it so
  // the dense factory (and later the rerank postprocessor) just consume it.
  // A caller can pre-supply deps.embeddingProvider (tests inject a fake one).
  const stageDeps = {
    ...deps,
    embeddingProvider: deps.embeddingProvider ?? createEmbeddingProvider(config.providers?.embedding || {}, deps),
    rerankProvider: deps.rerankProvider ?? createRerankProvider(config.providers?.rerank || {}, deps),
  };

  const retrievers = config.retrievers
    .map((name) => (RETRIEVER_FACTORIES[name] ? RETRIEVER_FACTORIES[name](stageDeps, config) : null))
    .filter(Boolean);
  if (retrievers.length === 0) {
    // Never leave the pipeline legless: lexical is the always-on floor.
    retrievers.push(createLexicalRetriever());
  }

  const postprocessors = config.postprocessors
    .map((name) => (POSTPROCESSOR_FACTORIES[name] ? POSTPROCESSOR_FACTORIES[name](stageDeps, config) : null))
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
    // corpusFromStore tells the dense retriever whether ANN over task_chunks
    // ranks the SAME documents the caller is searching. A caller-supplied
    // corpus (eval fixture, tests) must be ranked in-memory, never against
    // live store rows.
    let corpusFromStore = false;
    if (!corpus) {
      if (!this.pool || !ctx.gid) {
        throw new Error('SearchService.search needs either ctx.corpus or (pool + ctx.gid)');
      }
      corpus = await loadCorpus(this.pool, ctx.gid);
      corpusFromStore = true;
    }
    return this.pipeline.run(query, { ...ctx, corpus, corpusFromStore });
  }
}

export default { SearchService, assemblePipeline, loadCorpus };
