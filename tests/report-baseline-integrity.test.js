// E16.12 — staleness BASELINE integrity guard.
//
// Staleness (E16.6) means "the report is older than the latest graph change,"
// with graphs.updated_at as the baseline. The load-bearing invariant: a report
// write must NEVER bump graphs.updated_at. If it did, a freshly generated report
// would read as instantly stale (the graph would look newer than the report it
// just produced) and the ask-to-update gate would misfire. E16.1 gave `reports`
// its OWN trigger (notify_report_change) that only pg_notify's kind:'report' and
// never UPDATEs graphs — this file is the dedicated contract test for that
// isolation. It overlaps the E16.6 probe tests on purpose but focuses on:
//   - report writes (INSERT + UPDATE) leave graphs.updated_at/version untouched;
//   - the report notify is isolated (exactly one kind:report frame, ZERO
//     tasks/edges frames) over the real LISTEN/NOTIFY path in src/sse.js;
//   - the staleness baseline holds for the TASK path AND the EDGE path (E16.6
//     only exercised tasks) AND a graph rename (any graph write counts);
//   - a report re-write does NOT clear staleness.
//
// Setup mirrors tests/reports-api.test.js (header-auth adapter, getTestPool) and
// tests/report-sse.test.js (subscribe + fakeRes.write over the DB NOTIFY pipe).
import request from 'supertest';
import { getTestPool, TEST_URL } from './setup.js';
import { _setAdapterForTests } from '../src/auth/index.js';
import { makeHeaderAuthAdapter } from './__support__/test_auth.js';
import { subscribe, unsubscribe } from '../src/sse.js';

let app;
let pool;

