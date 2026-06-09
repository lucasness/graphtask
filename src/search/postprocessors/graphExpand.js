// GraphExpander postprocessor — Phase 3, the RECALL lever (#197 / #173 §11,
// LlamaIndex PrevNext-style expansion §11). Runs AFTER fusion: it takes the
// fused top hits as SEEDS and traverses our `edges` table (k-hop BFS) to pull
// in edge-connected nodes that text retrieval missed entirely.
//
// Why this and not rerank: the reranker only REORDERS candidates already in the
// pool — it cannot fix a RETRIEVAL miss (the relevant node never got retrieved;
// see #196). Graph expansion can: when a missed node is edge-connected to one we
// DID find, traversal surfaces it. Free (SQL over `edges`), fast (no model/GPU),
// and it attacks exactly the recall@k gap our list-navigation flows need (#172).
//
// Precision guard: expanded nodes are APPENDED after the fused list, never
// interleaved above it, so a loosely-related neighbor can never bury a strong
// lexical/dense hit. Per-seed and total fan-out caps keep the tail from flooding
// the list. Both knobs are config.
//
// Edge source is dual, mirroring the dense retriever's store/in-memory split:
//   • route   — query the `edges` table via deps.pool, scoped WHERE graph_id =
//               ctx.gid (single-graph search; the scope is the access control —
//               we never read another graph's edges).
//   • eval/test — ctx.edges supplies the adjacency in-memory (no DB), so the
//               same expander runs against the frozen fixture and the live graph.
// With neither available it returns the list unchanged (graceful, like every
// stage — the pipeline still wraps postprocess() so a throw degrades too).

import { makeCandidate } from '../types.js';

const DEFAULT_HOPS = 1;            // 1-hop neighbours by default; the cheap, high-precision layer
const DEFAULT_MAX_PER_SEED = 5;    // cap each seed's fan-out so a hub node can't flood the list
const DEFAULT_MAX_ADDED = 50;      // overall cap on appended nodes

/**
 * @param {{
 *   pool?: Object,            // pg pool for the route path (edges via SQL)
 *   hops?: number,            // BFS depth from each seed (default 1)
 *   maxAddedPerSeed?: number, // per-seed fan-out cap (default 5)
 *   maxAdded?: number,        // total appended-node cap (default 50)
 *   edgeTypes?: string[]|null // restrict to these edge types; null = all (dependency + related)
 * }} opts
 * @returns {import('../types.js').Postprocessor}
 */
export function createGraphExpander({
  pool,
  hops = DEFAULT_HOPS,
  maxAddedPerSeed = DEFAULT_MAX_PER_SEED,
  maxAdded = DEFAULT_MAX_ADDED,
  edgeTypes = null,
} = {}) {
  // Pull this graph's edge rows. Scoped to the graph either way — the SQL leg by
  // WHERE graph_id, the in-memory leg because the caller only ever hands us the
  // one graph's edges. Returns null when no edge source exists (→ no-op).
  async function resolveEdges(ctx) {
    if (Array.isArray(ctx.edges)) return ctx.edges;
    if (pool && ctx.gid) {
      const { rows } = await pool.query(
        'SELECT source_id, target_id, type FROM edges WHERE graph_id = $1',
        [ctx.gid],
      );
      return rows;
    }
    return null;
  }

  return {
    name: 'graphExpand',
    async postprocess(query, candidates, ctx = {}) {
      if (!Array.isArray(candidates) || candidates.length === 0) return candidates;
      if (!(hops >= 1) || !(maxAdded >= 1) || !(maxAddedPerSeed >= 1)) return candidates;

      const edges = await resolveEdges(ctx);
      if (!Array.isArray(edges) || edges.length === 0) return candidates;

      // Build an undirected adjacency map keyed by String(id). `orig` keeps the
      // original id value (number in PG / fixtures) so appended candidates carry
      // the same taskId type the rest of the pipeline uses.
      const adj = new Map();
      const orig = new Map();
      const link = (a, b) => {
        if (!adj.has(a)) adj.set(a, new Set());
        adj.get(a).add(b);
      };
      for (const e of edges) {
        const sv = e.source ?? e.source_id;
        const tv = e.target ?? e.target_id;
        if (sv == null || tv == null) continue;
        if (edgeTypes && e.type != null && !edgeTypes.includes(e.type)) continue;
        const s = String(sv);
        const t = String(tv);
        orig.set(s, sv);
        orig.set(t, tv);
        link(s, t);
        link(t, s);
      }
      if (adj.size === 0) return candidates;

      const seedIds = candidates.map((c) => String(c.taskId));
      const present = new Set(seedIds); // never re-add a node already in the list
      const addedSet = new Set();
      const added = [];

      // BFS seed-by-seed in fused-rank order: the strongest seeds contribute
      // their neighbours first, so when the total cap bites it drops the
      // weakest seeds' neighbours, not the best ones'.
      for (const seed of seedIds) {
        if (added.length >= maxAdded) break;
        let perSeed = 0;
        const visited = new Set([seed]); // traversal-visited (≠ output-added): we
        let frontier = [seed];           // walk THROUGH present nodes for multi-hop
        for (let hop = 1; hop <= hops && perSeed < maxAddedPerSeed && added.length < maxAdded; hop++) {
          const next = [];
          for (const node of frontier) {
            for (const nb of adj.get(node) || []) {
              if (visited.has(nb)) continue;
              visited.add(nb);
              next.push(nb);
              if (present.has(nb) || addedSet.has(nb)) continue; // dedup output only
              addedSet.add(nb);
              added.push({ id: orig.get(nb) ?? nb, hop, via: orig.get(seed) ?? seed });
              perSeed++;
              if (perSeed >= maxAddedPerSeed || added.length >= maxAdded) break;
            }
            if (perSeed >= maxAddedPerSeed || added.length >= maxAdded) break;
          }
          frontier = next;
        }
      }

      if (added.length === 0) return candidates;

      // Score the appended nodes strictly below the fused tail and descending by
      // insertion order, so any consumer that sorts by score keeps them under
      // the real hits. Order is by array position regardless (the pipeline just
      // slices), so this is belt-and-suspenders for precision.
      const floor = Math.min(0, ...candidates.map((c) => Number(c.score) || 0));
      const expanded = added.map((a, i) =>
        makeCandidate(a.id, floor - 0.001 * (i + 1), 'graph', {
          meta: { expandHop: a.hop, via: a.via },
        }),
      );

      return [...candidates, ...expanded];
    },
  };
}

export default { createGraphExpander };
