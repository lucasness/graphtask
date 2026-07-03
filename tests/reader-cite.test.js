// E16 citations — the pure citation parser. The DOM transform (superscripts,
// hover tooltip, References list, click-through) is verified in the running app
// (no jsdom harness); this covers the shared, DOM-free logic: which ids get
// cited, in what order, and the numbering.
import { extractCiteIds, numberMap } from '../public/reader-cite.js';

describe('extractCiteIds (E16 citations)', () => {
  it('extracts cited ids in first-appearance order, de-duplicated', () => {
    const md = 'A[[cite:3171]] B[[cite:3200]] C[[cite:3171]] D[[cite:3164]]';
    expect(extractCiteIds(md)).toEqual(['3171', '3200', '3164']);
  });

  it('handles multi-id markers like [[cite:10, 20]]', () => {
    expect(extractCiteIds('x[[cite:10, 20]] y[[cite:20,30]]')).toEqual(['10', '20', '30']);
  });

  it('ignores non-numeric or malformed markers', () => {
    expect(extractCiteIds('[[cite:abc]] [[cite:]] [[cite: 42 ]]')).toEqual(['42']);
  });

  it('returns [] for empty / marker-less / bad input', () => {
    expect(extractCiteIds('no citations here')).toEqual([]);
    expect(extractCiteIds('')).toEqual([]);
    expect(extractCiteIds(null)).toEqual([]);
  });
});

describe('numberMap (E16 citations)', () => {
  it('assigns 1-based numbers in first-appearance order; reused ids keep their number', () => {
    const m = numberMap('a[[cite:9]] b[[cite:5]] c[[cite:9]] d[[cite:7]]');
    expect(m.get('9')).toBe(1);
    expect(m.get('5')).toBe(2);
    expect(m.get('7')).toBe(3);
    expect(m.size).toBe(3);
  });
});