const url = (gid) => `/api/graphs/${gid}/report`;
const metaUrl = (gid) => `/api/graphs/${gid}/report/meta`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A legacy owner-less graph (URL-bearer): both read + edit allowed with no user,
// so a report PUT needs no auth header — keeps the baseline assertions focused
// on the trigger behavior rather than the auth chain.
async function makeLegacyGraph(name = 'baseline') {
  return (await pool.query('INSERT INTO graphs (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
}

// Insert a task directly — fires bump_graph_updated_at() (the shared trigger on
// tasks/edges), which is what MUST move graphs.updated_at for the report to go
// stale. Returns the new task id (needed to wire an edge).
async function insertTask(gid, title) {
  return (await pool.query(
    `INSERT INTO tasks (graph_id, content, meta) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [gid, `---\ntitle: ${title}\nstatus: todo\n---\n`, JSON.stringify({ title, status: 'todo' })],
  )).rows[0].id;
}

async function insertEdge(gid, sourceId, targetId) {
  return (await pool.query(
    `INSERT INTO edges (graph_id, source_id, target_id, type, purpose)
     VALUES ($1, $2, $3, 'related', 'related to') RETURNING id`,
    [gid, sourceId, targetId],
  )).rows[0].id;
}

async function graphRow(gid) {
  return (await pool.query('SELECT updated_at, version FROM graphs WHERE id = $1', [gid])).rows[0];
}

// Parse captured SSE frames ('data: <json>\n\n') into payload objects.
function parseFrames(frames) {
  return frames
    .map((f) => f.match(/^data: (.+)\n\n$/))
    .filter(Boolean)
    .map((m) => JSON.parse(m[1]));
}

// NOTIFY crosses DB connections asynchronously — poll rather than assume the
// frame lands the instant the PUT resolves.
async function waitFor(pred, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(25);
  }
  return !!pred();
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_URL;
  delete process.env.AUTH_PROVIDER;
  // Importing app.js runs startSse(), which opens the single LISTEN connection
  // against the test DB — the connection our report NOTIFY must reach. That
  // LISTEN connects asynchronously; a NOTIFY fired before it is established would
  // be lost. Warm up on a sentinel graph_id until a frame round-trips, proving
  // the pipe is live before the isolation test writes. (Copied from
  // tests/report-sse.test.js.)
  app = (await import('../src/app.js')).default;
  pool = getTestPool();
  _setAdapterForTests(makeHeaderAuthAdapter());

  const warmId = 'baseline-warmup';
  const warmFrames = [];
  const warmRes = { write: (c) => warmFrames.push(String(c)) };
  subscribe(warmId, warmRes);
  const start = Date.now();
  while (warmFrames.length === 0 && Date.now() - start < 4000) {
    await pool.query(
      "SELECT pg_notify('graph_change', json_build_object('graph_id', $1::text, 'kind', 'warmup')::text)",
      [warmId],
    );
    await sleep(50);
  }
  unsubscribe(warmId, warmRes);
});

describe('report write leaves the staleness baseline (graphs.updated_at) untouched', () => {
  it('a report PUT (INSERT then UPDATE) does not move graphs.updated_at or graphs.version', async () => {
    const gid = await makeLegacyGraph();
    const before = await graphRow(gid);

    // INSERT (first PUT) — the notify_report_change trigger fires but must not
    // touch graphs.
    expect((await request(app).put(url(gid)).send({ title: 'R1', body: 'x' })).status).toBe(200);
    // UPDATE (second PUT) — the ON CONFLICT DO UPDATE branch, same isolation.
    await sleep(5);
    expect((await request(app).put(url(gid)).send({ title: 'R2', body: 'y' })).status).toBe(200);

    const after = await graphRow(gid);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    expect(after.version).toBe(before.version);
  });

  it('the report notify is isolated: exactly one kind:report frame, ZERO tasks/edges frames', async () => {
    const gid = await makeLegacyGraph();
    const frames = [];
    const fakeRes = { write: (chunk) => frames.push(String(chunk)) };
    subscribe(gid, fakeRes);

    // URL-bearer PUT on a legacy graph: no writer identity, so the only frame
    // this can produce is the report notify from notify_report_change().
    const put = await request(app).put(url(gid)).send({ title: 'Live', body: '# hi' });
    expect(put.status).toBe(200);

    const arrived = await waitFor(
      () => parseFrames(frames).some((e) => e.graph_id === gid && e.kind === 'report'),
    );
    unsubscribe(gid, fakeRes);

    const events = parseFrames(frames).filter((e) => e.graph_id === gid);
    expect(arrived).toBe(true);
    // Exactly one frame, tagged the singular 'report' (NOT 'reports'), whose id
    // is the graph_id — a report's identity IS its graph.
    const reportFrames = events.filter((e) => e.kind === 'report');
    expect(reportFrames).toHaveLength(1);
    expect(reportFrames[0].id).toBe(gid);
    // The report write must never masquerade as a graph edit.
    expect(events.filter((e) => e.kind === 'tasks')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'edges')).toHaveLength(0);
  });
});

describe('staleness baselines off graphs.updated_at (GET /report/meta)', () => {
  it('a report generated after the last change is NOT stale; a later TASK write flips it stale', async () => {
    const gid = await makeLegacyGraph();
    await sleep(5);
    await request(app).put(url(gid)).send({ title: 'R', body: 'x' });
    // No graph change since generation → fresh.
    expect((await request(app).get(metaUrl(gid))).body.stale).toBe(false);

    // A task INSERT bumps graphs.updated_at via bump_graph_updated_at().
    await sleep(5);
    await insertTask(gid, 'A');
    expect((await request(app).get(metaUrl(gid))).body.stale).toBe(true);
  });

  it('an EDGE write ALSO flips a fresh report stale (E16.6 only covered the task path)', async () => {
    const gid = await makeLegacyGraph();
    // Wire the nodes BEFORE generating the report so the edge below is the only
    // graph change after generation — the report must be fresh when created.
    const a = await insertTask(gid, 'A');
    const b = await insertTask(gid, 'B');
    await sleep(5);
    await request(app).put(url(gid)).send({ title: 'R', body: 'x' });
    expect((await request(app).get(metaUrl(gid))).body.stale).toBe(false);

    // An edge INSERT fires the same shared trigger → graphs.updated_at moves.
    await sleep(5);
    await insertEdge(gid, a, b);
    expect((await request(app).get(metaUrl(gid))).body.stale).toBe(true);
  });

  it('a graph RENAME also flips a fresh report stale — any graph write counts', async () => {
    const gid = await makeLegacyGraph('before');
    await sleep(5);
    await request(app).put(url(gid)).send({ title: 'R', body: 'x' });
    expect((await request(app).get(metaUrl(gid))).body.stale).toBe(false);

    // The staleness baseline is graphs.updated_at, so ANY write that bumps it —
    // task writes, edge writes, AND a plain rename/settings change — counts as a
    // graph change. This is intended: the reader banner asks to refresh after any
    // graph edit, not only structural task/edge edits. The PATCH /graphs route's
    // rename path does `SET name = ..., updated_at = NOW()`; we exercise that same
    // bump directly to keep the assertion off the OCC/manage-permission plumbing.
    await sleep(5);
    await pool.query('UPDATE graphs SET name = $1, updated_at = NOW() WHERE id = $2', ['after', gid]);
    expect((await request(app).get(metaUrl(gid))).body.stale).toBe(true);
  });

  it('a report re-write does NOT clear staleness (generated_at + graphs.updated_at both preserved)', async () => {
    const gid = await makeLegacyGraph();
    await sleep(5);
    const first = (await request(app).put(url(gid)).send({ title: 'R', body: 'x' })).body;

    // Make the graph newer than the report, then snapshot the baseline.
    await sleep(5);
    await insertTask(gid, 'A');
    expect((await request(app).get(metaUrl(gid))).body.stale).toBe(true);
    const baseline = await graphRow(gid);

    // Re-PUT the report: generated_at is preserved (set only on INSERT) and the
    // report trigger never touches graphs — so a re-write is NOT a regeneration
    // and staleness must persist.
    await sleep(5);
    const second = (await request(app).put(url(gid)).send({ title: 'R2', body: 'y' })).body;
    expect(second.generated_at).toBe(first.generated_at);

    const afterRewrite = await graphRow(gid);
    expect(afterRewrite.updated_at.getTime()).toBe(baseline.updated_at.getTime());
    expect(afterRewrite.version).toBe(baseline.version);
    expect((await request(app).get(metaUrl(gid))).body.stale).toBe(true);
  });
});

describe('GET /report/meta exposes the staleness baseline', () => {
  it('returns graph_updated_at equal to the graph current updated_at', async () => {
    const gid = await makeLegacyGraph();
    await sleep(5);
    await request(app).put(url(gid)).send({ title: 'R', body: 'x' });

    const g = await graphRow(gid);
    const res = await request(app).get(metaUrl(gid));
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
    // Both the report timestamps AND the graph last-change timestamp are present,
    // so a client can compute "report older than graph" without guessing.
    expect(res.body).toHaveProperty('generated_at');
    expect(res.body).toHaveProperty('graph_updated_at');
    expect(new Date(res.body.graph_updated_at).getTime()).toBe(g.updated_at.getTime());
  });

  it('graph_updated_at tracks the latest graph change (advances after a task write)', async () => {
    const gid = await makeLegacyGraph();
    await sleep(5);
    await request(app).put(url(gid)).send({ title: 'R', body: 'x' });
    const t0 = new Date((await request(app).get(metaUrl(gid))).body.graph_updated_at).getTime();

    await sleep(5);
    await insertTask(gid, 'A');
    const meta = (await request(app).get(metaUrl(gid))).body;
    const t1 = new Date(meta.graph_updated_at).getTime();
    expect(t1).toBeGreaterThan(t0);
    // graph_updated_at now newer than the report → stale, consistent with the flag.
    expect(new Date(meta.generated_at).getTime()).toBeLessThan(t1);
    expect(meta.stale).toBe(true);
  });
});
