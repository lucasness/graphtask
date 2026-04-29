---
name: graphtask
description: Convert a plan into a graphtask graph and track progress as you work — CRUD on tasks/edges, dependency traversal, status updates from todo through review (never done; that's a human gate).
when_to_use: When the user says "turn this plan into a graph", "track this in graphtask", "draw a dependency graph", or when you want to record your own progress on a multi-step task while the user watches it live.
allowed-tools: Bash(curl *) Bash(jq *) Bash(mkdir -p *) Bash(grep *) Bash(echo *) Bash(cat *)
---

# graphtask

graphtask is a graph-based task manager. The REST API at `$GRAPHTASK_BASE_URL` (default `http://127.0.0.1:3000`) is the agent surface — you create graphs, add tasks (markdown with frontmatter), wire dependency or related edges between them, and update status as you work. The browser canvas updates **live** via SSE, so a user watching the page sees every change you make in real time.

There's no auth. Each graph's id is a random 16-char string and is bearer-token equivalent — anyone with the URL can read or modify the graph.

## When this skill applies

Activate when the user wants to track multi-step work in a graph or asks something about an existing graph. Concrete triggers and what to do:

- *"Turn this plan into a graph"* / *"Track this in graphtask"* — run sections 1 + 2: resolve the graph, materialize the **whole plan** as tasks + dependency edges in one batch *before* starting any of it. The user wants the structure visible first.
- *"What's blocking X?"* — `GET /tasks/<X>/blockers` and summarize. Don't recompute readiness yourself; the server does it.
- *"What can I work on next?"* — `GET /tasks/ready`. If empty, look for `review`-status tasks and run `/unblocks` on each (section 4) to find the ones whose finalization would unblock work.
- *"Mark X done"* / *"Finish X"* — you move it to `review`, never `done`. See section 3.

Skip if the work is one-step (a tweak, a quick question, fixing a typo). Graph overhead isn't worth it for those.

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

**Plan first, then execute.** When the user gives you a multi-step plan, materialize the *entire* DAG before starting the first task. The graph is the artifact the user reviews — they want to see structure on the canvas, not just the next step.

**One task = one user-meaningful unit of work.** Don't create a task per file edit or git commit. Granularity should match what a human would read in a status update.

For each task, write a real markdown body — title alone is not enough. The body is what the human sees when reviewing your work. See section 3 for what to put in the body at each status.

```bash
# Tasks. Body content tells the user what you intend to do, in plain markdown.
T1=$(curl -sS -X POST "$GT_BASE/api/graphs/$GID/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"content":"---\ntitle: Audit current session-token usage\nstatus: todo\n---\n## Approach\nGrep src/auth/** for token reads. List call sites that need to switch to cookie-based reads.\n"}' \
  | jq -r .id)
T2=$(curl -sS -X POST "$GT_BASE/api/graphs/$GID/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"content":"---\ntitle: Implement cookie-based session\nstatus: todo\n---\n## Approach\nWrap the existing session middleware so reads come from `Set-Cookie` (httpOnly + secure) instead of the auth header.\n"}' \
  | jq -r .id)
T3=$(curl -sS -X POST "$GT_BASE/api/graphs/$GID/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"content":"---\ntitle: Update auth tests\nstatus: todo\n---\n## Approach\nSwitch test fixtures from header-based to cookie-jar style. Update assertions for Set-Cookie response headers.\n"}' \
  | jq -r .id)

# Bulk dependencies — transactional, all-or-nothing.
curl -sS -X POST "$GT_BASE/api/graphs/$GID/edges/bulk" \
  -H 'Content-Type: application/json' \
  -d "{\"edges\":[
    {\"source_id\":$T1,\"target_id\":$T2,\"type\":\"dependency\"},
    {\"source_id\":$T2,\"target_id\":$T3,\"type\":\"dependency\"}
  ]}"
```

`POST /edges/bulk` semantics: validates every edge, opens a transaction, inserts them all, then runs cycle detection across the resulting graph. **Any failure rolls everything back** and returns `400`/`409` with `{ error, failedAt: <index> }`. Fix the offending edge and retry the whole batch — never assume partial application.

## 3. Status discipline and task body content

Status enum: `todo` → `in_progress` → `review` → `done`. Each transition should bring **new body content** that justifies the status. Don't bump status without updating the body — the body is the artifact.

| Status | Who sets it | What the body should contain |
|---|---|---|
| `todo` | You (during plan creation) | The approach: what needs to be done, why, any known constraints. |
| `in_progress` | You (when you actually start) | Running notes: what you're investigating, what you've ruled out, files you're touching. Update as you go. |
| `review` | You (when you think it's done) | What you did, files changed, how to verify. **This is what the human reads to confirm.** Make it self-contained. |
| `done` | **Only the human** | Their confirmation that they accept your work. **Never write this yourself.** |

**Read before you write.** Before PATCHing a task, fetch its current content with `GET /api/graphs/$GID/tasks/$TID` and read the body — the user may have edited it in the UI since you last touched it, and PATCH replaces the whole `content` blob. Merge your changes into what's actually there now; don't clobber the user's notes.

**Keep related task bodies in sync.** When work on one task surfaces information that affects another (e.g., you find that the schema migration also needs a new index, which is a different task), update *that* task's body to reflect the new finding. The graph is a living context document, not a one-shot plan. Each task body should be accurate to the current state of the work.

**Hard rule: before transitioning any task to `in_progress`, check its blockers.**

```bash
BLOCKERS=$(curl -sS "$GT_BASE/api/graphs/$GID/tasks/$TID/blockers" | jq 'length')
```

If `BLOCKERS > 0`, **do not start the task.** Pause and tell the user the task is blocked by [list with statuses], and ask whether to proceed anyway. `review` counts as blocking too — even though the agent finished its part, the human hasn't confirmed, so downstream work isn't safe to begin.

Only proceed if (a) blockers is zero, or (b) the user explicitly OKs starting while blocked. Don't rely on what you remember from when you first laid out the graph — the user may have deleted, retitled, or rearranged tasks since.

For readiness queries (section 4), `review` and `in_progress` count as not-yet-done — downstream tasks won't be classified as ready until every prerequisite is `done`.

PATCH replaces the entire `content` blob (frontmatter + body). Re-serialize the whole thing on every update:

```bash
# Moving from todo → in_progress with running notes
curl -sS -X PATCH "$GT_BASE/api/graphs/$GID/tasks/$T1" \
  -H 'Content-Type: application/json' \
  -d '{"content":"---\ntitle: Audit current session-token usage\nstatus: in_progress\n---\n## Approach\nGrep src/auth/** for token reads.\n\n## Findings so far\n- 4 call sites in src/auth/middleware.js read req.headers.authorization\n- 2 call sites in src/api/* call those middleware functions directly\n"}'

# Moving to review with a self-contained summary
curl -sS -X PATCH "$GT_BASE/api/graphs/$GID/tasks/$T1" \
  -H 'Content-Type: application/json' \
  -d '{"content":"---\ntitle: Audit current session-token usage\nstatus: review\n---\n## Findings\n6 call sites total — 4 in src/auth/middleware.js, 2 in src/api/users.js and src/api/projects.js.\n\n## Suggested next step\nReplace the middleware-internal reads with a cookie-aware helper, then keep the api/* call sites unchanged (they go through the middleware anyway).\n\n## Verify\nRun `rg -n \"req.headers.authorization\" src/` — should return zero results after T2 lands.\n"}'
```

**After everything is in `review`, stop.** Summarize in chat what you submitted and let the user review on the canvas. Don't poll the graph waiting for the human to mark things `done` — they'll use the UI. Your job ends at `review`.

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

## 6. Error handling

The API uses HTTP status codes meaningfully — handle them, don't paper over them:

- **Preflight fails (curl exit code ≠ 0 on `GET /api/graphs`)** — the app isn't reachable. **Stop and ask the user** what URL graphtask is at; don't try to install or start it yourself.
- **400 `cycle`** on `POST /edges` or `/edges/bulk` — your dependency would close a loop. The bulk version returns `failedAt: <index>` so you can identify the offending edge. Drop it (or invert direction) and retry the whole batch.
- **400 on `POST /tasks`** with a frontmatter validation message — check `title` length (≤50), `description` length (≤150), or `status` value.
- **409 on `POST /graphs`** (name conflict, normalized) — pick a different name.
- **404 on a task or edge** — it was likely deleted by the user. Re-fetch `GET /graph` and reconcile your local view; don't assume your cached ids are still valid.
- **409 on `PATCH /graphs/:id`** with name conflict — same as POST; rename.

## 7. What you must not touch

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
| GET | `/api/graphs/:gid/graph/shortest-path?from=&to=` | BFS over dependency edges (undirected); returns `{path, cost, tasks}` or empty if disconnected |
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

