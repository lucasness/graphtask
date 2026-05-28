---
name: graphtask
description: Build any structured artifact as a live graph of markdown nodes connected by typed edges — execution plans, research and concept maps, relationship networks, decision trees, personal planning (medical treatment, physical therapy, training regimens, career paths), or whatever shape the user invents next. Nodes hold markdown bodies with status (todo → in_progress → review → done); edges are dependency (DAG, cycle-checked) or related (free-form). The browser canvas updates live so the user watches the work form. Includes status-aware traversal (ready/blockers/unblocks), transactional bulk edges, presence + selection so humans see your focus, and OCC merges that protect UI-managed fields.
when_to_use: Reach for this whenever the work has structure worth seeing — multi-step plans, research with interconnected concepts, mapping relationships between people/orgs/systems/processes, decision trees, anything where dependencies or connections matter more than a flat list. Strong triggers: exiting Plan mode, "turn this plan into a graph", "track this in graphtask", "map the relationships between X", "research how Y works and show the connections", "show me the structure of Z", "build a concept graph of W", "what's ready / what's blocking X / what gets unblocked". Don't force it on one-step work. Once a graph is active for a body of work, every status change, finding, and new connection MUST go into the graph in real time — an out-of-sync graph is worse than no graph.
allowed-tools: Bash(curl *) Bash(jq *) Bash(mkdir -p *) Bash(grep *) Bash(echo *) Bash(cat *) Bash(git config *)
---

# graphtask

graphtask is a graph workspace — markdown nodes connected by typed edges, on a live canvas anyone can watch. Use it for execution plans, research and concept maps, relationship networks, decision trees, personal planning (medical treatment, physical therapy, training regimens, career paths), or whatever shape the user invents next. The REST API at `$GRAPHTASK_BASE_URL` is the agent surface: create a graph, add tasks (markdown with frontmatter — "task" is the API noun for any node, regardless of graph kind), wire dependency or related edges between them, and update status as work or research progresses. The browser canvas updates **live** via SSE, so a user watching the page sees every change you make in real time.

The user controls where the instance lives (hosted or local) and what `GRAPHTASK_BASE_URL` points at — you don't choose. **Before any other work, probe `GET $GRAPHTASK_BASE_URL/api/config`** — it returns `{auth_enabled, provider, viewer_user_id}` and tells you which access model is active.

## Access model

Three layers in order of strictness. When `auth_enabled: false`, only the third layer matters — every URL is bearer-token equivalent.

1. **Owner** (`graphs.owner_user_id`) — set when a signed-in user creates the graph. Full read/write/manage.
2. **Members** (`graph_members.role`) — `viewer` or `editor`, per user. Granted by the owner via the in-app Access panel (or `POST /api/graphs/:gid/members {email, role}`). If the invitee has no account yet, the row sits in `pending_members` until they sign in for the first time, when it auto-claims into a real member row.
3. **Anonymous tier** (`graphs.anon_role`) — what someone hitting the URL gets if they aren't the owner or a member. Values: `none` (URL → 403), `viewer` (read only), `editor` (read+write, attributed anonymously). Default `viewer`. Owner changes it via `PATCH /api/graphs/:id {anon_role}`.

Legacy graphs (`owner_user_id IS NULL`, created before Phase B or on a no-auth instance) always behave as URL-bearer regardless of mode.

**Your writes need attribution.** Without an agent token, you look anonymous to the server — fine for `anon_role=editor` graphs, blocked on owned graphs with `anon_role=none`. To attribute writes to a specific user, the user generates a token from the in-app key-icon panel and exports it as `GRAPHTASK_AGENT_TOKEN`. The identity block below picks it up automatically. Agent tokens always start with the prefix `gt_`; Clerk session JWTs start with `eyJ` (server uses the prefix to route).

### Why am I getting 401 / 403?

When the user reports an auth error from the canvas or asks you to debug one, work through these in order:

