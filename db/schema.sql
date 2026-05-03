DO $$ BEGIN
  CREATE TYPE edge_type AS ENUM ('dependency', 'related');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- graphs.id is a random string. 16 chars from a 31-char alphabet
-- (lowercase letters + digits, minus 0/1/i/l/o to avoid visual ambiguity).
-- ~31^16 ≈ 2^79 combinations — unguessable in practice, which is the whole
-- privacy model: the URL is the bearer token. The route still retries on the
-- negligible chance of a unique-violation collision.
CREATE OR REPLACE FUNCTION generate_short_graph_id() RETURNS TEXT AS $$
DECLARE
  alphabet TEXT := 'abcdefghjkmnpqrstuvwxyz23456789';
  result TEXT := '';
  i INT;
BEGIN
  FOR i IN 1..16 LOOP
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS graphs (
  id TEXT PRIMARY KEY DEFAULT generate_short_graph_id(),
  name TEXT NOT NULL,
  description TEXT,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  -- Per-graph overrides for font / font_color / bg_color. Missing keys
  -- fall back to the viewer's app-level Defaults at render time. Stored
  -- as JSONB so future per-graph settings can be added without a schema
  -- change. Always an object — never NULL — so client code can do
  -- `graph.settings.font || appDefault.font` without a null check.
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT graph_id_format
    CHECK (id ~ '^[a-z0-9]{4,32}$'),
  CONSTRAINT graph_name_required
    CHECK (length(trim(name)) > 0),
  CONSTRAINT graph_name_length
    CHECK (length(name) <= 80),
  CONSTRAINT graph_description_length
    CHECK (description IS NULL OR length(description) <= 500),
  CONSTRAINT graph_settings_object
    CHECK (jsonb_typeof(settings) = 'object')
);

-- Migration for DBs created before is_public / settings existed.
ALTER TABLE graphs ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE graphs ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  ALTER TABLE graphs DROP CONSTRAINT IF EXISTS graph_settings_object;
  ALTER TABLE graphs ADD CONSTRAINT graph_settings_object CHECK (jsonb_typeof(settings) = 'object');
END $$;

-- Partial index for the home-page list query (only public graphs are listed).
CREATE INDEX IF NOT EXISTS graphs_is_public_idx ON graphs(is_public) WHERE is_public = TRUE;

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
    CHECK (meta->>'status' IN ('todo', 'in_progress', 'review', 'done'))
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

-- Migrate the valid_status CHECK on tasks to include 'review' on existing
-- DBs (CREATE TABLE IF NOT EXISTS won't alter constraints on tables that
-- already exist). Idempotent: drops and re-adds the constraint.
DO $$ BEGIN
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS valid_status;
  ALTER TABLE tasks
    ADD CONSTRAINT valid_status
    CHECK (meta->>'status' IN ('todo', 'in_progress', 'review', 'done'));
END $$;

-- Bump graphs.updated_at whenever any task or edge in a graph changes, AND
-- emit a pg_notify event so SSE subscribers can push the change to live
-- viewers. Payload: { graph_id, kind: 'tasks'|'edges', op: 'INSERT'|...,
-- id: <affected row id> }. The id lets the client follow the agent visually
-- (pan camera, open side panel) instead of just refetching blindly.
CREATE OR REPLACE FUNCTION bump_graph_updated_at() RETURNS TRIGGER AS $$
DECLARE
  gid TEXT := COALESCE(NEW.graph_id, OLD.graph_id);
BEGIN
  UPDATE graphs SET updated_at = NOW() WHERE id = gid;
  PERFORM pg_notify(
    'graph_change',
    json_build_object(
      'graph_id', gid,
      'kind', TG_TABLE_NAME,
      'op', TG_OP,
      'id', COALESCE(NEW.id, OLD.id)
    )::text
  );
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

-- The original FKs on graph_id were ON DELETE CASCADE only. ID rotation
-- (POST /api/graphs/:id/rotate-id) needs ON UPDATE CASCADE so changing
-- graphs.id automatically propagates to tasks.graph_id and edges.graph_id.
-- Idempotent: drops the existing constraints by name and re-adds them.
DO $$ BEGIN
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_graph_id_fkey;
  ALTER TABLE tasks
    ADD CONSTRAINT tasks_graph_id_fkey
    FOREIGN KEY (graph_id) REFERENCES graphs(id)
    ON DELETE CASCADE ON UPDATE CASCADE;

  ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_graph_id_fkey;
  ALTER TABLE edges
    ADD CONSTRAINT edges_graph_id_fkey
    FOREIGN KEY (graph_id) REFERENCES graphs(id)
    ON DELETE CASCADE ON UPDATE CASCADE;
END $$;

-- Resolve any pre-existing duplicate normalized names by suffixing later
-- copies with " (2)", " (3)", etc., so the unique index below can be built.
-- Truncate the base name to leave room for the suffix within the 80-char
-- name length cap. Idempotent / safe to re-run.
DO $$
DECLARE
  r RECORD;
  base TEXT;
  suffix TEXT;
BEGIN
  FOR r IN
    SELECT id, name,
           row_number() OVER (
             PARTITION BY lower(regexp_replace(name, '\s+', '', 'g'))
             ORDER BY created_at, id
           ) AS rn
      FROM graphs
  LOOP
    IF r.rn > 1 THEN
      suffix := ' (' || r.rn || ')';
      base := substr(r.name, 1, 80 - length(suffix));
      UPDATE graphs SET name = base || suffix WHERE id = r.id;
    END IF;
  END LOOP;
END $$;

-- The previous global unique-on-normalized-name index was dropped: in a no-auth
-- bearer-token model it let anyone probe whether a graph by a given name
-- existed via the 409 response on POST. The dedup-suffix backfill above is
-- left in place since it's idempotent on existing DBs (and a no-op on fresh
-- ones) — we don't undo prior renames because users may have come to identify
-- their graph as "X (2)".
DROP INDEX IF EXISTS graphs_name_norm_uniq;

-- Edge curve metadata used to be a single signed number (perpendicular
-- offset; weight implicitly 0.5). It's now an object {distance, weight}
-- so users can slide the bezier control point along the edge as well as
-- perpendicular. Convert any existing number-form curve to the object form
-- with weight=0.5 (the previous implicit default). Idempotent.
UPDATE edges
   SET meta = jsonb_set(
         meta,
         '{curve}',
         jsonb_build_object('distance', meta->'curve', 'weight', 0.5)
       )
 WHERE jsonb_typeof(meta->'curve') = 'number';

-- One-time backfill: any pre-existing graphs with shorter IDs (e.g. the old
-- 8-char format) get rotated to a fresh 16-char ID. Safe to re-run; on a
-- fresh DB it's a no-op. The cascade above carries tasks/edges along.
DO $$
DECLARE
  old_id TEXT;
  new_id TEXT;
  attempts INT;
BEGIN
  FOR old_id IN SELECT id FROM graphs WHERE length(id) < 16 LOOP
    attempts := 0;
    LOOP
      new_id := generate_short_graph_id();
      BEGIN
        UPDATE graphs SET id = new_id WHERE id = old_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        attempts := attempts + 1;
        IF attempts >= 5 THEN
          RAISE EXCEPTION 'failed to allocate unique graph id after % attempts', attempts;
        END IF;
      END;
    END LOOP;
  END LOOP;
END $$;
