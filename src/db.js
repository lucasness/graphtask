import pg from 'pg';

export function createPool(connectionString) {
  return new pg.Pool({ connectionString });
}

function resolveConnectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const bootstrap = process.env.PG_BOOTSTRAP_URL;
  const dbName = process.env.DATABASE_NAME;
  if (bootstrap && dbName) {
    // Replace the path of PG_BOOTSTRAP_URL with our own DATABASE_NAME.
    const u = new URL(bootstrap);
    u.pathname = `/${dbName}`;
    return u.toString();
  }
  return 'postgresql://postgres@localhost/graphtask';
}

const pool = createPool(resolveConnectionString());

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