| Symptom | Likely cause | What to do |
|---|---|---|
| 401 on any `/api/*` write | Sent an `Authorization: Bearer …` that doesn't start with `gt_` and isn't a valid Clerk session | Drop the header (anon) or re-export a real `gt_…` token. The server's strict 401 path only triggers for malformed `gt_` lookups, so this usually means a token got truncated or revoked. |
| 401 on `/api/me` or `/api/me/agent_tokens` | Endpoint requires a real user; the caller is anon or has only an agent token without the right scope | These are user-facing — direct the user to the in-app modal instead of calling them as the agent. |
| 403 on `GET /api/graphs/:id` or `/graph` | Owned graph with `anon_role=none` and you aren't a member | Owner must either flip `anon_role` to `viewer`/`editor` or add the user (or your token's owner) as a member. |
| 403 on `POST/PATCH/DELETE` but `GET` works | `anon_role=viewer` lets you read; writes need editor+ | Owner flips `anon_role=editor` or grants the writer member-editor explicitly. |
| 403 specifically on `/members` or `PATCH {anon_role}` | These require `manage` — owner only | Only the owner can change sharing. Other roles cannot, even editors. |
| Worked a second ago, suddenly 403 on everything | Owner just kicked you (member removed) | An SSE `members/DELETE` frame should arrive and downgrade the browser. You'll need to be re-added. |

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
# in the in-app Settings → Agent tokens panel and exports it as
# GRAPHTASK_AGENT_TOKEN. **Required on auth-enabled instances** — the section 1
# preflight refuses to proceed without it (anonymous writes would create
# orphan graphs that don't appear in the user's "My graphs" sidebar). On
# no-auth deployments the var is unset and the block below is a no-op.
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

See [Presence lifecycle](#presence-lifecycle) below for how your avatar gets cleaned up between turns.

## Listing graphs and naming

`GET /api/graphs` returns the graphs the **current authenticated viewer** can see (owned + member-of), or all graphs when `auth_enabled: false`. It is not a public directory; private graphs only reachable by id stay reachable by id.

Graph names are not globally unique — duplicate-name `POST` and `PATCH` both succeed (200/201). Don't expect 409 on name conflicts.

## When this skill applies

### Why a graph beats a flat plan or notes

When the work has any structure, **propose the graph** — and tell the user why if they haven't asked:

- **Dependencies are visible.** What blocks what is a glance, not a paragraph. The server answers "what's ready" / "what's blocking X" / "what does finishing Y unlock" so neither of you has to reason about ordering by hand.
- **The structure is the artifact.** For research, mapping, and concept work, the graph itself is the deliverable the user keeps. Prose gets buried; a graph stays explorable.
- **Live two-way collaboration.** Humans watching the canvas see nodes appear, status flip, edges connect — and can rename, rewire, or add without breaking your flow. A flat plan can't offer that.
- **Persistent, living context.** Each node body is a document that evolves with the work. A week later the graph still reflects current understanding, not a snapshot.
- **Traversal queries.** "Critical path." "What's unexplored." "What does finishing X unlock." All one API call away once the graph exists.

The cost is one batched setup at the start and a few seconds per status flip. The benefit compounds across the session.

### Common shapes

The same primitive (markdown nodes + dependency/related edges + status) covers many shapes. Pick whichever fits the user's request; the user can invent new ones.

| Shape | Nodes are… | Edges are… | Status reads as… |
|---|---|---|---|
| **Execution plan** | tasks, one unit of work each | mostly `dependency`; `related` for cross-cutting context | progress: todo → in_progress → review → done |
| **Research / concept map** | concepts, entities, papers, findings | mostly `related`; `dependency` when one concept presupposes another | depth: unexplored → digging in → drafted → human-verified |
| **Relationship network** (keiretsu, ecosystem, org chart) | entities (companies, people, systems) | `related`, typed by body label — "invests in", "competes with", "feeds into" | confirmation: claim → being checked → sourced → human-confirmed |
| **Decision tree / option map** | options, criteria, outcomes | `dependency` for "requires"; `related` for "alternative to" | exploration depth |
| **Anything else with structure** | whatever the user calls them | whatever fits | whatever progress means here |

If the user describes work that doesn't fit a row above but has structure, **propose the graph anyway** — the data model is general; the rows above are starting points, not the menu.

### Strong triggers — reach for the graph when you see these

- Just exited Plan mode, or the user approved a multi-step plan.
- "Turn this plan into a graph" / "track this in graphtask" / "build a graph of …".
- "Map the relationships between …" / "show me how X connects to Y" / "research how Z works" (with > ~3 things to track).
- "Model the …" / "diagram the …" / "show the structure of …".
- "What's ready / what's blocking X / what does finishing Y unlock?" — these only make sense on an existing graph.

For ambiguous cases ("help me understand X", "what should I think about for Y"), **suggest** the graph with the pitch above and let the user decide. Don't force it; the goal is to make it the obvious choice, not the only choice.

### Skip the graph when

- The work is genuinely one-step — typo fixes, single-line tweaks, single-question lookups.
- The user explicitly asks for a verbal answer or a flat list.
- There's no real structure (one node + zero edges isn't worth the canvas).

