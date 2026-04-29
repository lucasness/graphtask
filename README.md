# graphtask

A graph-based task manager. Tasks are nodes; relationships between them are
edges. Each user keeps multiple separate **graphs** — pick one from the left
sidebar, sketch tasks on the canvas, edit them in a right-side inspector.

---

## Getting Started

Pick the path that matches how you want to run graphtask.

### 1. Use the hosted version

> _Hosted instance coming soon — link will go here._

No setup, no install. Open the link, start sketching graphs.

### 2. Run locally with Docker

The simplest local path. Everything — Node, Postgres, the pgRouting extension —
runs inside a single container, so you don't have to match versions or install
anything language-specific.

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

### 3. Run locally without Docker

For development, or if you'd rather not use Docker. You install Node and
Postgres yourself and point the app at your local database.

**Prerequisites**

- **Node 22+** — the start script uses `node --env-file`, a Node 22 flag.
- **PostgreSQL 17+** with the [`pgrouting`](https://pgrouting.org) extension
  installed (Debian/Ubuntu: `postgresql-17-pgrouting`; Homebrew: `pgrouting`).
  Required for the shortest-path API and for the test suite.

**Environment variables** (resolved in `src/db.js` / `src/server.js`, loaded
from `.env` by `npm start`)

- `DATABASE_URL` — full Postgres connection string. Takes precedence over the
  pair below.
- `PG_BOOTSTRAP_URL` + `DATABASE_NAME` — alternative: the URL's path is
  replaced with `/<DATABASE_NAME>` at runtime.
- If neither is set, falls back to `postgresql://postgres@localhost/graphtask`.
- `PORT` _(optional, default `3000`)_ — port the Express server binds to on
  `127.0.0.1`.

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
Postgres; `pgrouting` must be installed there.

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

---

## Stack

- Backend: Express 5 on Node 22, PostgreSQL with pgRouting, `pg`, and `yaml`.
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
  routes/
    _validate.js     requireIntegerParam middleware
    graphs.js        CRUD on /api/graphs
    tasks.js         task CRUD + leaves/subtasks/ancestors, all graph-scoped
    edges.js         edge CRUD with transactional cycle detection
    graphView.js     /api/graphs/:gid/graph and shortest-path payloads
db/
  schema.sql         graphs, tasks, edges, edge_type enum, updated_at trigger,
                     short-id generator function
public/
  index.html         static markup: sidebar, canvas, inspector, toolbar, modals
  app.js             frontend graph behavior + multi-graph sidebar
  style.css          app shell, sidebar, toolbar, palette, modal styles
tests/               Vitest specs: graphs, tasks, edges, graph queries, db, api
Dockerfile           Postgres 17 + pgRouting + Node 22 image
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
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
  content TEXT NOT NULL,                     -- canonical markdown
  meta JSONB NOT NULL,                       -- structured copy of frontmatter
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)

