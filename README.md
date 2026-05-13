# graphtask

A graph-based task manager. Tasks are nodes; relationships between them are
edges. Each user keeps multiple separate **graphs** — pick one from the left
sidebar, sketch tasks on the canvas, edit them in a right-side inspector.

The canvas updates **live** via Server-Sent Events, so collaborators (and
LLM agents driving the API via the bundled
[skill](.claude/skills/graphtask/SKILL.md)) appear in real time — the camera
pans to whatever was just touched, and a brief flash highlights the change.

---

## Getting Started

Pick the path that matches how you want to run graphtask.

### 1. Use the hosted version

**<https://graphtask.dev.wafer.works>** — no setup, no install.

Open the link, click `+` to create a graph, start sketching tasks. Each
graph gets a 16-char random id (`/g/<id>`) that acts as the access
token — share the URL to collaborate, rotate the id from the graph
settings (`⋮` → Rotate) to revoke.

**Use it with a Claude Code agent**

```sh
# 1. One-shot install: copies the skill into ~/.claude/skills/graphtask/
#    AND merges the presence-cleanup hooks into ~/.claude/settings.json.
#    Idempotent; settings.json is backed up before any change.
bash <(curl -fsSL https://raw.githubusercontent.com/lucasness/graphtask/main/install.sh)

# 2. Install jq (the skill's recipes and the hooks parse JSON with it)
brew install jq        # macOS — or: apt install jq / apk add jq

# 3. Point the agent at the hosted instance
export GRAPHTASK_BASE_URL="https://graphtask.dev.wafer.works"

# 4. Restart Claude Code so the new hooks load, then in any project:
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

The agent creates a graph on first use and writes its id to
`.graphtask/graph-id` in the project. Open
`https://graphtask.dev.wafer.works/g/<id>` in your browser to watch the
canvas update live as the agent works.

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

**Common commands**

```sh
docker compose up -d        # run in the background
docker compose logs -f      # tail logs
docker compose down         # stop, keep data
docker compose down -v      # stop, wipe data
HOST_PORT=3001 docker compose up   # serve on a different host port
```

**Use it with a Claude Code agent**

```sh
# 1. Install the skill (one-time; available in every project on your machine)
mkdir -p ~/.claude/skills/graphtask
curl -fsSL -o ~/.claude/skills/graphtask/SKILL.md \
  https://raw.githubusercontent.com/lucasness/graphtask/main/.claude/skills/graphtask/SKILL.md

# 2. Install jq
brew install jq        # macOS — or: apt install jq / apk add jq

# 3. Point the agent at your local Docker container
export GRAPHTASK_BASE_URL="http://localhost:3000"
# (use the same HOST_PORT you set above if not the default)

# 4. Run Claude Code in any project you want to track
cd ~/projects/your-project
claude
# Then prompt: "Turn this plan into a graph" or "Track this in graphtask"
```

The agent creates a graph on first use and writes its id to
`.graphtask/graph-id` in the project. Open
`http://localhost:3000/g/<id>` to watch live updates.

If you're hacking on graphtask itself, you can skip the personal install
— `claude` run from inside the cloned repo auto-discovers the skill at
`.claude/skills/graphtask/SKILL.md`.

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

See `.env.example` for a fully-commented template.

**Auth modes**

graphtask supports three deployment shapes; pick one at process start via
`AUTH_PROVIDER`. The default is no auth, and that's the recommended mode for
local dev and single-user self-hosted installs.

| `AUTH_PROVIDER` | Required env | Behavior |
|---|---|---|
| `none` _(default)_ | — | No sign-in UI. Every graph id is a bearer token, exactly as before. |
| `clerk` | `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Browser loads Clerk JS for email-OTP sign-in. Graphs created by signed-in users get an `owner_user_id`, an `anon_role` tier (`none` / `viewer` / `editor`) for URL holders, and an explicit member list. Graphs created anonymously stay legacy URL-bearer forever. |

Legacy (un-owned) graphs never lose URL-bearer access regardless of mode, so
flipping a previously-no-auth deployment to `clerk` does not lock anyone out
of their existing graphs. Owners share an owned graph by either flipping
`anon_role` (link-shared) or adding members by email; agents authenticate
with a `gt_*` bearer token minted from the in-app key-icon panel.

**Setup**

```sh
git clone https://github.com/lucasness/graphtask.git
cd graphtask
npm install
createdb graphtask
psql graphtask -f db/schema.sql

