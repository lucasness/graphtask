// Reader table-of-contents extractor (E16.17). Pure, DOM-free ES module — the
// same single-home contract as public/search-lexical.js: the browser loads it
// via a <script type="module"> shim that hangs the exports on window.ReaderToc
// (see index.html), and vitest imports it directly, so the thing we ship is the
// exact thing we test. app.js turns the returned items into the sticky Contents
// nav and assigns the matching ids to the Viewer's rendered h2–h4 in document
// order (both come from the same markdown, so the Nth heading lines up).

// Slugify a heading into a stable, hash-safe id. These ids are assigned to the
// rendered headings by us (not matched against any external scheme), so they
// only need to be deterministic and — after dedupe — collision-free.
export function slugify(text) {
  const base = String(text || '')
    .toLowerCase()
    .replace(/[`*_~]/g, '')     // strip inline markdown marks
    .replace(/[^\w\s-]/g, '')   // drop punctuation
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'section';
}

// Extract h2–h4 headings from markdown in document order, skipping fenced code
// blocks, and assign deduped slug ids (repeat text → id, id-1, id-2 …). Returns
// [{ level, text, id }]. h1 (the report title) and h5/h6 are excluded on
// purpose: h1 is the title, deeper levels would over-nest the rail.
export function extractToc(markdown) {
  const items = [];
  const counts = new Map();
  let inFence = false;
  for (const raw of String(markdown || '').split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // ATX heading: 2–4 '#', a space, the text, an optional closing run of '#'.
    const m = /^(#{2,4})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (!m) continue;
    const level = m[1].length;
    const text = m[2].replace(/[`*_]/g, '').trim();
    if (!text) continue;
    let id = slugify(text);
    if (counts.has(id)) {
      const n = counts.get(id) + 1;
      counts.set(id, n);
      id = `${id}-${n}`;
    } else {
      counts.set(id, 0);
    }
    items.push({ level, text, id });
  }
  return items;
}