edges(
  id SERIAL PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  target_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  type edge_type,                            -- dependency | related
  meta JSONB NOT NULL,
  UNIQUE(source_id, target_id),
  CHECK(source_id <> target_id)
)
```

- `graphs.id` is an opaque 8-char string (`a-z` + `2-9`, omitting `0/1/i/l/o`)
  generated by `generate_short_graph_id()` in plpgsql. The route retries on
  the negligible chance of a unique-violation collision. Avoids the URL
  leaking creation count the way `SERIAL` would.
- `graphs.updated_at` is bumped by an AFTER trigger on tasks/edges INSERT/
  UPDATE/DELETE. Sidebar timestamps reflect last activity in a graph.
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
- Cycle detection (POST + PATCH) runs inside a single transaction with
  `LOCK TABLE edges IN SHARE ROW EXCLUSIVE MODE` so concurrent writers can't
  both pass the check.

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
| GET | `/api/graphs/:gid/graph/shortest-path` | pgRouting shortest path |
| GET | `/api/graphs/:gid/events` | Server-sent events; pushes `{graph_id, kind, op}` on every task/edge change |

`requireIntegerParam('id')` middleware on numeric `:id` segments returns 400
on non-integer values (otherwise Postgres would raise a 500). `:gid` is an
opaque short string; a bad one falls through to a 404.

`markdown.applyDefaults` coerces YAML-parsed title and description to strings
before validation, so scalar YAML values do not break task saves.

---

## Agent API

The HTTP API above is stable enough for an LLM agent (Claude Code, Codex,
or anything that can run `curl`) to drive end to end — create a graph,
add tasks, wire dependencies, update statuses as work progresses, and
traverse for next-actionable tasks. The browser canvas updates live via
the `/events` SSE endpoint, so a user watching a graph sees the agent's
edits in real time.

The convention to follow as an agent:

- Persist the active graph id in `.graphtask/graph-id` (per-project, kept
  out of git — it's bearer-token equivalent).
- Move tasks `todo → in_progress → review`. **Never set `done`.**
  `done` is the human's confirmation; `review` is the agent's
  "I think this is finished, please confirm." Treat `review` as
  not-yet-done for dependency-readiness purposes.
- Use `POST /edges/bulk` for any multi-edge import — it's transactional
  and fails atomically with a `failedAt` index, so you never end up with
  a half-built dependency graph.
- If a graph id leaks, `POST /api/graphs/:id/rotate-id` invalidates it.

### Install the agent skill

The repo ships a Claude Code skill at `.claude/skills/graphtask/SKILL.md`
that teaches the agent the workflow above (graph resolution, status
discipline, bulk edges, status-aware traversal). Most users want the agent
available in **other** projects (so it can track work on whatever they're
building, with graphtask running in the background) — that's the
"personal" install:

**Personal — recommended for most users** (works in any project on your
machine):

```sh
# No clone needed; download just the skill file:
mkdir -p ~/.claude/skills/graphtask
curl -fsSL -o ~/.claude/skills/graphtask/SKILL.md \
  https://raw.githubusercontent.com/lucasness/graphtask/main/.claude/skills/graphtask/SKILL.md

# Then in the project you want to track:
cd ~/projects/my-real-project
claude        # the `graphtask` skill is now available globally
```

**Project-local — when you're working on graphtask itself.** Clone the
repo and Claude Code auto-discovers `.claude/skills/graphtask/SKILL.md`
when run from inside it. No install step:

```sh
git clone https://github.com/lucasness/graphtask.git
cd graphtask
claude
```

**Other agents (Codex, Cursor, etc.)** — the skill follows the open
[Agent Skills](https://agentskills.io) standard. Refer to your tool's
docs for the install path; the `SKILL.md` itself is portable.

#### Pointing at a hosted instance

By default the skill talks to `http://127.0.0.1:3000`. To use a hosted
graphtask instead, set `GRAPHTASK_BASE_URL` in the shell where you run
Claude Code:

```sh
export GRAPHTASK_BASE_URL="https://graphtask.example.com"
claude
```

Each graph's id is the only access control (no user accounts), so to share
or collaborate, just share the URL `${GRAPHTASK_BASE_URL}/g/<id>`. To
revoke a leaked id, hit `POST /api/graphs/<id>/rotate-id` from the UI's
rotate button or the API.

#### Dependencies

The skill drives the API via `curl` and `jq`. `curl` is universal; `jq`
needs to be installed separately on most systems (`brew install jq`,
`apt install jq`, `apk add jq`). Without `jq`, the recipes parse JSON
incorrectly.

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
  `preview`, `phantom`).
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

## Hot Keys

| Key | Behavior |
|---|---|
| `F` | Fit graph to viewport |
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

## Notable Decisions

- **Multi-graph as nested resources.** Routes are `/api/graphs/:gid/...`
  rather than carrying a graph_id query param everywhere. All cross-graph
  reads/writes are blocked at the route layer, not just the database.
- **Short opaque graph IDs.** Generated by a small plpgsql function used as
  the column DEFAULT. Avoids leaking creation count via auto-increment.
- **Transactional cycle detection.** `BEGIN` + `LOCK TABLE edges IN SHARE
  ROW EXCLUSIVE MODE` + recursive-CTE cycle check + INSERT/UPDATE in one
  unit. Concurrent dependency-edge writes can't both pass the check.
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
- OpenGraph preview metadata is not configured for the deployed app.
