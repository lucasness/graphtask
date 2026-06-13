import { describe, it, expect } from 'vitest';
import { createQueryRewriter } from '../src/search/queryRewrite.js';
import { SearchService } from '../src/search/service.js';
import { validateConfig, configFromEnv } from '../src/search/config.js';

// A fake fetch returning a scripted Anthropic Messages response.
function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responder(url, init);
    if (r.throw) throw r.throw;
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json };
  };
  fn.calls = calls;
  return fn;
}

describe('createQueryRewriter — backend selection', () => {
  it('returns null for backend "none" (default = no rewrite)', () => {
    expect(createQueryRewriter({ backend: 'none' })).toBeNull();
    expect(createQueryRewriter({})).toBeNull();
  });

  it('throws on an unknown backend', () => {
    expect(() => createQueryRewriter({ backend: 'banana' })).toThrow(/unknown query-rewrite backend/);
  });
});

describe('fixture rewriter', () => {
  it('rewrites mapped queries and passes unmapped ones through unchanged', async () => {
    const rw = createQueryRewriter({ backend: 'fixture', map: { 'powered up': 'energy utilities grid' } });
    expect(await rw.rewrite('powered up')).toBe('energy utilities grid');
    expect(await rw.rewrite('  powered up  ')).toBe('energy utilities grid'); // trims
    expect(await rw.rewrite('something else')).toBe('something else');
  });
});

describe('llm rewriter', () => {
  it('sends an Anthropic request and returns the text block', async () => {
    const fetchImpl = fakeFetch(() => ({ json: { content: [{ type: 'text', text: 'data center energy companies' }] } }));
    const rw = createQueryRewriter({ backend: 'llm', token: 'sk-test' }, { fetchImpl });
    expect(await rw.rewrite('who keeps the servers powered up')).toBe('data center energy companies');
    expect(fetchImpl.calls[0].url).toContain('api.anthropic.com');
    expect(fetchImpl.calls[0].init.headers['x-api-key']).toBe('sk-test');
    expect(fetchImpl.calls[0].body.messages[0].content).toBe('who keeps the servers powered up');
  });

  it('falls back to the raw query when no API key is configured (safe no-op)', async () => {
    const fetchImpl = fakeFetch(() => ({ json: {} }));
    const rw = createQueryRewriter({ backend: 'llm', token: '' }, { fetchImpl });
    expect(await rw.rewrite('a query')).toBe('a query');
    expect(fetchImpl.calls).toHaveLength(0); // never hit the network without a key
  });

  it('falls back to the raw query on an API error', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 500, json: {} }));
    const rw = createQueryRewriter({ backend: 'llm', token: 'sk-test', retries: 0 }, { fetchImpl });
    expect(await rw.rewrite('a query')).toBe('a query');
  });

  it('falls back to the raw query on an empty/garbage response', async () => {
    const fetchImpl = fakeFetch(() => ({ json: { content: [] } }));
    const rw = createQueryRewriter({ backend: 'llm', token: 'sk-test' }, { fetchImpl });
    expect(await rw.rewrite('a query')).toBe('a query');
  });
});

describe('config wiring', () => {
  it('defaults queryRewrite.backend to none', () => {
    expect(validateConfig({}).config.queryRewrite.backend).toBe('none');
  });

  it('rejects an unknown queryRewrite backend', () => {
    expect(validateConfig({ queryRewrite: { backend: 'nope' } }).errors.join()).toMatch(/queryRewrite.backend/);
  });

  it('maps QUERY_REWRITE / QUERY_REWRITE_MODEL from env', () => {
    const c = configFromEnv({ QUERY_REWRITE: 'llm', QUERY_REWRITE_MODEL: 'claude-haiku-4-5' });
    expect(c.queryRewrite).toEqual({ backend: 'llm', model: 'claude-haiku-4-5' });
  });
});

describe('SearchService applies the rewriter before retrieval', () => {
  const CORPUS = [
    { id: 1, title: 'solar power utilities', description: 'grid energy', body: 'electricity suppliers' },
    { id: 2, title: 'server hardware', description: 'racks and chassis', body: 'compute' },
  ];

  it('retrieves against the rewritten query, not the raw one', async () => {
    // Raw query "powered up" matches nothing lexically; the fixture rewrite to
    // "utilities energy" matches node 1. Proves retrieval used the rewrite.
    const config = { retrievers: ['lexical'], lexical: { ranker: 'bm25' }, queryRewrite: { backend: 'fixture' }, topK: 10 };
    const deps = { queryRewriter: createQueryRewriter({ backend: 'fixture', map: { 'powered up': 'utilities energy' } }) };
    const svc = new SearchService({ config, deps });

    const rewritten = await svc.search('powered up', { corpus: CORPUS });
    expect(rewritten.candidates.map((c) => c.taskId)).toContain(1);

    const raw = await svc.search('powered up', { corpus: CORPUS });
    // sanity: with no rewriter the same query finds nothing
    const plain = new SearchService({ config: { ...config, queryRewrite: { backend: 'none' } } });
    const plainRes = await plain.search('powered up', { corpus: CORPUS });
    expect(plainRes.candidates).toHaveLength(0);
    expect(raw.candidates.length).toBeGreaterThan(0);
  });
});
