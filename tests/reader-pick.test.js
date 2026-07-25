// Reader ?view=reader share-param helpers (public/reader-pick.js). The reader
// is an alternate VIEW of the active graph — it always renders the active
// graph's own report (no cross-graph fallback; renderReader bounces to the
// canvas when there is none). These helpers are the shareable-view plumbing:
// a link carries the sender's view, since reader mode itself is per-browser
// localStorage a receiver doesn't have.
import { describe, it, expect } from 'vitest';
import { readerRequestedInSearch, withReaderParam } from '../public/reader-pick.js';

describe('readerRequestedInSearch', () => {
  it('detects view=reader among other params, exact match only', () => {
    expect(readerRequestedInSearch('?view=reader')).toBe(true);
    expect(readerRequestedInSearch('?node=5&view=reader')).toBe(true);
    expect(readerRequestedInSearch('?view=Reader')).toBe(false);
    expect(readerRequestedInSearch('?view=graph')).toBe(false);
    expect(readerRequestedInSearch('')).toBe(false);
    expect(readerRequestedInSearch(null)).toBe(false);
  });
});

describe('withReaderParam', () => {
  it('adds and removes view=reader while preserving other params', () => {
    expect(withReaderParam('', true)).toBe('?view=reader');
    expect(withReaderParam('?node=5', true)).toBe('?node=5&view=reader');
    expect(withReaderParam('?view=reader&node=5', false)).toBe('?node=5');
    expect(withReaderParam('?view=reader', false)).toBe('');
    expect(withReaderParam('', false)).toBe('');
  });

  it('is idempotent — re-adding does not duplicate the param', () => {
    expect(withReaderParam('?view=reader', true)).toBe('?view=reader');
  });
});
