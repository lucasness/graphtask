import { describe, it, expect } from 'vitest';
import {
  lexicalSearch, fieldMatch, matchRanges, buildSnippet, tokenize,
} from '../public/search-lexical.js';

describe('tokenize', () => {
  it('lowercases and splits on whitespace, dropping empties', () => {
    expect(tokenize('  Cookie  Storage ')).toEqual(['cookie', 'storage']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('fieldMatch', () => {
  it('counts occurrences and requires every term (AND)', () => {
    expect(fieldMatch('cookie cookie jar', ['cookie'])).toMatchObject({ matched: true, freq: 2 });
    expect(fieldMatch('cookie jar', ['cookie', 'jar'])).toMatchObject({ matched: true, freq: 2 });
    expect(fieldMatch('cookie jar', ['cookie', 'missing'])).toMatchObject({ matched: false, freq: 0 });
  });
  it('reports the earliest match index', () => {
    expect(fieldMatch('aaa term bbb term', ['term']).firstIndex).toBe(4);
  });
});

describe('lexicalSearch ranking contract', () => {
  const docs = [
    { id: 1, title: 'auth tokens', description: 'x', body: 'y', createdAt: '2026-01-01' },
    { id: 2, title: 'rate limiting', description: 'session token bucket', body: 'z', createdAt: '2026-01-02' },
    { id: 3, title: 'kanban', description: 'columns', body: 'a token appears here once', createdAt: '2026-01-03' },
  ];

  it('tiers by strongest field: title > description > body', () => {
    const r = lexicalSearch('token', docs);
    expect(r.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(r.map((x) => x.field)).toEqual(['title', 'description', 'body']);
  });

  it('a node ranks by its strongest field only (one row per node)', () => {
    const r = lexicalSearch('token', docs);
    expect(r.length).toBe(3);
    expect(new Set(r.map((x) => x.id)).size).toBe(3);
  });

  it('within a tier, orders by match frequency desc', () => {
    const sameTier = [
      { id: 10, title: 'token', description: '', body: '', createdAt: '2026-01-01' },
      { id: 11, title: 'token token token', description: '', body: '', createdAt: '2026-01-01' },
      { id: 12, title: 'token token', description: '', body: '', createdAt: '2026-01-01' },
    ];
    expect(lexicalSearch('token', sameTier).map((x) => x.id)).toEqual([11, 12, 10]);
  });

  it('breaks freq ties newest-first (createdAt, then id)', () => {
    const tied = [
      { id: 20, title: 'token', description: '', body: '', createdAt: '2026-01-01' },
      { id: 21, title: 'token', description: '', body: '', createdAt: '2026-03-01' },
      { id: 22, title: 'token', description: '', body: '', createdAt: '2026-02-01' },
    ];
    expect(lexicalSearch('token', tied).map((x) => x.id)).toEqual([21, 22, 20]);
  });

  it('falls back to id desc when createdAt is absent/equal', () => {
    const tied = [
      { id: 5, title: 'token' }, { id: 7, title: 'token' }, { id: 6, title: 'token' },
    ];
    expect(lexicalSearch('token', tied).map((x) => x.id)).toEqual([7, 6, 5]);
  });

  it('multi-term requires all terms in the same field', () => {
    const d = [
      { id: 1, title: 'cookie storage', description: '', body: '' },   // both in title
      { id: 2, title: 'cookie', description: 'storage', body: '' },     // split across fields → no field has both
    ];
    const r = lexicalSearch('cookie storage', d);
    expect(r.map((x) => x.id)).toEqual([1]);
  });

  it('returns [] for empty query and respects limit', () => {
    expect(lexicalSearch('', docs)).toEqual([]);
    expect(lexicalSearch('token', docs, { limit: 1 }).length).toBe(1);
  });
});

describe('matchRanges / buildSnippet', () => {
  it('finds and merges overlapping ranges', () => {
    expect(matchRanges('aXaXa', ['x'])).toEqual([[1, 2], [3, 4]]);
    // overlapping terms merge into one range
    expect(matchRanges('aaaa', ['aa'])).toEqual([[0, 4]]);
  });
  it('builds a snippet windowed around the first hit with rebased ranges', () => {
    const long = 'lorem '.repeat(20) + 'TARGET tail';
    const s = buildSnippet(long, ['target'], 60);
    expect(s.text).toContain('TARGET');
    expect(s.text.startsWith('…')).toBe(true);
    // every reported range should actually cover the matched text
    for (const [a, b] of s.ranges) {
      expect(s.text.slice(a, b).toLowerCase()).toBe('target');
    }
  });
});
