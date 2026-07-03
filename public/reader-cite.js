// Reader citation parser (E16 citations). Pure, DOM-free ES module — same
// single-home contract as public/reader-toc.js: the browser loads it via a
// <script type="module"> shim that hangs the exports on window.ReaderCite, and
// vitest imports it directly. The generator emits [[cite:<id>]] markers in the
// report markdown; app.js turns them into small numbered footnote superscripts
// (hover → node title/description, click → open the node in the graph), and the
// numbering is assigned HERE, in first-appearance order, so it re-derives fresh
// on every render (a report re-generated with different citations re-numbers).

// [[cite:123]] or [[cite:123, 456]] — one or more numeric node ids. Kept as a
// source string so app.js can build its own stateful RegExp for DOM splitting
// (one source of truth for the marker format).
export const CITE_MARKER_SOURCE = '\\[\\[cite:\\s*([0-9]+(?:\\s*,\\s*[0-9]+)*)\\s*\\]\\]';
export const CITE_MARKER = new RegExp(CITE_MARKER_SOURCE, 'g');

// Cited node ids in first-appearance order, de-duplicated. The array index + 1
// is the citation number a node gets, so this defines the numbering.
export function extractCiteIds(markdown) {
  const ids = [];
  const seen = new Set();
  const re = new RegExp(CITE_MARKER_SOURCE, 'g');
  let m;
  while ((m = re.exec(String(markdown || '')))) {
    for (const raw of m[1].split(',')) {
      const id = raw.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

// id → citation number (1-based, first-appearance order). The map app.js uses to
// stamp both the inline superscripts and the References list, keeping them in sync.
export function numberMap(markdown) {
  const ids = extractCiteIds(markdown);
  return new Map(ids.map((id, i) => [id, i + 1]));
}