### Once a graph is active, keep it synced — HARD RULE

The moment a graph exists for this body of work, it becomes the source of truth, and **all subsequent work on the subject must update the graph in real time**. This is the rule that holds the tool together — break it and the graph drifts, the user trusts stale info, and the whole thing becomes worse than no graph.

- **Status transitions happen as the work happens**, not batched at the end. Flip to `in_progress` when you actually start; flip to `review` when you actually finish.
- **Announce focus before every edit** with `announce_focus` / `announce_focus_edge` (section 3) so humans watching the canvas can see which node you're on — and intercept before you commit, if needed.
- **New findings update the right node's body**, not just a chat message. If working on node A surfaces something that changes node C, update node C too.
- **New connections become new edges.** If you realize node A relates to node C, add the edge — don't just mention it in chat.
- **Re-read before each write** (the OCC dance in section 3). The user may have edited the graph in the UI since your last touch.
- **Touched gids get appended** to `.graphtask/agent-session-graphs` so the Stop hook can depart your presence cleanly.
- **Run tests / code / research alongside the graph, not instead of it.** If you find yourself working for more than a few minutes without touching the graph, that's a bug — pause and reconcile.

This applies to every shape, not just execution graphs. A research graph that doesn't get updated as you read sources is just a stale diagram.

### The execution loop (for plan-shaped graphs)

Plan-shaped graphs have an ordering, so they get an explicit loop on top of the sync rule:

1. Resolve the active graph (section 1).
2. Materialize the **entire plan** as tasks + dependency edges in one batch (section 2). The user sees the structure on the canvas before any code is written.
3. Walk the graph task-by-task (section 4): pick the first ready task, check its blockers (section 3), announce focus, mark `in_progress`, do the work, mark `review` when finished, move on.
4. After every task is in `review`, stop and tell the user it's ready to confirm.

Don't dive into implementation, then "remember" to make a graph after — the user wants to watch the structure appear *before* work starts, then watch each task light up as you progress.

For research / mapping / freeform graphs, the loop is looser: explore → add nodes → connect → refine → repeat, with the same sync discipline above. There's no enforced ordering and no "stop at review" gate — the graph keeps growing until the user says it's complete.

**Other quick queries** (any graph shape):

- *"What's blocking X?"* — `GET /tasks/<X>/blockers` and summarize.
- *"What can I work on next?"* — `GET /tasks/ready` (plan graphs) or `GET /tasks/leaves` then filter to `status=todo` (any graph).
- *"Mark X done"* / *"Finish X"* — you move it to `review`. Only flip to `done` if the user explicitly says so for *that* node. See section 3.

