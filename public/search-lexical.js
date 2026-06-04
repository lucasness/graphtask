// Tier-0 lexical search — the model-free floor of the KB search engine
// (graph tasks #171 "retrieval recipe → lexical leg" and #172 "this graph"
// search). Pure, DOM-free, dependency-free ES module so it has ONE home:
//   - the browser loads it via a <script type="module"> shim that hangs the
//     exports on window.LexicalSearch (see public/index.html / app.js);
//   - Node imports it directly from vitest tests and the eval harness
//     (eval/run-eval.js), so the thing we ship is the exact thing we measure.
//
// Ranking contract (README "Find / search bar" + task #172):
//   substring match over title / description / body, TIERED BY FIELD
//   (title hits rank above description hits, which rank above body hits);
//   within a tier order by match frequency desc; newest-first tie-break.
//   A node ranks by its STRONGEST field only — one row per node.
//
// This is also the matcher the backend's BM25 stage later formalizes; keeping
// it pure means the eval harness can A/B it against every richer tier.

/** Field priority — earlier = stronger tier. A node is placed in the tier of
 *  its strongest matching field. */
export const FIELD_ORDER = ['title', 'description', 'body'];

/** Split a raw query into lowercased terms. Whitespace-separated; a doc must
 *  contain EVERY term (AND) in a single field for that field to match, which
 *  makes single-word queries behave like a plain substring find and
 *  multi-word queries behave like "all of these words appear here". */
export function tokenize(query) {
  return String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Count non-overlapping occurrences of `term` in already-lowercased `hay`. */
function countOccurrences(hay, term) {
  if (!term) return 0;
  let count = 0;
  let i = hay.indexOf(term);
  while (i !== -1) {
    count++;
    i = hay.indexOf(term, i + term.length);
  }
  return count;
}

/** Match `terms` against one field's text.
 *  Returns { matched, freq, firstIndex } where freq is the total occurrence
 *  count across all terms and firstIndex is the earliest match offset (for
 *  snippet anchoring). Requires every term to be present (AND semantics). */
export function fieldMatch(text, terms) {
  const hay = String(text || '').toLowerCase();
  if (!hay || terms.length === 0) return { matched: false, freq: 0, firstIndex: -1 };
  let freq = 0;
  let firstIndex = Infinity;
  for (const term of terms) {
    const c = countOccurrences(hay, term);
    if (c === 0) return { matched: false, freq: 0, firstIndex: -1 };
    freq += c;
    const idx = hay.indexOf(term);
    if (idx < firstIndex) firstIndex = idx;
  }
  return { matched: true, freq, firstIndex: firstIndex === Infinity ? -1 : firstIndex };
}

/** Compute [start,end) match ranges for the given terms within `text`
 *  (case-insensitive, against the original-cased string so the UI can render
 *  <mark> over the real text). Ranges are sorted and merged. Pure. */
export function matchRanges(text, terms) {
  const src = String(text || '');
  const hay = src.toLowerCase();
  const ranges = [];
  for (const term of terms) {
    if (!term) continue;
    let i = hay.indexOf(term);
    while (i !== -1) {
      ranges.push([i, i + term.length]);
      i = hay.indexOf(term, i + term.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Build a short, centered-on-first-match snippet with highlight ranges
 *  re-based into the snippet's coordinate space. Pure; the UI turns ranges
 *  into <mark> spans. */
export function buildSnippet(text, terms, max = 140) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return { text: '', ranges: [] };
  const ranges = matchRanges(src, terms);
  const first = ranges.length ? ranges[0][0] : 0;
  // Window the snippet around the first hit, leaving a little lead-in.
  let start = Math.max(0, first - 24);
  // Snap start to a word boundary so we don't slice mid-word.
  if (start > 0) {
    const sp = src.indexOf(' ', start);
    if (sp !== -1 && sp - start < 16) start = sp + 1;
  }
  let end = Math.min(src.length, start + max);
  let snippet = src.slice(start, end);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < src.length ? '…' : '';
  const offset = prefix.length - start;
  const rebased = ranges
    .map(([s, e]) => [s + offset, e + offset])
    .filter(([s, e]) => e > prefix.length && s < snippet.length + prefix.length)
    .map(([s, e]) => [Math.max(prefix.length, s), Math.min(snippet.length + prefix.length, e)]);
  return { text: prefix + snippet + suffix, ranges: rebased };
}

/** Newest-first comparator: prefer a later createdAt, else a higher id. */
function newerFirst(a, b) {
  const ta = a.createdAt != null ? new Date(a.createdAt).getTime() : NaN;
  const tb = b.createdAt != null ? new Date(b.createdAt).getTime() : NaN;
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
  return Number(b.id) - Number(a.id);
}

/**
 * Rank `docs` against `query` with the tiered lexical contract above.
 * @param {string} query
 * @param {Array<{id:(number|string), title?:string, description?:string, body?:string, createdAt?:(string|number)}>} docs
 * @param {{limit?:number, snippetMax?:number}} [opts]
 * @returns {Array<{id, doc, field, freq, tier, snippet:{text,ranges}}>}
 */
export function lexicalSearch(query, docs, opts = {}) {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const limit = opts.limit ?? Infinity;
  const snippetMax = opts.snippetMax ?? 140;

  const hits = [];
  for (const doc of docs || []) {
    let best = null;
    for (let tier = 0; tier < FIELD_ORDER.length; tier++) {
      const field = FIELD_ORDER[tier];
      const m = fieldMatch(doc[field], terms);
      if (m.matched) {
        // First (strongest) matching field wins — title beats description beats body.
        best = { field, tier, freq: m.freq };
        break;
      }
    }
    if (!best) continue;
    const snippetField = best.field === 'title' ? (doc.description || doc.body || doc.title)
      : doc[best.field];
    hits.push({
      id: doc.id,
      doc,
      field: best.field,
      tier: best.tier,
      freq: best.freq,
      snippet: buildSnippet(snippetField, terms, snippetMax),
    });
  }

  hits.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;       // tier: title > desc > body
    if (a.freq !== b.freq) return b.freq - a.freq;        // frequency desc
    return newerFirst(a.doc, b.doc);                      // newest-first tie-break
  });

  return Number.isFinite(limit) ? hits.slice(0, limit) : hits;
}

export default { lexicalSearch, fieldMatch, matchRanges, buildSnippet, tokenize, FIELD_ORDER };
