# graphtask

A graph-based task manager. Tasks are nodes; relationships between them are
edges. Each user keeps multiple separate **graphs** — pick one from the left
sidebar, sketch tasks on the canvas, edit them in a right-side inspector.

Beyond software plans, people use graphtask for personal planning too —
medical treatment, physical therapy, training regimens, career paths —
anywhere structure itself is the artifact.

The canvas updates **live** via Server-Sent Events, so collaborators (and
LLM agents driving the API via the bundled
[skill](.claude/skills/graphtask/SKILL.md)) appear in real time — the camera
pans to whatever was just touched, and a brief flash highlights the change.

---

## Getting started

Pick the path that matches how you want to run graphtask. To drive it
from a Claude Code agent regardless of which path you pick, see
[Using it with an agent](#using-it-with-an-agent).

### 1. Use the hosted version

**<https://graphtask.wafers.live>** — no setup, no install.

Open the link, click `+` to create a graph, start sketching tasks. Each
graph gets a 16-char random id (`/g/<id>`) that acts as the access
token — share the URL to collaborate, rotate the id from the graph
settings (`⋮` → Rotate) to revoke.

The hosted instance runs with `AUTH_PROVIDER=clerk`, so the sidebar
shows a sign-in button (email OTP). Anonymous use still works — you
just don't get owned-graph features (My graphs / Shared with me
bucketing, member invitations, per-graph access tier). The "Auth
modes" subsection under "Run locally without Docker" below covers
what changes when you sign in.

### 2. Run locally with Docker

The simplest local path. Everything — Node and Postgres — runs inside a
single container, so you don't have to match versions or install anything
language-specific.

**Prerequisites**

- **Docker Desktop** (or the Docker engine).

**Environment variables**

- `HOST_PORT` _(optional, default `3000`)_ — host port to publish the app on.

**Setup**

```sh
git clone https://github.com/lucasness/graphtask.git
cd graphtask
docker compose up
```

Open <http://localhost:3000>.

The first run takes a minute or two while Docker pulls the Postgres image
and initializes the database. Subsequent starts are a few seconds.

Your graphs are stored in a Docker named volume (`pgdata`), so they survive
`docker compose down` / `up` cycles. Wipe everything with
`docker compose down -v`.

Pasted-into-editor and dropped-onto-canvas images live in the same database
(`uploads` table, BYTEA bytes), so they also sit on the `pgdata` volume and
count against its disk usage. The default per-image cap is 5 MB; raise or
lower it via `GRAPHTASK_UPLOAD_MAX_BYTES` if needed.

**Common commands**

```sh
docker compose up -d        # run in the background
docker compose logs -f      # tail logs
docker compose down         # stop, keep data
docker compose down -v      # stop, wipe data
HOST_PORT=3001 docker compose up   # serve on a different host port
```

### 3. Run locally without Docker

For development, or if you'd rather not use Docker. You install Node and
Postgres yourself and point the app at your local database.

**Prerequisites**

- **Node 22+** — the start script uses `node --env-file`, a Node 22 flag.
- **PostgreSQL 14+** — any modern version. No extensions needed; all graph
  traversal (including shortest-path) runs as recursive CTEs in plain SQL.

**Environment variables** (resolved in `src/db.js` / `src/server.js`, loaded
from `.env` by `npm start`)

- `DATABASE_URL` — full Postgres connection string. Takes precedence over the
  pair below.
- `PG_BOOTSTRAP_URL` + `DATABASE_NAME` — alternative: the URL's path is
  replaced with `/<DATABASE_NAME>` at runtime.
- If neither is set, falls back to `postgresql://postgres@localhost/graphtask`.
- `PORT` _(optional, default `3000`)_ — port the Express server binds to on
  `127.0.0.1`.
- `AUTH_PROVIDER` _(optional, default `none`)_ — see "Auth modes" below.
- `GRAPHTASK_UPLOAD_MAX_BYTES` _(optional, default `5242880` = 5 MB)_ — per-image
  upload cap in raw bytes. Images are stored as BYTEA inside the same Postgres
  database (no extra object store), so this also bounds how big a single row in
  the `uploads` table can get.

**The database must already exist; the schema does not.** graphtask applies
`db/schema.sql` automatically on every boot — it's idempotent (`CREATE TABLE IF
NOT EXISTS`, guarded `ALTER`s), so there is no manual migration step and no
`psql -f` to run. What the app does *not* do is create the database itself: that
has to exist before it connects, or boot fails at the first query. Create it
with `createdb <name>`, or use the database your Postgres host already gave you
(a managed provider like RDS / Supabase / Neon hands you one — point
`DATABASE_URL` at it and the first boot populates the tables). That single
prerequisite — an existing, reachable database — is the same in every
environment; only *how* you obtain the database differs.

See `.env.example` for a fully-commented template.

**Auth modes**

graphtask supports two deployment shapes; pick one at process start via
`AUTH_PROVIDER`. The default is no auth, and that's the recommended mode for
local dev and single-user self-hosted installs.

| `AUTH_PROVIDER` | Required env | Behavior |
|---|---|---|
| `none` _(default)_ | — | No sign-in UI. Every graph id is a bearer token, exactly as before. |
| `clerk` | `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Browser loads Clerk JS for email-OTP sign-in. Graphs created by signed-in users get an `owner_user_id`, an `anon_role` tier (`none` / `viewer` / `editor`) for URL holders, and an explicit member list. |

**The access model in one paragraph.** A graph belongs to at most one
`owner_user_id`. The owner can add `viewer` or `editor` members by
email; rows for emails without a Clerk account yet sit in
`pending_members` until that email signs in and auto-claims them. On
top of that, every graph carries an `anon_role` tier (`none` / `viewer`
/ `editor`) that decides what someone holding the URL but neither the
owner nor a member gets — `none` returns 403, `viewer` is read-only,
`editor` is read+write attributed anonymously. Legacy graphs
(`owner_user_id IS NULL`) always behave as URL-bearer regardless of
mode; flipping a no-auth deployment to Clerk doesn't retroactively
lock them down. Agents authenticate with a `gt_*` bearer token minted
from the in-app key-icon panel; the server discriminates them from
Clerk session JWTs (which start with `eyJ`) by prefix-checking the
`Authorization` header.