## 1. Resolve the active graph

Look up the graph id in this order, fall back to creating a new one:

1. `.graphtask/graph-id` file in the project root (single line, the id only).
2. `GRAPHTASK_GRAPH_ID` env var.
3. Create a new graph via `POST /api/graphs` and persist its id to `.graphtask/graph-id`.

When you create the file, also add `.graphtask/` to `.gitignore` if it isn't there. The id is bearer-token equivalent.

```bash
GT_BASE="${GRAPHTASK_BASE_URL:-http://127.0.0.1:3000}"

# Preflight: probe /api/config to confirm reachability AND learn whether auth
# is enabled. /api/config returns {auth_enabled, provider, viewer_user_id}.
CONFIG=$(curl -sS --max-time 2 "$GT_BASE/api/config" 2>/dev/null) || {
  echo "graphtask not reachable at $GT_BASE — start the app or set GRAPHTASK_BASE_URL." >&2
  exit 1
}

# Auth gate: on auth-enabled instances, refuse to proceed without a token.
# Anonymous agent writes create orphan graphs (owner_user_id NULL) that won't
# appear in the user's "My graphs" sidebar — fail loud, not silent.
AUTH_ENABLED=$(echo "$CONFIG" | jq -r .auth_enabled)
if [ "$AUTH_ENABLED" = "true" ] && [ -z "$GRAPHTASK_AGENT_TOKEN" ]; then
  cat >&2 <<EOF
graphtask at $GT_BASE has auth enabled; GRAPHTASK_AGENT_TOKEN is required.
Open the in-app Agent tokens panel (key icon), generate a token, then persist it
via whichever env mechanism your project uses, e.g.:
  export GRAPHTASK_AGENT_TOKEN=gt_...        # this shell only
  echo GRAPHTASK_AGENT_TOKEN=gt_... >> ~/.zshrc   # all future shells
Then re-run.
EOF
  exit 1
fi

mkdir -p .graphtask
if [ ! -f .graphtask/graph-id ]; then
  GID=$(curl -sS -X POST "$GT_BASE/api/graphs" \
    "${WRITE_HEADERS[@]}" \
    -d '{"name":"Project plan"}' \
    | jq -r .id)
  echo "$GID" > .graphtask/graph-id
  grep -qxF '.graphtask/' .gitignore 2>/dev/null || echo '.graphtask/' >> .gitignore
  # Show the user the URL to open. /g/:gid is the same route for every view
  # (graph, kanban, …) — view is a per-user localStorage flag, not in the URL.
  echo "Graph created: $GT_BASE/g/$GID"
fi
GID="$(cat .graphtask/graph-id)"
grep -qxF "$GID" .graphtask/agent-session-graphs 2>/dev/null || echo "$GID" >> .graphtask/agent-session-graphs
```

**Always print the URL after creating a graph** so the user can open the canvas immediately — don't just hand them the id and make them assemble the URL themselves. The same applies any time you create a *new* graph mid-session (e.g., if you rotate-id or start a separate plan).

If a graph id leaks (e.g. accidentally committed), call `POST /api/graphs/$GID/rotate-id` to invalidate it and update the local file with the new id from the response.

## 2. Build the graph

**Materialize what you already know up front.** The graph is the artifact the user reviews — they want to see structure on the canvas, not get nodes one at a time. For plan-shaped graphs, lay down the **entire DAG** before starting the first task. For research / mapping / freeform graphs, lay down the **starting nodes and connections you already know about**, then grow the graph as you learn.

**One node = one user-meaningful concept or unit of work.** Don't create a node per file edit, per git commit, or per sentence of notes. Granularity should match what a human would read in a status update or scan as a single concept.

For each node, write a real markdown body — title alone is never enough. The body is what the human sees when reviewing or exploring. See section 3 for what to put in the body at each status.

