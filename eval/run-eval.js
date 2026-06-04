#!/usr/bin/env node
// Eval harness runner for the KB search engine (graph tasks #171/#173).
//
// Runs the current retrieval tier over a frozen labeled query set and reports
// BOTH accuracy (Recall@K / nDCG@K / MRR / MAP, pytrec_eval semantics) AND
// latency (per-query p50/p95) — the dual gate from #173 §8. Phase 1 wires the
// Tier-0 lexical ranker (public/search-lexical.js); later phases point
// `runTier` at the hybrid + graph backend behind the same harness so each
// swap is A/B'd against the same numbers.
//
// Usage:
//   node eval/run-eval.js                 # offline fixture corpus (default)
//   node eval/run-eval.js --gid <id>      # score against a live graph's nodes
//   node eval/run-eval.js --k 5,10,20     # custom cutoffs
//   GRAPHTASK_BASE_URL=... GRAPHTASK_AGENT_TOKEN=... node eval/run-eval.js --gid <id>
//
// --gid only swaps the CORPUS (live node bodies); queries + qrels still come
// from eval/dataset.json, so author qrels against real node ids before using it.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lexicalSearch } from '../public/search-lexical.js';
import { scoreQuery, meanScores, percentile } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { ks: [5, 10], gid: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--gid') args.gid = argv[++i];
    else if (argv[i] === '--k') args.ks = argv[++i].split(',').map((n) => parseInt(n, 10)).filter(Boolean);
  }
  return args;
}

async function loadLiveCorpus(gid) {
  const base = process.env.GRAPHTASK_BASE_URL || 'http://127.0.0.1:3000';
  const headers = process.env.GRAPHTASK_AGENT_TOKEN
    ? { Authorization: `Bearer ${process.env.GRAPHTASK_AGENT_TOKEN}` }
    : {};
  const res = await fetch(`${base}/api/graphs/${gid}/tasks`, { headers });
  if (!res.ok) throw new Error(`failed to load live graph ${gid}: ${res.status}`);
  const rows = await res.json();
  // Minimal frontmatter split (mirrors public/app.js parseFrontmatter).
  const FENCE = '---';
  return rows.map((row) => {
    const text = row.content || '';
    let meta = {}, body = text;
    if (text.startsWith(FENCE + '\n')) {
      const end = text.indexOf('\n' + FENCE, FENCE.length);
      if (end !== -1) {
        for (const line of text.slice(FENCE.length + 1, end).split('\n')) {
          const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
          if (m) meta[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
        }
        body = text.slice(end + FENCE.length + 2);
      }
    }
    return { id: row.id, title: meta.title || '', description: meta.description || '', body, createdAt: row.created_at };
  });
}

// The retrieval tier under test. Swap this body in later phases (hybrid + graph).
function runTier(query, corpus) {
  return lexicalSearch(query, corpus, { limit: 100 }).map((r) => r.id);
}

function fmt(n) { return (Math.round(n * 1000) / 1000).toFixed(3); }

async function main() {
  const args = parseArgs(process.argv);
  const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset.json'), 'utf-8'));
  const corpus = args.gid ? await loadLiveCorpus(args.gid) : dataset.corpus;
  const { queries, qrels } = dataset;
  const qids = Object.keys(queries);

  console.log(`\nKB search eval — tier: lexical (Tier-0)`);
  console.log(`corpus: ${args.gid ? `live graph ${args.gid}` : 'fixture'} (${corpus.length} docs) · queries: ${qids.length} · cutoffs: ${args.ks.join(',')}\n`);

  const perQuery = [];
  const latencies = [];
  for (const qid of qids) {
    const qrel = qrels[qid] || {};
    const t0 = performance.now();
    const ranked = runTier(queries[qid], corpus);
    latencies.push(performance.now() - t0);
    const scores = scoreQuery(ranked.map(String), qrel, args.ks);
    perQuery.push(scores);
    const top = ranked.slice(0, Math.max(...args.ks)).join(',');
    console.log(`  ${qid.padEnd(4)} "${queries[qid]}"`);
    console.log(`       ndcg@${args.ks[0]}=${fmt(scores[`ndcg@${args.ks[0]}`])} recall@${args.ks[0]}=${fmt(scores[`recall@${args.ks[0]}`])} mrr=${fmt(scores.mrr)} · top: [${top}]`);
  }

  const mean = meanScores(perQuery);
  console.log('\n  ── mean ──');
  for (const key of Object.keys(mean)) console.log(`     ${key.padEnd(12)} ${fmt(mean[key])}`);
  console.log('\n  ── latency (ms) ──');
  console.log(`     p50 ${fmt(percentile(latencies, 50))}  p95 ${fmt(percentile(latencies, 95))}  max ${fmt(Math.max(...latencies))}`);
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