Deeper details (sharing flows, client-side storage, live access-change
propagation, what's out of scope) live under
[Sharing & access model — deep dive](#sharing--access-model--deep-dive).

**Setting up Clerk**

1. Create a Clerk app at <https://dashboard.clerk.com> (use a separate
   app for dev vs. prod).
2. Enable **Email address** as the sole sign-in identifier and **Email
   verification code** (OTP) as the verification strategy. graphtask
   doesn't wire up any other Clerk sign-in method — leaving them
   enabled won't break anything, but they won't appear in the modal
   either.
3. Copy your **Publishable key** and **Secret key** from the Clerk
   dashboard into your `.env`:
   ```sh
   CLERK_PUBLISHABLE_KEY=pk_test_...   # or pk_live_... in prod
   CLERK_SECRET_KEY=sk_test_...        # or sk_live_... in prod
   AUTH_PROVIDER=clerk
   ```
4. Restart the server. The boot log should mention the Clerk adapter
   loading; the browser's `/api/config` will report `auth_enabled: true`.

**Setup**

```sh
git clone https://github.com/lucasness/graphtask.git
cd graphtask
npm install

# Create the database (the app needs it to exist; it won't create it for you).
# You do NOT need to load the schema by hand — db/schema.sql is applied
# automatically, and idempotently, on every server boot.
createdb graphtask

# npm start runs `node --env-file=.env`, which errors if .env is missing.
# Create one (empty is fine) and/or set vars inline:
touch .env
DATABASE_URL=postgresql://localhost/graphtask npm start
```

Open <http://localhost:3000>.

**Tests**

`npm test` spins up and tears down a `graphtask_test` database on your local
Postgres. No extensions required.

Production tuning notes (open-file limits, single-process presence) live
under [Production notes](#production-notes).

---

## Using it with an agent

graphtask ships a Claude Code skill (`SKILL.md`) so an LLM agent can drive
your graphs end-to-end while you watch the canvas update live. Works on
any deploy path — hosted, Docker, or local.

### Set up

```sh
# 1. Install the skill (one-time; available in every project on your machine).
#    Also merges presence-cleanup hooks into ~/.claude/settings.json
#    (with a timestamped backup) so the agent's 🤖 avatar blinks out
#    cleanly when it stops working.
bash <(curl -fsSL https://raw.githubusercontent.com/lucasness/graphtask/main/install.sh)

# 2. Install jq (the skill's recipes and the hooks parse JSON with it)
brew install jq        # macOS — or: apt install jq / apk add jq

# 3. Point the agent at your graphtask instance
export GRAPHTASK_BASE_URL="https://graphtask.wafers.live"   # hosted
# export GRAPHTASK_BASE_URL="https://graphtask.example.com"     # self-hosted
# export GRAPHTASK_BASE_URL="http://localhost:3000"             # local Docker / npm start

# 4. Mint and export an agent token — REQUIRED on auth-enabled instances.
#    (The hosted instance always is; Docker/local only if you opted in.)
#    See "Mint an agent token" below for the mint flow.
export GRAPHTASK_AGENT_TOKEN=gt_...

# 5. Restart Claude Code so the new hooks load, then in any project:
cd ~/projects/your-project
claude
# Prompt: "Turn this plan into a graph" or "Track this in graphtask"
```

What `install.sh` does — also visible in the script itself:
- copies `SKILL.md` to `~/.claude/skills/graphtask/`
- merges two hooks into `~/.claude/settings.json` (with a `.bak.<timestamp>` backup):
  - **SessionStart**: clears any stale agent-session files from a prior crash
  - **Stop**: departs the agent's presence at the end of every response so the 🤖 avatar blinks out cleanly when the agent stops working

Override `CLAUDE_HOME` if your Claude config lives somewhere other than `~/.claude`.

If you're hacking on graphtask itself, you can skip the personal install
— `claude` run from inside the cloned repo auto-discovers the skill at
`.claude/skills/graphtask/SKILL.md`.

The agent creates a graph on first use and writes its id to
`.graphtask/graph-id` in the project. It prints the URL after creating —
open it in a browser to watch updates live.

### Mint an agent token

If your graphtask instance has `AUTH_PROVIDER=clerk` (the hosted version
always does; local / Docker setups only if you opted in), the agent
needs a `gt_*` token to attribute writes to your account. Without one,
the skill's preflight refuses to run on auth-enabled instances —
the alternative is silently producing orphan graphs (owner-less,
invisible in your "My graphs" sidebar).

1. **Mint.** Sign in to the app, click the key icon in the sidebar,
   click Generate. The modal shows the `gt_…` string **exactly once** —
   copy it immediately. After that, only the hash is stored server-side;
   if you lose the plaintext, delete the token and mint a new one.
2. **Export it somewhere Claude Code will see it.** Pick whichever fits:
   - **Shell rc** (`~/.zshrc`, `~/.bashrc`): `export GRAPHTASK_AGENT_TOKEN=gt_...`
     — every future shell, every future Claude Code session.
   - **`~/.claude/settings.json` `env` block**: scoped to Claude Code
     specifically, works regardless of which shell you launched it from.
   - **Current terminal only**: `export GRAPHTASK_AGENT_TOKEN=gt_...`
     then run `claude` — works until you close the terminal.
   - **Note:** project-level `.env` files are NOT auto-loaded by Claude
     Code; don't expect that to work without extra plumbing.
3. **Verify.** Open a Claude Code session, ask the agent to create a
   test graph. It should print the URL after creating, and the graph
   should appear in your "My graphs" sidebar (not "Shared with me" or
   nowhere).

To rotate a leaked or stale token, delete it from the Agent tokens
panel and mint a new one. Tokens you've never used can be deleted
freely — the modal lists creation date and last-used time so you can
audit.

### What the agent can do

**Give the agent a concrete multi-step plan.** Vague prompts like
*"help me with auth"* don't produce useful graphs. Multi-step prompts
work much better:

> *"I need to refactor the auth middleware: audit current session-token
> usage, swap to httpOnly cookies, update the auth tests, then deploy
> behind a feature flag."*

The agent should materialize this as 4–5 tasks with dependency edges
**before** writing any code, so you see the structure first, then watch
each task light up as it works through them.

**The "review" handshake.** The agent never sets `done` itself. When it
thinks a task is finished, it moves to `review` (yellow). You confirm
in one of two ways:

1. **Approve** — click the task in the UI, change status to `done`. The
   agent's downstream tasks become eligible (use `/tasks/ready` to see
   what's now ready).
2. **Push back** — reply with feedback ("the cookie wrapper needs to
   handle SameSite=None"). The agent should re-read the task body and
   update it with the new requirement, then re-do the work.

Don't set `done` without skimming the body — that's the whole point of
the gate.

**Recovering when the agent gets stuck or wanders.** Useful prompts:

- *"What's blocking task X?"* — agent calls `/blockers`, summarizes.
- *"What can you work on next?"* — agent calls `/ready`.
- *"Which review tasks would unblock something if I confirmed them?"* —
  agent loops over review tasks calling `/unblocks` (documented pattern
  in the skill body).
- *"Update the graph to reflect what you just learned about X"* —
  agent reads relevant task bodies and patches them with new findings.

**If the agent isn't using the skill automatically.** The skill is
designed to fire after Plan mode and on multi-step prompts, but
description-matching is heuristic. Force it explicitly with phrases
like *"track this in graphtask"*, *"turn this into a graphtask graph"*,
or *"use the graphtask skill"*.

**One graph per project (usually).** The agent persists the active graph
id in `.graphtask/graph-id` in the project root. That file is
bearer-token equivalent and goes in `.gitignore` (the skill's setup
step adds it for you). To work on a different project's graph, run the
agent from a different directory.

**Sharing and revoking access.** Each graph's URL is its only access
control. To collaborate, share `https://graphtask.wafers.live/g/<id>`
(or your hosted URL). To revoke a leaked link, open the graph's `⋮`
settings → Sharing → Rotate. The old URL 404s; tasks/edges follow to
the new id automatically.

**Tidy a sprawling graph.** If the canvas is getting unwieldy after
lots of edits, press `T` (or click the Tidy toolbar button) to re-run
the layout compactly and refit. Overrides any custom node placements,
so use it when you'd rather start with a clean arrangement than
preserve manual positions.

**Don't micromanage the structure.** Let the agent create tasks and
edges. If you don't like the structure, edit it in the UI — the agent
is told to re-read task content before patching, so it'll notice. Don't
dictate every task title; trust the breakdown.

**When NOT to use the skill.** Single-step changes (a typo fix, a
quick question, a one-line tweak) don't benefit from graph overhead.
The skill itself tells the agent to skip graph creation for these. If
the agent creates a one-task graph for something trivial, push back:
*"skip the graph for this."*

### Watching the agent work

Open the graph URL in a tab while you work. The agent's edits land
on the canvas within ~150 ms via SSE. The camera pans to whatever the
agent just touched, the side panel opens to show the new content, and
the node briefly flashes in a color matching the action:

- **blue dashed border** — new task created
- **orange / yellow / green underlay** — task moved to `in_progress` /
  `review` / `done` respectively
- **purple underlay** — body edited without changing status

Watching the agent work this way is most of the value — the graph IS
the visible artifact of the agent's progress.

### Turning off tracking

Two independent controls in the top-right corner:

- **LIVE / QUIET push-button** (below your avatar) — toggles per-graph
  auto-follow. When QUIET, the camera doesn't pan and the panel doesn't
  auto-open on agent edits; color flashes still play so you can see
  where work is happening. Toggling sets the default for new graphs
  without changing graphs you've already toggled.
- **Eye icon** — hides the entire presence chrome (avatar bar + LIVE
  button) for this browser. Per-user, global. Click again to restore.

---

## Using it with hotkeys

The "View" column indicates which views the key is active in. Graph =
the canonical cytoscape view; Kanban = the column-grouped lens.
Cmd/Ctrl-modified shortcuts and overlay-internal keys (Enter/Esc inside
an edit overlay) always apply.

| Key | View | Behavior |
|---|---|---|
| `F` | Graph | Fit graph to viewport (preserves layout) |
| `T` | Graph | Tidy: re-run layout with tight spacing, persist new positions, then fit. Overrides any custom node placements |
| `G` | Both | Graph: create a node at the visible-area center. Kanban: create a new task in the selected card's column (or Todo if no selection) |
| `S` | Both | Graph: cycle selected node status; Enter saves, Esc cancels. Kanban: directly cycle selected card's status (drag is the primary UX; S is "next status, no confirm") |
| `B` | Graph | Open color palette for selected nodes/edges |
| `E` | Graph | Start edge creation, cycle in-progress edge direction, or cycle selected edge direction |
| `Enter` | Graph | Commit pending explicit edit session |
| `Cmd/Ctrl+Enter` | Both | Commit new-node creation from anywhere (graph view); save panel edits (both views) |
| `Esc` | Both | Cancel current edit, close panel, or clear selection |
| `Backspace/Delete` | Graph | Open delete confirmation |
| Arrow keys | Graph | Move selection to nearest node/edge in that direction; inside color palette, navigate swatches |
| Cmd/Ctrl drag | Graph | Rubber-band select nodes and edge midpoints |
| `Cmd/Ctrl+K` | Both | Open settings |

### Editing flows

**Nodes**

- Clicking empty canvas creates a pending Cytoscape node with id `__pending__`.
- Pending nodes are visible immediately but are not persisted until the title
  is committed (Enter or Cmd/Ctrl+Enter).
- Existing task fields autosave with a short debounce.
- Status cycling is optimistic: `S` changes the visible status; Enter saves
  and Esc restores.
- Inline title editing uses an HTML contenteditable overlay positioned over
  the Cytoscape node. It scales with zoom and resizes the Cytoscape node.

**Edges**

- Pressing `E` with node(s) selected starts edge creation. A hidden phantom
  node follows the cursor and preview edges connect from the selected sources.
- During edge creation, `E` cycles `forward → related → backward → forward`.
- Clicking a target node commits created edges. Clicking empty canvas starts
  a pending target node and keeps preview edges until that node is saved.
- Pressing `E` with one edge selected starts an optimistic direction/type
  edit. The edge turns dashed while the edit is pending; Enter saves, Esc
  restores.
- Backward dependency edits are represented visually with `dir-backward`
  until save, then the server PATCH swaps source/target.
- Hover an edge to reveal the curve handle. The handle sits *on* the rendered
  curve at `B(t = weight)` — the bezier sample at the weight parameter. Drag
  it freely in 2D: parallel position along the edge maps to `curve.weight`
  via inverse-smoothstep, perpendicular distance back-solves into
  `curve.distance` (bulge height). Weight is clamped per-edge to a dynamic
  range derived from each node's size + a small margin, so the dot can
  never land inside either endpoint node — the bounds intersect the static
  `[0.10, 0.90]` range. Note: changing weight slides the bulge along the
  edge but doesn't change *how sharply* the curve bends; that's controlled
  by `distance` (a quadratic bezier's perpendicular peak is always at
  parameter 0.5 with magnitude `0.5·distance`).
- Dependency cycle detection wraps the cycle-check + INSERT/UPDATE in a
  single Postgres transaction with a SHARE ROW EXCLUSIVE lock on `edges`,
  so concurrent edge writers can't slip a cycle past the check.

**Color palette**

- `B` opens the palette for selected nodes, edges, or mixed selections.
- Palette values come from the Flexoki dark theme used by the app.
- Swatches show the actual color that will be applied to node fill or edge
  line/arrow color.
- Arrow keys navigate as a 2D 5-column grid. Enter or click applies and saves.
- Color changes affect background/edge color, not the selection highlight.

**Graph metadata**

- `⋮` on a sidebar card opens `#graph-modal` with name + description fields
  and Save / Delete buttons. Esc or backdrop click cancels. Delete reuses the
  shared `confirmDelete` modal.

---

## Details

Reference material for agent implementers and contributors hacking on
graphtask itself. If you're just using the app or the agent skill, you
can stop here.

### Stack

- Backend: Express 5 on Node 22, PostgreSQL (any modern version), `pg`, and `yaml`.
- Frontend: Vanilla JS, Cytoscape.js, TOAST UI Editor, and CSS using a Flexoki
  dark palette. No build step.
- Tests: Vitest and supertest.
- Package manager: npm.

### Layout

```text
src/
  server.js          starts Express on PORT, binds to 127.0.0.1
  app.js             builds the Express app and mounts routers
  db.js              shared pg pool + withTx helper; resolves DATABASE_URL
                     from env, falling back to PG_BOOTSTRAP_URL+DATABASE_NAME
  markdown.js        frontmatter parse/serialize, validation, defaults
  sse.js             shared LISTEN client + per-graph subscriber map for
                     /events broadcasts
  routes/
    _validate.js     requireIntegerParam middleware
    graphs.js        CRUD on /api/graphs + rotate-id
    tasks.js         task CRUD + leaves/ready/subtasks/ancestors/blockers/
                     unblocks, all graph-scoped
    edges.js         edge CRUD + bulk insert with transactional cycle
                     detection
    graphView.js     /api/graphs/:gid/graph and shortest-path payloads
db/
  schema.sql         graphs, tasks, edges, edge_type enum, updated_at +
                     pg_notify trigger, short-id generator function
public/
  index.html         static markup: sidebar, canvas, inspector, toolbar, modals
  app.js             frontend graph behavior + multi-graph sidebar + SSE
                     client + agent-follow mode
  style.css          app shell, sidebar, toolbar, palette, modal styles
tests/               Vitest specs: graphs, tasks, edges, graph queries, db, api
.claude/skills/graphtask/SKILL.md  agent playbook (Agent Skills standard)
Dockerfile           Postgres 17 + Node 22 image
docker-entrypoint.sh initdb, loopback-only pg_hba, schema load, node start
```

### Data Model

```sql
graphs(
  id TEXT PRIMARY KEY DEFAULT generate_short_graph_id(),
  name TEXT NOT NULL,                        -- 1..80 chars
  description TEXT,                          -- nullable, ≤ 500 chars
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

tasks(
  id SERIAL PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  content TEXT NOT NULL,                     -- canonical markdown
  meta JSONB NOT NULL,                       -- structured copy of frontmatter
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)

edges(
  id SERIAL PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  source_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  target_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  type edge_type,                            -- dependency | related
  meta JSONB NOT NULL,
  UNIQUE(source_id, target_id),
  CHECK(source_id <> target_id)
)

uploads(
  id TEXT PRIMARY KEY DEFAULT generate_short_graph_id(),
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  bytes BYTEA NOT NULL,
  content_type TEXT NOT NULL,                -- image/png | jpeg | gif | webp | svg+xml
  byte_size INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user UUID REFERENCES users(id) ON DELETE SET NULL
)
```

- `graphs.id` is an opaque 16-char string (`a-z` + `2-9`, omitting `0/1/i/l/o`)
  generated by `generate_short_graph_id()` in plpgsql. Roughly 80 bits of
  entropy — the URL itself is the access control. The route retries on the
  negligible chance of a unique-violation collision.
- `ON UPDATE CASCADE` on `tasks.graph_id` and `edges.graph_id` lets
  `POST /api/graphs/:id/rotate-id` issue a fresh graph id and have all child
  rows follow without a separate update.
- `graphs.updated_at` is bumped by an AFTER trigger on tasks/edges
  INSERT/UPDATE/DELETE. The same trigger calls
  `pg_notify('graph_change', { graph_id, kind, op, id })` so SSE subscribers
  can push live updates to viewers.
- Task `content` is canonical: the server parses frontmatter, validates it,
  and stores a synchronized structured copy in `tasks.meta`.
- Task metadata: `title`, `status`, optional `description`, optional `color`,
  optional saved graph coordinates `x`/`y`, optional `background-image` URL
  (referenced from the `uploads` table; renders inside the node frame).
- Status enum: `todo` (no highlight), `in_progress` (orange), `review`
  (yellow — agent-finished, awaiting human confirmation), `done` (green).
  Convention: when an LLM agent updates the graph it stops at `review`;
  `done` is the human's final confirmation. Treat `review` as not-yet-done
  for dependency-readiness purposes.
- Edge metadata: optional `curve` shaped as `{distance, weight}` driving the
  Cytoscape unbundled-Bezier control point — `distance` is the signed
  perpendicular offset (legacy API still accepts a bare number with implicit
  `weight: 0.5`), `weight` is the parallel position along the source→target
  axis (`0.10..0.90`, `0.5` = midpoint). Optional `color` (validated 6-digit
  hex).
- `dependency` edges are directed and acyclic; `related` edges can form loops.
- Cycle detection (POST + PATCH + bulk) runs inside a single transaction
  with `LOCK TABLE edges IN SHARE ROW EXCLUSIVE MODE` so concurrent writers
  can't both pass the check.
- Graph names are not globally unique — duplicate-name `POST` and `PATCH`
  both succeed. The old `graphs_name_norm_uniq` index was dropped in
  Phase B; rely on `id`, not `name`, for any lookup.

### API

All task/edge/graph-view routes are scoped to a graph via `:gid`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/graphs` | List graphs, ordered by `updated_at DESC` |
| POST | `/api/graphs` | Body: `{name, description?}` |
| GET | `/api/graphs/:id` | Fetch one graph |
| PATCH | `/api/graphs/:id` | Body: any of `{name, description}`; bumps `updated_at` |
| DELETE | `/api/graphs/:id` | Cascades to tasks and edges |
| GET | `/api/graphs/:gid/tasks` | List tasks in graph |
| POST | `/api/graphs/:gid/tasks` | Body: `{content}` markdown blob |
| GET | `/api/graphs/:gid/tasks/:id` | Fetch one task |
| PATCH | `/api/graphs/:gid/tasks/:id` | Body: `{content}` |
| DELETE | `/api/graphs/:gid/tasks/:id` | Cascades to edges |
| GET | `/api/graphs/:gid/tasks/leaves` | Tasks with no incoming dependency edges |
| GET | `/api/graphs/:gid/tasks/ready` | Status=todo tasks where every recursive prereq is done (treats `review` as not-yet-done) |
| GET | `/api/graphs/:gid/tasks/:id/subtasks` | All recursive prerequisites |
| GET | `/api/graphs/:gid/tasks/:id/ancestors` | All recursive dependents |
| GET | `/api/graphs/:gid/tasks/:id/blockers` | Recursive prereqs whose status is not `done` |
| GET | `/api/graphs/:gid/tasks/:id/unblocks` | Direct parents that would become ready if this task were marked done |
| GET | `/api/graphs/:gid/edges` | List edges in graph |
| POST | `/api/graphs/:gid/edges` | Body: `{source_id, target_id, type, meta?}` |
| POST | `/api/graphs/:gid/edges/bulk` | Body: `{edges: [...]}` — transactional, all-or-nothing; returns `{edges: [...]}` or `{error, failedAt}` |
| PATCH | `/api/graphs/:gid/edges/:id` | Partial update; supports endpoints, type, meta |
| DELETE | `/api/graphs/:gid/edges/:id` | Delete edge |
| POST | `/api/graphs/:id/rotate-id` | Issue a new graph id; old URL stops working |
| GET | `/api/graphs/:gid/graph` | Combined `{nodes, links}` canvas payload |
| GET | `/api/graphs/:gid/graph/shortest-path` | Recursive-CTE BFS over dependency edges (undirected) |
| GET | `/api/graphs/:gid/events` | Server-sent events; pushes `{graph_id, kind, op, id}` on every task/edge change |
| POST | `/api/graphs/:gid/uploads` | Raw image bytes (`image/png\|jpeg\|gif\|webp\|svg+xml`, 5 MB cap). Returns `{id, url, content_type, byte_size}` — reference the URL from a task's `background-image` frontmatter to render the image inside the node frame. |
| GET | `/api/graphs/:gid/uploads/:id` | Image bytes, served with stored content-type, immutable cache headers, and `X-Content-Type-Options: nosniff`. |
| GET | `/api/config` | `{auth_enabled, provider, viewer_user_id}`; the SPA reads this on boot to decide whether to load Clerk |
| GET / POST / DELETE | `/api/graphs/:gid/members` (+ `/pending/:email`) | Owner-managed sharing; pending rows auto-claim on the invitee's first sign-in |
| GET / POST / DELETE | `/api/me/agent_tokens` | Mint / list / revoke `gt_*` bearer tokens for agent attribution |

`requireIntegerParam('id')` middleware on numeric `:id` segments returns 400
on non-integer values (otherwise Postgres would raise a 500). `:gid` is an
opaque short string; a bad one falls through to a 404.

`markdown.applyDefaults` coerces YAML-parsed title and description to strings
before validation, so scalar YAML values do not break task saves.

### Agent design notes

The HTTP API above is stable enough for an LLM agent (Claude Code, Codex,
or anything that can run `curl`) to drive end to end. The skill install
steps live inside [Using it with an agent](#using-it-with-an-agent) above;
this section covers the conventions and constraints any agent integration
should follow.

**Conventions agents follow**

- Persist the active graph id in `.graphtask/graph-id` (per-project, kept
  out of git — it's bearer-token equivalent).
- Move tasks `todo → in_progress → review`. **Never set `done`.**
  `done` is the human's confirmation; `review` is the agent's
  "I think this is finished, please confirm." Treat `review` as
  not-yet-done for dependency-readiness purposes (the
  `/tasks/ready`, `/tasks/:id/blockers`, and `/tasks/:id/unblocks`
  endpoints already encode this).
- Use `POST /edges/bulk` for any multi-edge import — it's transactional
  and fails atomically with a `failedAt` index, so you never end up with
  a half-built dependency graph.
- If a graph id leaks, `POST /api/graphs/:id/rotate-id` invalidates it.

**Live updates**

The browser canvas re-renders within ~150 ms of any task/edge mutation
via the `/events` SSE endpoint, so a user watching a graph sees the
agent's edits in real time. The agent doesn't need to consume the SSE
stream itself.

**Other agents (Codex, Cursor, etc.)**

The shipped skill at `.claude/skills/graphtask/SKILL.md` follows the
open [Agent Skills](https://agentskills.io) standard. The `SKILL.md`
file is portable; refer to your tool's docs for the install path. Any
agent that can `curl` is a viable client — the skill is just the
playbook.

### Views — per-graph view preference

The canvas region renders one of two views: **Graph** (cytoscape DAG —
the canonical edit surface) or **Kanban** (four-column board grouped by
status). Tasks + edges are unchanged; the view is a render lens.

**Where it lives.** Graph settings modal → Appearance section → View
dropdown (above Font). Two options: `Graph` (default), `Kanban`.

**Per-user, per-graph, never synced.** The choice writes to
`localStorage['graphtask:view:<gid>']` — client-only, no server PATCH,
no SSE broadcast. Two collaborators on the same graph can sit in
different views; flipping yours doesn't change theirs. Each graph
remembers its own setting per browser.

**Kanban specifics:**
- Columns are status (todo / in_progress / review / done). Column title
  text is colored per status (grey / orange / yellow / green).
- Cards: title + 2-line body excerpt + optional left color bar from
  `meta.color`. Sorted within column by `updated_at DESC`.
- Click a card → opens the existing right-side inspector. The kanban
  board shifts left if the panel would cover the selected card's
  column, so the column stays visible.
- Drag a card to a different column → optimistic move + PATCH `status`
  with OCC fields; flash on the destination card. SSE re-buckets for
  other tabs/agents with the same flash.
- Hotkeys: `G` creates a new task in the selected column (or Todo); `S`
  cycles status of the selected card (one-press, no confirm — drag is
  the primary UX). F/T/E/B are graph-only and no-op in kanban.
- Empty columns show a "Drop tasks here" placeholder.
- Mobile (<768px): horizontal scroll, one column at a time via
  `scroll-snap`.

**Cross-view presence.** Peer selection underlays + cursor pills work
across both views off the same `peerSelectionState`. A peer selecting
a task in graph view shows up as a colored outline + name pill on the
corresponding card in kanban, and vice versa.

**Eye toggle.** Top-right corner has a tiny eye icon (visible on hover
over the avatar bar / LIVE button) that hides both the avatar bar and
the LIVE push-button. State is `localStorage['graphtask:presence-hidden']`
— per-user, global, applies to both views.

### Frontend Model

The frontend has four main regions:

- **Sidebar**: `#sidebar` lists graphs with name + relative updated time.
  `+` creates a new graph; `⋮` opens the edit modal (rename, description,
  delete). The active graph card is highlighted.
- **Canvas**: `#cy` fills the area to the right of the sidebar. Cytoscape
  paints nodes and edges. Styling is driven by element data (`status`,
  `color`, `edgeType`, `curve`) and transient classes (`selected`, `editing`,
  `leaf`, `dir-backward`, `edge-type-editing`, `edge-hover-target`,
  `preview`, `phantom`, `agent-flash-*`). In kanban view, `#cy` is
  hidden and `#kanban` (a separate fixed container in the same region)
  renders the column board.
- **Side panel**: `#panel` is a resizable right-side inspector for node
  title, status, and markdown body. Opening it recenters the selected node
  in the visible canvas area (sidebar-aware via `cy.width()`).
- **Bottom toolbar**: `#bottom-bar` is contextual and changes by selection
  mode. Centered within the canvas area.

#### Active-graph routing

- URL: `/g/:gid` reflects the active graph; bookmarkable.
- Boot resolution order: URL → `localStorage` last-active → first available
  graph → none.
- `popstate` keeps the canvas in sync with browser back/forward.
- All API calls go through an `apiBase()` helper that prefixes
  `/api/graphs/:activeGraphId`, so a route's URL never accidentally targets
  the wrong graph.

#### Lazy graph creation

When no graph is active, the canvas placeholder reads "Click here for a new
task". Clicking the canvas (or pressing `G`, or the `+` toolbar button)
lazily creates an `Untitled` graph and immediately starts the new-task flow
at the click position. If the user backs out without committing the first
task, a deferred check (`maybeCleanupLazyGraph`) deletes the empty graph and
resets the URL to `/`.

#### Selection Modes

`getSelectionMode()` returns:

- `neutral`: nothing selected. Toolbar shows New (`G`), Fit (`F`), Settings.
- `node`: one or more nodes selected. Toolbar shows Status (`S`), Color (`B`),
  Connect (`E`), and Delete.
- `edge`: one or more edges selected. Toolbar shows Color (`B`), Direction
  (`E`), and Delete. For a single edge, Direction shows a right arrow, left
  arrow, or horizontal bidirectional arrow for the current state.
- `mixed`: nodes and edges selected together. Toolbar shows Color (`B`) and
  Delete.
- `edge-creating`: edge creation in progress. Toolbar shows a preview summary
  and Direction (`E`) for the in-progress edge type.

`updateToolbar()` runs after selection/mode changes and after `fetchGraph()`
because refetching rebuilds Cytoscape elements and clears transient classes.

#### Agent-follow

When an SSE event arrives indicating an external (non-local) edit on a task,
the client (a) refetches the graph with selection preservation, (b) animates
the camera to the affected node, and (c) for UPDATE events, opens the side
panel showing the new content. The "who is editing this" visual cue comes
from the peer-selection classes (writer's color outline + dashed border)
when the agent broadcasts its current task — see Multi-peer presence below.
Agent-follow is suppressed if the user `pointerdown`/`keydown`/`wheel`d in
the last 2 seconds, so manual work isn't yanked around. `loadIntoEditor`
sets a 200ms suppression window on the autosave scheduler so the synthetic
`change` event from `setMarkdown` doesn't cause a round-trip-PATCH echo loop.

Multi-agent follow rules: 0 active agents → no auto-pan; 1 active agent →
follow it regardless of owner; 2+ agents → follow only the one whose
`owner_user_id` matches the local user. An anon viewer with 2+ agents gets
no auto-pan (rely on highlights). A round push-button below the local
user's avatar — labeled `LIVE` when tracking, `QUIET` when paused, with
a soft orange pulse halo while live — toggles agent-follow per-graph;
toggling on one graph propagates the new state as the default for future
graphs but doesn't change other graphs you've explicitly toggled.

#### Multi-peer presence

Every active writer (human or agent) appears in the avatar bar (top-right,
capped at 7 individuals + a "+N others" chip). Avatar colors are
deterministic per writer_id from a 64-color palette (16 base hues × 4
lightness/saturation variants) so collaborators see the same color across
reloads and devices.

When a peer selects or opens a node/edge they POST to
`/api/graphs/:gid/selection`, which fans out via SSE. Other viewers render
(a) a colored underlay on the node (or dashed border if the peer has the
side panel open) in the peer's color, and (b) a "peer cursor" — a small
glowing dot + name pill positioned at a free corner of the node. Multiple
peers on the same node stack into one marker (2-4 peers: vertical rows
with initials; 5+: a single overflow chip showing "AB & N others"). Peer
markers are placed by a deterministic 8-direction probe that avoids
overlapping other nodes; the marker repositions on cy pan/zoom/drag.

The local user's own selection isn't rendered as a peer marker — instead
the standard `.selected` underlay renders in their own avatar color.
Agents (`type: 'agent'`) skip the 60s idle filter so a long-thinking agent
keeps its marker visible until its Stop hook DELETEs presence at end of
turn.

OCC: agents must PATCH with `base_version` + `base_content` so the
server's three-way merge protects UI-managed frontmatter keys (`x`/`y`
positions, `color`, `curve`) the agent didn't include. Without OCC fields
the PATCH falls back to blind replace and silently wipes those keys. See
the [skill](.claude/skills/graphtask/SKILL.md) for the canonical
`work_on_task` / `announce_focus_edge` helpers.

Agent-vs-agent same-field conflicts use **owner-agent precedence**: the
agent whose `owner_user_id` matches `graphs.owner_user_id` wins. If both
or neither agents are the graph owner's, falls through to last-write-wins.
Human-vs-agent rule unchanged: human always wins.

### Sharing & access model — deep dive

Extends the "Auth modes" + access-model paragraph under
[Run locally without Docker](#3-run-locally-without-docker).

**Sharing flows**

Four common cases are worth walking through, since the boundary
between anonymous and signed-in is fuzzier than most "who owns this"
models.

- **Anon creates a graph on a no-auth instance.** `owner_user_id`
  stays `NULL` and `anon_role` defaults to `viewer`. The creating
  browser stores the gid in `localStorage` under `graphtask:recent`
  with `created: true`. Anyone with the URL can read it; writes are
  also allowed because there's no auth layer at all.

- **Signed-in user creates a graph.** `owner_user_id` is set on
  insert. `anon_role` still defaults to `viewer` so a URL share Just
  Works without the owner thinking about access. Server-truth places
  the graph under **My graphs** in the owner's sidebar; everyone else
  hitting the URL sees it land under **Shared with me** in their
  `localStorage` cache.

- **Owner shares by flipping `anon_role`.** `PATCH /api/graphs/:id`
  with `{anon_role: 'editor' | 'viewer' | 'none'}` updates the graph
  row. The route emits an SSE `{kind: 'graphs', op: 'UPDATE'}` frame,
  so any live viewer's browser refetches the row + canvas within ~1
  second. Going to `none` evicts non-members in real time
  (`fetchGraph`'s 403 path swaps the canvas for an "Access denied"
  state); going back up to `viewer`/`editor` re-grants via either an
  SSE `onopen` rescue (if the browser retried the closed stream) or
  the 10-second `accessDenied` poll fallback.

- **Owner shares by adding a member.** `POST
  /api/graphs/:gid/members` with `{email, role}`. If the email
  matches an existing `users` row, the route inserts directly into
  `graph_members`; otherwise it stashes the row in `pending_members`.
  When that email later signs in, `verifyAuth`'s
  `claimPendingByEmail` promotes the pending row into a real member
  row on the spot. Kicking a member (`DELETE
  /api/graphs/:gid/members/:userId`) emits an SSE frame so the
  kicked browser evicts in real time, matching the `anon_role → none`
  path.

- **Anon creates a graph, then signs in later.** This is the auto-
  claim flow. On any sign-in (or sign-in after a fresh page load on
  an already-authed browser), the client walks `localStorage`
  recents for entries with `created: true` and `POST`s
  `/api/graphs/:id/claim` for each. The server-side `claim` route
  succeeds only when `owner_user_id IS NULL` (legacy), idempotently
  assigning the graph to the signed-in user. Already-owned graphs
  return 403 and the claim is skipped. Other-device-created graphs
  the user visited but didn't create locally won't get the `created:
  true` flag and therefore won't auto-claim — that's by design,
  since the URL alone doesn't prove ownership intent.

**Client-side storage**

Everything the browser persists is namespaced under `graphtask:`.
Wipe these to reset client state without touching the database.

`localStorage` (persists across tab closes):

- `graphtask:lastGraphId` — gid of the last graph the user viewed in
  this browser. Drives the auto-open-last-graph boot path when the
  URL doesn't carry a gid.
- `graphtask:recent` — JSON array (capped at 20) of recently visited
  graphs: `{id, name, last_visited_at, created}`. Used for the
  signed-out sidebar bucketing (Phase A behavior) and the
  `created: true` flag is the input to the auto-claim flow above.
- `graphtask:hide-private-warn` — flag remembering that the user
  dismissed the "this graph is private; share with care" first-write
  toast.
- `graphtask:sidebarCollapsed` — boolean for the sidebar's
  collapsed/expanded state.
- `graphtask:view:<gid>` — per-graph view preference: `graph` (default)
  or `kanban`. Set from the View dropdown in the graph settings modal
  (under Appearance). Per-user, per-graph, never synced via SSE — two
  collaborators on the same graph can pick different views independently.
- `graphtask:presence-hidden` — `'1'` if the user has hidden the
  presence chrome (avatar bar + LIVE push-button) via the top-right
  eye icon. Per-user, global (applies to every graph + view). Toggled
  by clicking the eye; the icon stays visible (faintly) so the user
  can un-hide.

`sessionStorage` (clears on tab close):

- `graphtask:readonly-banner-dismissed:<gid>` — set when the user
  clicks Dismiss on the orange read-only banner. Per-tab and per-gid
  so a hard reload remembers the dismissal, but a fresh tab brings
  the banner back as a reminder.

No auth tokens live in localStorage. Clerk's session cookies are
managed by the Clerk frontend on its own host (not the app origin),
so they aren't accessible from our JS. `gt_*` agent tokens are
shown plaintext exactly once in the mint modal and never persisted
client-side — the user copy-pastes them into their own shell.

**Live updates when access changes**

Two layers of plumbing keep open browsers in sync without manual
reload.

- **The kick / revoke path** (`anon_role → none` or
  `DELETE /members/:userId`) emits an SSE frame on the graph's
  channel. Every subscribed viewer's `refreshFromEvent` runs,
  hits the 403, and downgrades to the access-denied state inside
  ~1 second.
- **The re-grant path** (`anon_role` back up to `viewer`/`editor`,
  or a new member being added) is harder because the now-denied
  viewer's `EventSource` is itself 403'd at the read gate and
  may or may not retry depending on the browser. Two safety nets
  cover this: an `onopen` rescue that probes `fetchGraph` the
  moment a denied-then-reopened stream succeeds, and a 10-second
  poll that calls `fetchGraph` while `accessDenied` is true and
  clears itself once the probe passes.

For paths where the server crashes / SSE drops / the user closes the
tab, the worst case is a manual reload — never a stale-write-against-
revoked-access leak, because every API write is gated server-side by
`requireGraph` regardless of what the browser thinks.

**Out of scope for Phase B**

These were intentionally left off the auth scope to keep the surface
small. Don't expect them to work:

- No teams, orgs, or shared workspaces — sharing is per-graph, not per-group.
- No commenter-only role — `viewer` is read-only, `editor` is full
  read/write. There's no third tier in between.
- No SSO, social login, or magic links — email OTP only.
- No per-task ACL — the access tier is graph-wide.
- No "claim this graph" flow for inheriting a legacy graph you didn't
  create locally — only graphs created while signed in are owned, and
  only graphs created locally-then-claimed by the same browser get
  auto-promoted on sign-in.

### Production notes

**Open-file limit (for live updates at scale)**

graphtask uses Server-Sent Events for live graph updates: every browser tab
viewing a graph holds one open file descriptor on the server for the
duration of its visit. The OS default cap is often `1024` per process, which
caps concurrent viewers at the same number.

- The Docker setup raises this to `65535` automatically (`ulimits.nofile`
  in `docker-compose.yml` + a `ulimit -Sn` in the entrypoint).
- The native `npm start` script attempts the same (`ulimit -Sn 65535`),
  falling back to the highest soft limit your shell allows.
- For production deployments behind a process supervisor (systemd,
  PM2, Docker, etc.), set `LimitNOFILE=65535` (systemd) or the
  equivalent in your supervisor's config so the **hard** limit is
  raised before the node process starts. A non-root process can only
  raise its soft limit up to the existing hard limit.

**Presence assumes a single process**

The collaborator avatars in the top-right of each graph are driven by
in-memory per-process state. A single Node process can comfortably
serve hundreds-to-thousands of concurrent SSE viewers, which is enough
for any realistic graph. But if you fan the server across multiple Node
processes behind a load balancer, viewers routed to different processes
won't see each other's avatars — presence is partitioned per process.

If you need horizontal scaling, either pin SSE traffic for a given
graph to one process (e.g. consistent-hash sticky routing on the graph
id) or fan presence events across processes via Postgres `LISTEN/NOTIFY`
or Redis pub/sub. The single-server `docker compose` setup and the
default `npm start` are not affected.

**Image uploads live in Postgres**

Node background images and editor paste/drop images go through
`POST /api/graphs/:gid/uploads` and land in the `uploads` table as `BYTEA`.
That means image storage *is* database storage — there's no separate object
store to configure, and a `pg_dump` captures everything. The trade-off is
that DB size grows with image use. Three knobs:

- **Per-image cap** — `GRAPHTASK_UPLOAD_MAX_BYTES` (default 5 MB) bounds how
  big a single upload can be. Lower it for environments where users tend to
  paste high-resolution screenshots and you'd rather force them to compress
  first.
- **Allowed types** — fixed at `image/png|jpeg|gif|webp|svg+xml`. SVGs are
  served with `X-Content-Type-Options: nosniff` so a hostile SVG can't run
  script in the app's origin.
- **Cleanup** — today only the graph-delete cascade reaps uploads. Replacing
  or removing a node's image leaves the prior `uploads` row in place. For
  single-user / small-team self-hosting that's usually fine; the orphan
  reaper on the roadmap is the long-term answer.

There is no schema migration step for self-hosters — `src/db.js` applies
`db/schema.sql` on every boot and the `uploads` table is a `CREATE TABLE IF
NOT EXISTS`, so pulling the new code and restarting is enough. Existing
graphs / tasks / edges are untouched.

### Notable Decisions

- **Multi-graph as nested resources.** Routes are `/api/graphs/:gid/...`
  rather than carrying a graph_id query param everywhere. All cross-graph
  reads/writes are blocked at the route layer, not just the database.
- **Short opaque graph IDs.** Generated by a small plpgsql function used as
  the column DEFAULT. Avoids leaking creation count via auto-increment;
  the URL is the bearer token in the no-auth model.
- **Transactional cycle detection.** `BEGIN` + `LOCK TABLE edges IN SHARE
  ROW EXCLUSIVE MODE` + recursive-CTE cycle check + INSERT/UPDATE in one
  unit. Concurrent dependency-edge writes can't both pass the check.
  Bulk insert applies the cycle check after all rows land, so multi-edge
  cycles within one batch (A→B + B→A) are caught and rolled back.
- **Lazy graphs.** First-click creates a graph; backing out cleans it up.
  Trains the user on the click-to-create UX with no setup ceremony.
- **No node overlap.** `resolveNodeOverlap()` pushes nodes apart by ≥12 world
  units and persists moved coordinates.
- **Predictable refresh.** Many mutations use optimistic UI followed by
  `fetchGraph()` after server success or failure.
- **Explicit save signals.** New node creation, status edit, edge direction
  edit all require Enter. Pending edits turn dashed to make that visible.
- **Single static frontend.** `public/app.js` intentionally avoids a build
  step. If it grows much further, splitting by behavior area is the next
  cleanup.
- **No external graph extension.** Shortest-path runs as a recursive-CTE
  BFS instead of pgRouting, so the app works on any modern Postgres
  without extension installs.
- **SSE + Postgres LISTEN/NOTIFY for live updates.** One LISTEN connection
  per node process; clients fan out via an in-memory `Map<graphId, Set<Response>>`.
  Connection cap (default 8888 via `SSE_MAX_CONNECTIONS`) sits below the
  per-process fd limit.
- **Three-way merge for concurrent edits.** Tasks, edges, and graphs each
  carry a `version` and `last_modified_by` column. PATCH handlers do a
  field-level merge in `src/merge.js` so two writers (human + agent, or
  two tabs) touching different fields both land even when one is on a
  stale base. JSONB columns (`tasks.meta`, `edges.meta`, `graphs.settings`)
  are one-level flattened so different sub-keys count as disjoint fields.
  The `X-Writer-Type: human | agent` header drives the policy table —
  defaults to `human` when missing so an unidentified write never silently
  wins as an agent:

  | Scenario | Resolution |
  |---|---|
  | Two writers, different fields | Silent merge — both edits land. |
  | Same field, one is human | Human wins, always. |
  | Same field, both human | Last-write-wins per field. |
  | Same field, both agent | Last-write-wins per field. |
  | Delete vs edit | Delete wins. |
  | Edit on a deleted row | 410 Gone. |

  Client (`public/app.js`) tracks per-row `version`, sends
  `base_version` + `base_content` (tasks) or `base_row` (edges/graphs) on
  every PATCH, and `patchWithRetry()` retries once on 409 using the
  server-supplied `current` as the new base. The 409 path is defensive —
  the server resolves every documented scenario itself, so it normally
  returns 200 with the merged row.

  **UI-managed key protection.** A subtle case: an agent that rebuilds
  frontmatter from scratch (typical, since the PATCH body is a full
  content blob) ends up with `writerEdit.x === undefined` even though
  base had `x=100`. The naive merge reads that as "agent removed x" and
  wipes the value — every PATCH after a user drag silently snaps the
  node back. To prevent this, routes pass a `protectedFromAgentRemoval`
  list into `mergeFields`. When the writer is an agent and the new
  edit omits a key in that list (and the key existed in base), the
  merge treats it as "didn't mention" rather than "removed" and
  preserves the current value. Tasks protect `x`, `y`, `color`; edges
  protect `meta.color`, `meta.curve`. An agent that genuinely wants to
  clear one of these sends an explicit `null` — `null` is defined, so
  the protection short-circuit doesn't fire and the clear lands.

  *Why not a partial-update API instead?* A dedicated
  `PATCH {body, meta_patch}` endpoint where agents declare scope
  explicitly is semantically cleaner, but it doubles the agent surface
  (agents would have to choose between full-content and partial PATCH
  on every write) and offers no protection when the agent picks the
  wrong endpoint. The protected-key list is one place, enforced by
  the server, with zero new API surface; the only cost is needing an
  explicit `null` escape hatch for the rare "I really do want to clear
  this" case.

### Where To Look First

| Want to... | Look at |
|---|---|
| Change graph CRUD or sidebar | `src/routes/graphs.js`, sidebar block in `public/app.js` |
| Change node/edge visuals | Cytoscape `style` array in `public/app.js` |
| Change toolbar markup | `#bottom-bar` in `public/index.html` |
| Change toolbar state | `updateToolbar()` in `public/app.js` |
| Add a keyboard shortcut | Global keydown handler in `public/app.js` |
| Change task metadata | `src/markdown.js`, `src/routes/tasks.js`, `db/schema.sql` |
| Change edge metadata | `src/routes/edges.js` and edge style/persistence in `public/app.js` |
| Change graph schema or trigger | `db/schema.sql` |
| Change live-update behavior | `src/sse.js`, `openGraphEventStream` / `refreshFromEvent` / `followAgentEdit` in `public/app.js` |
| Change agent skill content | `.claude/skills/graphtask/SKILL.md` |
| Debug transient frontend state | Module-scope state in `public/app.js`: `activeGraphId`, `pendingNode`, `edgeCreation`, `edgeTypeEditing`, `statusEditing`, `colorPaletteState`, `_lazyCreatedGraphId` |

### Current Caveats

- Multi-node edge creation is fan-out. If the target is also selected, the
  self-edge is skipped.
- Lazy graph cleanup is local to the active session — closing the tab during
  a pending node leaves an empty `Untitled` graph in the sidebar; it can be
  deleted manually via the `⋮` modal.
- Schema changes that alter column types still need a manual `DROP TABLE`
  on existing databases; `IF NOT EXISTS` won't pick up type diffs.
- The frontend is intentionally not modularized yet.

### Roadmap

The canonical "what's next" list — what's shipped, what's planned, and
the aspirational reach items live here so contributors don't re-litigate
the same choices.

#### Status at a glance

Completion checklist — the detailed entries below carry the full context.

**Shipped**

- [x] **Kanban view** — first multi-view lens; status columns, drag-to-PATCH,
  per-user view preference. (`public/app.js`)
- [x] **Optimistic concurrency (OCC) + three-way merge** — `version` /
  `last_modified_by` on tasks·edges·graphs, merge in `src/merge.js`.
- [x] **Modular UI primitives** — `VIEWS` registry + `View` interface; per-view
  branching now dispatches through `activeView()`. (`public/app.js`)

**Planned — not started**

- [ ] **Future views** — alternate lenses on the same `tasks`/`edges` data,
  added one at a time after the modular primitives refactor:
  - [ ] **Tech tree** — Civ-style layered DAG, read-only.
  - [ ] **Table view**
  - [ ] **Calendar view**
- [ ] **Responsive layout system** — kill hardcoded px; mobile bottom-sheet
  panel + avatar-bar reflow.
- [ ] **Configurable custom fields** — graph-declared typed task fields.
- [ ] **Custom ordering** — per-graph, per-view sort/grouping (needs custom fields).
- [ ] **In-graph find (Cmd/Ctrl+F)** — intercept the browser find hotkey;
  ranked keyword search over the current graph's node title / description /
  body, jump-to-node.
- [ ] **Knowledge-base search across graphs** — search over node bodies.

**Reach — aspirational, unscheduled**

- [ ] **Subagent fanout** — parallel subagents claiming ready tasks.
- [ ] **True pause/play** — server holds the next PATCH while paused.
- [ ] **Upload orphan reaper** — sweep unreferenced `uploads` rows.

#### Planned

- **Multi-view: same data, different lenses.** *(Kanban ✅ shipped · tech tree + future views ⬜ planned)* Same `tasks` + `edges`
  rows, multiple rendering modes. The graph-DAG view (current) stays
  the canonical edit surface; new views are alternate lenses that read
  the same data and translate edits where they make sense.

  **Shipped:**
  - [x] **Kanban** — tasks grouped into columns by `status` (todo /
    in_progress / review / done). Cards show title + body excerpt; drag
    between columns issues a PATCH that flips `status` (OCC three-way
    merge handles concurrent drags). Edges hidden; the graph view stays
    the place to wire dependencies. Selected via the View dropdown in
    graph settings (Appearance → View); preference is per-user, per-graph,
    client-only (`localStorage['graphtask:view:<gid>']`) — two
    collaborators on the same graph can be in different views. See
    *Views — per-graph view preference* below.

  **Planned views:**
  - [ ] **Tech tree** — Civilization-style layered DAG. Tasks ordered into
    rows by topological depth (recursive prereq distance); edges drawn
    between rows. Layout is computed, so the view is primarily
    read-only — click a node to jump back to graph view with that node
    selected.
  - [ ] **Future views** — table view, calendar view, etc. — added one at
    a time once a second view shakes out the per-view abstractions
    (see *Modular UI primitives* below).

- **Modular UI primitives.** ✅ The inline `if (currentView === 'kanban') { … }`
  branches that had accreted across the codebase — toolbar button visibility,
  the global keydown switch, `peerCursorRefresh` positioning,
  `applyPeerSelectionToCy`'s card paint, the Escape handler, SSE task hooks,
  the "New" control, and `applyView` itself — now dispatch through a single
  `VIEWS` registry. Each view is one entry implementing a shared `View`
  interface (`enter`, `adjustLayout`, `updateToolbar`, `handleKeydown`,
  `onEscape`, `renderPeerCursors`, `wipePeerCards` / `paintPeerCard`,
  `onRemoteTaskEvent`, `createPrimaryItem`), resolved via `activeView()`.
  Adding a third view (tech tree) now means adding a registry entry, not
  threading another conditional through every surface. The registry also
  documents the forward-looking extension points — a view's agent-follow
  target and applicable selection modes — for the views still to land. See
  the "View registry (modular UI primitives)" block at the top of
  `public/app.js`.

- **Responsive layout system.** ⬜ Most of the canvas chrome
  (`#presence-bar`, `.push-button`, `#panel`, peer-cursor placement,
  modal widths) is currently positioned with hardcoded pixel
  offsets — `top: 104px`, `right: 12px`, `width: 40px`, etc. — tuned
  by eye for a desktop viewport. As soon as the viewport gets
  narrower, taller, or denser, the row alignments we manually
  calibrated (avatar bar ↔ status label ↔ MY GRAPHS ↔ Title) start
  drifting. Turn the ad-hoc px-tuning into a system so the layout
  holds across phones, tablets, and varied desktop sizes without
  re-tuning each element.

  What "a system" means here:
  - **Flex / grid primitives** for groupings like the top-right
    "avatar bar + push-button" stack, instead of separate fixed-
    positioned elements that each compute their own `right`.
  - **Fluid sizing**: `clamp()`, `min()`, `rem`, `vw`/`vh` for
    dimensions that should scale with viewport, replacing the
    hardcoded px on widths and gaps.
  - **Breakpoint strategy**: a small set of media-query layouts
    (mobile portrait, tablet, desktop) where the shape of the UI
    actually changes — e.g., sidebar collapses to a drawer below
    768px, side panel becomes a bottom sheet on phones.
  - **Container queries** for elements that should reflow based on
    their container rather than the viewport (e.g., the side panel
    when the user resizes it).
  - **Extend the design tokens** so every gap/padding/margin uses
    `--space-*` rather than raw pixels. Same for the few remaining
    raw font-size px (status label is 7px, should be a token).
  - **Audit pass**: every `position: fixed` + `top:` / `right:` /
    `width: <px>` rule gets either reworked into a layout primitive
    or annotated with a comment explaining why pixel-perfect is the
    right choice for that element.

  This is ongoing work, not a single PR — every UI change going
  forward should use the system rather than adding new hardcoded
  positions.

  **Current mobile state (iPhone-sized viewport).** Most of the app
  holds up better than expected at phone width — the work below is
  scoped to the specific things that don't:

  - **Left sidebar (graphs list)** — open/close already works fine on
    mobile, no changes needed.
  - **Right side panel (node inspector)** — takes up way too much of
    the viewport when it opens, leaving almost no canvas visible. On
    mobile it should pull up from the **bottom** instead of sliding in
    from the right: occupy the bottom ~40% of the viewport by default,
    draggable up to read more, draggable down, dismissable. The top
    section always keeps some of the graph visible behind it.
  - **Avatar bar (top-right)** — bleeds over the right side panel on
    mobile, doesn't seem to respect the panel's bounds the way it does
    on desktop. Needs to either reflow when the panel is open or move
    out of that corner entirely on small viewports.

- **Configurable custom fields on graphs.** ⬜ Today every task carries the
  same fixed frontmatter (title, status, optional description / color /
  position). A "custom fields" system would let a graph owner declare
  additional typed fields — `priority: number`, `assignee: string`,
  `due_date: date`, etc. — that every task in that graph then carries.
  Field definitions live on the graph row; task `meta` carries the
  values. Surfaces in the inspector (extra form rows), in the kanban
  group-by picker, and in future views (table columns, calendar dates).

- **Custom ordering.** ⬜ Once custom fields exist, ordering follows. Per
  graph, **per view**, persist a sort/grouping strategy:

  - **Graph view** — order traversal by a custom numeric field (e.g.
    `Priority`). Weights nodes for "find the highest-priority unblocked
    task" queries; lets shortest-path / dependency-walking endpoints
    optimize for total weight instead of edge count.
  - **Kanban view** — drag-to-reorder within a column. Default to
    `updated_at DESC` (current). Once dragged, save an explicit per-column
    order so all viewers of the same graph see the same kanban layout.
    Effectively each column gets its own ordered list, shared across
    collaborators (unlike the per-user *view* preference, which is
    intentionally personal).
  - **Other views** — table sort columns, calendar date field
    selection, etc. — all reduce to "which field on which view".

  This is a big feature stack: custom fields first, then per-view
  ordering on top. Cross-cuts schema (graph-level field defs, task
  meta), API (validation per field type, ordering reads/writes), and
  every view's render pipeline. Worth doing once the multi-view
  infrastructure is exercised across two or three views and the
  shape of "view-specific config" becomes clear.

- **In-graph find (Cmd/Ctrl+F).** ⬜ Today pressing Cmd/Ctrl+F on the graph
  triggers the *browser's* native find — which reports "0/0" even when the
  word is plainly on screen, because Cytoscape paints node labels onto a
  `<canvas>` and the browser only searches the DOM text layer. Replace that
  dead-end with an in-app find bar scoped to the current graph.

  - **Interception.** Intercept the hotkey the same way Cmd/Ctrl+K already
    opens graph settings (`public/app.js` global keydown handler, ~line
    7882: `e.preventDefault(); openGraphSettings();`). Add a sibling branch
    for `e.key === 'f'` that `preventDefault()`s the native find and opens
    the in-app find bar. No conflict with the bare `f` graph hotkey
    (zoom-to-fit, `handleGraphKeydown`) — that one carries no modifier.

  - **Search surface.** Lexical keyword match over each node in the current
    graph across three fields: **title**, **description**, **body**. Client-
    side over the already-loaded `tasks` is enough at current graph sizes;
    no new endpoint required to start.

  - **Ranking — tiered by field, then by frequency.** Results group by the
    strongest field the keyword hits, in this order:
    1. **Title matches** — top of the list. Within the group, order by how
       many times the keyword appears (more = higher); tie-break by
       `created_at` (newest first).
    2. **Description matches** — next group, ordered the same way (count
       desc, then newest-first).
    3. **Body matches** — last group, same ordering.

    A node is ranked by its strongest field only (a title hit outranks a
    body hit on the same node — it doesn't appear in every group it
    matches).

  - **UX.** Find bar overlay (top of canvas, like the screenshot's native
    bar but ours); type to filter live; ↑/↓ (or Enter / Shift+Enter) walk
    the ranked results; the active result selects + centers its node on the
    graph (`cy`). Esc closes the bar and restores prior selection.

  - **Relationship to the cross-graph KB search below.** Different feature,
    don't merge them. This one is *in-graph, client-side, lexical, instant*
    — the find-on-this-page replacement. The KB search below is *cross-
    graph, server-side, semantic*. They can share a relevance vocabulary
    later, but this ships first and standalone.

- **Knowledge-base search across graphs.** ⬜ Each node body is a piece
  of markdown that evolves with the work, so a long-lived graph
  already functions as a notebook — but today the only way to find
  "the node about X" is to know the gid and `GET` it. Add a search
  layer so graphs become a queryable knowledge base, both for humans
  ("where did I write about cookie storage?") and agents ("read what
  this user already knows about auth before planning").

  Open questions to decide before building:
  - **Backend.** Likely candidates: pgvector inside the existing
    Postgres (no new infra; embed task bodies on PATCH; semantic +
    keyword in one place), Typesense / Meilisearch (faster text
    relevance, separate process), or a hybrid (pg full-text for
    lexical, pgvector for semantic). Start from scratch rather than
    pulling in a heavyweight RAG framework — the corpus is just
    `tasks.content` rows, indexing on the existing `updated_at`
    trigger is straightforward.
  - **Scope.** Per-graph search first (lives next to the existing
    `/api/graphs/:gid/tasks` routes), cross-graph "search my graphs"
    as a follow-up gated by the access model — never leak nodes
    across owners.
  - **References to study.** `safishamsi`'s
    [`graphify`](https://github.com/safishamsi/graphify) (Karpathy-
    *inspired*, not by Karpathy) on turning a body of notes into a
    navigable concept graph. Notably it uses **no embeddings/vectors** —
    at index time an LLM distills the corpus into a `graph.json` of
    named concept nodes + tagged edges + Leiden community clusters; at
    query time it keyword-matches seed nodes then BFS-walks the subgraph
    and hands only that to the LLM (~1,700 vs ~123,000 raw tokens). The
    "relatedness" embeddings would compute is instead precomputed into
    explicit edges. Microsoft's
    [`graphrag`](https://github.com/microsoft/graphrag) on doing
    retrieval over a graph-structured corpus rather than a flat
    embedding pile — closer to our actual shape, since our data
    already lives as nodes + edges.

  Pull this into active work once one of: (a) graphs we use daily
  cross the size where manual recall stops working, (b) an agent
  workflow asks the question "what does this graph already say
  about X" often enough that a search endpoint pays for itself.

#### Reach

Aspirational — interesting if we get to them, but we may never. Not
actively planned; pull into Planned only if user feedback or a
concrete need surfaces.

- **Subagent fanout.** ⬜ Today one agent token = one Claude Code session
  walking the graph sequentially. Future: spawn N subagents in parallel,
  each picking up a different ready task. Builds on existing
  infrastructure (multi-agent presence, owner-aware follow filter,
  owner-agent OCC precedence, `announce_focus` from SKILL.md) plus a
  coordination layer that hands out tasks.

  Note: Claude Code's `Agent` tool already works against graphtask
  *today* — subagents inherit the parent's `.graphtask/agent-session.json`
  and share its `writer_id`, so all writes go through correctly. The
  data layer is safe. The caveat is visual telemetry: one avatar in
  the bar regardless of N subagents, the peer cursor flips between
  whichever subagent most-recently called `announce_focus`, and the
  camera-follow toggle jumps between unrelated tasks. With 2-3
  subagents this reads as "fast-paced"; with 7 it'd be chaotic.
  Concurrent PATCHes to the *same task* by two subagents fall through
  to last-write-wins (the owner-agent OCC precedence relies on
  distinct writer_ids), but in practice subagents work on different
  tasks so this is rare.

  If we ever build this out, the pieces are:
  - **Coordination layer** — hand out ready tasks and prevent two
    subagents from claiming the same one. Could be a server-side
    `claim` endpoint, or rely on `/tasks/ready` polling + race on
    first-PATCH-to-`in_progress`.
  - **Spawn mechanism** — currently a user has to manually start N
    Claude Code sessions each with its own `gt_*` token. Could be an
    in-app "spawn subagents" action that mints transient tokens and
    shells out.
  - **Per-subagent identity beyond `writer_id`** — so the avatar bar
    shows "Worker A", "Worker B" instead of one generic robot. Pure
    polish: nothing breaks without it (see the note above). Would
    require the parent agent to mint a fresh UUID + name per subagent
    and pass them through the subagent's environment so the per-task
    session file picks them up.

- **Pause/play that actually pauses the agent.** ⬜ Today the toggle is
  local-only — it just stops the viewer's camera from following.
  Future: use the broadcasted `announce_focus` from the SKILL.md
  helpers as the ack point. When paused, the server holds the next
  PATCH from that writer until resumed, giving the human a chance to
  intercept ("wait, don't touch that edge"). Reach because the local-
  follow toggle covers most of the perceived need — true pause is a
  nice-to-have, not a daily pain.

- **Upload orphan reaper.** ⬜ Node background images go through
  `/api/graphs/:gid/uploads`; today the only cleanup is the cascade on graph
  delete. If a user replaces or removes a node's `background-image` (or
  deletes the node entirely), the old `uploads` row sticks around. Per-graph
  storage grows monotonically until the graph itself is deleted.

  The pragmatic fix is a periodic reaper (pg_cron job or a server-side
  interval): for each graph, find `uploads` rows whose `id` isn't referenced
  by any `tasks.content` in that graph, and `DELETE` them. Eventually-
  consistent, no inline coupling between task PATCH and upload lifecycle,
  no race with a user who's mid-paste-of-the-same-bytes.

  Worth doing once we see actual storage growth from real use; until then,
  the cascade-on-graph-delete is the only sweep the system has, and that's
  fine.
