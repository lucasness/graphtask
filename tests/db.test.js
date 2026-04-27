import { getTestPool } from './setup.js';

function taskContent(title, extra = '') {
  const status = 'todo';
  return `---\ntitle: ${title}\nstatus: ${status}\n${extra}---\n`;
}

function taskMeta(title, extra = {}) {
  return JSON.stringify({ title, status: 'todo', ...extra });
}

describe('Database schema', () => {
  let pool;

  beforeAll(() => {
    pool = getTestPool();
  });

  it('should connect to the test database', async () => {
    const result = await pool.query('SELECT 1 AS result');
    expect(result.rows[0].result).toBe(1);
  });

  it('should have pgrouting extension enabled', async () => {
    const result = await pool.query(
      "SELECT extname FROM pg_extension WHERE extname = 'pgrouting'"
    );
    expect(result.rows).toHaveLength(1);
  });

  it('should have tasks table with correct columns', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'tasks' ORDER BY ordinal_position`
    );
    const columns = result.rows.map((r) => r.column_name);
    expect(columns).toEqual([
      'id', 'content', 'meta', 'created_at', 'updated_at',
    ]);
  });

  it('should have edges table with correct columns', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'edges' ORDER BY ordinal_position`
    );
    const columns = result.rows.map((r) => r.column_name);
    expect(columns).toEqual([
      'id', 'source_id', 'target_id', 'type', 'meta', 'created_at',
    ]);
  });

  it('should enforce unique constraint on edges(source_id, target_id)', async () => {
    await pool.query(
      `INSERT INTO tasks (content, meta) VALUES ($1, $2), ($3, $4)`,
      [taskContent('A'), taskMeta('A'), taskContent('B'), taskMeta('B')]
    );
    await pool.query(
      "INSERT INTO edges (source_id, target_id, type) VALUES (1, 2, 'dependency')"
    );
    await expect(
      pool.query("INSERT INTO edges (source_id, target_id, type) VALUES (1, 2, 'dependency')")
    ).rejects.toThrow(/unique/i);
  });

  it('should reject self-referencing edges', async () => {
    await pool.query(
      `INSERT INTO tasks (content, meta) VALUES ($1, $2)`,
      [taskContent('A'), taskMeta('A')]
    );
    await expect(
      pool.query("INSERT INTO edges (source_id, target_id, type) VALUES (1, 1, 'dependency')")
    ).rejects.toThrow(/check/i);
  });

  it('should cascade delete edges when a task is deleted', async () => {
    await pool.query(
      `INSERT INTO tasks (content, meta) VALUES ($1, $2), ($3, $4)`,
      [taskContent('A'), taskMeta('A'), taskContent('B'), taskMeta('B')]
    );
    await pool.query(
      "INSERT INTO edges (source_id, target_id, type) VALUES (1, 2, 'dependency')"
    );
    await pool.query('DELETE FROM tasks WHERE id = 1');
    const result = await pool.query('SELECT * FROM edges');
    expect(result.rows).toHaveLength(0);
  });
});
