// E16.17 — the reader Contents rail's pure extractor. The DOM wiring (sticky
// nav + IntersectionObserver scroll-spy) is verified in the running app (the
// suite has no jsdom harness); this covers the shared, DOM-free logic: which
// headings become entries, fenced-code skipping, and duplicate-slug dedupe.
import { extractToc, slugify } from '../public/reader-toc.js';

describe('extractToc (E16.17)', () => {
  it('extracts h2–h4 only, excluding the h1 title and h5/h6', () => {
    const md = '# Title\n## A\n### B\n#### C\n##### D\n###### E\n';
    expect(extractToc(md).map((i) => [i.level, i.text])).toEqual([
      [2, 'A'], [3, 'B'], [4, 'C'],
    ]);
  });

  it('skips headings inside fenced code blocks (``` and ~~~)', () => {
    const md = '## Real\n```\n## Fake in code\n```\n~~~\n## Also fake\n~~~\n## Real2\n';
    expect(extractToc(md).map((i) => i.text)).toEqual(['Real', 'Real2']);
  });

  it('dedupes repeated heading slugs deterministically', () => {
    const md = '## Intro\n## Intro\n## Intro\n';
    expect(extractToc(md).map((i) => i.id)).toEqual(['intro', 'intro-1', 'intro-2']);
  });

  it('strips inline markdown marks from both the text and the id', () => {
    const [it] = extractToc('## **Bold** and `code`\n');
    expect(it.text).toBe('Bold and code');
    expect(it.id).toBe('bold-and-code');
  });

  it('ignores non-ATX lines and requires a space after the hashes', () => {
    expect(extractToc('##NoSpace\ntext ## not a heading\n')).toEqual([]);
  });

  it('returns [] for empty or heading-less input', () => {
    expect(extractToc('')).toEqual([]);
    expect(extractToc('just a paragraph\nand another line')).toEqual([]);
    expect(extractToc(null)).toEqual([]);
  });
});

describe('slugify (E16.17)', () => {
  it('lowercases, hyphenates, and strips punctuation', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('  Spaced   Out  ')).toBe('spaced-out');
  });
  it('falls back to "section" when nothing survives', () => {
    expect(slugify('!!!')).toBe('section');
    expect(slugify('')).toBe('section');
  });
});
