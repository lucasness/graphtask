// Search pipeline configuration — declarative, validated, defaulted (#173 §11
// "Config"). One config object → one pipeline. The self-host story is that
// capability is CONFIG, not code: the default runs anywhere with zero setup
// (Tier-0 lexical, no model); dense/rerank light up by configuring providers.
//
// 12-factor: `configFromEnv()` reads the EMBEDDING_*/RERANK_* env into the same
// shape, so an operator swaps the local-VM backend for Modal with an env change
// and no code change (#173 §10).

import { RETRIEVERS, POSTPROCESSORS, FUSION_MODES, PROVIDER_BACKENDS } from './types.js';

/**
 * The boring default: Tier-0 lexical only, RRF joiner, top-K 10, no model
 * providers. Runs anywhere. graphExpand + rerank are Phase-3 postprocessors —
 * the registry/ports accept them now (so config can name them), but the
 * default leaves them off until they're implemented, which keeps the P2.0
 * pipeline's lexical ranking byte-identical to raw lexicalSearch.
 *
 * @returns {Object} a fresh, mutable default config
 */
export function defaultConfig() {
  return {
    retrievers: ['lexical'],
    fusion: { mode: 'rrf', k: 60 },
    postprocessors: [],
    topK: 10,
    providers: {
      embedding: { backend: 'none' },
      rerank: { backend: 'none' },
    },
  };
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function validateProvider(label, p, errors) {
  if (p === undefined) return;
  if (!isPlainObject(p)) { errors.push(`providers.${label} must be an object`); return; }
  if (p.backend !== undefined && !PROVIDER_BACKENDS.includes(p.backend)) {
    errors.push(`providers.${label}.backend must be one of ${PROVIDER_BACKENDS.join(', ')}`);
  }
}

/**
 * Validate a config object. Returns `{ config, errors }` — `config` is the
 * input normalized over the defaults, `errors` is a (possibly empty) array of
 * human-readable messages. Callers decide whether to throw (route: 400) or
 * fall back (service: default). Unknown stage NAMES are errors here rather than
 * silently dropped, so a typo surfaces loudly; a known-but-unimplemented stage
 * is the pipeline's graceful-degradation concern, not config's.
 */
export function validateConfig(input = {}) {
  const errors = [];
  const base = defaultConfig();
  if (!isPlainObject(input)) {
    return { config: base, errors: ['config must be an object'] };
  }

  const cfg = {
    retrievers: input.retrievers ?? base.retrievers,
    fusion: { ...base.fusion, ...(isPlainObject(input.fusion) ? input.fusion : {}) },
    postprocessors: input.postprocessors ?? base.postprocessors,
    topK: input.topK ?? base.topK,
    providers: {
      embedding: { ...base.providers.embedding, ...(isPlainObject(input.providers?.embedding) ? input.providers.embedding : {}) },
      rerank: { ...base.providers.rerank, ...(isPlainObject(input.providers?.rerank) ? input.providers.rerank : {}) },
    },
  };

  if (!Array.isArray(cfg.retrievers) || cfg.retrievers.length === 0) {
    errors.push('retrievers must be a non-empty array');
  } else {
    for (const r of cfg.retrievers) {
      if (!RETRIEVERS.includes(r)) errors.push(`unknown retriever "${r}" (known: ${RETRIEVERS.join(', ')})`);
    }
  }

  if (!FUSION_MODES.includes(cfg.fusion.mode)) {
    errors.push(`fusion.mode must be one of ${FUSION_MODES.join(', ')}`);
  }
  if (!Number.isInteger(cfg.fusion.k) || cfg.fusion.k < 1) {
    errors.push('fusion.k must be a positive integer');
  }

  if (!Array.isArray(cfg.postprocessors)) {
    errors.push('postprocessors must be an array');
  } else {
    for (const p of cfg.postprocessors) {
      if (!POSTPROCESSORS.includes(p)) errors.push(`unknown postprocessor "${p}" (known: ${POSTPROCESSORS.join(', ')})`);
    }
  }

  if (!Number.isInteger(cfg.topK) || cfg.topK < 1) {
    errors.push('topK must be a positive integer');
  }

  validateProvider('embedding', cfg.providers.embedding, errors);
  validateProvider('rerank', cfg.providers.rerank, errors);

  return { config: cfg, errors };
}

/** Throwing variant for callers that treat a bad config as fatal. */
export function assertConfig(input) {
  const { config, errors } = validateConfig(input);
  if (errors.length) {
    const err = new Error(`invalid search config: ${errors.join('; ')}`);
    err.status = 400;
    err.errors = errors;
    throw err;
  }
  return config;
}

/**
 * Build a config from environment variables (12-factor). The default stays
 * Tier-0 lexical; dense is added only when an embedding backend other than
 * `none` is configured. This is the seam P2.1/P2.2/P2.3/P2.4 hang the real
 * providers off of — no code change to swap local-VM ⇄ Modal, just env.
 *
 *   EMBEDDING_BACKEND   none | http | local-onnx   (default none)
 *   EMBEDDING_URL       provider endpoint (http backend)
 *   EMBEDDING_MODEL     model id (part of the index version)
 *   EMBEDDING_DIM       vector dimension
 *   RERANK_BACKEND/URL/MODEL  same shape, Tier-2 (Phase 3)
 *   SEARCH_TOPK         final top-K (default 10)
 */
export function configFromEnv(env = process.env) {
  const cfg = defaultConfig();

  const embBackend = env.EMBEDDING_BACKEND || 'none';
  cfg.providers.embedding = {
    backend: embBackend,
    ...(env.EMBEDDING_URL ? { url: env.EMBEDDING_URL } : {}),
    ...(env.EMBEDDING_MODEL ? { model: env.EMBEDDING_MODEL } : {}),
    ...(env.EMBEDDING_DIM ? { dim: Number(env.EMBEDDING_DIM) } : {}),
  };
  if (embBackend !== 'none' && !cfg.retrievers.includes('dense')) {
    cfg.retrievers.push('dense');
  }

  const rrBackend = env.RERANK_BACKEND || 'none';
  cfg.providers.rerank = {
    backend: rrBackend,
    ...(env.RERANK_URL ? { url: env.RERANK_URL } : {}),
    ...(env.RERANK_MODEL ? { model: env.RERANK_MODEL } : {}),
  };
  // Reranker postprocessor is Phase 3; env wiring is forward-looking only.

  if (env.SEARCH_TOPK) cfg.topK = Number(env.SEARCH_TOPK);

  return cfg;
}

export default { defaultConfig, validateConfig, assertConfig, configFromEnv };
