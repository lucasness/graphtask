#!/usr/bin/env node
// Hybrid-at-50 A/B (#197/#198 follow-up) — the FAITHFUL production config.
// Earlier A/Bs ran lexical-only (the in-memory dense leg re-embeds the whole
// corpus per query and OOMs the 2.9GB box). This one uses the PRODUCTION store-
// ANN dense path: chunk embeddings are precomputed in task_chunks, so dense is
// a pgvector ANN query and only the 40 short QUERY strings get embedded — light.
//
// It measures the real shipping pipeline — lexical(top-50) + dense(top-50) →
// RRF — and A/Bs the postprocessors on top of it:
//   baseline · +graphExpand (recall lever) · +rerank (precision lever) · +both
// against the stock graph's 40 qrels, on real hardware. Models load ONCE and
// are injected into every variant.
//
// Run from the project with the app's env:  set -a; source .env; set +a; node eval/hybrid-ab.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveConnectionString, createPool } from '../src/db.js';
import { assemblePipeline, loadCorpus } from '../src/search/service.js';
import { createEmbeddingProvider } from '../src/search/providers/embedding.js';
import { createRerankProvider } from '../src/search/providers/rerank.js';
import { scoreQuery, meanScores, percentile } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GID = process.env.STOCK_GID || 'fwmhe8ysfrnx9fw7';
const KS = [1, 5, 10, 20, 25, 30];
const CAP = 50; // production per-retriever candidate cap (#173 §10)

const fmt = (n) => (Math.round(n * 1000) / 1000).toFixed(3);
const d = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(Math.abs(n))}` : ' 0.000');

async function main() {
  const pool = createPool(resolveConnectionString());
  const corpus = await loadCorpus(pool, GID);
  const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset-stocks.json'), 'utf-8'));
  const { queries, qrels } = dataset;
  const qids = Object.keys(queries);

  // Rerank knobs follow the SHIPPED defaults (#198 winner) so this script
  // reproduces the README table out of the box; override via the same env the
  // app reads (RERANK_MODEL / RERANK_DTYPE / RERANK_TOPM / RERANK_MAXCHARS).
  const rerankCfg = {
    backend: 'local-onnx',
    model: process.env.RERANK_MODEL || 'Xenova/ms-marco-TinyBERT-L-2-v2',
    dtype: process.env.RERANK_DTYPE || 'q8',
    topM: Number(process.env.RERANK_TOPM || 20),
    maxChars: Number(process.env.RERANK_MAXCHARS || 512),
  };

  // Load each model ONCE; inject into every variant so we don't reload weights.
  const embeddingProvider = createEmbeddingProvider({ backend: 'local-onnx', model: 'Xenova/bge-small-en-v1.5', dim: 384 }, {});
  const rerankProvider = createRerankProvider(rerankCfg, {});
  const deps = { pool, embeddingProvider, rerankProvider };

  const base = {
    retrievers: ['lexical', 'dense'],
    fusion: { mode: 'rrf', k: 60 },
    topK: 100,
    providers: {
      // queryPrefix rides the same env the app reads (#224 A/B: run once with
      // EMBEDDING_QUERY_PREFIX unset, once with the bge instruction).
      embedding: {
        backend: 'local-onnx', model: 'Xenova/bge-small-en-v1.5', dim: 384,
        ...(process.env.EMBEDDING_QUERY_PREFIX ? { queryPrefix: process.env.EMBEDDING_QUERY_PREFIX } : {}),
      },
      rerank: rerankCfg,
    },
    graphExpand: { hops: 1, maxAddedPerSeed: 5, maxAdded: 50 },
  };

  const variants = [
    ['hybrid (baseline)', []],
    ['+graphExpand', ['graphExpand']],
    ['+rerank', ['rerank']],
    ['+both (expand→rerank)', ['graphExpand', 'rerank']],
  ];

  const results = {};
  for (const [label, postprocessors] of variants) {
    const pipeline = assemblePipeline({ ...base, postprocessors }, deps);
    const per = [];
    const lat = [];
    for (const qid of qids) {
      const t0 = performance.now();
      const { candidates } = await pipeline.run(queries[qid], {
        gid: GID, corpus, corpusFromStore: true, lexicalTopK: CAP, denseTopK: CAP,
      });
      lat.push(performance.now() - t0);
      per.push(scoreQuery(candidates.map((c) => String(c.taskId)), qrels[qid] || {}, KS));
    }
    // lat[0] on the first rerank variant includes the one-time model load —
    // that's the real "first search after boot" cost, so report it.
    results[label] = { mean: meanScores(per), p50: percentile(lat, 50), p95: percentile(lat, 95), first: lat[0] };
    process.stderr.write(`  ✓ ${label}\n`);
  }

  // Table: every metric, every variant, Δ vs the hybrid baseline.
  const metrics = ['recall@5', 'recall@10', 'recall@20', 'recall@25', 'recall@30', 'ndcg@10', 'precision@1', 'mrr'];
  const labels = variants.map((v) => v[0]);
  const baseM = results[labels[0]].mean;
  console.log(`\nHybrid-at-${CAP} A/B — stock graph ${GID} · ${qids.length} queries · lexical(top-${CAP})+dense(top-${CAP})→RRF`);
  console.log(`rerank: ${rerankCfg.model} ${rerankCfg.dtype} topM=${rerankCfg.topM} maxChars=${rerankCfg.maxChars}\n`);
  console.log(`  ${'metric'.padEnd(12)} ${labels.map((l) => l.padStart(22)).join('')}`);
  for (const m of metrics) {
    const cells = labels.map((l, i) => {
      const v = results[l].mean[m];
      return (i === 0 ? fmt(v) : `${fmt(v)} (${d(v - baseM[m])})`).padStart(22);
    });
    console.log(`  ${m.padEnd(12)} ${cells.join('')}`);
  }
  console.log(`  ${'latency p50'.padEnd(12)} ${labels.map((l) => `${Math.round(results[l].p50)}ms`.padStart(22)).join('')}`);
  console.log(`  ${'latency p95'.padEnd(12)} ${labels.map((l) => `${Math.round(results[l].p95)}ms`.padStart(22)).join('')}`);
  console.log(`  ${'first query'.padEnd(12)} ${labels.map((l) => `${Math.round(results[l].first)}ms`.padStart(22)).join('')}\n`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
