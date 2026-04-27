CREATE EXTENSION IF NOT EXISTS pgrouting CASCADE;

DO $$ BEGIN
  CREATE TYPE edge_type AS ENUM ('dependency', 'related');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT title_required
    CHECK (meta->>'title' IS NOT NULL AND meta->>'title' != ''),
  CONSTRAINT title_length
    CHECK (length(meta->>'title') <= 50),
  CONSTRAINT description_length
    CHECK (length(meta->>'description') <= 150 OR meta->>'description' IS NULL),
  CONSTRAINT valid_status
    CHECK (meta->>'status' IN ('todo', 'in_progress', 'done'))
);

CREATE TABLE IF NOT EXISTS edges (
  id SERIAL PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type edge_type NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_id, target_id),
  CHECK(source_id != target_id)
);

ALTER TABLE edges
  ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}';
