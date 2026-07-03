# graphtask

**graphtask turns a plan into a picture.** You sketch the things you need to do
as boxes on a canvas and draw lines between the ones that depend on each other,
so the shape of the work — what's blocked, what's ready, what's done — is
something you can see and rearrange instead of a flat checklist.

Under the hood it's a graph-based task manager: tasks are nodes, relationships
between them are edges. Each user keeps multiple separate **graphs** — pick one
from the left sidebar, sketch tasks on the canvas, edit them in a right-side
inspector.

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
bucketing, member invitations, per-graph access tier). See
[Authentication](#authentication) for what changes when you sign in.

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
- **PostgreSQL 14+** — any modern version. No extensions to install by hand —
  the schema only uses the standard-contrib `pgcrypto` extension (bundled with
  stock Postgres) and creates it itself. All graph traversal runs as recursive
  CTEs.

**Environment variables** (resolved in `src/db.js` / `src/server.js`, loaded
from `.env` by `npm start`)

- `DATABASE_URL` — full Postgres connection string. Takes precedence over the
  pair below.
- `PG_BOOTSTRAP_URL` + `DATABASE_NAME` — alternative: the URL's path is
  replaced with `/<DATABASE_NAME>` at runtime.
- If neither is set, falls back to `postgresql://postgres@localhost/graphtask`.
- `PORT` _(optional, default `3000`)_ — port the Express server binds to on
  `127.0.0.1`.
- `AUTH_PROVIDER` _(optional, default `none`)_ — see [Authentication](#authentication).
- `GRAPHTASK_UPLOAD_MAX_BYTES` _(optional, default `5242880` = 5 MB)_ — per-image
  upload cap in raw bytes. Images are stored as BYTEA inside the same Postgres
  database (no extra object store), so this also bounds how big a single row in
  the `uploads` table can get.

**The database must already exist; the schema does not.** graphtask applies
`db/schema.sql` automatically and idempotently on every boot (`CREATE TABLE IF
NOT EXISTS`, guarded `ALTER`s), so there's no manual migration step — but it
won't create the database itself, so boot fails at the first query if it's
missing. Create one with `createdb <name>`, or point `DATABASE_URL` at a database
a managed provider (RDS / Supabase / Neon) already gave you, and the first boot
populates the tables.

See `.env.example` for a fully-commented template.

Sign-in (the optional Clerk auth mode) is configured the same way on every run
path — see [Authentication](#authentication).

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

`npm test` (re)creates a `graphtask_test` database on your local Postgres at
the start of each run (dropping any prior one). No extensions to install by
hand — the schema only uses the standard-contrib `pgcrypto` extension (bundled
with stock Postgres) and creates it itself.

Production tuning notes (open-file limits, single-process presence) live
under [Production notes](#production-notes).

---

## Authentication

graphtask supports two deployment shapes; pick one at process start via
`AUTH_PROVIDER`. The default is no auth — the recommended mode for local dev and
single-user self-hosted installs; the hosted instance runs `clerk`. Whichever run
path you took in [Getting started](#getting-started), sign-in is configured the
same way here.

| `AUTH_PROVIDER` | Required env | Behavior |
|---|---|---|
| `none` _(default)_ | — | No sign-in UI. Every graph id is a bearer token, exactly as before. |
| `clerk` | `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Browser loads Clerk JS for email-OTP sign-in. Graphs created by signed-in users get an `owner_user_id`, an `anon_role` tier (`none` / `viewer` / `editor`) for URL holders, and an explicit member list. |

**The access model, briefly.** With Clerk on, a graph has at most one owner who
can add `viewer`/`editor` members by email, and every graph also carries an
`anon_role` tier (`none` → 403, `viewer` → read-only, `editor` → read+write,
anonymously attributed) for anyone holding just the URL. Legacy graphs
(`owner_user_id IS NULL`) always behave as URL-bearer, so flipping a no-auth
deployment to Clerk doesn't retroactively lock them down. Agents authenticate
with a `gt_*` bearer token (minted from the in-app key-icon panel), which the
server tells apart from Clerk session JWTs (`eyJ…`) by prefix-checking the
`Authorization` header. The full model — sharing flows, pending-member
auto-claim, client-side storage, live access-change propagation, and what's out
of scope — lives in [Sharing & access model —
deep dive](#sharing--access-model--deep-dive).

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

---

## Using it with an agent

graphtask ships a Claude Code skill (`SKILL.md`) so an LLM agent can drive
your graphs end-to-end while you watch the canvas update live. Works on
any deploy path — hosted, Docker, or local.

### Set up

```sh
# 1. Install jq (the skill's recipes and the hooks parse JSON with it).
#    install.sh exits early if jq is missing, so install it first.
brew install jq        # macOS — or: apt install jq / apk add jq

# 2. Install the skill (one-time; available in every project on your machine).
#    Also merges presence-cleanup hooks into ~/.claude/settings.json
#    (with a timestamped backup) so the agent's 🤖 avatar blinks out
#    cleanly when it stops working.
bash <(curl -fsSL https://raw.githubusercontent.com/lucasness/graphtask/main/install.sh)

# 3. Point the agent at your graphtask instance
export GRAPHTASK_BASE_URL="https://graphtask.wafers.live"   # hosted
# export GRAPHTASK_BASE_URL="https://graphtask.example.com"     # self-hosted
# export GRAPHTASK_BASE_URL="http://localhost:3000"             # local Docker / npm start

# 4. Mint and export an agent token — recommended on auth-enabled instances
#    (the hosted one always is). Without it the agent still works, but anonymously:
#    what it creates isn't tied to your account or shown in your "My graphs"
#    sidebar. With a token, your work is saved to you. The agent will flag this
#    and offer to proceed either way. See "Mint an agent token" below.
export GRAPHTASK_AGENT_TOKEN=gt_...

# 5. Restart Claude Code so the new hooks load, then in any project:
cd ~/projects/your-project
claude
# Prompt: "Turn this plan into a graph" or "Track this in graphtask"
```

What `install.sh` does — also visible in the script itself:
- copies `SKILL.md` to `~/.claude/skills/graphtask/`
- copies the bundled `workflows/` (e.g. `research.workflow.js`, referenced by SKILL.md) to `~/.claude/skills/graphtask/workflows/`
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
always does; local / Docker setups only if you opted in), a `gt_*` token
attributes the agent's writes to your account. It's **recommended, not
required**: without one the agent still works, but anonymously — the
graphs it creates are owner-less (`owner_user_id NULL`) and don't appear
in your "My graphs" sidebar, reachable only by URL. With a token, your
work is saved to you. The skill is set up to notice when no token is
present, tell you this tradeoff, and let you choose — provide a token, or
go ahead anonymously.

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
| `C` | Graph | Open color palette for the selected edge(s) (edge-context color; `B` also works) |
| `D` | Graph | Cycle selected edge direction forward → related → backward (canonical edge-direction key; `E` also works) |
| `Enter` | Graph | Commit pending explicit edit session |
| `Cmd/Ctrl+Enter` | Both | Commit new-node creation from anywhere — only while an unsaved pending node exists (graph view). Panel field edits autosave on a short debounce; no key is needed to save them. |
| `Esc` | Both | Cancel current edit, close panel, or clear selection |
| `Backspace/Delete` | Both | Open delete confirmation |
| Arrow keys | Graph | Move selection to nearest node/edge in that direction; inside color palette, navigate swatches |
| Cmd/Ctrl drag | Graph | Rubber-band select nodes and edge midpoints |
| `Cmd/Ctrl+K` | Both | Open settings |
| `Cmd/Ctrl+F` | Both | Open the in-app search bar (KB search); replaces the browser's native find |

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
- Hover an edge to reveal a draggable curve handle: drag it to reshape the
  edge's bend — parallel position along the edge sets `curve.weight`,
  perpendicular distance sets `curve.distance` (bulge height). The exact
  back-solve and per-edge clamping math is in [Data Model](#data-model).

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
  purpose TEXT NOT NULL DEFAULT 'related to', -- required for | supports | contradicts | related to (E15, canonical)
  type edge_type,                            -- derived from purpose: required for→dependency, else→related
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

reports(
  graph_id TEXT PRIMARY KEY REFERENCES graphs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  title TEXT NOT NULL,                       -- ≤ 200 chars
  description TEXT,                          -- nullable, ≤ 500 chars
  body TEXT NOT NULL DEFAULT '',             -- the report markdown
  source_graph_version INTEGER,              -- graphs.version at generation (staleness key)
  run_id TEXT,                               -- workflow-run attribution
  meta JSONB NOT NULL DEFAULT '{}',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
- `reports` is the graph's ONE canonical human-readable report (E16), keyed by
  `graph_id` (one row per graph; `PUT` replaces it in place). It lives OUTSIDE
  the tasks/edges model and carries its OWN notify trigger that emits
  `pg_notify('graph_change', { kind: 'report' })` but — unlike the tasks/edges
  trigger — never bumps `graphs.updated_at`/`version`. So generating or updating
  a report has ZERO impact on the graph, which keeps staleness meaningful: the
  reader flags a report as out of date when its `generated_at` predates
  `graphs.updated_at`. Reports inherit their graph's visibility (reads gated
  `read`, writes gated `edit`) and are never git-committed — they're DB state,
  not repo files, so report generation stays outside `save-project`.
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
- Curve-handle drag math (contributor detail): the hover handle sits *on* the
  rendered curve at `B(t = weight)` — the bezier sample at the weight parameter.
  Dragging it back-solves both fields: parallel position maps to `curve.weight`
  via inverse-smoothstep, perpendicular distance back-solves into
  `curve.distance`. Weight is clamped per-edge to a dynamic range derived from
  each node's size + a small margin, so the handle can never land inside either
  endpoint node — the bounds intersect the static `[0.10, 0.90]` range. Changing
  weight slides the bulge along the edge but doesn't change *how sharply* the
  curve bends; that's `distance` (a quadratic bezier's perpendicular peak is
  always at parameter 0.5 with magnitude `0.5·distance`).
- `dependency` edges are directed and acyclic; `related` edges can form loops.
- Cycle detection (POST + PATCH + bulk) runs inside a single transaction
  with `LOCK TABLE edges IN SHARE ROW EXCLUSIVE MODE` so concurrent writers
  can't both pass the check.
- Graph names are not globally unique — duplicate-name `POST` and `PATCH`
  both succeed. The old `graphs_name_norm_uniq` index was dropped when
  owner/member auth landed; rely on `id`, not `name`, for any lookup.

#### Universal schema (E15)

**E15** is the internal codename for this universal-schema milestone — the work
that made one backward-compatible schema serve both execution plans and deep
research. Everything is additive and optional — a plain task graph that never
sets these fields behaves exactly as before.

- **Edge `purpose`** is the canonical edge field, directed source→target, one of `required for` · `supports` · `contradicts` · `related to` (default). The server **derives** the structural `type` from it (`required for` → `dependency`, the other three → `related`) and emits both, so the canvas and every dependency query (ready/blockers/unblocks/cycle-check) are unchanged. Writes set `purpose` (the only accepted edge field on writes — a legacy `type` is no longer accepted). Only `required for` is cycle-checked and traversed by the status queries; `supports`/`contradicts` are the directed **signed** relations the inconsistency scan reads.
- **Reserved typed node fields** in `meta` (validated when present; no migration — `meta` is JSONB): `type` (open string ≤40; `reference` = an external source, absent = a work/knowledge node), `significance` (number 0–1, universal), `confidence` (number 0–1, research-tier), `verified_at` (ISO-8601 datetime, a deliberate re-check, distinct from the automatic `updated_at`). The three numeric/datetime fields are merge-protected like `x`/`y` (a body-rewriting agent PATCH that omits them keeps them; explicit `null` clears).
- **Role predicates** (derived, not stored): a **claim** = `confidence` set AND `type` ≠ `reference`; an **open question** = `status: todo` with no `confidence`; a **reference** = `type: reference`.
- **No canvas/UI rendering** for the new fields, by design — they're agent-/query-facing. The canvas still renders off the derived `type`.
- **Completion gates** (the skill enforces both): stop at `review`, never `done`; and after any graph write, run the inconsistency scan and surface tensions — never auto-resolve a `contradicts` edge.

### API

All task/edge/graph-view routes are scoped to a graph via `:gid`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/graphs` | List graphs, ordered by `updated_at DESC` |
| POST | `/api/graphs` | Body: `{name, description?, allow_anonymous?}`. Owner = the authenticated caller. **Orphan guard:** on an accounts-enabled instance an *unauthenticated* create is refused `401` (would be an owner-less graph, invisible in "My graphs") unless `allow_anonymous:true` is sent. No-auth instances + authenticated callers are unaffected. |
| GET | `/api/graphs/:id` | Fetch one graph |
| PATCH | `/api/graphs/:id` | Body: any of `{name, description}`; bumps `updated_at` |
| DELETE | `/api/graphs/:id` | Cascades to tasks and edges |
| GET | `/api/graphs/:gid/tasks` | List tasks in graph |
| POST | `/api/graphs/:gid/tasks` | Body: `{content}` markdown blob |
| GET | `/api/graphs/:gid/tasks/:id` | Fetch one task |
| PATCH | `/api/graphs/:gid/tasks/:id` | Body: `{content}` |
| DELETE | `/api/graphs/:gid/tasks/:id` | Cascades to edges |
| GET | `/api/graphs/:gid/tasks/leaves` | Tasks with no incoming dependency edges |
| GET | `/api/graphs/:gid/tasks/ready` | Open questions ready to start: `status:todo` AND **no `confidence` set** AND every recursive prereq is `done` (treats `review`/`in_progress` as not-yet-done). A confidence-bearing todo node is a claim/finding, not ready work — its re-checking is `/frontier`'s job, so it never appears here. |
| GET | `/api/graphs/:gid/tasks/:id/subtasks` | All recursive prerequisites |
| GET | `/api/graphs/:gid/tasks/:id/ancestors` | All recursive dependents |
| GET | `/api/graphs/:gid/tasks/:id/blockers` | Recursive prereqs whose status is not `done` |
| GET | `/api/graphs/:gid/tasks/:id/unblocks` | Direct parents that would become ready if this task were marked done |
| GET | `/api/graphs/:gid/edges` | List edges in graph |
| POST | `/api/graphs/:gid/edges` | Body: `{source_id, target_id, purpose, meta?}` — `purpose` ∈ `required for \| supports \| contradicts \| related to`, required (server derives + stores `type`; legacy `type` no longer accepted) |
| POST | `/api/graphs/:gid/edges/bulk` | Body: `{edges: [...]}` — transactional, all-or-nothing; returns `{edges: [...]}` or `{error, failedAt}` |
| PATCH | `/api/graphs/:gid/edges/:id` | Partial update; supports endpoints, `purpose`, meta (a purpose change into/out of `required for` re-runs cycle detection) |
| DELETE | `/api/graphs/:gid/edges/:id` | Delete edge |
| POST | `/api/graphs/:id/rotate-id` | Issue a new graph id; old URL stops working |
| GET | `/api/graphs/:gid/graph` | Combined `{nodes, links}` canvas payload |
| GET | `/api/graphs/:gid/graph/shortest-path` | Recursive-CTE BFS over dependency edges (undirected) |
| POST | `/api/graphs/:gid/search` | Hybrid keyword+vector search over the graph's nodes. Body: `{query, config?, filter?}`. Returns `{query, results, timings}` where `results` is the ranked candidate list (`{taskId, score, source, snippet, meta}`). The optional `filter` (E15) is a Mongo-style metadata filter (`$eq/$ne/$gt/$gte/$lt/$lte/$in/$nin` + `$and/$or`) that post-filters results without changing ranking. |
| POST | `/api/search` | Cross-graph search over the graphs the caller can read |
| POST | `/api/graphs/:gid/context` | Query- or node-seeded k-hop neighborhood with bodies (one cohesive KB call). Body `{query?\|seeds?, hops?, maxNodes?, edgeTypes?, alpha?, filter?}`. The E15 `filter` applies at output with the **bridge rule** (a node bridging two matching nodes is retained, marked `bridge:true`), never pruning traversal. |
| POST | `/api/graphs/:gid/frontier` | E15 re-verification frontier: load-bearing (out-degree of `required for`+`supports`) ∧ (stale ∨ low-confidence) confidence-bearing nodes. Body `{minImportance?, staleDays?, lowConfidenceBelow?, maxResults?}` → `{frontier, truncated, params}`. |
| POST | `/api/graphs/:gid/inconsistencies` | E15 signed-cycle scan: directed cycles in the supports/contradicts subgraph with an odd number of `contradicts` edges. Body `{start?, maxCycleLen?, maxCycles?}` (graph-wide, or per-claim when `start` is a node id) → `{mode, inconsistencies, truncated, scanned}`. |
| POST | `/api/graphs/:gid/batch` | Transactional upsert of many nodes + edges (idempotent per node `external_id`; `run_id` attribution). The dynamic-workflow write-back path. |
| GET | `/api/graphs/:gid/events` | Server-sent events; pushes `{graph_id, kind, op, id}` on every task/edge change |
| POST | `/api/graphs/:gid/uploads` | Raw image bytes (`image/png\|jpeg\|gif\|webp\|svg+xml`, 5 MB cap). Returns `{id, url, content_type, byte_size}` — reference the URL from a task's `background-image` frontmatter to render the image inside the node frame. |
| GET | `/api/graphs/:gid/uploads/:id` | Image bytes, served with stored content-type, immutable cache headers, and `X-Content-Type-Options: nosniff`. |
| GET / PUT / DELETE | `/api/graphs/:gid/report` | The graph's ONE canonical report (E16), stored outside tasks/edges so writes never bump `graphs.updated_at`. **GET** (read) returns the report plus `viewer_can_edit`; **PUT** (edit) upserts and replaces it in place (one per graph, idempotent); **DELETE** (edit) removes it. A viewer/anon can read but not write. |
| GET | `/api/graphs/:gid/report/meta` | Body-less existence + staleness probe (read). Returns `{exists:false}` or `{exists:true, title, generated_at, updated_at, source_graph_version, graph_updated_at, stale}`, where `stale` means the report's `generated_at` predates the graph's last change. GET (not HEAD — HEAD would classify as `edit` and 403 a viewer). |
| GET | `/api/reports` | Cross-graph report list for the reader's rail: the graphs the caller owns or is a member of that have a report (scope-SQL-as-ACL, mirroring `/api/search`). Metadata only, no bodies; anonymous → `[]` (never 401). |
| GET | `/api/config` | `{auth_enabled, provider, publishable_key, viewer_user_id}`; the SPA reads this on boot to decide whether to load Clerk |
| GET / POST / DELETE | `/api/graphs/:gid/members` (+ `/pending/:email`) | Owner-managed sharing; pending rows auto-claim on the invitee's first sign-in |
| GET / POST / DELETE | `/api/me/agent_tokens` | Mint / list / revoke `gt_*` bearer tokens for agent attribution |

`requireIntegerParam('id')` middleware on numeric `:id` segments returns 400
on non-integer values (otherwise Postgres would raise a 500). `:gid` is an
opaque short string; a bad one falls through to a 404.

`markdown.applyDefaults` coerces YAML-parsed title and description to strings
before validation, so scalar YAML values do not break task saves.

### Agent design notes

The HTTP API is stable enough for an LLM agent (Claude Code, Codex, or anything
that can run `curl`) to drive end to end. The **canonical agent contract** —
recipes, the OCC pattern, and the exact endpoint predicates — lives in the
[skill](.claude/skills/graphtask/SKILL.md); this section is a short orientation
that points there rather than re-stating it. Install steps are in [Using it with
an agent](#using-it-with-an-agent).

- **Conventions.** Persist the active graph id in `.graphtask/graph-id`
  (per-project, git-ignored, bearer-token equivalent); move tasks `todo →
  in_progress → review` and **never set `done`** (that's the human's
  confirmation, and `/tasks/ready`·`/blockers`·`/unblocks` already treat
  `review` as not-yet-done); use `POST /edges/bulk` for multi-edge imports
  (transactional, `failedAt` index on failure); `POST /api/graphs/:id/rotate-id`
  invalidates a leaked id. Full status discipline is in SKILL.md §3.
- **Search.** For "what does the graph say about X", call `POST
  /api/graphs/:gid/search`, take the top ~50, and rerank/synthesize from them —
  the retriever is tuned for **recall** and the agent is itself the most capable
  reranker, so the agent path needs no server-side rerank. The why, the `eval/`
  harnesses, and the tier model are in [design/SEARCH.md](design/SEARCH.md).
- **Search + traversal.** Search jumps to the most relevant nodes by content;
  traversal follows their edges. When the graph *is* a knowledge base
  (concept-page nodes, `related` cross-references), **search for the entry
  node(s), then walk `related` links** to read the neighborhood — the index is
  `GET /api/graphs/:gid/graph` → `{nodes, links}` (nodes minus body, edges with
  `type`); fetch bodies with `GET /tasks/:id`. The structural endpoints
  (`/subtasks`, `/ancestors`, `/blockers`, `/unblocks`, `/ready`, `/leaves`) and
  `/graph/shortest-path` follow **`dependency` edges only** — a `related`-linked
  KB is navigated through the `/graph` map.
- **Write-side structure.** Read quality is downstream of write-time structure,
  so the skill carries a write-side doctrine (SKILL.md §2): author real **bridge
  nodes** instead of faking direct edges, name a node's neighbors in its body,
  keep `related` edges genuine and specific, and **optimize for truth, not the
  retriever**. A/B-validated to lift mid-tier multi-hop answer quality while
  keeping the graph leaner, not denser.
- **Live updates.** The browser canvas re-renders within ~150 ms of any
  task/edge mutation via the `/events` SSE endpoint; the agent doesn't need to
  consume the stream itself.
- **Other agents (Codex, Cursor, etc.).** The skill follows the open [Agent
  Skills](https://agentskills.io) standard and is portable; any agent that can
  `curl` is a viable client — refer to your tool's docs for the install path.

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

**View registry (modular UI primitives).** The per-view branches that once
accreted as inline `if (currentView === 'kanban') { … }` checks — toolbar button
visibility, the global keydown switch, `peerCursorRefresh` positioning,
`applyPeerSelectionToCy`'s card paint, the Escape handler, SSE task hooks, the
"New" control, and `applyView` itself — now dispatch through a single `VIEWS`
registry. Each view is one entry implementing a shared `View` interface (`enter`,
`adjustLayout`, `updateToolbar`, `handleKeydown`, `onEscape`, `renderPeerCursors`,
`wipePeerCards` / `paintPeerCard`, `onRemoteTaskEvent`, `createPrimaryItem`),
resolved via `activeView()`. Adding a third view (e.g. tech tree) means adding a
registry entry, not threading another conditional through every surface. The
registry also documents the forward-looking extension points — a view's
agent-follow target and applicable selection modes — for views still to land. See
the "View registry (modular UI primitives)" block at the top of `public/app.js`.

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
when the agent broadcasts its current task — see [Multi-peer
presence](#multi-peer-presence).
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

Agents writing through this presence layer must use OCC (PATCH with
`base_version` + `base_content`) so concurrent UI-managed keys survive a
body-rewriting PATCH. The canonical agent-facing OCC contract — the
`work_on_task` / `announce_focus_edge` helpers and the exact protected-key list
— is owned by the [skill](.claude/skills/graphtask/SKILL.md); the server-side
three-way-merge mechanics are in [Notable Decisions](#notable-decisions).

Agent-vs-agent same-field conflicts use **owner-agent precedence**: the agent
whose `owner_user_id` matches `graphs.owner_user_id` wins; if both or neither are
the graph owner's, it falls through to last-write-wins. Human-vs-agent is
unchanged — human always wins.

### Sharing & access model — deep dive

Extends the [Authentication](#authentication) section — the auth modes table and
the access-model summary.

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
  signed-out sidebar bucketing, and the `created: true` flag is the
  input to the auto-claim flow (see *Anon creates a graph, then signs in
  later* under Sharing flows).
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

**Out of scope (auth)**

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
  preserves the current value. Tasks protect `x`, `y`, `color`,
  `background-image`, plus the E15 research fields `significance`,
  `confidence`, `verified_at`; edges protect `meta.color`, `meta.curve`. An
  agent that genuinely wants to
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

What's shipped, what's planned, and the aspirational reach items — so
contributors don't re-litigate the same choices. This list is the single source
of truth for status; the full running plan, decisions, and dependencies live in
the project graph (`safqkahqnftyef4j`). The knowledge-base search architecture
and benchmarks have their own design doc: [design/SEARCH.md](design/SEARCH.md).

**Shipped**

- [x] **Kanban view** — first multi-view lens; status columns, drag-to-PATCH,
  per-user view preference. (`public/app.js`)
- [x] **Optimistic concurrency (OCC) + three-way merge** — `version` /
  `last_modified_by` on tasks·edges·graphs, merge in `src/merge.js`. (See
  [Notable Decisions](#notable-decisions).)
- [x] **Modular UI primitives** — `VIEWS` registry + `View` interface; per-view
  branching now dispatches through `activeView()`. (`public/app.js`; see [View
  registry](#views--per-graph-view-preference).)
- [x] **Find / search bar (Cmd/Ctrl+F)** — in-app search bar, This-graph /
  All-graphs toggle, `?node=` jump (`public/app.js`).
- [x] **Knowledge-base search (hybrid + graph)** —
  lexical(BM25)+dense(pgvector)→RRF→optional rerank→graph expansion; per-graph +
  cross-graph endpoints; embedding indexer + boot warmup (`src/search/`,
  `src/routes/search.js`, `searchAll.js`). Architecture + benchmarks in
  [design/SEARCH.md](design/SEARCH.md).

**Planned — not started**

- [ ] **Future views** — alternate lenses on the same `tasks`/`edges` data, added
  one at a time now that the modular primitives are in place: **tech tree**
  (Civ-style layered DAG, read-only), **table view**, **calendar view**.
- [ ] **Responsive layout system** — turn the ad-hoc `position: fixed` px-tuning
  into flex/grid primitives, fluid sizing (`clamp()` / `rem` / `vw`), and a small
  breakpoint set. Mobile work is scoped to the right side panel (pull up as a
  bottom sheet instead of sliding in from the right) and the avatar bar (reflow
  when the panel is open); the left sidebar already works on mobile.
- [ ] **Configurable custom fields** — graph-declared typed task fields
  (`priority`, `assignee`, `due_date`, …); definitions live on the graph row,
  values in task `meta`. Surfaces in the inspector, the kanban group-by, and
  future views.
- [ ] **Custom ordering** — per-graph, per-view sort/grouping (depends on custom
  fields): weighted traversal in graph view, shared drag-to-reorder per kanban
  column, table/calendar field selection.

**Reach — aspirational, unscheduled**

- [ ] **Autonomous multimodal ingestion → KB graph** — the *ingestion* half of
  the KB story (retrieval is shipped): an agent is handed a pile of
  links/files/pasted sources and autonomously builds a concept graph (fetch,
  extract concepts + relationships, create nodes + typed edges). Construction
  habits to teach the skill *when built* (provenance on edges, hub nodes, one
  concept per node) are tracked in the project graph; does **not** depend on the
  search work.
- [ ] **Subagent fanout** — parallel subagents claiming ready tasks. The `Agent`
  tool already works today (subagents inherit the parent's
  `.graphtask/agent-session.json` and share its `writer_id`, so writes are safe;
  same-task concurrent PATCHes fall to last-write-wins). The gap is a
  coordination layer (hand out ready tasks, prevent double-claims) and
  per-subagent avatar identity.
- [ ] **True pause/play** — today the toggle is local-only (stops the viewer's
  camera). Future: use the broadcast `announce_focus` as an ack point so the
  server holds the next PATCH from that writer until resumed.
- [ ] **Upload orphan reaper** — periodic sweep (pg_cron / server interval) of
  `uploads` rows no longer referenced by any `tasks.content` in the graph. Today
  only the graph-delete cascade reaps uploads, so per-graph storage grows
  monotonically. (See [Production notes](#production-notes).)