# npm start runs `node --env-file=.env`, which errors if .env is missing.
# Create one (empty is fine) and/or set vars inline:
touch .env
DATABASE_URL=postgresql://localhost/graphtask npm start
```

Open <http://localhost:3000>.

**Tests**

`npm test` spins up and tears down a `graphtask_test` database on your local
Postgres. No extensions required.

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

**Use it with a Claude Code agent**

```sh
# 1. Install the skill (one-time; available in every project on your machine)
mkdir -p ~/.claude/skills/graphtask
curl -fsSL -o ~/.claude/skills/graphtask/SKILL.md \
  https://raw.githubusercontent.com/lucasness/graphtask/main/.claude/skills/graphtask/SKILL.md

# 2. Install jq
brew install jq        # macOS — or: apt install jq / apk add jq

# 3. Point the agent at your local server
export GRAPHTASK_BASE_URL="http://localhost:3000"
# (use the same PORT you set above if not the default)

# 4. Run Claude Code in any project you want to track
cd ~/projects/your-project
claude
# Then prompt: "Turn this plan into a graph" or "Track this in graphtask"
```

The agent creates a graph on first use and writes its id to
`.graphtask/graph-id` in the project. Open
`http://localhost:3000/g/<id>` to watch live updates.

If you're hacking on graphtask itself, you can skip the personal install
— `claude` run from inside the cloned repo auto-discovers the skill at
`.claude/skills/graphtask/SKILL.md`.

---

## Working with the agent skill — tips and patterns

Once the skill is installed (see Getting Started for the install
one-liner), here's how to actually get value out of it.

**Open the graph URL in a tab while you work.** The agent's edits land
on the canvas within ~150 ms via SSE. The camera pans to whatever the
agent just touched, the side panel opens to show the new content, and
the node briefly flashes in a color matching the action:

- **blue dashed border** — new task created
- **orange / yellow / green underlay** — task moved to `in_progress` /
  `review` / `done` respectively
- **purple underlay** — body edited without changing status

Watching the agent work this way is most of the value — the graph IS
the visible artifact of the agent's progress.

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
control. To collaborate, share `https://graphtask.dev.wafer.works/g/<id>`
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

---

## Hot Keys

| Key | Behavior |
|---|---|
| `F` | Fit graph to viewport (preserves layout) |
| `T` | Tidy: re-run layout with tight spacing, persist new positions, then fit. Overrides any custom node placements |
| `G` | Create a node at the visible-area center |
| `S` | Cycle selected node status; Enter saves, Esc cancels |
| `B` | Open color palette for selected nodes/edges |
| `E` | Start edge creation, cycle in-progress edge direction, or cycle selected edge direction |
| `Enter` | Commit pending explicit edit session |
| `Cmd/Ctrl+Enter` | Commit new-node creation from anywhere |
| `Esc` | Cancel current edit, close panel, or clear selection |
| `Backspace/Delete` | Open delete confirmation |
| Arrow keys | Move selection to nearest node/edge in that direction; inside color palette, navigate swatches |
| Cmd/Ctrl drag | Rubber-band select nodes and edge midpoints |

---

## Editing Flows

### Nodes

- Clicking empty canvas creates a pending Cytoscape node with id `__pending__`.
- Pending nodes are visible immediately but are not persisted until the title
  is committed (Enter or Cmd/Ctrl+Enter).
- Existing task fields autosave with a short debounce.
- Status cycling is optimistic: `S` changes the visible status; Enter saves
  and Esc restores.
- Inline title editing uses an HTML contenteditable overlay positioned over
  the Cytoscape node. It scales with zoom and resizes the Cytoscape node.

### Edges

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

### Color Palette

- `B` opens the palette for selected nodes, edges, or mixed selections.
- Palette values come from the Flexoki dark theme used by the app.
- Swatches show the actual color that will be applied to node fill or edge
  line/arrow color.
- Arrow keys navigate as a 2D 5-column grid. Enter or click applies and saves.
- Color changes affect background/edge color, not the selection highlight.

### Graph metadata

- `⋮` on a sidebar card opens `#graph-modal` with name + description fields
  and Save / Delete buttons. Esc or backdrop click cancels. Delete reuses the
  shared `confirmDelete` modal.

---

> The remaining sections cover the HTTP API, data model, internal
> architecture, and conventions. They're primarily reference material for
> agent implementers and contributors hacking on graphtask itself — if
> you're just using the app or the agent skill, you can stop here.

---

## Stack

