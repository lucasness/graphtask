---
name: graphtask
description: Convert a plan into a graphtask graph and track progress as you work — CRUD on tasks/edges, dependency traversal, status updates from todo through review (never done; that's a human gate).
when_to_use: When the user says "turn this plan into a graph", "track this in graphtask", "draw a dependency graph", or when you want to record your own progress on a multi-step task while the user watches it live.
allowed-tools: Bash(curl *) Bash(jq *) Bash(mkdir -p *) Bash(grep *) Bash(echo *) Bash(cat *)
---

# graphtask

graphtask is a graph-based task manager. The REST API at `$GRAPHTASK_BASE_URL` (default `http://127.0.0.1:3000`) is the agent surface — you create graphs, add tasks (markdown with frontmatter), wire dependency or related edges between them, and update status as you work. The browser canvas updates **live** via SSE, so a user watching the page sees every change you make in real time.

There's no auth. Each graph's id is a random 16-char string and is bearer-token equivalent — anyone with the URL can read or modify the graph.

## 1. Resolve the active graph

Look up the graph id in this order, fall back to creating a new one:

1. `.graphtask/graph-id` file in the project root (single line, the id only).
2. `GRAPHTASK_GRAPH_ID` env var.
3. Create a new graph via `POST /api/graphs` and persist its id to `.graphtask/graph-id`.

When you create the file, also add `.graphtask/` to `.gitignore` if it isn't there. The id is bearer-token equivalent.

```bash
GT_BASE="${GRAPHTASK_BASE_URL:-http://127.0.0.1:3000}"

# Preflight: confirm the app is reachable before doing anything else.
if ! curl -sS --max-time 2 -o /dev/null "$GT_BASE/api/graphs"; then
  echo "graphtask not reachable at $GT_BASE — start the app or set GRAPHTASK_BASE_URL." >&2
  exit 1
fi

mkdir -p .graphtask
if [ ! -f .graphtask/graph-id ]; then
  curl -sS -X POST "$GT_BASE/api/graphs" \
    -H 'Content-Type: application/json' \
    -d '{"name":"Project plan"}' \
    | jq -r .id > .graphtask/graph-id
  grep -qxF '.graphtask/' .gitignore 2>/dev/null || echo '.graphtask/' >> .gitignore
fi
GID="$(cat .graphtask/graph-id)"
```

If a graph id leaks (e.g. accidentally committed), call `POST /api/graphs/$GID/rotate-id` to invalidate it and update the local file with the new id from the response.

## 2. Convert a plan into a graph

For each plan item, create a task. Then wire dependencies in one bulk call so the entire DAG either lands or nothing does.

```bash
# Tasks (collect ids).
T1=$(curl -sS -X POST "$GT_BASE/api/graphs/$GID/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"content":"---\ntitle: Read existing schema\nstatus: todo\n---\nNotes go here."}' \
  | jq -r .id)
T2=$(curl -sS -X POST "$GT_BASE/api/graphs/$GID/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"content":"---\ntitle: Draft migration\nstatus: todo\n---\n"}' \
  | jq -r .id)
T3=$(curl -sS -X POST "$GT_BASE/api/graphs/$GID/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"content":"---\ntitle: Apply and verify\nstatus: todo\n---\n"}' \
  | jq -r .id)

# Bulk dependencies — transactional, all-or-nothing.
curl -sS -X POST "$GT_BASE/api/graphs/$GID/edges/bulk" \
  -H 'Content-Type: application/json' \
  -d "{\"edges\":[
    {\"source_id\":$T1,\"target_id\":$T2,\"type\":\"dependency\"},
    {\"source_id\":$T2,\"target_id\":$T3,\"type\":\"dependency\"}
  ]}"
```

`POST /edges/bulk` semantics: validates every edge first, then opens a transaction, inserts them all, then runs cycle detection across the resulting graph. **Any failure rolls everything back** and returns `400`/`409` with `{ error, failedAt: <index> }`. Re-fix the offending edge and retry the whole batch — never assume partial application.

## 3. Status discipline

Status enum: `todo` → `in_progress` → `review` → `done`.

- **Move to `in_progress`** when you start the task.
- **Move to `review`** when *you* think it's finished. Submit your output to the user via the body or a description field — they'll review and finalize.
- **Never set `done`.** `done` is the human's confirmation that they accept your work. If you set `done` yourself, you bypass that gate.

For dependency-readiness purposes, treat both `review` and `in_progress` as "not yet done" — a downstream task is *not* ready to start until every prerequisite is `done`.

PATCH replaces the entire `content` blob (frontmatter + body), so re-serialize the whole thing:

```bash
curl -sS -X PATCH "$GT_BASE/api/graphs/$GID/tasks/$T1" \
  -H 'Content-Type: application/json' \
  -d '{"content":"---\ntitle: Read existing schema\nstatus: in_progress\n---\nFound the relevant constraints in db/schema.sql."}'
```

## 4. Status-aware traversal (find what to work on next, what's blocking, what gets unblocked)

The server does the recursion — never compute readiness yourself. All four queries treat `review` and `in_progress` as "not yet done" so a downstream task only becomes ready when every prerequisite is `done`.

```bash
# What can I work on right now? Returns todo tasks with all recursive prereqs done.
curl -sS "$GT_BASE/api/graphs/$GID/tasks/ready"

# What's blocking task X from being completable? Returns recursive prereqs not yet done
# (mix of todo, in_progress, review tasks). Use this to triage a stuck goal.
curl -sS "$GT_BASE/api/graphs/$GID/tasks/$T2/blockers"

# If I finish task X, what becomes ready? Returns the direct parent tasks whose
# only remaining non-done prereq is X. Use this to find "critical review" tasks —
# review tasks whose completion would unlock further work.
curl -sS "$GT_BASE/api/graphs/$GID/tasks/$T1/unblocks"
```

For raw structural traversal (no status filtering):

```bash
curl -sS "$GT_BASE/api/graphs/$GID/tasks/leaves"          # DAG roots: no incoming deps
curl -sS "$GT_BASE/api/graphs/$GID/tasks/$T2/subtasks"    # all recursive prerequisites
curl -sS "$GT_BASE/api/graphs/$GID/tasks/$T2/ancestors"   # all recursive dependents
curl -sS "$GT_BASE/api/graphs/$GID/graph/shortest-path?from=$T1&to=$T3"
```

**Pattern: "find the review tasks I should chase down to unstick the critical path"**

```bash
# 1. Get all review tasks
REVIEW_IDS=$(curl -sS "$GT_BASE/api/graphs/$GID/tasks" | jq -r '.[] | select(.meta.status == "review") | .id')
# 2. For each, ask the server what completing it would unblock
for id in $REVIEW_IDS; do
  unblocks=$(curl -sS "$GT_BASE/api/graphs/$GID/tasks/$id/unblocks" | jq 'length')
  if [ "$unblocks" -gt 0 ]; then
    echo "task $id unblocks $unblocks parent(s)"
  fi
done
```

## 5. Update edge type or endpoints

Switch a `related` edge to `dependency` (or vice versa), or repoint an edge to a different source/target. Cycle detection re-runs if you set `type: 'dependency'`.

```bash
curl -sS -X PATCH "$GT_BASE/api/graphs/$GID/edges/$EID" \
  -H 'Content-Type: application/json' \
  -d '{"type":"related"}'
```

## 6. What you must not touch

- `meta.curve` and `meta.color` on edges, and `meta.color` on tasks — those are user UI concerns. Leave them alone.
- The `done` status on tasks — never write it; that's the human's call.

## API reference

All paths below are `:gid`-scoped (substitute `$GID`). Base URL is `$GT_BASE` (`GRAPHTASK_BASE_URL` env var, default `http://127.0.0.1:3000`).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/graphs` | List graphs |
| POST | `/api/graphs` | `{name, description?}` — name must be unique (case + whitespace insensitive) |
| GET | `/api/graphs/:id` | One graph |
| PATCH | `/api/graphs/:id` | `{name?, description?}` |
| DELETE | `/api/graphs/:id` | Cascades to tasks + edges |
| POST | `/api/graphs/:id/rotate-id` | Invalidates the URL; returns the new id |
| GET | `/api/graphs/:gid/tasks` | List tasks |
| POST | `/api/graphs/:gid/tasks` | `{content}` markdown |
| GET | `/api/graphs/:gid/tasks/:id` | One task |
| PATCH | `/api/graphs/:gid/tasks/:id` | `{content}` — full replace |
| DELETE | `/api/graphs/:gid/tasks/:id` | Cascades to its edges |
| GET | `/api/graphs/:gid/tasks/leaves` | DAG roots (no incoming dep edges) |
| GET | `/api/graphs/:gid/tasks/ready` | Tasks ready to start: status=todo with all recursive prereqs done |
| GET | `/api/graphs/:gid/tasks/:id/subtasks` | All recursive prerequisites |
| GET | `/api/graphs/:gid/tasks/:id/ancestors` | All recursive dependents |
| GET | `/api/graphs/:gid/tasks/:id/blockers` | Recursive prereqs not yet done |
| GET | `/api/graphs/:gid/tasks/:id/unblocks` | Direct parents that would become ready if this task were done |
| GET | `/api/graphs/:gid/edges` | List edges |
| POST | `/api/graphs/:gid/edges` | `{source_id, target_id, type, meta?}` |
| POST | `/api/graphs/:gid/edges/bulk` | `{edges: [...]}` — transactional, all-or-nothing |
| PATCH | `/api/graphs/:gid/edges/:id` | Partial update |
| DELETE | `/api/graphs/:gid/edges/:id` | Delete |
| GET | `/api/graphs/:gid/graph` | `{nodes, links}` snapshot |
| GET | `/api/graphs/:gid/graph/shortest-path?from=&to=` | Dijkstra over dependency edges |
| GET | `/api/graphs/:gid/events` | SSE stream — used by the browser; you generally don't need to consume this |

### Markdown frontmatter shape

```yaml
---
title: string (required, ≤50 chars)
description: optional string (≤150 chars)
status: todo | in_progress | review | done   # defaults to todo
---
free-form markdown body
```

### Edge shape

```json
{
  "source_id": 1,
  "target_id": 2,
  "type": "dependency",
  "meta": {}
}
```

`type` ∈ `dependency | related`. Dependency edges form a DAG; the server enforces this with a transactional cycle check on every insert/update (single + bulk).

## Common failure modes

- **409 on POST /tasks** with name-conflict error — graph names are unique on a normalized form. Use a different name.
- **400 cycle on POST /edges or /edges/bulk** — your dependency would close a loop. Inspect `failedAt` (bulk only) to find which edge tripped it.
- **404 on a task or edge** — wrong graph id, or the resource was deleted (likely by the user).
- **EventSource silently stops updating** — ignore for your purposes; the user's browser will reconnect automatically.
