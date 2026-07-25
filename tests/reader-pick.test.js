// Reader report-selection order (the shared-link fix). Pins the contract of
// public/reader-pick.js: the active graph's own report is ALWAYS tried first —
// a /g/<id> URL names that graph, so a remembered last-read report from
// another graph must never shadow it. The last-read memory is only the
// fallback for graphs with no report of their own, and the chain ends on the
// active graph again so a dead remembered pointer still lands on the active
// graph's capability-aware empty-state CTA.
import { describe, it, expect } from 'vitest';
import { readerFallbackChain, readerRequestedInSearch, withReaderParam } from '../public/reader-pick.js';

describe('readerFallbackChain', () => {
  it('active graph first, remembered report as fallback, active CTA last', () => {
    expect(readerFallbackChain('active', 'last')).toEqual(['active', 'last', 'active']);
  });

  it('no remembered report → active only', () => {
    expect(readerFallbackChain('active', null)).toEqual(['active']);
    expect(readerFallbackChain('active', undefined)).toEqual(['active']);
  });

  it('remembered report IS the active graph → no duplicate fallback', () => {
    expect(readerFallbackChain('same', 'same')).toEqual(['same']);
  });

  it('no active graph → still falls back to the remembered report', () => {
    expect(readerFallbackChain(null, 'last')).toEqual([null, 'last', null]);
  });
});

// The ?view=reader share param: a shared link carries the sender's view, since
// reader mode itself is per-browser localStorage a receiver doesn't have.
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