- Backend: Express 5 on Node 22, PostgreSQL (any modern version), `pg`, and `yaml`.
- Frontend: Vanilla JS, Cytoscape.js, TOAST UI Editor, and CSS using a Flexoki
  dark palette. No build step.
- Tests: Vitest and supertest.
- Package manager: npm.

---

## Layout

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

---

## Data Model

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
  optional saved graph coordinates `x`/`y`.
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

---

## API

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
| GET | `/api/config` | `{auth_enabled, provider, viewer_user_id}`; the SPA reads this on boot to decide whether to load Clerk |
| GET / POST / DELETE | `/api/graphs/:gid/members` (+ `/pending/:email`) | Owner-managed sharing; pending rows auto-claim on the invitee's first sign-in |
| GET / POST / DELETE | `/api/me/agent_tokens` | Mint / list / revoke `gt_*` bearer tokens for agent attribution |

`requireIntegerParam('id')` middleware on numeric `:id` segments returns 400
on non-integer values (otherwise Postgres would raise a 500). `:gid` is an
opaque short string; a bad one falls through to a 404.

`markdown.applyDefaults` coerces YAML-parsed title and description to strings
before validation, so scalar YAML values do not break task saves.

---

## Agent design notes

The HTTP API above is stable enough for an LLM agent (Claude Code, Codex,
or anything that can run `curl`) to drive end to end. The skill install
steps live inside each Getting Started path above; this section covers
the conventions and constraints any agent integration should follow.

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

---

## Frontend Model

The frontend has four main regions:

- **Sidebar**: `#sidebar` lists graphs with name + relative updated time.
  `+` creates a new graph; `⋮` opens the edit modal (rename, description,
  delete). The active graph card is highlighted.
- **Canvas**: `#cy` fills the area to the right of the sidebar. Cytoscape
  paints nodes and edges. Styling is driven by element data (`status`,
  `color`, `edgeType`, `curve`) and transient classes (`selected`, `editing`,
  `leaf`, `dir-backward`, `edge-type-editing`, `edge-hover-target`,
  `preview`, `phantom`, `agent-flash-*`).
- **Side panel**: `#panel` is a resizable right-side inspector for node
  title, status, and markdown body. Opening it recenters the selected node
  in the visible canvas area (sidebar-aware via `cy.width()`).
- **Bottom toolbar**: `#bottom-bar` is contextual and changes by selection
  mode. Centered within the canvas area.

### Active-graph routing

- URL: `/g/:gid` reflects the active graph; bookmarkable.
- Boot resolution order: URL → `localStorage` last-active → first available
  graph → none.
- `popstate` keeps the canvas in sync with browser back/forward.
- All API calls go through an `apiBase()` helper that prefixes
  `/api/graphs/:activeGraphId`, so a route's URL never accidentally targets
  the wrong graph.

### Lazy graph creation

When no graph is active, the canvas placeholder reads "Click here for a new
task". Clicking the canvas (or pressing `G`, or the `+` toolbar button)
lazily creates an `Untitled` graph and immediately starts the new-task flow
at the click position. If the user backs out without committing the first
task, a deferred check (`maybeCleanupLazyGraph`) deletes the empty graph and
resets the URL to `/`.

### Selection Modes

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

### Agent-follow

When an SSE event arrives indicating an external (non-local) edit on a task,
the client (a) refetches the graph with selection preservation, (b) animates
the camera to the affected node, (c) briefly flashes the node with a
semantic color (blue for INSERT, status colors for status changes, purple
for body-only edits), and (d) for UPDATE events, opens the side panel
showing the new content. Agent-follow is suppressed if the user
`pointerdown`/`keydown`/`wheel`d in the last 2 seconds, so manual work isn't
yanked around. `loadIntoEditor` sets a 200ms suppression window on the
autosave scheduler so the synthetic `change` event from `setMarkdown`
doesn't cause a round-trip-PATCH echo loop.

---

## Notable Decisions

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

---

## Where To Look First

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

---

## Current Caveats

- Multi-node edge creation is fan-out. If the target is also selected, the
  self-edge is skipped.
- Lazy graph cleanup is local to the active session — closing the tab during
  a pending node leaves an empty `Untitled` graph in the sidebar; it can be
  deleted manually via the `⋮` modal.
- Schema changes that alter column types still need a manual `DROP TABLE`
  on existing databases; `IF NOT EXISTS` won't pick up type diffs.
- The frontend is intentionally not modularized yet.
