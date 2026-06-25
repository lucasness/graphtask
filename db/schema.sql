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

ALTER TABLE graphs ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  ALTER TABLE graphs DROP CONSTRAINT IF EXISTS graph_settings_object;
  ALTER TABLE graphs ADD CONSTRAINT graph_settings_object CHECK (jsonb_typeof(settings) = 'object');
END $$;

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
    CHECK (length(meta->>'title') <= 100),
  CONSTRAINT description_length
    CHECK (length(meta->>'description') <= 200 OR meta->>'description' IS NULL),
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

-- Raise the title/description length caps (50→100, 150→200) on existing DBs.
-- CREATE TABLE IF NOT EXISTS won't relax constraints on tables that already
-- exist. Idempotent: drops and re-adds. Widening only, so existing rows pass.
DO $$ BEGIN
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS title_length;
  ALTER TABLE tasks
    ADD CONSTRAINT title_length
    CHECK (length(meta->>'title') <= 100);
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS description_length;
  ALTER TABLE tasks
    ADD CONSTRAINT description_length
    CHECK (length(meta->>'description') <= 200 OR meta->>'description' IS NULL);
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

-- Optimistic concurrency + writer provenance. `version` is bumped on every
-- write; clients send the version they read so the server can detect and
-- merge concurrent edits. `last_modified_by` records whether the most recent
-- write came from a human (browser) or an agent (skill / API client) — used
-- for conflict resolution (human wins on same-field collision) and for
-- future audit / UI affordances. Both default to safe values for existing
-- rows: version=0 means "no write tracked yet", last_modified_by=NULL means
-- "unknown".
ALTER TABLE tasks  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks  ADD COLUMN IF NOT EXISTS last_modified_by VARCHAR(16);
ALTER TABLE edges  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE edges  ADD COLUMN IF NOT EXISTS last_modified_by VARCHAR(16);
ALTER TABLE graphs ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE graphs ADD COLUMN IF NOT EXISTS last_modified_by VARCHAR(16);

DO $$ BEGIN
  ALTER TABLE tasks  DROP CONSTRAINT IF EXISTS tasks_last_modified_by_valid;
  ALTER TABLE tasks  ADD  CONSTRAINT tasks_last_modified_by_valid
    CHECK (last_modified_by IS NULL OR last_modified_by IN ('human', 'agent'));
  ALTER TABLE edges  DROP CONSTRAINT IF EXISTS edges_last_modified_by_valid;
  ALTER TABLE edges  ADD  CONSTRAINT edges_last_modified_by_valid
    CHECK (last_modified_by IS NULL OR last_modified_by IN ('human', 'agent'));
  ALTER TABLE graphs DROP CONSTRAINT IF EXISTS graphs_last_modified_by_valid;
  ALTER TABLE graphs ADD  CONSTRAINT graphs_last_modified_by_valid
    CHECK (last_modified_by IS NULL OR last_modified_by IN ('human', 'agent'));
END $$;

-- Pluggable auth (Phase B1): users + graph ownership. Both are opt-in at
-- runtime — `AUTH_PROVIDER=none` (the default) never writes to `users` and
-- leaves `graphs.owner_user_id` NULL. Legacy graphs (owner NULL) preserve the
-- URL-bearer access semantics from Phase A forever — see docs/auth.md.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));

ALTER TABLE graphs
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS graphs_owner_idx ON graphs (owner_user_id)
  WHERE owner_user_id IS NOT NULL;

-- Phase B5c (Google-Docs-faithful refactor): the graph's general-access tier.
-- 'none' = Restricted (only owner + explicit members); 'viewer' = anyone with
-- the URL can read; 'editor' = anyone with the URL can edit. The graph URL
-- /g/<gid> IS the share link — there is no separate invite-token URL.
-- Default is 'viewer' (friendlier-by-default for a collaboration tool); the
-- owner can lock it down via the Access section in the graph-modal.
ALTER TABLE graphs
  ADD COLUMN IF NOT EXISTS anon_role TEXT NOT NULL DEFAULT 'viewer';
DO $$ BEGIN
  ALTER TABLE graphs DROP CONSTRAINT IF EXISTS graphs_anon_role_check;
  ALTER TABLE graphs ADD CONSTRAINT graphs_anon_role_check
    CHECK (anon_role IN ('none', 'viewer', 'editor'));
  -- Update the column default too in case the table was created with the
  -- earlier 'none' default. Idempotent.
  ALTER TABLE graphs ALTER COLUMN anon_role SET DEFAULT 'viewer';
END $$;

-- Phase B5c also drops the old `is_public` column. Its two jobs (anonymous
-- read access, home-page directory listing) collapse into `anon_role` — see
-- the discussion in feedback_graphtask_auth_gotchas.md. Idempotent: existing
-- DBs lose the column on next boot; fresh DBs never had it.
DO $$ BEGIN
  -- Drop the partial index first so the column drop succeeds.
  DROP INDEX IF EXISTS graphs_is_public_idx;
  ALTER TABLE graphs DROP COLUMN IF EXISTS is_public;
