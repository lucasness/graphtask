// Route resolution (the /graph/<id> silent-misdirection fix). Pins the
// contract of public/route-parse.js: alias shapes resolve to the same graph
// with a canonical path the caller replaceStates into the bar, and unknown
// paths are told apart from root so the boot fallback can't leave a bogus
// path displayed over an unrelated graph.
import { describe, it, expect } from 'vitest';
import { resolveRoute } from '../public/route-parse.js';

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
