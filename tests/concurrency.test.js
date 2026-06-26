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
  const r = await pool.query("INSERT INTO graphs (name) VALUES ('t') RETURNING id");
  gid = r.rows[0].id;
});

const tasksUrl = () => `/api/graphs/${gid}/tasks`;
const edgesUrl = () => `/api/graphs/${gid}/edges`;
const graphUrl = () => `/api/graphs/${gid}`;

function md({ title = 'A', status = 'todo', body = '' } = {}) {
  return `---\ntitle: ${title}\nstatus: ${status}\n---\n${body}`;
}

async function makeTask(content) {
  const res = await request(app).post(tasksUrl()).send({ content });
  expect(res.status).toBe(201);
  return res.body;
}

describe('OCC: tasks three-way merge', () => {
  it('regression: full-document PATCHes on different fields no longer clobber each other', async () => {
    const task = await makeTask(md({ title: 'Buy milk', status: 'todo' }));
    const baseVersion = task.version;
    const baseContent = task.content;

    // Human edits title (with OCC base).
    const humanRes = await request(app)
      .patch(`${tasksUrl()}/${task.id}`)
      .set('X-Writer-Type', 'human')
      .send({
        content: md({ title: 'Buy oat milk', status: 'todo' }),
        base_version: baseVersion,
        base_content: baseContent,
      });
    expect(humanRes.status).toBe(200);
    expect(humanRes.body.meta.title).toBe('Buy oat milk');
    expect(humanRes.body.meta.status).toBe('todo');

    // Agent edits status with the SAME stale base — exactly the lost-update
    // scenario from the plan. Server should three-way merge.
    const agentRes = await request(app)
      .patch(`${tasksUrl()}/${task.id}`)
      .set('X-Writer-Type', 'agent')
      .send({
        content: md({ title: 'Buy milk', status: 'done' }),
        base_version: baseVersion,
        base_content: baseContent,
      });
    expect(agentRes.status).toBe(200);
    // Both edits visible: human's title + agent's status.
    expect(agentRes.body.meta.title).toBe('Buy oat milk');
    expect(agentRes.body.meta.status).toBe('done');
  });

  it('Scenario B: human wins same-field collision regardless of order — agent first', async () => {
    const task = await makeTask(md({ status: 'todo' }));
    const base = { version: task.version, content: task.content };

    // Agent applies status=done first.
    const agentFirst = await request(app)
      .patch(`${tasksUrl()}/${task.id}`)
      .set('X-Writer-Type', 'agent')
      .send({
        content: md({ status: 'done' }),
        base_version: base.version,
        base_content: base.content,
      });
    expect(agentFirst.status).toBe(200);
    expect(agentFirst.body.meta.status).toBe('done');
    expect(agentFirst.body.last_modified_by).toBe('agent');

    // Human PATCH arrives second with the same stale base — same field
    // collision, human should win.
    const humanSecond = await request(app)
      .patch(`${tasksUrl()}/${task.id}`)
      .set('X-Writer-Type', 'human')
      .send({
        content: md({ status: 'in_progress' }),
        base_version: base.version,
        base_content: base.content,
      });
    expect(humanSecond.status).toBe(200);
    expect(humanSecond.body.meta.status).toBe('in_progress');
    expect(humanSecond.body.last_modified_by).toBe('human');
  });

  it('Scenario B: human wins same-field collision regardless of order — human first', async () => {
    const task = await makeTask(md({ status: 'todo' }));
    const base = { version: task.version, content: task.content };

    // Human applies status=in_progress first.
    const humanFirst = await request(app)
      .patch(`${tasksUrl()}/${task.id}`)
      .set('X-Writer-Type', 'human')
      .send({
        content: md({ status: 'in_progress' }),
        base_version: base.version,
        base_content: base.content,
      });
    expect(humanFirst.status).toBe(200);
    expect(humanFirst.body.meta.status).toBe('in_progress');

    // Agent PATCH arrives second with stale base trying to set status=done.
    // Human's value should be preserved.
    const agentSecond = await request(app)
      .patch(`${tasksUrl()}/${task.id}`)
      .set('X-Writer-Type', 'agent')
      .send({
        content: md({ status: 'done' }),
        base_version: base.version,
        base_content: base.content,
      });
    expect(agentSecond.status).toBe(200);
    expect(agentSecond.body.meta.status).toBe('in_progress');
  });

  it('two human writers on same field: last-write-wins per field', async () => {
    const task = await makeTask(md({ title: 'A' }));
    const base = { version: task.version, content: task.content };

    await request(app)
      .patch(`${tasksUrl()}/${task.id}`)
      .set('X-Writer-Type', 'human')
      .send({
        content: md({ title: 'A from tab 1' }),
        base_version: base.version,
        base_content: base.content,
      });

    const tab2 = await request(app)
      .patch(`${tasksUrl()}/${task.id}`)
      .set('X-Writer-Type', 'human')
      .send({
        content: md({ title: 'A from tab 2' }),
        base_version: base.version,
        base_content: base.content,
      });
    expect(tab2.status).toBe(200);
    expect(tab2.body.meta.title).toBe('A from tab 2');
  });

  it('version increments and last_modified_by reflects the writer', async () => {
    const task = await makeTask(md({ title: 'A' }));
    expect(task.version).toBe(0);
    expect(task.last_modified_by).toBe('human'); // POST default header

    const r1 = await request(app)
      .patch(`${tasksUrl()}/${task.id}`)
      .set('X-Writer-Type', 'agent')
      .send({ content: md({ title: 'B' }) });
    expect(r1.body.version).toBe(1);
    expect(r1.body.last_modified_by).toBe('agent');

    const r2 = await request(app)
      .patch(`${tasksUrl()}/${task.id}`)
      .set('X-Writer-Type', 'human')
      .send({ content: md({ title: 'C' }) });
    expect(r2.body.version).toBe(2);
    expect(r2.body.last_modified_by).toBe('human');
  });

  it('writer-type defaults to human when header missing or unrecognized', async () => {
    const task = await makeTask(md({ title: 'A' }));
    const noHeader = await request(app)
      .patch(`${tasksUrl()}/${task.id}`)
      .send({ content: md({ title: 'B' }) });
    expect(noHeader.body.last_modified_by).toBe('human');

    const garbage = await request(app)
      .patch(`${tasksUrl()}/${task.id}`)
      .set('X-Writer-Type', 'banana')
      .send({ content: md({ title: 'C' }) });
    expect(garbage.body.last_modified_by).toBe('human');
  });
});

