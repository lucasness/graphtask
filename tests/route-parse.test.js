// Route resolution (the /graph/<id> silent-misdirection fix). Pins the
// contract of public/route-parse.js: alias shapes resolve to the same graph
// with a canonical path the caller replaceStates into the bar, and unknown
// paths are told apart from root so the boot fallback can't leave a bogus
// path displayed over an unrelated graph.
import { describe, it, expect } from 'vitest';
import { resolveRoute, resolveNodeRoute, nodeHref } from '../public/route-parse.js';

describe('resolveRoute', () => {
  it('canonical /g/<id> resolves, canonical path round-trips', () => {
    expect(resolveRoute('/g/abc123')).toEqual({ kind: 'graph', gid: 'abc123', canonical: '/g/abc123' });
    expect(resolveRoute('/g/abc123/')).toEqual({ kind: 'graph', gid: 'abc123', canonical: '/g/abc123' });
  });

  it('alias shapes /graph/<id> and /graphs/<id> resolve to the same canonical', () => {
    expect(resolveRoute('/graph/j4kw7xvzvaxqugcu')).toEqual({
      kind: 'graph', gid: 'j4kw7xvzvaxqugcu', canonical: '/g/j4kw7xvzvaxqugcu',
    });
    expect(resolveRoute('/graphs/abc123')).toEqual({ kind: 'graph', gid: 'abc123', canonical: '/g/abc123' });
  });

  it('root is root, not unknown', () => {
    expect(resolveRoute('/')).toEqual({ kind: 'root' });
    expect(resolveRoute('')).toEqual({ kind: 'root' });
  });

  it('everything else is unknown — never quietly treated as a graph or root', () => {
    expect(resolveRoute('/gr/abc')).toEqual({ kind: 'unknown' });
    expect(resolveRoute('/g/')).toEqual({ kind: 'unknown' });
    expect(resolveRoute('/g/ABC')).toEqual({ kind: 'unknown' }); // ids are [a-z0-9]
    expect(resolveRoute('/g/abc/extra')).toEqual({ kind: 'unknown' });
    expect(resolveRoute('/reports')).toEqual({ kind: 'unknown' });
  });
});

describe('resolveNodeRoute (single-node permalink)', () => {
  it('resolves /g/<gid>/n/<id>, with or without a trailing slash', () => {
    expect(resolveNodeRoute('/g/abc123/n/3171'))
      .toEqual({ gid: 'abc123', id: '3171', canonical: '/g/abc123/n/3171' });
    expect(resolveNodeRoute('/g/abc123/n/3171/'))
      .toEqual({ gid: 'abc123', id: '3171', canonical: '/g/abc123/n/3171' });
  });

  it('returns null for anything else, so a bad path can never render a node page', () => {
    expect(resolveNodeRoute('/g/abc123')).toBeNull();       // plain graph route
    expect(resolveNodeRoute('/g/abc123/n/')).toBeNull();
    expect(resolveNodeRoute('/g/abc123/n/abc')).toBeNull(); // ids are numeric
    expect(resolveNodeRoute('/g/ABC/n/1')).toBeNull();      // gids are [a-z0-9]
    expect(resolveNodeRoute('/graph/abc123/n/1')).toBeNull(); // canonical /g only
    expect(resolveNodeRoute('/g/abc/n/1/extra')).toBeNull();
    expect(resolveNodeRoute('')).toBeNull();
  });

  it('the two resolvers never both claim a path', () => {
    for (const p of ['/g/abc123', '/g/abc123/n/7', '/graph/abc123', '/', '/nope']) {
      const asGraph = resolveRoute(p).kind === 'graph';
      const asNode = resolveNodeRoute(p) !== null;
      expect(asGraph && asNode).toBe(false);
    }
  });
});

describe('nodeHref', () => {
  it('builds the permalink and carries `from` so the back-link survives node→node hops', () => {
    expect(nodeHref('abc123', 3171)).toBe('/g/abc123/n/3171');
    expect(nodeHref('abc123', 3171, 'report')).toBe('/g/abc123/n/3171?from=report');
  });

  it('encodes its inputs', () => {
    expect(nodeHref('a b', '1', 'a&b')).toBe('/g/a%20b/n/1?from=a%26b');
  });
});
