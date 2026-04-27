import request from 'supertest';
import { getTestPool, TEST_URL } from './setup.js';

let app;
let pool;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_URL;
  const mod = await import('../src/app.js');
  app = mod.default;
  pool = getTestPool();
});

function taskRow(title) {
  const content = `---\ntitle: ${title}\nstatus: todo\n---\n`;
  const meta = JSON.stringify({ title, status: 'todo' });
  return [content, meta];
}

// Build test graph (arrows = execution order, source is prerequisite of target):
// A → B → D
// A → C → D
// D -- E (related)
beforeEach(async () => {
  for (const t of ['A', 'B', 'C', 'D', 'E']) {
    const [c, m] = taskRow(t);
    await pool.query(`INSERT INTO tasks (content, meta) VALUES ($1, $2)`, [c, m]);
  }
  await pool.query(`
    INSERT INTO edges (source_id, target_id, type) VALUES
      (1, 2, 'dependency'),
      (1, 3, 'dependency'),
      (2, 4, 'dependency'),
      (3, 4, 'dependency'),
      (4, 5, 'related')
  `);
});

describe('Graph queries', () => {
  describe('GET /api/tasks/:id/subtasks (prerequisites)', () => {
    it('should return all prerequisites of task D', async () => {
      const res = await request(app).get('/api/tasks/4/subtasks');
      expect(res.status).toBe(200);
      const ids = res.body.map((t) => t.id).sort();
      expect(ids).toEqual([1, 2, 3]); // A, B, C
    });

    it('should return empty for a root node with no prerequisites', async () => {
      const res = await request(app).get('/api/tasks/1/subtasks');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('should return 404 for non-existent task', async () => {
      const res = await request(app).get('/api/tasks/9999/subtasks');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/tasks/:id/ancestors (dependents)', () => {
    it('should return all dependents of task A', async () => {
      const res = await request(app).get('/api/tasks/1/ancestors');
      expect(res.status).toBe(200);
      const ids = res.body.map((t) => t.id).sort();
      expect(ids).toEqual([2, 3, 4]); // B, C, D
    });

    it('should return empty for an end-goal node', async () => {
      const res = await request(app).get('/api/tasks/4/ancestors');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('should return 404 for non-existent task', async () => {
      const res = await request(app).get('/api/tasks/9999/ancestors');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/tasks/leaves', () => {
    it('should return tasks with no incoming dependency edges (can start immediately)', async () => {
      const res = await request(app).get('/api/tasks/leaves');
      expect(res.status).toBe(200);
      const ids = res.body.map((t) => t.id).sort();
      // A has no prerequisites, E has no dependency edges at all
      expect(ids).toEqual([1, 5]);
    });

    it('should return all tasks when no dependency edges exist', async () => {
      await pool.query('DELETE FROM edges');
      const res = await request(app).get('/api/tasks/leaves');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(5);
    });
  });

  describe('GET /api/graph/shortest-path', () => {
    it('should find shortest path between two tasks', async () => {
      // All edges cost 1, both A->B->D and A->C->D are length 2
      const res = await request(app).get('/api/graph/shortest-path?from=1&to=4');
      expect(res.status).toBe(200);
      expect(res.body.path).toHaveLength(3);
      expect(res.body.path[0]).toBe(1);
      expect(res.body.path[2]).toBe(4);
      expect(res.body.cost).toBe(2);
    });

    it('should return empty path for disconnected tasks', async () => {
      const [c, m] = taskRow('F');
      await pool.query(`INSERT INTO tasks (content, meta) VALUES ($1, $2)`, [c, m]);
      const res = await request(app).get('/api/graph/shortest-path?from=1&to=6');
      expect(res.status).toBe(200);
      expect(res.body.path).toEqual([]);
    });

    it('should return 400 if from or to is missing', async () => {
      const res = await request(app).get('/api/graph/shortest-path?from=1');
      expect(res.status).toBe(400);
    });

    it('should return 400 if from or to is not a valid integer', async () => {
      const res = await request(app).get('/api/graph/shortest-path?from=abc&to=def');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/graph', () => {
    it('should return full graph data with nodes and links', async () => {
      const res = await request(app).get('/api/graph');
      expect(res.status).toBe(200);
      expect(res.body.nodes).toHaveLength(5);
      expect(res.body.links).toHaveLength(5);
      const node = res.body.nodes.find((n) => n.id === 1);
      expect(node.title).toBe('A');
      expect(node.status).toBe('todo');
      const link = res.body.links.find((l) => l.source === 1 && l.target === 2);
      expect(link.type).toBe('dependency');
      expect(link.meta).toEqual({});
    });

    it('should return empty graph when no data', async () => {
      await pool.query('TRUNCATE tasks, edges RESTART IDENTITY CASCADE');
      const res = await request(app).get('/api/graph');
      expect(res.status).toBe(200);
      expect(res.body.nodes).toEqual([]);
      expect(res.body.links).toEqual([]);
    });
  });
});