END $$;

-- Phase B2/B5c: graph membership. The Share modal's "Add by email" form
-- inserts here directly when the invitee already has a Clerk account;
-- otherwise their row sits in `pending_members` until they sign in.
CREATE TABLE IF NOT EXISTS graph_members (
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (graph_id, user_id)
);
CREATE INDEX IF NOT EXISTS graph_members_user_idx ON graph_members (user_id);
-- Loosen the legacy CHECK to allow 'viewer' on existing DBs that already
-- have the 'editor'-only constraint.
DO $$ BEGIN
  ALTER TABLE graph_members DROP CONSTRAINT IF EXISTS graph_members_role_check;
  ALTER TABLE graph_members ADD CONSTRAINT graph_members_role_check
    CHECK (role IN ('viewer', 'editor'));
END $$;

-- Phase B5c: pending invites by email. Owner adds an email + role in the
-- Share modal; when that email signs in via Clerk, verifyAuth auto-converts
-- the pending row into a real `graph_members` row.
-- Email is stored lower-cased and matched case-insensitively against Clerk's
-- primary email address.
CREATE TABLE IF NOT EXISTS pending_members (
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (graph_id, email)
);
CREATE INDEX IF NOT EXISTS pending_members_email_idx ON pending_members (email);

-- Phase B3: invite tokens (Pattern B — GitHub-style click-to-claim links).
-- Owner POSTs to mint one; the plaintext token is returned ONCE and stored as
-- SHA-256 only. Recipient hits /api/invites/:token/claim, which becomes a
-- graph_members row and deletes the invite (single-use). Revocation is a
-- soft-delete via revoked_at so a leaked token can be killed without losing
-- audit context.
CREATE TABLE IF NOT EXISTS invite_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor')),
  -- anon_role: what holders WITHOUT a Clerk session get when they click the
  -- link. Default 'viewer' mirrors Google Docs' "Anyone with the link can
  -- view". Set to 'none' for strict "must sign in to view" mode, 'editor'
  -- for fully-open collaboration. `role` is what signed-in claimers become.
  anon_role TEXT NOT NULL DEFAULT 'viewer'
    CHECK (anon_role IN ('none', 'viewer', 'editor')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE invite_tokens
  ADD COLUMN IF NOT EXISTS anon_role TEXT NOT NULL DEFAULT 'viewer';
DO $$ BEGIN
  ALTER TABLE invite_tokens DROP CONSTRAINT IF EXISTS invite_tokens_anon_role_check;
  ALTER TABLE invite_tokens
    ADD CONSTRAINT invite_tokens_anon_role_check
    CHECK (anon_role IN ('none', 'viewer', 'editor'));
END $$;
CREATE INDEX IF NOT EXISTS invite_tokens_graph_idx ON invite_tokens (graph_id)
  WHERE revoked_at IS NULL;

-- Phase B4: app-issued agent tokens. Lets a Claude Code agent (or any
-- non-browser client) authenticate as a specific user without going through
-- Clerk. The plaintext token is returned once at mint and never again;
-- token_hash is the only thing persisted. Revoking sets `revoked_at` and the
-- next bearer-auth attempt returns 401 immediately — no grace period.
CREATE TABLE IF NOT EXISTS agent_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_tokens_user_idx ON agent_tokens (user_id)
  WHERE revoked_at IS NULL;

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

-- Per-(user, graph) follow preference for the camera-follow toggle.
-- Absent row = "use the user's default" (see user_prefs). Authed users only;
-- anons store the equivalent in localStorage (gt_follow_default and
-- gt_follow_graph_<gid>).
CREATE TABLE IF NOT EXISTS user_graph_prefs (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  graph_id     TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  agent_follow BOOLEAN NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, graph_id)
);

-- Per-user global default for "new graphs I haven't toggled yet". Toggling
-- on any graph also writes-through to this row, so the user's most recent
-- choice becomes the default for FUTURE graphs without changing existing
-- per-graph rows.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  agent_follow_default BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Owner of the row's most recent write — needed for owner-agent precedence
-- in mergeFields when two agents conflict on the same field. Nullable for
-- anonymous writers and for legacy rows written before this column existed.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_modified_by_user UUID
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE edges ADD COLUMN IF NOT EXISTS last_modified_by_user UUID
  REFERENCES users(id) ON DELETE SET NULL;

