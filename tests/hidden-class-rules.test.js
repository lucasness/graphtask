// Guards on the one stylesheet both pages share. Both rules below have the same
// shape of failure: style.css is written for the SPA, node.html reuses it, and
// an SPA-wide assumption silently breaks the standalone page with no error
// anywhere — so neither is catchable by reading the diff.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(`../public/${p}`, import.meta.url)), 'utf8');

// `.hidden` is an inert marker class here — style.css declares it empty and each
// component supplies its own `display: none`. An element shipped with
// class="hidden" and no matching rule is therefore just visible on first paint.
// That bit #reader-empty: "No report yet" stayed pinned under every real report.
describe.each(['index.html', 'node.html'])('%s — elements that start hidden', (page) => {
  it('every class="hidden" element is actually hidden by style.css', () => {
    const html = read(page);
    const css = read('style.css');
    const unhidden = [];
    for (const tag of html.match(/<[a-z][^>]*>/gi) || []) {
      const classes = tag.match(/\bclass="([^"]*)"/)?.[1];
      if (!classes || !/\bhidden\b/.test(classes)) continue;
      const id = tag.match(/\bid="([^"]+)"/)?.[1];
      const selectors = classes.split(/\s+/).filter((c) => c && c !== 'hidden').map((c) => `.${c}.hidden`);
      if (id) selectors.push(`#${id}.hidden`);
      if (!selectors.some((s) => css.includes(s))) unhidden.push(id ? `#${id}` : classes);
    }
    expect(unhidden).toEqual([]);
  });
});

// The SPA pins everything to the viewport (#sidebar, #cy, #kanban, and #reader,
// which scrolls its own inner column), so `body { overflow: hidden }` is right
// for it. node.html is ordinary document flow and must scroll the DOCUMENT — and
// because `html` declares no overflow, body's value is what propagates to the
// viewport, so it inherits that lock and a node taller than one screen becomes
// unreadable. Nothing errors; the page just stops scrolling.
describe('node.html can scroll the document', () => {
  it('opts out of the SPA-wide viewport lock', () => {
    const css = read('style.css');
    const lock = /(^|\})\s*body\s*\{[^}]*overflow:\s*hidden/m.test(css);
    const optOut = /body\.view-node\s*\{[^}]*overflow:\s*(visible|auto|scroll)/.test(css);
    // If the lock is ever dropped the opt-out is harmless — but while it exists,
    // node.html must override it.
    expect(lock && !optOut).toBe(false);
  });
});
