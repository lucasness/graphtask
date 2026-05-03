import request from 'supertest';
import { TEST_URL } from './setup.js';

let app;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_URL;
  const mod = await import('../src/app.js');
  app = mod.default;
});

describe('Graph CRUD', () => {
  describe('POST /api/graphs', () => {
    it('should create a graph with name only', async () => {
      const res = await request(app)
        .post('/api/graphs')
        .send({ name: 'My project' });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('My project');
      expect(res.body.description).toBeNull();
      expect(res.body.id).toBeDefined();
      expect(res.body.created_at).toBeDefined();
      expect(res.body.updated_at).toBeDefined();
    });

    it('should create a graph with description', async () => {
      const res = await request(app)
        .post('/api/graphs')
        .send({ name: 'With desc', description: 'a longer thing' });
      expect(res.status).toBe(201);
      expect(res.body.description).toBe('a longer thing');
    });

    it('should reject empty name', async () => {
      const res = await request(app).post('/api/graphs').send({ name: '   ' });
      expect(res.status).toBe(400);
    });

    it('should reject missing name', async () => {
      const res = await request(app).post('/api/graphs').send({});
      expect(res.status).toBe(400);
    });

    it('should reject name > 80 chars', async () => {
      const res = await request(app)
        .post('/api/graphs')
        .send({ name: 'x'.repeat(81) });
      expect(res.status).toBe(400);
    });

    it('should reject description > 500 chars', async () => {
      const res = await request(app)
        .post('/api/graphs')
        .send({ name: 'OK', description: 'x'.repeat(501) });
      expect(res.status).toBe(400);
    });

    // Global name uniqueness was dropped — the 409 response let attackers
    // probe whether a graph by a given name existed. Duplicate names now
    // succeed at every casing/whitespace variant.
    it('should allow duplicate names', async () => {
      const a = await request(app).post('/api/graphs').send({ name: 'My Graph' });
      const b = await request(app).post('/api/graphs').send({ name: 'My Graph' });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body.id).not.toBe(b.body.id);
    });

    it('should allow case-insensitive duplicates', async () => {
      const a = await request(app).post('/api/graphs').send({ name: 'My Graph' });
      const b = await request(app).post('/api/graphs').send({ name: 'MY GRAPH' });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
    });

    it('should allow whitespace-variant duplicates', async () => {
      const a = await request(app).post('/api/graphs').send({ name: 'My Graph' });
      const b = await request(app).post('/api/graphs').send({ name: 'mygraph' });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
    });

    it('should allow distinct names', async () => {
      const a = await request(app).post('/api/graphs').send({ name: 'one' });
      const b = await request(app).post('/api/graphs').send({ name: 'two' });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
    });

    it('should default new graphs to private', async () => {
      const res = await request(app).post('/api/graphs').send({ name: 'private by default' });
      expect(res.status).toBe(201);
      expect(res.body.is_public).toBe(false);
    });
  });

  describe('GET /api/graphs', () => {
    it('should return empty array when no graphs', async () => {
      const res = await request(app).get('/api/graphs');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    // The list endpoint is the home-page directory; only public graphs are
    // listed. Private graphs are still reachable by URL.
    it('should return only public graphs ordered by updated_at DESC', async () => {
      const a = await request(app).post('/api/graphs').send({ name: 'first' });
      const b = await request(app).post('/api/graphs').send({ name: 'second' });
      const c = await request(app).post('/api/graphs').send({ name: 'third' });
      for (const id of [a.body.id, b.body.id, c.body.id]) {
        await request(app).patch(`/api/graphs/${id}`).send({ is_public: true });
      }
      const res = await request(app).get('/api/graphs');
      expect(res.body.map((g) => g.name)).toEqual(['third', 'second', 'first']);
    });

    it('should exclude private graphs from the list', async () => {
      const priv = await request(app).post('/api/graphs').send({ name: 'private' });
      const pub = await request(app).post('/api/graphs').send({ name: 'public' });
      await request(app).patch(`/api/graphs/${pub.body.id}`).send({ is_public: true });
      const res = await request(app).get('/api/graphs');
      expect(res.body.map((g) => g.id)).toEqual([pub.body.id]);
      // Private graph still reachable by id (URL bearer-token model).
      const direct = await request(app).get(`/api/graphs/${priv.body.id}`);
      expect(direct.status).toBe(200);
    });
  });

  describe('GET /api/graphs/:id', () => {
    it('should return a single graph', async () => {
      const create = await request(app)
        .post('/api/graphs')
        .send({ name: 'one' });
      const res = await request(app).get(`/api/graphs/${create.body.id}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('one');
    });

    it('should 404 on non-existent', async () => {
      const res = await request(app).get('/api/graphs/zzzzzzzz');
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/graphs/:id', () => {
    it('should rename a graph', async () => {
      const create = await request(app).post('/api/graphs').send({ name: 'old' });
      const res = await request(app)
        .patch(`/api/graphs/${create.body.id}`)
        .send({ name: 'new' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('new');
    });

    it('should update description', async () => {
      const create = await request(app).post('/api/graphs').send({ name: 'g' });
      const res = await request(app)
        .patch(`/api/graphs/${create.body.id}`)
        .send({ description: 'hello' });
      expect(res.status).toBe(200);
      expect(res.body.description).toBe('hello');
    });

    it('should clear description with explicit null', async () => {
      const create = await request(app)
        .post('/api/graphs')
        .send({ name: 'g', description: 'will be cleared' });
      const res = await request(app)
        .patch(`/api/graphs/${create.body.id}`)
        .send({ description: null });
      expect(res.status).toBe(200);
      expect(res.body.description).toBeNull();
    });

    it('should bump updated_at on patch', async () => {
      const create = await request(app).post('/api/graphs').send({ name: 'old' });
      const before = new Date(create.body.updated_at).getTime();
      // Wait so timestamp can advance (NOW() has microsecond precision but
      // postgres updated_at column truncates).
      await new Promise((r) => setTimeout(r, 10));
      const res = await request(app)
        .patch(`/api/graphs/${create.body.id}`)
        .send({ name: 'new' });
      const after = new Date(res.body.updated_at).getTime();
      expect(after).toBeGreaterThan(before);
    });

    it('should 400 on empty body', async () => {
      const create = await request(app).post('/api/graphs').send({ name: 'g' });
      const res = await request(app).patch(`/api/graphs/${create.body.id}`).send({});
      expect(res.status).toBe(400);
    });

    it('should 404 on non-existent', async () => {
      const res = await request(app)
        .patch('/api/graphs/zzzzzzzz')
        .send({ name: 'new' });
      expect(res.status).toBe(404);
    });

    it('should allow renaming to a colliding name', async () => {
      await request(app).post('/api/graphs').send({ name: 'taken' });
      const other = await request(app).post('/api/graphs').send({ name: 'free' });
      const res = await request(app)
        .patch(`/api/graphs/${other.body.id}`)
        .send({ name: 'TAKEN' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('TAKEN');
    });

    it('should toggle is_public', async () => {
      const create = await request(app).post('/api/graphs').send({ name: 'toggle' });
      expect(create.body.is_public).toBe(false);
      const flipOn = await request(app)
        .patch(`/api/graphs/${create.body.id}`)
        .send({ is_public: true });
      expect(flipOn.status).toBe(200);
      expect(flipOn.body.is_public).toBe(true);
      const list = await request(app).get('/api/graphs');
      expect(list.body.map((g) => g.id)).toContain(create.body.id);
      const flipOff = await request(app)
        .patch(`/api/graphs/${create.body.id}`)
        .send({ is_public: false });
      expect(flipOff.body.is_public).toBe(false);
      const listAfter = await request(app).get('/api/graphs');
      expect(listAfter.body.map((g) => g.id)).not.toContain(create.body.id);
    });

    it('should 400 when is_public is not a boolean', async () => {
      const create = await request(app).post('/api/graphs').send({ name: 'g' });
      const res = await request(app)
        .patch(`/api/graphs/${create.body.id}`)
        .send({ is_public: 'yes' });
      expect(res.status).toBe(400);
    });

    it('should default settings to an empty object on create', async () => {
      const res = await request(app).post('/api/graphs').send({ name: 'g' });
      expect(res.status).toBe(201);
      expect(res.body.settings).toEqual({});
    });

    it('should accept a valid settings patch and merge keys', async () => {
      const create = await request(app).post('/api/graphs').send({ name: 'g' });
      const r1 = await request(app)
        .patch(`/api/graphs/${create.body.id}`)
        .send({ settings: { font: 'garamond', font_color: '#abcdef' } });
      expect(r1.status).toBe(200);
      expect(r1.body.settings).toEqual({ font: 'garamond', font_color: '#abcdef' });

      // Subsequent patch merges with existing keys.
      const r2 = await request(app)
        .patch(`/api/graphs/${create.body.id}`)
        .send({ settings: { bg_color: '#100F0F' } });
      expect(r2.body.settings).toEqual({
        font: 'garamond',
        font_color: '#abcdef',
        bg_color: '#100F0F',
      });

      // Setting a key to null clears it (revert to default).
      const r3 = await request(app)
        .patch(`/api/graphs/${create.body.id}`)
        .send({ settings: { font: null } });
      expect(r3.body.settings).toEqual({
        font_color: '#abcdef',
        bg_color: '#100F0F',
      });
    });

    it('should 400 on unknown settings key', async () => {
      const create = await request(app).post('/api/graphs').send({ name: 'g' });
      const res = await request(app)
        .patch(`/api/graphs/${create.body.id}`)
        .send({ settings: { wat: 'nope' } });
      expect(res.status).toBe(400);
    });

    it('should 400 on invalid font id', async () => {
      const create = await request(app).post('/api/graphs').send({ name: 'g' });
      const res = await request(app)
        .patch(`/api/graphs/${create.body.id}`)
        .send({ settings: { font: 'comic-sans' } });
      expect(res.status).toBe(400);
    });

    it('should 400 on non-hex color', async () => {
      const create = await request(app).post('/api/graphs').send({ name: 'g' });
      const res = await request(app)
        .patch(`/api/graphs/${create.body.id}`)
        .send({ settings: { font_color: 'red' } });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/graphs/:id', () => {
    it('should delete a graph', async () => {
      const create = await request(app).post('/api/graphs').send({ name: 'gone' });
      const del = await request(app).delete(`/api/graphs/${create.body.id}`);
      expect(del.status).toBe(200);
      const get = await request(app).get(`/api/graphs/${create.body.id}`);
      expect(get.status).toBe(404);
    });

    it('should 404 on non-existent', async () => {
      const res = await request(app).delete('/api/graphs/zzzzzzzz');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/graphs/:id/rotate-id', () => {
    it('should issue a fresh 16-char id and 404 the old one', async () => {
      const create = await request(app).post('/api/graphs').send({ name: 'r' });
      const oldId = create.body.id;
      const res = await request(app).post(`/api/graphs/${oldId}/rotate-id`);
      expect(res.status).toBe(200);
      expect(res.body.id).not.toBe(oldId);
      expect(res.body.id).toMatch(/^[a-z2-9]{16}$/);
      expect(res.body.name).toBe('r');

      const oldGet = await request(app).get(`/api/graphs/${oldId}`);
      expect(oldGet.status).toBe(404);
      const newGet = await request(app).get(`/api/graphs/${res.body.id}`);
      expect(newGet.status).toBe(200);
    });

    it('should carry tasks and edges to the new id via cascade', async () => {
      const g = await request(app).post('/api/graphs').send({ name: 'with-data' });
      const oldId = g.body.id;
      const t1 = await request(app)
        .post(`/api/graphs/${oldId}/tasks`)
        .send({ content: '---\ntitle: a\nstatus: todo\n---\n' });
      const t2 = await request(app)
        .post(`/api/graphs/${oldId}/tasks`)
        .send({ content: '---\ntitle: b\nstatus: todo\n---\n' });
      await request(app).post(`/api/graphs/${oldId}/edges`).send({
        source_id: t1.body.id,
        target_id: t2.body.id,
        type: 'dependency',
      });

      const rot = await request(app).post(`/api/graphs/${oldId}/rotate-id`);
      const newId = rot.body.id;

      const tasks = await request(app).get(`/api/graphs/${newId}/tasks`);
      expect(tasks.status).toBe(200);
      expect(tasks.body.length).toBe(2);
      const edges = await request(app).get(`/api/graphs/${newId}/edges`);
      expect(edges.status).toBe(200);
      expect(edges.body.length).toBe(1);

      const oldTasks = await request(app).get(`/api/graphs/${oldId}/tasks`);
      expect(oldTasks.body).toEqual([]);
    });

    it('should 404 on non-existent graph', async () => {
      const res = await request(app).post('/api/graphs/zzzzzzzz/rotate-id');
      expect(res.status).toBe(404);
    });
  });
});
