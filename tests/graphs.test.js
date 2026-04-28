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
  });

  describe('GET /api/graphs', () => {
    it('should return empty array when no graphs', async () => {
      const res = await request(app).get('/api/graphs');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('should return graphs ordered by updated_at DESC', async () => {
      await request(app).post('/api/graphs').send({ name: 'first' });
      await request(app).post('/api/graphs').send({ name: 'second' });
      await request(app).post('/api/graphs').send({ name: 'third' });
      const res = await request(app).get('/api/graphs');
      expect(res.body.map((g) => g.name)).toEqual(['third', 'second', 'first']);
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
});
