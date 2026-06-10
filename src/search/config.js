// Search pipeline configuration — declarative, validated, defaulted (#173 §11
// "Config"). One config object → one pipeline. The self-host story is that
// capability is CONFIG, not code: the default runs anywhere with zero setup
// (Tier-0 lexical, no model); dense/rerank light up by configuring providers.
//
// 12-factor: `configFromEnv()` reads the EMBEDDING_*/RERANK_* env into the same
// shape, so an operator swaps the local-VM backend for Modal with an env change
// and no code change (#173 §10).

import { RETRIEVERS, POSTPROCESSORS, FUSION_MODES, PROVIDER_BACKENDS, EDGE_TYPES } from './types.js';

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
    // graphExpand knobs (#197). Carried even when the stage is off so enabling
    // it (postprocessors:['graphExpand']) inherits sane caps; the stage reads
    // these from config.graphExpand. hops=1 is the cheap, high-precision layer;
    // the caps bound fan-out so a hub node can't flood the list.
    graphExpand: { hops: 1, maxAddedPerSeed: 5, maxAdded: 50 },
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
    graphExpand: { ...base.graphExpand, ...(isPlainObject(input.graphExpand) ? input.graphExpand : {}) },
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

  // graphExpand caps must be positive integers; edgeTypes (optional) a subset of
  // the real edge types so a typo'd type can't silently match nothing.
  for (const key of ['hops', 'maxAddedPerSeed', 'maxAdded']) {
    const v = cfg.graphExpand[key];
    if (!Number.isInteger(v) || v < 1) errors.push(`graphExpand.${key} must be a positive integer`);
  }
  if (cfg.graphExpand.edgeTypes !== undefined) {
    if (!Array.isArray(cfg.graphExpand.edgeTypes)) {
      errors.push('graphExpand.edgeTypes must be an array');
    } else {
      for (const t of cfg.graphExpand.edgeTypes) {
        if (!EDGE_TYPES.includes(t)) errors.push(`graphExpand.edgeTypes has unknown type "${t}" (known: ${EDGE_TYPES.join(', ')})`);
      }
    }
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
 *   EMBEDDING_TIMEOUT_MS  per-request timeout (default 10000; raise for cold/remote backends)
 *   EMBEDDING_RETRIES   bounded retries on timeout/5xx (default 2)
 *   EMBEDDING_BATCH     embed batch size (default 64; lower for long docs)
 *   RERANK_BACKEND/URL/MODEL  same shape, Tier-2 cross-encoder; setting a
 *                       backend enables the rerank postprocessor
 *   RERANK_TIMEOUT_MS/RETRIES  transport knobs (cold/remote GPU reranker)
 *   RERANK_TOPM         how many fused hits to rerank (default 50 — measured
 *                       better recall than 20 at ~same cost with the default
 *                       TinyBERT @ 512 chars; see #198)
 *   RERANK_DTYPE        local-onnx weights variant: q8 (default) | fp32
 *   GRAPH_EXPAND        1/true (or any GRAPH_EXPAND_* knob) enables k-hop
 *                       graph expansion — the recall lever, no model (#197)
 *   GRAPH_EXPAND_HOPS / _MAX_PER_SEED / _MAX  BFS depth + fan-out caps
 *   GRAPH_EXPAND_EDGE_TYPES  comma list to restrict traversal (default: all)
 *   SEARCH_TOPK         final top-K (default 10)
 */
// Auth credentials for a provider, read with a per-provider prefix so embedding
// and rerank can point at different backends. Modal proxy-auth (key+secret) or
// a bearer token; the provider picks the header from whichever is set (#173
// §10). MODAL_KEY/MODAL_SECRET act as a shared fallback so a single Modal app
// secret serves both providers without repeating it.
function authFromEnv(env, prefix) {
  const out = {};
  const token = env[`${prefix}_TOKEN`];
  const modalKey = env[`${prefix}_MODAL_KEY`] || env.MODAL_KEY;
  const modalSecret = env[`${prefix}_MODAL_SECRET`] || env.MODAL_SECRET;
  if (token) out.token = token;
  if (modalKey) out.modalKey = modalKey;
  if (modalSecret) out.modalSecret = modalSecret;
  return out;
}

export function configFromEnv(env = process.env) {
  const cfg = defaultConfig();

  const embBackend = env.EMBEDDING_BACKEND || 'none';
  cfg.providers.embedding = {
    backend: embBackend,
    ...(env.EMBEDDING_URL ? { url: env.EMBEDDING_URL } : {}),
    ...(env.EMBEDDING_MODEL ? { model: env.EMBEDDING_MODEL } : {}),
    ...(env.EMBEDDING_DIM ? { dim: Number(env.EMBEDDING_DIM) } : {}),
    // Transport knobs: a cold/remote backend (e.g. Modal scaled-to-zero, or a
    // large corpus index batch) can blow past the 10s default and silently
    // degrade to lexical. Let operators raise the ceiling per deployment.
    ...(env.EMBEDDING_TIMEOUT_MS ? { timeoutMs: Number(env.EMBEDDING_TIMEOUT_MS) } : {}),
    ...(env.EMBEDDING_RETRIES ? { retries: Number(env.EMBEDDING_RETRIES) } : {}),
    ...(env.EMBEDDING_BATCH ? { batchSize: Number(env.EMBEDDING_BATCH) } : {}),
    ...authFromEnv(env, 'EMBEDDING'),
  };
  if (embBackend !== 'none' && !cfg.retrievers.includes('dense')) {
    cfg.retrievers.push('dense');
  }

  // Graph expansion (#197): the recall lever, off by default. GRAPH_EXPAND
  // (1/true) — or simply setting any GRAPH_EXPAND_* knob — lights up the
  // postprocessor. Pushed BEFORE rerank below so when both are on the order is
  // graphExpand → rerank (expand the pool, then rerank what's in it; #197).
  const geOn = ['1', 'true', 'yes'].includes(String(env.GRAPH_EXPAND || '').toLowerCase())
    || env.GRAPH_EXPAND_HOPS || env.GRAPH_EXPAND_MAX_PER_SEED
    || env.GRAPH_EXPAND_MAX || env.GRAPH_EXPAND_EDGE_TYPES;
  if (geOn) {
    if (env.GRAPH_EXPAND_HOPS) cfg.graphExpand.hops = Number(env.GRAPH_EXPAND_HOPS);
    if (env.GRAPH_EXPAND_MAX_PER_SEED) cfg.graphExpand.maxAddedPerSeed = Number(env.GRAPH_EXPAND_MAX_PER_SEED);
    if (env.GRAPH_EXPAND_MAX) cfg.graphExpand.maxAdded = Number(env.GRAPH_EXPAND_MAX);
    if (env.GRAPH_EXPAND_EDGE_TYPES) {
      cfg.graphExpand.edgeTypes = env.GRAPH_EXPAND_EDGE_TYPES.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (!cfg.postprocessors.includes('graphExpand')) cfg.postprocessors.push('graphExpand');
  }

  const rrBackend = env.RERANK_BACKEND || 'none';
  cfg.providers.rerank = {
    backend: rrBackend,
    ...(env.RERANK_URL ? { url: env.RERANK_URL } : {}),
    ...(env.RERANK_MODEL ? { model: env.RERANK_MODEL } : {}),
    ...(env.RERANK_DTYPE ? { dtype: env.RERANK_DTYPE } : {}),
    ...(env.RERANK_TIMEOUT_MS ? { timeoutMs: Number(env.RERANK_TIMEOUT_MS) } : {}),
    ...(env.RERANK_RETRIES ? { retries: Number(env.RERANK_RETRIES) } : {}),
    ...(env.RERANK_TOPM ? { topM: Number(env.RERANK_TOPM) } : {}),
    ...(env.RERANK_MAXCHARS ? { maxChars: Number(env.RERANK_MAXCHARS) } : {}),
    ...authFromEnv(env, 'RERANK'),
  };
  // Tier-2 cross-encoder rerank: configuring a backend lights up the rerank
  // postprocessor (the slot is implemented; #173 §2/§11). `none` leaves it off.
  if (rrBackend !== 'none' && !cfg.postprocessors.includes('rerank')) {
    cfg.postprocessors.push('rerank');
  }

  if (env.SEARCH_TOPK) cfg.topK = Number(env.SEARCH_TOPK);

  return cfg;
}

export default { defaultConfig, validateConfig, assertConfig, configFromEnv };
