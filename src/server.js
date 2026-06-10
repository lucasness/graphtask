import app from './app.js';
import pool, { applySchema } from './db.js';
import { configFromEnv } from './search/config.js';
import { createEmbeddingProvider } from './search/providers/embedding.js';
import { createChunkIndexer } from './search/indexer.js';
import { warmupDefaultService } from './routes/search.js';

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

// Semantic-search indexer (#190 write path): with an embedding backend
// configured, keep task_chunks in step with tasks — LISTEN on the graph_change
// trigger + a boot backfill. Deliberately NOT awaited: model warm-up and the
// first backfill can take seconds and the server must serve immediately
// (lexical search answers regardless; dense fills in as the store catches up).
try {
  const provider = createEmbeddingProvider(configFromEnv().providers.embedding);
  if (provider) {
    const indexer = createChunkIndexer({ pool, provider });
    indexer.start().catch((err) => {
      console.error('[search-index] failed to start —', err.message);
    });
  }
} catch (err) {
  console.error('[search-index] not started —', err.message);
}

// Warm the search models off the request path (not awaited — same rationale as
// the indexer above: the server must serve immediately; lexical answers while
// the dense/rerank weights load).
const warmT0 = performance.now();
warmupDefaultService()
  .then(() => console.log(`[search-warmup] models warm in ${Math.round(performance.now() - warmT0)}ms`))
  .catch((err) => console.error('[search-warmup] failed —', err.message));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`graphtask running on 127.0.0.1:${PORT}`);
});
