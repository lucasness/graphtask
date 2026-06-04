import request from 'supertest';
import { getTestPool, TEST_URL } from './setup.js';

let app;
let pool;
let gid;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_URL;
  const mod = await import('../src/app.js');
  app = mod.default;
  pool = getTestPool();
});

beforeEach(async () => {
  const r = await pool.query("INSERT INTO graphs (name) VALUES ('search-test') RETURNING id");
  gid = r.rows[0].id;
});

function md(title, opts = {}) {
  const lines = [`title: ${title}`];
  if (opts.description) lines.push(`description: ${opts.description}`);
  lines.push(`status: ${opts.status || 'todo'}`);
  return `---\n${lines.join('\n')}\n---\n${opts.body || ''}`;
}

const searchUrl = () => `/api/graphs/${gid}/search`;
const tasksUrl = () => `/api/graphs/${gid}/tasks`;

async function seed() {
  await request(app).post(tasksUrl()).send({ content: md('auth tokens', { description: 'x', body: 'y' }) });
  await request(app).post(tasksUrl()).send({ content: md('rate limiting', { description: 'session token bucket', body: 'z' }) });
  await request(app).post(tasksUrl()).send({ content: md('kanban', { description: 'columns', body: 'a token appears here once' }) });
}

describe('POST /api/graphs/:gid/search', () => {
  it('ranks live PG nodes by the tiered lexical contract (title > desc > body)', async () => {
    await seed();
    const res = await request(app).post(searchUrl()).send({ query: 'token' });
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('token');
    const titles = res.body.results.map((r) => r.meta.field);
    expect(titles).toEqual(['title', 'description', 'body']);
    // every result carries a snippet + the timings envelope is present
    expect(res.body.results[0]).toHaveProperty('snippet');
    expect(res.body.timings).toHaveProperty('total');
    expect(res.body.timings.retrievers).toHaveProperty('lexical');
  });

  it('returns 400 on a missing/empty query', async () => {
    expect((await request(app).post(searchUrl()).send({})).status).toBe(400);
    expect((await request(app).post(searchUrl()).send({ query: '   ' })).status).toBe(400);
  });

  it('returns 400 on an invalid config override', async () => {
    const res = await request(app).post(searchUrl()).send({ query: 'token', config: { topK: 0 } });
    expect(res.status).toBe(400);
    expect(res.body.errors.join()).toMatch(/topK/);
  });

  it('honors a valid config override (topK)', async () => {
    await seed();
    const res = await request(app).post(searchUrl()).send({ query: 'token', config: { topK: 1 } });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });

  it('returns an empty result set (never errors) when nothing matches', async () => {
    await seed();
    const res = await request(app).post(searchUrl()).send({ query: 'zzzznomatch' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('404s for an unknown graph id', async () => {
    const res = await request(app).post('/api/graphs/doesnotexist/search').send({ query: 'token' });
    expect(res.status).toBe(404);
  });
});
