---
name: graphtask
description: Materialize any multi-step plan as a graphtask graph, then drive execution from the graph. The graph IS your execution scaffold — not a side tracker. Tasks move todo → in_progress → review (never done; that's a human gate). Includes status-aware traversal, transactional bulk edges, and live canvas updates the user can watch.
when_to_use: Use IMMEDIATELY after exiting Plan mode, after the user approves a plan, or any time you're about to execute multi-step work — turn the plan into a graph FIRST, then walk the graph task-by-task. Also fires on explicit triggers: "turn this plan into a graph", "track this in graphtask", "what should I work on next?", "what's blocking X?".
allowed-tools: Bash(curl *) Bash(jq *) Bash(mkdir -p *) Bash(grep *) Bash(echo *) Bash(cat *) Bash(git config *)
---

# graphtask

graphtask is a graph-based task manager. The REST API at `$GRAPHTASK_BASE_URL` is the agent surface — you create graphs, add tasks (markdown with frontmatter), wire dependency or related edges between them, and update status as you work. The browser canvas updates **live** via SSE, so a user watching the page sees every change you make in real time.

## Deployment context (resolve before any other work)

The skill runs against whatever instance `GRAPHTASK_BASE_URL` points at. Two shapes you'll see:

| Where it runs | Example `GRAPHTASK_BASE_URL` | Auth |
|---|---|---|
| Hosted | `https://graphtask.dev.wafer.works` | usually `clerk` |
| Local (Docker or `npm start`) | `http://127.0.0.1:3000` (default fallback) | usually `none` |

Always probe `GET $GRAPHTASK_BASE_URL/api/config` first — it returns `{auth_enabled, provider, viewer_user_id}`. If `auth_enabled: false`, every graph URL is bearer-token equivalent and you can read/write freely. If `auth_enabled: true`, see the access model below.

## Access model (auth-enabled instances)

Phase B adds ownership + sharing on top of URL-bearer access. Three layers in order of strictness:

1. **Owner** (`graphs.owner_user_id`) — set when a signed-in user creates the graph. Full read/write/manage.
2. **Members** (`graph_members.role`) — `viewer` or `editor`, per user. Granted by the owner via the in-app Access panel (or `POST /api/graphs/:gid/members {email, role}`). If the invitee has no account yet, the row sits in `pending_members` until they sign in.
3. **Anonymous tier** (`graphs.anon_role`) — what someone hitting the URL gets if they aren't the owner or a member. Values: `none` (URL → 403), `viewer` (read only), `editor` (read+write, attributed anonymously). Default `viewer`. Owner changes it via `PATCH /api/graphs/:id {anon_role}`.

Legacy graphs (`owner_user_id IS NULL`, created before Phase B or on a no-auth instance) always behave as URL-bearer regardless of mode.

**For this skill specifically:** without an agent token, your writes look anonymous. On owned graphs with `anon_role=none`, those writes 403. Have the user generate a token (in-app: user pill → key icon → Generate) and export it as `GRAPHTASK_AGENT_TOKEN`. The identity block below picks it up automatically and attributes every write to that user. Tokens start with the prefix `gt_`.

## Installation (if not already installed)

If your user is asking you to install graphtask, run `install.sh` from the repo root — it copies this skill to the user's `~/.claude/skills/graphtask/` and merges the Stop + SessionStart hooks below into `~/.claude/settings.json` (idempotent, with a timestamped settings backup).

```bash
# From a cloned repo:
bash install.sh

# Or directly from GitHub:
bash <(curl -fsSL https://raw.githubusercontent.com/lucasness/graphtask/main/install.sh)
```

The script honors two env overrides if the default paths don't match the user's setup:
- `CLAUDE_HOME` — defaults to `~/.claude`. Override if the user's Claude Code config lives elsewhere (e.g. a managed wafer at `/data/claude-home/.claude`).
- `GRAPHTASK_SKILL_URL` — defaults to the GitHub raw URL. Override to install from a fork or mirror.

After install, remind the user to:
1. Restart Claude Code so the hooks load.
2. Set `GRAPHTASK_BASE_URL` if they're using a hosted instance (not `http://127.0.0.1:3000`).
3. Install `jq` if missing (`brew install jq` / `apt install jq` / `apk add jq`).

If `install.sh` doesn't fit (e.g., shared multi-user host, locked-down `settings.json`, custom hook manager), fall back to: copy `SKILL.md` to the user's skills directory manually, then add the hook snippet in "Agent presence cleanup (hooks)" below.

## Agent identity (do this once per session)

Every write should carry three headers so the live canvas shows you as `🤖 <owner>'s Claude` in the top-right avatar bar alongside human collaborators:

- `X-Writer-Type: agent`
- `X-Writer-Id` — a session-stable uuid
- `X-Writer-Name` — `<owner>'s Claude` (owner = `git config user.name`, fallback random animal)

Persist the identity to `.graphtask/agent-session.json` so all writes within one Claude Code session look like the same agent. Run this once at the top of your bash work and reference `${WRITE_HEADERS[@]}` in every subsequent curl that writes:

```bash
mkdir -p .graphtask
if [ ! -f .graphtask/agent-session.json ]; then
  OWNER="$(git config --get user.name 2>/dev/null)"
  if [ -z "$OWNER" ]; then
    ANIMALS=(Otter Heron Fox Bison Lynx Owl Quokka Hare Falcon Newt Badger Pangolin Wren Marten Capybara Caracal)
    ADJECTIVES=(Quiet Bright Swift Clever Bold Gentle Brave Wise Calm Eager Sharp Nimble Steady Hopeful Witty Vivid Daring Curious Lively Mellow Kind Keen)
    OWNER="${ADJECTIVES[$((RANDOM % ${#ADJECTIVES[@]}))]} ${ANIMALS[$((RANDOM % ${#ANIMALS[@]}))]}"
  fi
  AGENT_ID="$(cat /proc/sys/kernel/random/uuid)"
  echo "{\"id\":\"$AGENT_ID\",\"name\":\"${OWNER}'s Claude\"}" > .graphtask/agent-session.json
fi
AGENT_ID="$(jq -r .id .graphtask/agent-session.json)"
AGENT_NAME="$(jq -r .name .graphtask/agent-session.json)"

WRITE_HEADERS=(
  -H 'Content-Type: application/json'
  -H 'X-Writer-Type: agent'
  -H "X-Writer-Id: $AGENT_ID"
  -H "X-Writer-Name: $AGENT_NAME"
)

# Authed deployments (AUTH_PROVIDER=clerk): the user generates an agent token
# in the in-app Settings → Agent tokens panel and exports it. If the env var
# is set, send it as a bearer token on every write so the server can attribute
# the request to the user. On no-auth deployments the var is unset and the
# block below is a no-op.
if [ -n "$GRAPHTASK_AGENT_TOKEN" ]; then
  WRITE_HEADERS+=( -H "Authorization: Bearer $GRAPHTASK_AGENT_TOKEN" )
  READ_HEADERS=( -H "Authorization: Bearer $GRAPHTASK_AGENT_TOKEN" )
else
  READ_HEADERS=()
fi
```

**Every write `curl` below should use `"${WRITE_HEADERS[@]}"` in place of the bare `-H 'Content-Type: application/json'`.** Reads (`GET`) only need `"${READ_HEADERS[@]}"` when you're accessing a private graph owned by the authed user — public reads work without it.

After any write to a graph, record the gid so the optional cleanup hook (below) can depart your presence on session end:

```bash
grep -qxF "$GID" .graphtask/agent-session-graphs 2>/dev/null || echo "$GID" >> .graphtask/agent-session-graphs
```

See [Agent presence cleanup (hooks)](#agent-presence-cleanup-hooks) for the optional Claude Code lifecycle hooks. Without the hook, the server's idle reaper removes you after 30 minutes of no writes.

## Listing graphs and naming

`GET /api/graphs` returns the graphs the **current authenticated viewer** can see (owned + member-of), or all graphs when `auth_enabled: false`. It is not a public directory; private graphs only reachable by id stay reachable by id.

Graph names are not globally unique — duplicate-name `POST` and `PATCH` both succeed (200/201). Don't expect 409 on name conflicts.

## When this skill applies

**Primary use case: executing a plan.** Whenever you have a multi-step plan — whether you just exited Plan mode, the user approved a plan, or you're about to do work that has more than one logical step — *use this skill before writing any implementation code*. The graph is your execution scaffold. The flow:

1. Resolve the active graph (section 1).
2. Materialize the **entire plan** as tasks + dependency edges in one batch (section 2). The user now sees the structure on the canvas.
3. Walk the graph task-by-task (section 4): pick the first ready task, check its blockers (section 3), mark `in_progress`, do the actual work, mark `review` when finished, move on.
4. After every task is in `review`, stop and tell the user it's ready for them to confirm.

This sequence is the pattern. Don't dive into implementation, then "remember" to make a graph after — the user wants to watch the structure appear *before* the work starts, then watch each task light up as you progress.

**Other triggers (subordinate to the primary pattern):**

- *"What's blocking X?"* — `GET /tasks/<X>/blockers` and summarize.
- *"What can I work on next?"* — `GET /tasks/ready`. If empty, look for `review` tasks whose `/unblocks` is non-empty (section 4).
- *"Track this in graphtask"* / *"Turn this plan into a graph"* — same as the primary flow, just user-initiated.
- *"Mark X done"* / *"Finish X"* — you move it to `review`, never `done`. See section 3.

**Skip if the work is one-step** — a typo fix, a quick question, a one-line tweak. Graph overhead isn't worth it.

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
    "${WRITE_HEADERS[@]}" \
    -d '{"name":"Project plan"}' \
    | jq -r .id > .graphtask/graph-id
  grep -qxF '.graphtask/' .gitignore 2>/dev/null || echo '.graphtask/' >> .gitignore
fi
GID="$(cat .graphtask/graph-id)"
grep -qxF "$GID" .graphtask/agent-session-graphs 2>/dev/null || echo "$GID" >> .graphtask/agent-session-graphs
```

If a graph id leaks (e.g. accidentally committed), call `POST /api/graphs/$GID/rotate-id` to invalidate it and update the local file with the new id from the response.

## 2. Convert a plan into a graph

**Plan first, then execute.** When the user gives you a multi-step plan, materialize the *entire* DAG before starting the first task. The graph is the artifact the user reviews — they want to see structure on the canvas, not just the next step.

**One task = one user-meaningful unit of work.** Don't create a task per file edit or git commit. Granularity should match what a human would read in a status update.

For each task, write a real markdown body — title alone is not enough. The body is what the human sees when reviewing your work. See section 3 for what to put in the body at each status.

```bash
# Tasks. Body content tells the user what you intend to do, in plain markdown.
T1=$(curl -sS -X POST "$GT_BASE/api/graphs/$GID/tasks" \
  "${WRITE_HEADERS[@]}" \
  -d '{"content":"---\ntitle: Audit current session-token usage\nstatus: todo\n---\n## Approach\nGrep src/auth/** for token reads. List call sites that need to switch to cookie-based reads.\n"}' \
  | jq -r .id)
T2=$(curl -sS -X POST "$GT_BASE/api/graphs/$GID/tasks" \
  "${WRITE_HEADERS[@]}" \
  -d '{"content":"---\ntitle: Implement cookie-based session\nstatus: todo\n---\n## Approach\nWrap the existing session middleware so reads come from `Set-Cookie` (httpOnly + secure) instead of the auth header.\n"}' \
  | jq -r .id)
T3=$(curl -sS -X POST "$GT_BASE/api/graphs/$GID/tasks" \
  "${WRITE_HEADERS[@]}" \
  -d '{"content":"---\ntitle: Update auth tests\nstatus: todo\n---\n## Approach\nSwitch test fixtures from header-based to cookie-jar style. Update assertions for Set-Cookie response headers.\n"}' \
  | jq -r .id)

# Bulk dependencies — transactional, all-or-nothing.
curl -sS -X POST "$GT_BASE/api/graphs/$GID/edges/bulk" \
  "${WRITE_HEADERS[@]}" \
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
  "${WRITE_HEADERS[@]}" \
  -d '{"content":"---\ntitle: Audit current session-token usage\nstatus: in_progress\n---\n## Approach\nGrep src/auth/** for token reads.\n\n## Findings so far\n- 4 call sites in src/auth/middleware.js read req.headers.authorization\n- 2 call sites in src/api/* call those middleware functions directly\n"}'

# Moving to review with a self-contained summary
curl -sS -X PATCH "$GT_BASE/api/graphs/$GID/tasks/$T1" \
  "${WRITE_HEADERS[@]}" \
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
  "${WRITE_HEADERS[@]}" \
  -d '{"type":"related"}'
```

## 6. Error handling

The API uses HTTP status codes meaningfully — handle them, don't paper over them:

- **Preflight fails (curl exit code ≠ 0 on `GET /api/graphs`)** — the app isn't reachable. **Stop and ask the user** what URL graphtask is at; don't try to install or start it yourself.
- **400 `cycle`** on `POST /edges` or `/edges/bulk` — your dependency would close a loop. The bulk version returns `failedAt: <index>` so you can identify the offending edge. Drop it (or invert direction) and retry the whole batch.
- **400 on `POST /tasks`** with a frontmatter validation message — check `title` length (≤50), `description` length (≤150), or `status` value.
- **400 on `PATCH /graphs/:id`** with `is_public must be a boolean` — pass `true` / `false`, not strings.
- **400 on `PATCH /graphs/:id`** with `unknown settings key` / `font must be one of …` / `… must be a 6-digit hex color` — see section 8 for valid `settings` shape.
- **404 on a task or edge** — it was likely deleted by the user. Re-fetch `GET /graph` and reconcile your local view; don't assume your cached ids are still valid.

## 7. What you must not touch

- `meta.curve` and `meta.color` on edges, and `meta.color` on tasks — those are user UI concerns. Leave them alone.
- The `done` status on tasks — never write it; that's the human's call.
- The graph's `settings` JSONB (font / colors) — also a UI concern. Don't touch unless the user explicitly asks (e.g. "make this graph's background dark green"). See section 8 if so.

## Agent presence cleanup (hooks)

**Already handled by `install.sh`** — if the user ran the installer, both hooks below are already in their `~/.claude/settings.json`. The rest of this section documents what those hooks do and what the manual install looks like for environments where `install.sh` doesn't fit.

The "Agent identity" headers at the top of this skill make you visible on the canvas while you work. Without cleanup, the avatar lingers between turns (and across your whole Claude Code session) until the 30-minute server-side reaper sweeps it.

Two Claude Code hooks handle cleanup. `SessionStart` clears stale state from a previous session; `Stop` fires at the end of every agent response and departs your presence on every graph you touched — so the avatar disappears the instant you stop working and reappears on your next write. (`Stop` is the per-turn lifecycle event; for ungraceful session ends, the server's idle reaper is the safety net.)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "rm -f .graphtask/agent-session.json .graphtask/agent-session-graphs"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "GT_BASE=\"${GRAPHTASK_BASE_URL:-http://127.0.0.1:3000}\"; if [ -f .graphtask/agent-session.json ] && [ -f .graphtask/agent-session-graphs ]; then AID=$(jq -r .id .graphtask/agent-session.json); while IFS= read -r g; do [ -n \"$g\" ] && curl -sS -X DELETE \"$GT_BASE/api/graphs/$g/presence/$AID\" -o /dev/null || true; done < .graphtask/agent-session-graphs; : > .graphtask/agent-session-graphs; fi"
          }
        ]
      }
    ]
  }
}
```

The `Stop` script truncates `.graphtask/agent-session-graphs` (rather than deleting the identity file) so the next write within the same Claude Code session re-uses the same agent uuid — collaborators see the same `🤖 <owner>'s Claude` blink in and out, not a parade of fresh agents.

The hook is optional. The skill itself works without it; the cost of skipping it is just lingering avatars until the 30-minute reaper catches them or you end the Claude Code session.

## 8. Per-graph appearance settings (do not touch unless asked)

Each graph carries a `settings` JSONB object with optional keys:

| Key | Type | Validation |
|---|---|---|
| `font` | string | one of `inter`, `garamond`, `roboto` |
| `font_color` | string | `^#[0-9A-Fa-f]{6}$` |
| `bg_color` | string | `^#[0-9A-Fa-f]{6}$` |

Missing keys fall back to the viewer's app-level Defaults. PATCH merges; sending `null` for a key clears it.

```bash
# Override font + background for this graph
curl -sS -X PATCH "$GT_BASE/api/graphs/$GID" \
  "${WRITE_HEADERS[@]}" \
  -d '{"settings":{"font":"garamond","bg_color":"#100F0F"}}'

# Clear the per-graph font override (revert to default)
curl -sS -X PATCH "$GT_BASE/api/graphs/$GID" \
  "${WRITE_HEADERS[@]}" \
  -d '{"settings":{"font":null}}'
```

Invalid keys/values return 400. There's no `POST /api/graphs/:id/settings` endpoint — `PATCH /api/graphs/:id` with a `settings` field is the only path.

## API reference

All paths below are `:gid`-scoped (substitute `$GID`). Base URL is `$GT_BASE` (`GRAPHTASK_BASE_URL` env var, default `http://127.0.0.1:3000`).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/config` | `{auth_enabled, provider, viewer_user_id}` — probe first to learn the deployment mode |
| GET | `/api/graphs` | Lists graphs the viewer owns + is a member of (auth on); all graphs (auth off) |
| POST | `/api/graphs` | `{name, description?}` — duplicate names allowed; new graphs default `anon_role='viewer'` and `settings={}` |
| GET | `/api/graphs/:id` | One graph; also returns `viewer_can_edit` / `viewer_can_manage` based on the caller's role |
| PATCH | `/api/graphs/:id` | `{name?, description?, anon_role?, settings?}` — `anon_role` ∈ `none | viewer | editor`; see section 8 for `settings` |
| DELETE | `/api/graphs/:id` | Cascades to tasks + edges |
| POST | `/api/graphs/:id/rotate-id` | Issues a new id; old URL stops resolving |
| GET | `/api/graphs/:gid/members` | `{members, pending}` — manage-gated read |
| POST | `/api/graphs/:gid/members` | `{email, role}` — promotes to member if email matches a user, else stashes pending |
| DELETE | `/api/graphs/:gid/members/:userId` | Kick a real member; emits SSE so the kicked browser evicts in real time |
| DELETE | `/api/graphs/:gid/members/pending/:email` | Cancel a pending invite |
| GET | `/api/me` | Caller's user row (auth-enabled instances) |
| GET | `/api/me/agent_tokens` / POST / DELETE | Agent-token CRUD; user-facing, normally driven from the in-app modal |
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

