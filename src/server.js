import app from './app.js';
import pool, { applySchema } from './db.js';

const PORT = Number(process.env.PORT) || 3000;

// Apply (idempotent) schema before accepting connections. Catches schema
// drift on every restart — no more "users table missing" 500s after a
// Phase B deploy that forgot the `psql -f db/schema.sql` step.
try {
  await applySchema(pool);
  console.log('graphtask schema applied');
} catch (err) {
  console.error('graphtask schema apply failed —', err.message);
  process.exit(1);
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`graphtask running on 127.0.0.1:${PORT}`);
});