-- E14.1: batch-upsert idempotency key + workflow-run attribution. Both columns
-- are nullable and additive — the existing single-write paths never set them,
-- so legacy rows and the canvas are unaffected. `external_id` is a client
-- supplied stable key so re-running a dynamic-workflow round UPSERTs the same
-- node instead of duplicating; the partial-unique index enforces that per
-- graph while allowing unlimited NULLs (ad-hoc creates without a key). `run_id`
-- records the run that CREATED the row: it's set on INSERT and preserved across
-- idempotent re-runs (re-upserts don't overwrite it), so a run's additions can
-- be inspected or undone in one query — `DELETE ... WHERE run_id = :id` removes
-- exactly what that run introduced (POST /api/graphs/:gid/batch — src/routes/batch.js).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE edges ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE edges ADD COLUMN IF NOT EXISTS run_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_graph_external_id_uniq
  ON tasks(graph_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_run_id_idx ON tasks(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS edges_run_id_idx ON edges(run_id) WHERE run_id IS NOT NULL;

-- E15.A1: edge `purpose` as the canonical edge field. purpose ∈
-- {'required for','supports','contradicts','related to'} (directed source→
-- target). The existing `type` enum is KEPT as a derived-internal structural
-- column (purpose='required for' → 'dependency', everything else → 'related')
-- so every cycle-detection + dependency-traversal query keeps keying off `type`
-- with no SQL change. Additive + idempotent:
--   1. ADD COLUMN with DEFAULT 'related to' backfills every legacy row.
--   2. The UPDATE promotes the dependency rows to 'required for'. Keyed on
--      type='dependency' (and only when not already promoted) so it's a no-op
--      on every boot after the first and never churns correctly-synced rows.
ALTER TABLE edges ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'related to';
DO $$ BEGIN
  ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_purpose_valid;
  ALTER TABLE edges ADD CONSTRAINT edges_purpose_valid
    CHECK (purpose IN ('required for', 'supports', 'contradicts', 'related to'));
END $$;
UPDATE edges SET purpose = 'required for'
 WHERE type = 'dependency' AND purpose <> 'required for';

-- Graph-scoped uploaded image bytes. Referenced by `background-image` in a
-- task's frontmatter as `/api/graphs/<gid>/uploads/<id>`. The bytes live in
-- Postgres so a self-hosted instance needs nothing beyond the existing DB.
-- Cascade on graph delete; node-level cleanup (an upload whose only
-- referencing node was deleted) is a reap-later concern tracked in the
-- roadmap rather than something we trigger inline.
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY DEFAULT generate_short_graph_id(),
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  bytes BYTEA NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT uploads_content_type_valid
    CHECK (content_type IN ('image/png','image/jpeg','image/gif','image/webp','image/svg+xml')),
  CONSTRAINT uploads_byte_size_positive
    CHECK (byte_size > 0)
);
CREATE INDEX IF NOT EXISTS uploads_graph_id_idx ON uploads(graph_id);

-- Dense-retrieval chunk store for semantic search (graph task #190, P2.2).
-- One node → many title-prefixed passages (see src/search/chunking.js); each
-- carries its embedding for ANN search, then results collapse back to nodes by
-- task_id (max-pool) and fuse with the lexical leg via RRF.
--
-- The WHOLE block is guarded on pgvector being present. Both deploy paths now
-- ship it: the self-host image bakes in postgresql-17-pgvector (see Dockerfile)
-- and the Wafer worker image gained vector 0.8.2 (2026-06-07) — the guard
-- remains for self-hosters running their own pre-pgvector Postgres, where this
-- is a clean no-op and the dense leg falls back to in-memory ranking.
-- schema.sql is applied on every boot, so this must never error when the
-- extension is absent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    -- DDL is EXECUTE'd so the halfvec type / hnsw opclass are only resolved
    -- after the extension is guaranteed loaded (and never parsed where absent).
    EXECUTE $ddl$
      CREATE TABLE IF NOT EXISTS task_chunks (
        id              SERIAL PRIMARY KEY,
        task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        graph_id        TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
        chunk_index     INTEGER NOT NULL,
        chunk_text      TEXT NOT NULL,
        -- sha256 of the whole node content: re-chunk only when this changes,
        -- so an unchanged node skips re-embedding entirely (#190 write path).
        content_sha     TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        -- BGE-M3 default (1024-dim) — the size-driven pick from #190. halfvec
        -- halves storage vs full float for negligible recall loss.
        embedding       halfvec(1024),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (task_id, chunk_index)
      )
    $ddl$;
    -- task_id IS the chunk→node link; CASCADE auto-cleans chunks when a node is
    -- deleted. graph_id is the "this graph" scope filter (and the column a
    -- later cross-graph access filter rides on).
    EXECUTE 'CREATE INDEX IF NOT EXISTS task_chunks_task_id_idx ON task_chunks(task_id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS task_chunks_graph_id_idx ON task_chunks(graph_id)';
    -- HNSW over cosine. m/ef are immaterial at <1k vectors (#190) but cost
    -- nothing to set now and matter once a graph grows.
    EXECUTE 'CREATE INDEX IF NOT EXISTS task_chunks_embedding_idx ON task_chunks '
         || 'USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64)';
  ELSE
    RAISE NOTICE 'pgvector not available — skipping task_chunks (dense store deferred; eval runs in-memory)';
  END IF;
END $$;