describe('OCC: 410 Gone on missing rows', () => {
  it('PATCH on a deleted task returns 410', async () => {
    const task = await makeTask(md({ title: 'X' }));
    await request(app).delete(`${tasksUrl()}/${task.id}`);
    const res = await request(app)
      .patch(`${tasksUrl()}/${task.id}`)
      .send({ content: md({ title: 'Y' }) });
    expect(res.status).toBe(410);
  });

  it('delete-vs-edit: delete wins, subsequent stale edit gets 410', async () => {
    const task = await makeTask(md({ title: 'X' }));
    const base = { version: task.version, content: task.content };

    // DELETE arrives first.
    await request(app).delete(`${tasksUrl()}/${task.id}`);

    // Stale PATCH from the slower writer hits the missing-row branch.
    const patch = await request(app)
      .patch(`${tasksUrl()}/${task.id}`)
      .set('X-Writer-Type', 'human')
      .send({
        content: md({ title: 'Y' }),
        base_version: base.version,
        base_content: base.content,
      });
    expect(patch.status).toBe(410);
  });
});

describe('OCC: edges three-way merge', () => {
  async function makeEdge() {
    const a = await makeTask(md({ title: 'A' }));
    const b = await makeTask(md({ title: 'B' }));
    const e = await request(app).post(edgesUrl()).send({
      source_id: a.id, target_id: b.id, purpose: 'required for',
    });
    return e.body;
  }

  it('disjoint meta fields merge cleanly (one writer touches color, another curve)', async () => {
    const edge = await makeEdge();
    // Both writers read at version 0.
    const baseRow = edge;

    // Writer A sets color.
    const a = await request(app)
      .patch(`${edgesUrl()}/${edge.id}`)
      .send({ base_version: 0, base_row: baseRow, meta: { color: '#ff0000' } });
    expect(a.status).toBe(200);

    // Writer B (still at v0, didn't see A's write) sets curve.
    const b = await request(app)
      .patch(`${edgesUrl()}/${edge.id}`)
      .send({ base_version: 0, base_row: baseRow, meta: { curve: { distance: 30, weight: 0.5 } } });
    expect(b.status).toBe(200);
    expect(b.body.meta.color).toBe('#ff0000'); // A's write preserved
    expect(b.body.meta.curve).toEqual({ distance: 30, weight: 0.5 });
    expect(b.body.version).toBe(2);
  });

  it('same field, human writer beats agent already applied', async () => {
    const edge = await makeEdge();
    const baseRow = edge;

    // Agent sets color first.
    await request(app)
      .patch(`${edgesUrl()}/${edge.id}`)
      .set('X-Writer-Type', 'agent')
      .send({ base_version: 0, base_row: baseRow, meta: { color: '#ff0000' } });

    // Human (still at v0) picks a different color for the same field.
    const h = await request(app)
      .patch(`${edgesUrl()}/${edge.id}`)
      .set('X-Writer-Type', 'human')
      .send({ base_version: 0, base_row: baseRow, meta: { color: '#0000ff' } });
    expect(h.status).toBe(200);
    expect(h.body.meta.color).toBe('#0000ff'); // human wins same-field collision
  });

  it('matching base_version proceeds and bumps version', async () => {
    const edge = await makeEdge();
    expect(edge.version).toBe(0);
    const ok = await request(app)
      .patch(`${edgesUrl()}/${edge.id}`)
      .set('X-Writer-Type', 'human')
      .send({ base_version: 0, base_row: edge, meta: { color: '#ff0000' } });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(1);
    expect(ok.body.last_modified_by).toBe('human');
  });
});