The example below is plan-shaped (`dependency` edges for ordering). For a research / mapping shape, swap `"type":"dependency"` for `"type":"related"` and use whichever frontmatter status fits the depth ladder (e.g. `todo` = unexplored, `review` = drafted). The bulk-edge mechanics are identical regardless of shape.

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

## 3. Status discipline and node body content

Status enum: `todo` → `in_progress` → `review` → `done`. Each transition should bring **new body content** that justifies the status. Don't bump status without updating the body — the body is the artifact, regardless of graph shape.

The body content should always justify the current status. What "justify" means depends on what the node represents:

| Status | Who sets it | Body content (any graph shape) |
|---|---|---|
| `todo` | You (during graph creation) | The starting frame. Execution nodes: the approach, what needs to be done, known constraints. Research / mapping nodes: the question or claim, what we want to know, what's open. |
| `in_progress` | You (when you actually start) | Running notes: what you're investigating, what you've ruled out, files / sources you're touching. Update as you go. |
| `review` | You (when you think it's done) | Self-contained synthesis ready for the human. Execution nodes: what you did, files changed, how to verify. Research / mapping nodes: the synthesized finding with sources and reasoning. **This is what the human reads to confirm.** |
| `done` | **Only the human** | Their confirmation that they accept the node. **Never write this yourself unless the user explicitly asks you to** ("mark X as done", "finish X off"). That permission applies to *that node only* — don't infer permission for siblings, parents, or the rest of the graph. |

**Read before you write, and send OCC fields.** Always GET the task right before you PATCH it AND include `base_version` + `base_content` in the PATCH body. Without those, the server falls back to "blind replace" and your write silently overwrites any UI-managed frontmatter keys (positions `x`/`y`, `color`, `curve`) that exist on the row but aren't in your new content. With OCC fields the server runs a three-way merge that preserves fields you didn't touch — so you can safely rewrite the title/status/body without enumerating every other meta key.

**Keep related task bodies in sync.** When work on one task surfaces information that affects another (e.g., you find that the schema migration also needs a new index, which is a different task), update *that* task's body to reflect the new finding. The graph is a living context document, not a one-shot plan. Each task body should be accurate to the current state of the work.

**Hard rule: before transitioning any task to `in_progress`, check its blockers.**

```bash
BLOCKERS=$(curl -sS "$GT_BASE/api/graphs/$GID/tasks/$TID/blockers" | jq 'length')
```

If `BLOCKERS > 0`, **do not start the task.** Pause and tell the user the task is blocked by [list with statuses], and ask whether to proceed anyway. `review` counts as blocking too — even though the agent finished its part, the human hasn't confirmed, so downstream work isn't safe to begin.

Only proceed if (a) blockers is zero, or (b) the user explicitly OKs starting while blocked. Don't rely on what you remember from when you first laid out the graph — the user may have deleted, retitled, or rearranged tasks since.

For readiness queries (section 4), `review` and `in_progress` count as not-yet-done — downstream tasks won't be classified as ready until every prerequisite is `done`.

PATCH replaces the entire `content` blob (frontmatter + body). The OCC pattern below is the **only safe way to update a task**: GET first, capture `version` + `content`, then PATCH with those as `base_version` + `base_content`. The server's three-way merge then preserves any UI-managed keys (`x`/`y` positions, `color`, `curve`) that aren't in your new content.

**Required: announce your focus.** Before you start touching a task — and every time you switch which task you're working on — POST to `/api/graphs/:gid/selection` with `cursor_anchor` + `editing` set to that task. This is what tells humans watching the canvas which node you're on; without it, your edits show up as flickers on the canvas with no source attribution and no colored outline. The server keeps one selection per writer (so a new POST replaces the previous), and your Stop hook DELETEs presence at end of turn which cascades to clearing the selection. The helpers below combine selection-announce with `patch_task` so you can't accidentally forget.

```bash
announce_focus() {
  # Tell viewers "I'm working on this task right now". Replaces any previous
  # selection from this agent (one selection per writer_id on the server).
  local TID="$1"
  local ANCHOR
  ANCHOR=$(jq -nc --argjson id "$TID" '{kind: "node", id: $id}')
  curl -sS -X POST "$GT_BASE/api/graphs/$GID/selection" \
    "${WRITE_HEADERS[@]}" \
    -d "{\"node_ids\":[$TID],\"edge_ids\":[],\"editing\":$ANCHOR,\"cursor_anchor\":$ANCHOR}" \
    >/dev/null
}

announce_focus_edge() {
  # Same as announce_focus but for an edge. Use before any edge PATCH so
  # the viewer can see which edge you're about to touch — they may want
  # to intercept ("wait, don't change THAT one") before you commit.
  local EID="$1"
  local ANCHOR
  ANCHOR=$(jq -nc --argjson id "$EID" '{kind: "edge", id: $id}')
  curl -sS -X POST "$GT_BASE/api/graphs/$GID/selection" \
    "${WRITE_HEADERS[@]}" \
    -d "{\"node_ids\":[],\"edge_ids\":[$EID],\"editing\":$ANCHOR,\"cursor_anchor\":$ANCHOR}" \
    >/dev/null
}

clear_focus() {
  # Optional explicit clear when you're done with a task and won't touch
  # another. Usually not needed — Stop hook cleanup handles it at end of turn.
  curl -sS -X DELETE "$GT_BASE/api/graphs/$GID/selection/$AGENT_ID" >/dev/null
}

patch_task() {
  # Usage: patch_task <TID> <new-content>
  # Fetches the current task, then PATCHes with OCC so the server can
  # protect UI-managed frontmatter keys (positions etc.) you didn't touch.
  # ALWAYS call announce_focus first (or use work_on_task which bundles them).
  local TID="$1"
  local NEW_CONTENT="$2"
  local CUR_JSON
  CUR_JSON=$(curl -sS "$GT_BASE/api/graphs/$GID/tasks/$TID")
  local CUR_VERSION
  CUR_VERSION=$(echo "$CUR_JSON" | jq -r .version)
  local CUR_CONTENT
  CUR_CONTENT=$(echo "$CUR_JSON" | jq -r .content)
  curl -sS -X PATCH "$GT_BASE/api/graphs/$GID/tasks/$TID" \
    "${WRITE_HEADERS[@]}" \
    -d "$(jq -nc \
      --arg c "$NEW_CONTENT" \
      --argjson v "$CUR_VERSION" \
      --arg b "$CUR_CONTENT" \
      '{content: $c, base_version: $v, base_content: $b}')"
}

work_on_task() {
  # Preferred wrapper: announces focus, then PATCHes. Use this for every
  # task edit so the canvas viewers always see who's on what.
  announce_focus "$1"
  patch_task "$1" "$2"
}

# Moving from todo → in_progress with running notes
work_on_task "$T1" "$(cat <<'EOF'
---
title: Audit current session-token usage
status: in_progress
---
## Approach
Grep src/auth/** for token reads.

## Findings so far
- 4 call sites in src/auth/middleware.js read req.headers.authorization
- 2 call sites in src/api/* call those middleware functions directly
EOF
)"

# Moving to review with a self-contained summary
work_on_task "$T1" "$(cat <<'EOF'
---
title: Audit current session-token usage
status: review
---
## Findings
6 call sites total — 4 in src/auth/middleware.js, 2 in src/api/users.js and src/api/projects.js.

## Suggested next step
Replace the middleware-internal reads with a cookie-aware helper, then keep the api/* call sites unchanged (they go through the middleware anyway).

## Verify
Run `rg -n "req.headers.authorization" src/` — should return zero results after T2 lands.
EOF
)"
```

Notice the PATCH body has no `x`/`y` or `color` keys, but the user's drag positions and color tweaks will survive. The server's mergeFields treats those keys as **protected from agent removal** — when the writer is an agent and the new content omits one of them, the merge preserves the current value rather than reading the omission as "remove this key". Task protections: `x`, `y`, `color`. Edge protections: `meta.color`, `meta.curve`.

This protection only covers that fixed list. Custom frontmatter keys you drop from a rewritten content blob are still treated as removals — if you want them to survive across PATCHes, include them yourself (read existing frontmatter from `base_content`, splice in your changes, send the merged blob).

**Escape hatch.** If you legitimately want to clear a protected key (e.g. user asks you to reset a node's position), send the key with an explicit `null` value. `null` is defined, so the protection short-circuit doesn't fire and the clear lands.

**Without OCC fields, the PATCH falls back to blind replace** and you'll silently wipe any UI keys the human is managing. Always send `base_version` + `base_content`.

**After everything is in `review`, stop.** Summarize in chat what you submitted and let the user review on the canvas. Don't poll the graph waiting for the human to mark things `done` — they'll use the UI. Your job ends at `review`.

## 4. Status-aware traversal (find what to work on next, what's blocking, what gets unblocked)

These queries are most natural on plan-shaped graphs where ordering matters, but the **structural** ones (`subtasks`, `ancestors`, `shortest-path`, `leaves`) also work on research / mapping graphs — useful for "what concepts does this finding rest on?" or "what's the chain from entity A to entity B?". The **status-aware** ones (`ready`, `blockers`, `unblocks`) only make sense if the graph has an ordering and a notion of "done."

The server does the recursion — never compute readiness yourself. All four status-aware queries treat `review` and `in_progress` as "not yet done" so a downstream task only becomes ready when every prerequisite is `done`.

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

**Required: announce focus on the edge first** with `announce_focus_edge` (defined in section 3). This is the same "tell viewers what you're about to touch" rule as for tasks — without it, the human can't see which edge you're about to change in time to intercept.

Same OCC rule as tasks: GET first, send `base_version` + `base_row` so the server's three-way merge protects UI-managed `meta` keys (`color`, `curve`) the user set on the edge.

```bash
announce_focus_edge "$EID"
CUR=$(curl -sS "$GT_BASE/api/graphs/$GID/edges/$EID")
curl -sS -X PATCH "$GT_BASE/api/graphs/$GID/edges/$EID" \
  "${WRITE_HEADERS[@]}" \
  -d "$(jq -nc \
    --argjson v "$(echo "$CUR" | jq .version)" \
    --argjson r "$CUR" \
    '{type: "related", base_version: $v, base_row: $r}')"
```

(Edges use `base_row` instead of `base_content` because they have structured fields, not a content blob.)

## 6. Error handling

The API uses HTTP status codes meaningfully — handle them, don't paper over them:

- **Preflight fails (curl exit code ≠ 0 on `GET /api/graphs`)** — the app isn't reachable. **Stop and ask the user** what URL graphtask is at; don't try to install or start it yourself.
- **400 `cycle`** on `POST /edges` or `/edges/bulk` — your dependency would close a loop. The bulk version returns `failedAt: <index>` so you can identify the offending edge. Drop it (or invert direction) and retry the whole batch.
- **400 on `POST /tasks`** with a frontmatter validation message — check `title` length (≤50), `description` length (≤150), or `status` value.
- **400 on `PATCH /graphs/:id`** with `anon_role must be one of none, viewer, editor` — pass one of those three strings literally.
- **400 on `PATCH /graphs/:id`** with `unknown settings key` / `font must be one of …` / `… must be a 6-digit hex color` — see section 8 for valid `settings` shape.
- **403 on any graph route** — access denied for this caller. See the "Why am I getting 401 / 403?" table near the top to triage by route + verb.
- **404 on a task or edge** — it was likely deleted by the user. Re-fetch `GET /graph` and reconcile your local view; don't assume your cached ids are still valid.
- **409 on a write** — three-way merge fell through (rare; server handles most conflicts silently). Retry once with the `current` row from the 409 body as your new base.
- **410 on a `PATCH /tasks/:id`** — the task was deleted between your read and write. Refetch `GET /graph` and decide whether to recreate or skip.

## 7. What you must not touch

- `meta.x` and `meta.y` on tasks — node positions on the canvas. These are persisted whenever the user drags a node; if you omit them from your PATCH body the server's three-way merge keeps them intact (assuming you sent `base_version` + `base_content` per section 3). Don't include `x`/`y` in your frontmatter.
- `meta.curve` and `meta.color` on edges, and `meta.color` on tasks — those are user UI concerns. Same rule: leave them out of your PATCH; the merge preserves them.
- The `done` status on tasks — never write it on your own initiative. Only set `done` when the user explicitly says so for a specific task ("mark T1 done", "go ahead and finish off the testing task"). Vague positive feedback ("looks great") is **not** permission. When in doubt, leave it in `review` and ask.
- The graph's `settings` JSONB (font / colors) — also a UI concern. Don't touch unless the user explicitly asks (e.g. "make this graph's background dark green"). See section 8 if so.

## Presence lifecycle

Your writes drop `🤖 <owner>'s Claude` into the canvas avatar bar. Two things can clear it:

- **Claude Code lifecycle hooks** (set up at install time, outside this skill): a `Stop` hook departs your presence on every graph you've touched at the end of each turn, and `SessionStart` clears stale identity files. With hooks installed, the avatar blinks in on your first write and out the moment you finish responding.
- **Server-side idle reaper** — sweeps inactive presence after ~30 minutes. The safety net if hooks aren't installed or a session ends ungracefully.

You don't manage the hooks yourself. The thing you DO need to do — keep doing — is appending touched gids to `.graphtask/agent-session-graphs` after every write so the hook (if present) knows which graphs to depart from.

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

## Setup (only if the user asks)

If the user says something like "set up graphtask" / "install the skill" / "I followed your steps but the canvas isn't updating":

1. **Skill + hooks** — run the project's installer, which copies this `SKILL.md` to `~/.claude/skills/graphtask/` and merges presence-cleanup hooks (Stop + SessionStart) into `~/.claude/settings.json` with a timestamped backup:
   ```bash
   bash <(curl -fsSL https://raw.githubusercontent.com/lucasness/graphtask/main/install.sh)
   ```
   Override `CLAUDE_HOME` if their config lives somewhere other than `~/.claude`. After the script runs, tell them to **restart Claude Code** so the new hooks load.
2. **`jq`** — recipes parse JSON with it. Install via `brew install jq` (macOS), `apt install jq` (Debian/Ubuntu), or `apk add jq` (Alpine).
3. **`GRAPHTASK_BASE_URL`** — point at the instance they're using. Hosted users: `export GRAPHTASK_BASE_URL=https://graphtask.wafers.live`. Self-hosted: `export GRAPHTASK_BASE_URL=https://graphtask.example.com`. Local users: leave unset; the recipes default to `http://127.0.0.1:3000`. The agent uses this for both API calls AND the URL it prints to the user — so it must be reachable from the user's browser, not just the agent.
4. **`GRAPHTASK_AGENT_TOKEN`** (auth-enabled instances — **required**, not optional) — tell them to open the in-app Agent tokens panel (key icon), click Generate, copy the `gt_…` string from the modal (shown exactly once), and persist it in whichever env mechanism their setup uses (`export` in `~/.zshrc`, a project `.env` loaded by the shell, a wafer `session.env`, etc.). The section 1 preflight will refuse to run without it on auth-enabled instances, so this is a blocker if missed.

If the user reports they can't reach graphtask at all (preflight `curl` fails), don't try to start the server yourself — ask whether they're running it locally and which port, or whether they meant to point at the hosted URL.

