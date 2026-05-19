import request from 'supertest';
import { getTestPool, TEST_URL } from './setup.js';
import { _setAdapterForTests } from '../src/auth/index.js';
import { makeHeaderAuthAdapter } from './__support__/test_auth.js';

let app;
let pool;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_URL;
  delete process.env.AUTH_PROVIDER;
  app = (await import('../src/app.js')).default;
  pool = getTestPool();
  _setAdapterForTests(makeHeaderAuthAdapter());
});

async function makeUser(p, suffix) {
  const r = await p.query(
    `INSERT INTO users (provider, provider_user_id, email, display_name)
     VALUES ('test-header', $1, $2, $1) RETURNING *`,
    [suffix, `${suffix}@test.local`],
  );
  return r.rows[0];
}

async function makeGraph(p, ownerId, name = 'g') {
  const r = await p.query(
    `INSERT INTO graphs (name, owner_user_id, anon_role) VALUES ($1, $2, 'viewer') RETURNING *`,
    [name, ownerId],
  );
  return r.rows[0];
}

describe('Follow-prefs API (authed)', () => {
  let user, graph;

  beforeEach(async () => {
    user = await makeUser(pool, `prefs-${Math.random().toString(36).slice(2, 8)}`);
    graph = await makeGraph(pool, user.id, 'pref-graph');
  });

  it('GET /api/me/prefs returns default true when no row exists', async () => {
    const r = await request(app)
      .get('/api/me/prefs')
      .set('X-Test-User-Id', user.provider_user_id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ agent_follow_default: true });
  });

  it('PUT /api/me/prefs upserts the default', async () => {
    const put = await request(app)
      .put('/api/me/prefs')
      .set('X-Test-User-Id', user.provider_user_id)
      .send({ agent_follow_default: false });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ agent_follow_default: false });
    const get = await request(app)
      .get('/api/me/prefs')
      .set('X-Test-User-Id', user.provider_user_id);
    expect(get.body).toEqual({ agent_follow_default: false });
  });

  it('PUT /api/me/prefs rejects non-boolean body', async () => {
    const r = await request(app)
      .put('/api/me/prefs')
      .set('X-Test-User-Id', user.provider_user_id)
      .send({ agent_follow_default: 'yes' });
    expect(r.status).toBe(400);
  });

  it('GET /api/graphs/:gid/prefs/me returns null when no row exists', async () => {
    const r = await request(app)
      .get(`/api/graphs/${graph.id}/prefs/me`)
      .set('X-Test-User-Id', user.provider_user_id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ agent_follow: null });
  });

  it('PUT per-graph also writes through to the user default in one tx', async () => {
    // Confirm starting state: both endpoints empty/default.
    const def0 = await request(app)
      .get('/api/me/prefs')
      .set('X-Test-User-Id', user.provider_user_id);
    expect(def0.body.agent_follow_default).toBe(true);
    const per0 = await request(app)
      .get(`/api/graphs/${graph.id}/prefs/me`)
      .set('X-Test-User-Id', user.provider_user_id);
    expect(per0.body.agent_follow).toBeNull();

    // Toggle this graph to false.
    const put = await request(app)
      .put(`/api/graphs/${graph.id}/prefs/me`)
      .set('X-Test-User-Id', user.provider_user_id)
      .send({ agent_follow: false });
    expect(put.status).toBe(200);

    // Per-graph row should now be false, AND the user's default should
    // also flip to false (write-through).
    const per1 = await request(app)
      .get(`/api/graphs/${graph.id}/prefs/me`)
      .set('X-Test-User-Id', user.provider_user_id);
    expect(per1.body.agent_follow).toBe(false);
    const def1 = await request(app)
      .get('/api/me/prefs')
      .set('X-Test-User-Id', user.provider_user_id);
    expect(def1.body.agent_follow_default).toBe(false);
  });

  it('toggling graph A does not change per-graph row on graph B', async () => {
    const graphB = await makeGraph(pool, user.id, 'pref-graph-b');
    // Set graph A explicitly to false.
    await request(app)
      .put(`/api/graphs/${graph.id}/prefs/me`)
      .set('X-Test-User-Id', user.provider_user_id)
      .send({ agent_follow: false });
    // Graph B has not been toggled — its per-graph row should still be null.
    const r = await request(app)
      .get(`/api/graphs/${graphB.id}/prefs/me`)
      .set('X-Test-User-Id', user.provider_user_id);
    expect(r.body.agent_follow).toBeNull();
  });
});
