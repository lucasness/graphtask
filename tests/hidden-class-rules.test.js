// `.hidden` is an inert marker class in this codebase — style.css declares it
// empty and each component supplies its own `display: none` override. An element
// shipped with class="hidden" but no matching rule is therefore visible on first
// paint, silently and with no error. That bit #reader-empty: the "No report yet"
// placeholder stayed pinned under every rendered report.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(`../public/${p}`, import.meta.url)), 'utf8');

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
