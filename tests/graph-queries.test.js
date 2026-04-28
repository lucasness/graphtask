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

function taskRow(title) {
  const content = `---\ntitle: ${title}\nstatus: todo\n---\n`;
  const meta = JSON.stringify({ title, status: 'todo' });
  return [content, meta];
}

// Graph (arrows = execution order, source is prerequisite of target):
// A → B → D
// A → C → D
// D -- E (related)
// Inserted via TRUNCATE+RESTART so task ids are 1..5 deterministically.
beforeEach(async () => {
  const g = await pool.query("INSERT INTO graphs (name) VALUES ('t') RETURNING id");
  gid = g.rows[0].id;
  for (const t of ['A', 'B', 'C', 'D', 'E']) {
    const [c, m] = taskRow(t);
    await pool.query(
      `INSERT INTO tasks (graph_id, content, meta) VALUES ($1, $2, $3)`,
      [gid, c, m]
    );
  }
  await pool.query(
    `INSERT INTO edges (graph_id, source_id, target_id, type) VALUES
      ($1, 1, 2, 'dependency'),
      ($1, 1, 3, 'dependency'),
      ($1, 2, 4, 'dependency'),
      ($1, 3, 4, 'dependency'),
      ($1, 4, 5, 'related')`,
    [gid]
  );
});

const tasksUrl = () => `/api/graphs/${gid}/tasks`;
const graphUrl = () => `/api/graphs/${gid}/graph`;

describe('Graph queries', () => {
  describe('GET /api/graphs/:gid/tasks/:id/subtasks (prerequisites)', () => {
    it('should return all prerequisites of task D', async () => {
      const res = await request(app).get(`${tasksUrl()}/4/subtasks`);
      expect(res.status).toBe(200);
      const ids = res.body.map((t) => t.id).sort();
      expect(ids).toEqual([1, 2, 3]); // A, B, C
    });

    it('should return empty for a root node with no prerequisites', async () => {
      const res = await request(app).get(`${tasksUrl()}/1/subtasks`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('should return 404 for non-existent task', async () => {
      const res = await request(app).get(`${tasksUrl()}/9999/subtasks`);
      expect(res.status).toBe(404);
    });

    it('should return 400 for non-integer id', async () => {
      const res = await request(app).get(`${tasksUrl()}/abc/subtasks`);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/graphs/:gid/tasks/:id/ancestors (dependents)', () => {
    it('should return all dependents of task A', async () => {
      const res = await request(app).get(`${tasksUrl()}/1/ancestors`);
      expect(res.status).toBe(200);
      const ids = res.body.map((t) => t.id).sort();
      expect(ids).toEqual([2, 3, 4]); // B, C, D
    });

    it('should return empty for an end-goal node', async () => {
      const res = await request(app).get(`${tasksUrl()}/4/ancestors`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('should return 404 for non-existent task', async () => {
      const res = await request(app).get(`${tasksUrl()}/9999/ancestors`);
      expect(res.status).toBe(404);
    });

    it('should return 400 for non-integer id', async () => {
      const res = await request(app).get(`${tasksUrl()}/abc/ancestors`);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/graphs/:gid/tasks/leaves', () => {
    it('should return tasks with no incoming dependency edges', async () => {
      const res = await request(app).get(`${tasksUrl()}/leaves`);
      expect(res.status).toBe(200);
      const ids = res.body.map((t) => t.id).sort();
      expect(ids).toEqual([1, 5]);
    });

    it('should return all tasks when no dependency edges exist', async () => {
      await pool.query('DELETE FROM edges');
      const res = await request(app).get(`${tasksUrl()}/leaves`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(5);
    });
  });

  describe('GET /api/graphs/:gid/graph/shortest-path', () => {
    it('should find shortest path between two tasks', async () => {
      const res = await request(app).get(`${graphUrl()}/shortest-path?from=1&to=4`);
      expect(res.status).toBe(200);
      expect(res.body.path).toHaveLength(3);
      expect(res.body.path[0]).toBe(1);
      expect(res.body.path[2]).toBe(4);
      expect(res.body.cost).toBe(2);
    });

    it('should return empty path for disconnected tasks', async () => {
      const [c, m] = taskRow('F');
      await pool.query(
        `INSERT INTO tasks (graph_id, content, meta) VALUES ($1, $2, $3)`,
        [gid, c, m]
      );
      const res = await request(app).get(`${graphUrl()}/shortest-path?from=1&to=6`);
      expect(res.status).toBe(200);
      expect(res.body.path).toEqual([]);
    });

    it('should return 400 if from or to is missing', async () => {
      const res = await request(app).get(`${graphUrl()}/shortest-path?from=1`);
      expect(res.status).toBe(400);
    });

    it('should return 400 if from or to is not a valid integer', async () => {
      const res = await request(app).get(`${graphUrl()}/shortest-path?from=abc&to=def`);
      expect(res.status).toBe(400);
    });

    it('should not cross graphs', async () => {
      const otherGid = (
        await pool.query("INSERT INTO graphs (name) VALUES ('other') RETURNING id")
      ).rows[0].id;
      const [c, m] = taskRow('Z');
      const z1 = await pool.query(
        `INSERT INTO tasks (graph_id, content, meta) VALUES ($1, $2, $3) RETURNING id`,
        [otherGid, c, m]
      );
      const z2 = await pool.query(
        `INSERT INTO tasks (graph_id, content, meta) VALUES ($1, $2, $3) RETURNING id`,
        [otherGid, c, m]
      );
      await pool.query(
        `INSERT INTO edges (graph_id, source_id, target_id, type) VALUES ($1, $2, $3, 'dependency')`,
        [otherGid, z1.rows[0].id, z2.rows[0].id]
      );
      // Try to find path between two tasks in 'other' graph using `gid` URL: should not find them.
      const res = await request(app).get(
        `${graphUrl()}/shortest-path?from=${z1.rows[0].id}&to=${z2.rows[0].id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.path).toEqual([]);
    });
  });

  describe('GET /api/graphs/:gid/graph', () => {
    it('should return graph data with nodes and links', async () => {
      const res = await request(app).get(graphUrl());
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

    it('should not include nodes/links from other graphs', async () => {
      const otherGid = (
        await pool.query("INSERT INTO graphs (name) VALUES ('other') RETURNING id")
      ).rows[0].id;
      const [c, m] = taskRow('Z');
      await pool.query(
        `INSERT INTO tasks (graph_id, content, meta) VALUES ($1, $2, $3)`,
        [otherGid, c, m]
      );
      const res = await request(app).get(graphUrl());
      expect(res.body.nodes).toHaveLength(5);
    });

    it('should return empty graph when no data', async () => {
      await pool.query('TRUNCATE tasks, edges RESTART IDENTITY CASCADE');
      const res = await request(app).get(graphUrl());
      expect(res.status).toBe(200);
      expect(res.body.nodes).toEqual([]);
      expect(res.body.links).toEqual([]);
    });
  });
});