describe('OCC: graphs three-way merge', () => {
  it('disjoint fields merge cleanly (name + description)', async () => {
    const cur = await request(app).get(graphUrl()).expect(200);
    const baseRow = cur.body;
    const baseV = baseRow.version;

    const a = await request(app)
      .patch(graphUrl())
      .send({ base_version: baseV, base_row: baseRow, name: 'renamed-by-A' });
    expect(a.status).toBe(200);

    const b = await request(app)
      .patch(graphUrl())
      .send({ base_version: baseV, base_row: baseRow, description: 'changed-by-B' });
    expect(b.status).toBe(200);
    expect(b.body.name).toBe('renamed-by-A');
    expect(b.body.description).toBe('changed-by-B');
  });

  it('disjoint settings keys merge cleanly (font vs bg_color)', async () => {
    const cur = await request(app).get(graphUrl()).expect(200);
    const baseRow = cur.body;
    const baseV = baseRow.version;

    await request(app)
      .patch(graphUrl())
      .send({ base_version: baseV, base_row: baseRow, settings: { font: 'inter' } });

    const b = await request(app)
      .patch(graphUrl())
      .send({ base_version: baseV, base_row: baseRow, settings: { bg_color: '#abcdef' } });
    expect(b.status).toBe(200);
    expect(b.body.settings.font).toBe('inter');
    expect(b.body.settings.bg_color).toBe('#abcdef');
  });

  it('human writer wins same-field collision against agent', async () => {
    const cur = await request(app).get(graphUrl()).expect(200);
    const baseRow = cur.body;
    const baseV = baseRow.version;

    await request(app)
      .patch(graphUrl())
      .set('X-Writer-Type', 'agent')
      .send({ base_version: baseV, base_row: baseRow, name: 'agent-name' });

    const h = await request(app)
      .patch(graphUrl())
      .set('X-Writer-Type', 'human')
      .send({ base_version: baseV, base_row: baseRow, name: 'human-name' });
    expect(h.status).toBe(200);
    expect(h.body.name).toBe('human-name');
  });

  it('matching base_version proceeds and bumps version', async () => {
    const ok = await request(app)
      .patch(graphUrl())
      .set('X-Writer-Type', 'agent')
      .send({ base_version: 0, name: 'renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(1);
    expect(ok.body.last_modified_by).toBe('agent');
  });
});
