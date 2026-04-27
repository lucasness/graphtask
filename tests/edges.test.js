import request from 'supertest';
import { getTestPool, TEST_URL } from './setup.js';

let app;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_URL;
  const mod = await import('../src/app.js');
  app = mod.default;
});

function taskRow(title) {
  const content = `---\ntitle: ${title}\nstatus: todo\n---\n`;
  const meta = JSON.stringify({ title, status: 'todo' });
  return [content, meta];
}

describe('Edge CRUD', () => {
  let pool;

  beforeAll(() => {
    pool = getTestPool();
  });

  beforeEach(async () => {
    const [cA, mA] = taskRow('A');
    const [cB, mB] = taskRow('B');
    const [cC, mC] = taskRow('C');
    await pool.query(
      `INSERT INTO tasks (content, meta) VALUES ($1, $2), ($3, $4), ($5, $6)`,
      [cA, mA, cB, mB, cC, mC]
    );
  });

  describe('POST /api/edges', () => {
    it('should create a dependency edge', async () => {
      const res = await request(app)
        .post('/api/edges')
        .send({ source_id: 1, target_id: 2, type: 'dependency' });
      expect(res.status).toBe(201);
      expect(res.body.source_id).toBe(1);
      expect(res.body.target_id).toBe(2);
      expect(res.body.type).toBe('dependency');
    });

    it('should create a related edge', async () => {
      const res = await request(app)
        .post('/api/edges')
        .send({ source_id: 1, target_id: 3, type: 'related' });
      expect(res.status).toBe(201);
      expect(res.body.type).toBe('related');
    });

    it('should create an edge with curve metadata', async () => {
      const res = await request(app)
        .post('/api/edges')
        .send({ source_id: 1, target_id: 2, type: 'dependency', meta: { curve: 42.123 } });
      expect(res.status).toBe(201);
      expect(res.body.meta.curve).toBe(42.12);
    });

    it('should create an edge with color metadata', async () => {
      const res = await request(app)
        .post('/api/edges')
        .send({ source_id: 1, target_id: 2, type: 'dependency', meta: { color: '#253F55' } });
      expect(res.status).toBe(201);
      expect(res.body.meta.color).toBe('#253F55');
    });

    it('should reject edge with missing source_id', async () => {
      const res = await request(app)
        .post('/api/edges')
        .send({ target_id: 2, type: 'dependency' });
      expect(res.status).toBe(400);
    });

    it('should reject edge with missing target_id', async () => {
      const res = await request(app)
        .post('/api/edges')
        .send({ source_id: 1, type: 'dependency' });
      expect(res.status).toBe(400);
    });

    it('should reject edge with invalid type', async () => {
      const res = await request(app)
        .post('/api/edges')
        .send({ source_id: 1, target_id: 2, type: 'invalid' });
      expect(res.status).toBe(400);
    });

    it('should reject duplicate edge', async () => {
      await request(app)
        .post('/api/edges')
        .send({ source_id: 1, target_id: 2, type: 'dependency' });
      const res = await request(app)
        .post('/api/edges')
        .send({ source_id: 1, target_id: 2, type: 'dependency' });
      expect(res.status).toBe(409);
    });

    it('should reject self-referencing edge', async () => {
      const res = await request(app)
        .post('/api/edges')
        .send({ source_id: 1, target_id: 1, type: 'dependency' });
      expect(res.status).toBe(400);
    });

    it('should reject edge referencing non-existent task', async () => {
      const res = await request(app)
        .post('/api/edges')
        .send({ source_id: 1, target_id: 9999, type: 'dependency' });
      expect(res.status).toBe(400);
    });

    it('should detect and reject cycles for dependency edges', async () => {
      // A before B, B before C
      await request(app)
        .post('/api/edges')
        .send({ source_id: 1, target_id: 2, type: 'dependency' });
      await request(app)
        .post('/api/edges')
        .send({ source_id: 2, target_id: 3, type: 'dependency' });
      // C before A would form a cycle
      const res = await request(app)
        .post('/api/edges')
        .send({ source_id: 3, target_id: 1, type: 'dependency' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cycle/i);
    });

    it('should allow cycles for related edges', async () => {
      const r1 = await request(app)
        .post('/api/edges')
        .send({ source_id: 1, target_id: 2, type: 'related' });
      const r2 = await request(app)
        .post('/api/edges')
        .send({ source_id: 2, target_id: 3, type: 'related' });
      const r3 = await request(app)
        .post('/api/edges')
        .send({ source_id: 3, target_id: 1, type: 'related' });
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(r3.status).toBe(201);
    });
  });

  describe('GET /api/edges', () => {
    it('should return empty array when no edges', async () => {
      const res = await request(app).get('/api/edges');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('should return all edges', async () => {
      await pool.query(
        "INSERT INTO edges (source_id, target_id, type) VALUES (1, 2, 'dependency'), (2, 3, 'related')"
      );
      const res = await request(app).get('/api/edges');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });
  });

  describe('PATCH /api/edges/:id', () => {
    it('should update curve metadata without changing endpoints', async () => {
      await pool.query(
        "INSERT INTO edges (source_id, target_id, type) VALUES (1, 2, 'dependency')"
      );
      const res = await request(app)
        .patch('/api/edges/1')
        .send({ meta: { curve: -65 } });
      expect(res.status).toBe(200);
      expect(res.body.source_id).toBe(1);
      expect(res.body.target_id).toBe(2);
      expect(res.body.meta.curve).toBe(-65);
    });

    it('should update color metadata without changing endpoints', async () => {
      await pool.query(
        "INSERT INTO edges (source_id, target_id, type) VALUES (1, 2, 'dependency')"
      );
      const res = await request(app)
        .patch('/api/edges/1')
        .send({ meta: { color: '#3D4525' } });
      expect(res.status).toBe(200);
      expect(res.body.source_id).toBe(1);
      expect(res.body.target_id).toBe(2);
      expect(res.body.meta.color).toBe('#3D4525');
    });

    it('should reject invalid curve metadata', async () => {
      await pool.query(
        "INSERT INTO edges (source_id, target_id, type) VALUES (1, 2, 'dependency')"
      );
      const res = await request(app)
        .patch('/api/edges/1')
        .send({ meta: { curve: 9999 } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/curve/i);
    });

    it('should reject invalid color metadata', async () => {
      await pool.query(
        "INSERT INTO edges (source_id, target_id, type) VALUES (1, 2, 'dependency')"
      );
      const res = await request(app)
        .patch('/api/edges/1')
        .send({ meta: { color: 'blue' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/color/i);
    });
  });

  describe('DELETE /api/edges/:id', () => {
    it('should delete an edge', async () => {
      await pool.query(
        "INSERT INTO edges (source_id, target_id, type) VALUES (1, 2, 'dependency')"
      );
      const del = await request(app).delete('/api/edges/1');
      expect(del.status).toBe(200);
      const res = await request(app).get('/api/edges');
      expect(res.body).toHaveLength(0);
    });

    it('should return 404 for non-existent edge', async () => {
      const res = await request(app).delete('/api/edges/9999');
      expect(res.status).toBe(404);
    });
  });
});
