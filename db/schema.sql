CREATE EXTENSION IF NOT EXISTS pgrouting CASCADE;

DO $$ BEGIN
  CREATE TYPE edge_type AS ENUM ('dependency', 'related');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- graphs.id is a short random string. 8 chars from a 31-char alphabet
-- (lowercase letters + digits, minus 0/1/i/l/o to avoid visual ambiguity).
-- ~850 billion combinations — collision probability is negligible for a
-- personal tool, but the route still retries once on the unique violation.
CREATE OR REPLACE FUNCTION generate_short_graph_id() RETURNS TEXT AS $$
DECLARE
  alphabet TEXT := 'abcdefghjkmnpqrstuvwxyz23456789';
  result TEXT := '';
  i INT;
BEGIN
  FOR i IN 1..8 LOOP
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS graphs (
  id TEXT PRIMARY KEY DEFAULT generate_short_graph_id(),
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT graph_id_format
    CHECK (id ~ '^[a-z0-9]{4,32}$'),
  CONSTRAINT graph_name_required
    CHECK (length(trim(name)) > 0),
  CONSTRAINT graph_name_length
    CHECK (length(name) <= 80),
  CONSTRAINT graph_description_length
    CHECK (description IS NULL OR length(description) <= 500)
);

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS tasks_graph_id_idx ON tasks(graph_id);

CREATE TABLE IF NOT EXISTS edges (
  id SERIAL PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type edge_type NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_id, target_id),
  CHECK(source_id != target_id)
);

CREATE INDEX IF NOT EXISTS edges_graph_id_idx ON edges(graph_id);

-- Bump graphs.updated_at whenever any task or edge in a graph changes.
-- "Activity" semantic: create/update/delete of nodes or edges all count.
CREATE OR REPLACE FUNCTION bump_graph_updated_at() RETURNS TRIGGER AS $$
BEGIN
  UPDATE graphs SET updated_at = NOW()
   WHERE id = COALESCE(NEW.graph_id, OLD.graph_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bump_on_task_change ON tasks;
CREATE TRIGGER bump_on_task_change
  AFTER INSERT OR UPDATE OR DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION bump_graph_updated_at();

DROP TRIGGER IF EXISTS bump_on_edge_change ON edges;
CREATE TRIGGER bump_on_edge_change
  AFTER INSERT OR UPDATE OR DELETE ON edges
  FOR EACH ROW EXECUTE FUNCTION bump_graph_updated_at();
