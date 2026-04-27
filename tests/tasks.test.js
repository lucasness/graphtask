import request from 'supertest';
import { getTestPool, TEST_URL } from './setup.js';

let app;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_URL;
  const mod = await import('../src/app.js');
  app = mod.default;
});

function md(title, opts = {}) {
  const lines = [`title: ${title}`];
  if (opts.description) lines.push(`description: ${opts.description}`);
  lines.push(`status: ${opts.status || 'todo'}`);
  for (const [k, v] of Object.entries(opts)) {
    if (!['description', 'status', 'body'].includes(k)) lines.push(`${k}: ${v}`);
  }
  const body = opts.body || '';
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

describe('Task CRUD', () => {
  describe('POST /api/tasks', () => {
    it('should create a task with title only', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ content: md('My task') });
      expect(res.status).toBe(201);
      expect(res.body.meta.title).toBe('My task');
      expect(res.body.meta.status).toBe('todo');
      expect(res.body.id).toBeDefined();
    });

    it('should create a task with all fields', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ content: md('Full', { description: 'desc', status: 'in_progress' }) });
      expect(res.status).toBe(201);
      expect(res.body.meta.title).toBe('Full');
      expect(res.body.meta.description).toBe('desc');
      expect(res.body.meta.status).toBe('in_progress');
    });

    it('should preserve custom fields in meta', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ content: md('Custom', { priority: 'high', assignee: 'alice' }) });
      expect(res.status).toBe(201);
      expect(res.body.meta.priority).toBe('high');
      expect(res.body.meta.assignee).toBe('alice');
    });

    it('should preserve markdown body', async () => {
      const content = md('With body', { body: '\n## Notes\n\nSome details here\n' });
      const res = await request(app)
        .post('/api/tasks')
        .send({ content });
      expect(res.status).toBe(201);
      expect(res.body.content).toContain('## Notes');
      expect(res.body.content).toContain('Some details here');
    });

    it('should reject a task without content', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({});
      expect(res.status).toBe(400);
    });

    it('should reject a task without title', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ content: '---\nstatus: todo\n---\n' });
      expect(res.status).toBe(400);
    });

    it('should reject a task with invalid status', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ content: md('Bad', { status: 'invalid' }) });
      expect(res.status).toBe(400);
    });

    it('should reject a task with title > 50 chars', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ content: md('x'.repeat(51)) });
      expect(res.status).toBe(400);
    });

    it('should reject a task with description > 150 chars', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ content: md('Bad', { description: 'x'.repeat(151) }) });
      expect(res.status).toBe(400);
    });

    it('should default status to todo', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ content: '---\ntitle: Minimal\n---\n' });
      expect(res.status).toBe(201);
      expect(res.body.meta.status).toBe('todo');
    });
  });

  describe('GET /api/tasks', () => {
    it('should return empty array when no tasks', async () => {
      const res = await request(app).get('/api/tasks');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('should return all tasks', async () => {
      const pool = getTestPool();
      for (const t of ['A', 'B', 'C']) {
        await pool.query(
          `INSERT INTO tasks (content, meta) VALUES ($1, $2)`,
          [md(t), JSON.stringify({ title: t, status: 'todo' })]
        );
      }
      const res = await request(app).get('/api/tasks');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
    });
  });

  describe('GET /api/tasks/:id', () => {
    it('should return a single task by id', async () => {
      await request(app).post('/api/tasks').send({ content: md('Find me') });
      const res = await request(app).get('/api/tasks/1');
      expect(res.status).toBe(200);
      expect(res.body.meta.title).toBe('Find me');
    });

    it('should return 404 for non-existent id', async () => {
      const res = await request(app).get('/api/tasks/9999');
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/tasks/:id', () => {
    it('should update a task via new content', async () => {
      await request(app).post('/api/tasks').send({ content: md('Old') });
      const res = await request(app)
        .patch('/api/tasks/1')
        .send({ content: md('Updated') });
      expect(res.status).toBe(200);
      expect(res.body.meta.title).toBe('Updated');
    });

    it('should update status', async () => {
      await request(app).post('/api/tasks').send({ content: md('Task') });
      const res = await request(app)
        .patch('/api/tasks/1')
        .send({ content: md('Task', { status: 'done' }) });
      expect(res.status).toBe(200);
      expect(res.body.meta.status).toBe('done');
    });

    it('should set updated_at on update', async () => {
      const pool = getTestPool();
      await pool.query(
        `INSERT INTO tasks (content, meta, created_at)
         VALUES ($1, $2, NOW() - interval '1 hour')`,
        [md('Task'), JSON.stringify({ title: 'Task', status: 'todo' })]
      );
      const res = await request(app)
        .patch('/api/tasks/1')
        .send({ content: md('Changed') });
      expect(res.status).toBe(200);
      const created = new Date(res.body.created_at);
      const updated = new Date(res.body.updated_at);
      expect(updated.getTime()).toBeGreaterThan(created.getTime());
    });

    it('should return 404 for non-existent id', async () => {
      const res = await request(app)
        .patch('/api/tasks/9999')
        .send({ content: md('Nope') });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/tasks/:id', () => {
    it('should delete a task', async () => {
      await request(app).post('/api/tasks').send({ content: md('Delete me') });
      const del = await request(app).delete('/api/tasks/1');
      expect(del.status).toBe(200);
      const get = await request(app).get('/api/tasks/1');
      expect(get.status).toBe(404);
    });

    it('should return 404 for non-existent id', async () => {
      const res = await request(app).delete('/api/tasks/9999');
      expect(res.status).toBe(404);
    });
  });
});
