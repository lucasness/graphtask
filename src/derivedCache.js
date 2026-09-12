// E18.1 STEP 5 — process-local memo for graph states reconstructed from the
// event log.
//
// WHY A CACHE IS SOUND AT ALL. `seq` is allocated by `gt_next_seq()` under the
// graphs-row lock, held to commit, so the visible prefix is GAPLESS and
// commit-ordered. That makes "the state of graph G after event seq N" a value
// that can never change: no event can ever be inserted into the middle of an
// already-observed prefix. A pinned (graph, seq) is therefore genuinely
// immutable, which is also why `?asOfSeq=` is the one read on this surface that
// gets a real `Cache-Control: max-age` instead of `no-store`.
//
// WHY THE KEY IS `${graphId}:${seq}` AND NEVER `seq` ALONE. `tests/setup.js`
// runs `TRUNCATE ... RESTART IDENTITY CASCADE` before EVERY test while this
// module's state survives for the whole file. A seq-only key would hand test 2
// the answer it computed for test 1 — the two graphs both start their log at
// seq 1. The graph id is part of the identity of the value, not decoration.
//
// Ships `_resetDerivedCacheForTests()`: the house rule for any process-level
// singleton (src/auth/index.js:39, `_resetAdapterCacheForTests`).

// Small and fixed. Entries are folded states (no bodies — see src/events/fold.js
// on why the state carries `content_sha` and not `content`), so a few hundred
// is kilobytes per graph, not megabytes. Insertion-ordered Map + delete/re-set
// on read gives LRU eviction in a dozen lines and no dependency.
const MAX_ENTRIES = 256;

const cache = new Map();
let hits = 0;
let misses = 0;

export function derivedCacheKey(graphId, seq) {
  return `${graphId}:${seq}`;
}

// Returns the stored value or `undefined`. The value is shared, not copied:
// callers MUST treat it as read-only. Everything that consumes it
// (`foldEvents`, `toGraphPayload`) is pure and returns new objects, so this is
// a contract rather than a hazard.
export function getDerived(graphId, seq) {
  const key = derivedCacheKey(graphId, seq);
  if (!cache.has(key)) {
    misses += 1;
    return undefined;
  }
  const value = cache.get(key);
  // Re-insert to move it to the young end of the Map's insertion order.
  cache.delete(key);
  cache.set(key, value);
  hits += 1;
  return value;
}

export function setDerived(graphId, seq, value) {
  const key = derivedCacheKey(graphId, seq);
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_ENTRIES) {
    // The oldest key is the first one the iterator yields.
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return value;
}

// Drop everything for one graph. Nothing in E18.1 needs it — a (graph, seq)
// entry is immutable — but rotate-id moves a graph's log to a NEW id, and a
// future consumer that caches under the old id will want this.
export function dropDerivedForGraph(graphId) {
  const prefix = `${graphId}:`;
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

export function _resetDerivedCacheForTests() {
  cache.clear();
  hits = 0;
  misses = 0;
}

export function _derivedCacheStats() {
  return { size: cache.size, hits, misses };
}
