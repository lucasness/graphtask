import pg from 'pg';

export function createPool(connectionString) {
  return new pg.Pool({ connectionString });
}

const pool = createPool(
  process.env.DATABASE_URL || 'postgresql://postgres@localhost/graphtask'
);

export default pool;
