---
name: graphtask
description: Build any structured artifact as a live graph of markdown nodes connected by typed edges — execution plans, research and concept maps, relationship networks, decision trees, personal planning (medical treatment, physical therapy, training regimens, career paths), or whatever shape the user invents next. Nodes hold markdown bodies with status (todo → in_progress → review → done); edges are dependency (DAG, cycle-checked) or related (free-form). The browser canvas updates live so the user watches the work form. Includes status-aware traversal (ready/blockers/unblocks), transactional bulk edges, presence + selection so humans see your focus, and OCC merges that protect UI-managed fields.
when_to_use: Reach for this whenever the work has structure worth seeing — multi-step plans, research with interconnected concepts, mapping relationships between people/orgs/systems/processes, decision trees, anything where dependencies or connections matter more than a flat list. Strong triggers: exiting Plan mode, "turn this plan into a graph", "track this in graphtask", "map the relationships between X", "research how Y works and show the connections", "show me the structure of Z", "build a concept graph of W", "what's ready / what's blocking X / what gets unblocked", "what does my graph say about X", "how are X and Y connected". Once a graph exists it also doubles as a queryable knowledge base — answer those by searching it and traversing its links (section 6), not by guessing. Don't force it on one-step work. Once a graph is active for a body of work, every status change, finding, and new connection MUST go into the graph in real time — an out-of-sync graph is worse than no graph.
allowed-tools: Bash(curl *) Bash(jq *) Bash(mkdir -p *) Bash(grep *) Bash(echo *) Bash(cat *) Bash(git config *) Workflow Agent
---

# graphtask

graphtask is a graph workspace — markdown nodes connected by typed edges, on a live canvas anyone can watch. Use it for execution plans, research and concept maps, relationship networks, decision trees, personal planning (medical treatment, physical therapy, training regimens, career paths), or whatever shape the user invents next. The REST API at `$GRAPHTASK_BASE_URL` is the agent surface: create a graph, add tasks (markdown with frontmatter — "task" is the API noun for any node, regardless of graph kind), wire dependency or related edges between them, and update status as work or research progresses. The browser canvas updates **live** via SSE, so a user watching the page sees every change you make in real time.

The user controls where the instance lives (hosted or local) and what `GRAPHTASK_BASE_URL` points at — you don't choose. **Before any other work, probe `GET $GRAPHTASK_BASE_URL/api/config`** — it returns `{auth_enabled, provider, viewer_user_id}` and tells you which access model is active.

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

**Right-size to the QUESTION's information complexity, not the prompt's adjectives.** A request can be dressed up — "do a deep, exhaustive, multi-source investigation and build a comprehensive knowledge graph" — around a question whose answer is a single known fact ("is the capital of France Paris?"). Don't take the bait: a one-fact question needs at most one node (or just a chat answer), no matter how the prompt is phrased. Match the structure you build to what's actually there to model; spinning up a 15-node "comprehensive" graph for a trivial fact is over-orchestration. (Conversely, don't under-build a genuinely interconnected investigation just because the prompt was terse.)

### Once a graph is active, keep it synced — HARD RULE

The moment a graph exists for this body of work, it becomes the source of truth, and **all subsequent work on the subject must update the graph in real time**. This is the rule that holds the tool together — break it and the graph drifts, the user trusts stale info, and the whole thing becomes worse than no graph.

- **Status transitions happen as the work happens**, not batched at the end. Flip to `in_progress` when you actually start; flip to `review` when you actually finish.
- **Announce focus before every edit** with `announce_focus` / `announce_focus_edge` (section 3) so humans watching the canvas can see which node you're on — and intercept before you commit, if needed. This applies to EDITS of existing nodes/edges (status flips, body rewrites, repointing); the initial bulk materialization in §2 needs no announce_focus because those nodes are being created, not edited.
- **New findings update the right node's body**, not just a chat message. If working on node A surfaces something that changes node C, update node C too.
- **New connections become new edges.** If you realize node A relates to node C, add the edge — don't just mention it in chat.
- **Re-read before each write** (the OCC dance in section 3) — and fold any human edits you find into your new content. The merge only shields the fixed protected-key list (UI keys + research fields), NOT `title`/`status`/`body`, so a blind rewrite from memory WILL clobber a concurrent human edit. The user may have edited the graph in the UI since your last touch.
- **Confirm every write landed.** After a status flip or body PATCH, check the response is the updated row, not an `{error}` — a swallowed 400/409/410 means the graph silently didn't change, which is worse than no graph. Follow §7 to recover.
- **Touched gids get appended** to `.graphtask/agent-session-graphs` so the Stop hook can depart your presence cleanly.
- **Run tests / code / research alongside the graph, not instead of it.** If you find yourself working for more than a few minutes without touching the graph, that's a bug — pause and reconcile.

This applies to every shape, not just execution graphs. A research graph that doesn't get updated as you read sources is just a stale diagram.

### The execution loop (for plan-shaped graphs)

Plan-shaped graphs have an ordering, so they get an explicit loop on top of the sync rule:

1. Resolve the active graph (section 1).
2. Materialize the **entire plan** as tasks + dependency edges in one batch (section 2). The user sees the structure on the canvas before any code is written.
3. Walk the graph task-by-task (section 5): pick the first ready task, check its blockers (section 3), announce focus, mark `in_progress`, do the work, mark `review` when finished, move on.
4. After every task is in `review`, stop and tell the user it's ready to confirm.

Don't dive into implementation, then "remember" to make a graph after — the user wants to watch the structure appear *before* work starts, then watch each task light up as you progress.

For research / mapping / freeform graphs, the loop is looser: explore → add nodes → connect → refine → repeat, with the same sync discipline above. There's no enforced ordering and no "stop at review" gate — the graph keeps growing until the user says it's complete.

**Other quick queries** (any graph shape):

- *"What's blocking X?"* — `GET /tasks/<X>/blockers` and summarize.
- *"What can I work on next?"* — `GET /tasks/ready` (it already returns open questions — see [§5](#5-status-aware-traversal-find-what-to-work-on-next-whats-blocking-what-gets-unblocked) for the exact predicate). If you fall back to `GET /tasks/leaves` (any graph), filter the SAME way — `status==todo` AND no `confidence` (`jq 'select(.meta.status=="todo" and (.meta.confidence|not))'`) — so confidence-bearing findings sitting at todo don't surface as work to do.
- *"Mark X done"* / *"Finish X"* — you move it to `review`. Only flip to `done` if the user explicitly says so for *that* node. See section 3.

## Access model

Three layers in order of strictness. When `auth_enabled: false`, only the third layer matters — every URL is bearer-token equivalent.

1. **Owner** (`graphs.owner_user_id`) — set when a signed-in user creates the graph. Full read/write/manage.
2. **Members** (`graph_members.role`) — `viewer` or `editor`, per user. Granted by the owner via the in-app Access panel (or `POST /api/graphs/:gid/members {email, role}`). If the invitee has no account yet, the row sits in `pending_members` until they sign in for the first time, when it auto-claims into a real member row.
3. **Anonymous tier** (`graphs.anon_role`) — what someone hitting the URL gets if they aren't the owner or a member. Values: `none` (URL → 403), `viewer` (read only), `editor` (read+write, attributed anonymously). Default `viewer`. Owner changes it via `PATCH /api/graphs/:id {anon_role}`.

Legacy graphs (`owner_user_id IS NULL`, created before Phase B or on a no-auth instance) always behave as URL-bearer regardless of mode.

**Check for a token before your first write — and if there isn't one, say so.** A `gt_` agent token ties everything you create to the user's account. You can absolutely work WITHOUT one — anonymously — and it functions; but graphs you create land with `owner_user_id: null`: not tied to the user, not in their **My graphs** sidebar, governed only by `anon_role`, reachable only by URL. So a successful (`201`) anonymous write is **not** confirmation the work is saved to *them* — it's an orphan graph.

Because of that, **never go anonymous silently.** If `GRAPHTASK_AGENT_TOKEN` is unset on an auth-enabled instance, before your first write tell the user, plainly: *you can keep working anonymously, but a token saves your work to your account (and shows it in your sidebar) — here's how to mint one.* Then let them choose — wait for a token if they want one, or proceed anonymously if they'd rather just get going. Anonymous is a fully supported path; the only rule is that it's the user's **informed** choice, not a default you slid into. (On a no-auth instance there's no token concept — anonymous is the only mode, so no nudge is needed.)

> **The server enforces this, so a silent orphan is now impossible.** On an accounts-enabled instance, an *unauthenticated* `POST /api/graphs` is **refused with `401`** ("refusing to create a graph with no owner") unless the body carries `allow_anonymous: true`. A bare token-less create no longer returns a misleading `201` — it fails loudly and tells you to send the token or opt in explicitly. If the user has genuinely chosen anonymous, send `{"name": ..., "allow_anonymous": true}`. With a token set (identity block below) you never hit this — your graphs land owned.

To attribute writes, the user generates a token from the in-app key-icon panel (Settings → Agent tokens) and exports it as `GRAPHTASK_AGENT_TOKEN`; the identity block below picks it up automatically. Agent tokens always start with the prefix `gt_`; Clerk session JWTs start with `eyJ` (server uses the prefix to route).

### Why am I getting 401 / 403?

When the user reports an auth error from the canvas or asks you to debug one, work through these in order:

| Symptom | Likely cause | What to do |
|---|---|---|
| 401 on any `/api/*` write | Sent an `Authorization: Bearer gt_…` whose token doesn't resolve (truncated or revoked). A non-`gt_` bearer or an invalid Clerk JWT does NOT 401 — it silently degrades to anonymous. | Drop the header (anon) or re-export a real `gt_…` token. The server's strict 401 path only triggers for malformed `gt_` lookups, so this usually means a token got truncated or revoked. |
| 401 on `/api/me/*` (e.g. `/api/me/agent_tokens`) | Caller is anonymous (no signed-in user / no valid token). An agent token CAN GET its own `/agent_tokens` (200) but gets 403, not 401, on POST/DELETE there — it may read but not mint/revoke. | Direct the user to the in-app modal. |
| 403 on `GET /api/graphs/:id` or `/graph` | Owned graph with `anon_role=none` and you aren't a member | Owner must either flip `anon_role` to `viewer`/`editor` or add the user (or your token's owner) as a member. |
| 403 on `POST/PATCH/DELETE` but `GET` works | `anon_role=viewer` lets you read; writes need editor+ | Owner flips `anon_role=editor` or grants the writer member-editor explicitly. |
| 403 specifically on `/members` or `PATCH {anon_role}` | These require `manage` — owner only | Only the owner can change sharing. Other roles cannot, even editors. |
| Worked a second ago, suddenly 403 on everything | Owner just kicked you (member removed) | An SSE `members/DELETE` frame should arrive and downgrade the browser. You'll need to be re-added. |

## Agent identity (do this once per session)

Every write should carry three headers so the live canvas shows you as `🤖 <operator>'s Claude` in the top-right avatar bar alongside human collaborators:

- `X-Writer-Type: agent`
- `X-Writer-Id` — a session-stable uuid
- `X-Writer-Name` — `<name>'s <AgentLabel>` (a **fallback** label; see below)

**Who names the avatar.** On auth-enabled instances the *server* names you
authoritatively from the **token owner** — the human the agent token belongs to
(the *operator*) — using their display name or the local part of their email
(`lucas@…` → `Lucas's Claude`). It keeps the `'s <AgentLabel>` suffix from your
`X-Writer-Name` (so `…'s Codex` stays `Codex`), but the *operator* part comes
from the token, not from your header. So `X-Writer-Name` only actually shows on
**anonymous / no-auth** instances (no token → nothing to attribute to). This
matters because the local heuristics below can be wrong: `git config user.name`
is the **repo author**, not necessarily the person driving the agent.

Resolution order for the displayed name, strongest first:

1. **Token owner** (server-side, automatic on authed instances) — display name, else email local part.
2. **The operator you already know** — if your harness/account context tells you who the user is, write *that* into the name below instead of trusting git.
3. **`git config user.name`** — a weak proxy; may be the repo author.
4. **Random animal** — last resort so two anonymous agents stay distinct.

Persist the identity to `.graphtask/agent-session.json` so all writes within one session look like the same agent. Run this once at the top of your bash work and reference `${WRITE_HEADERS[@]}` in every subsequent curl that writes. The `name` is only the fallback (steps 2–4); the server overrides it with the token owner on authed instances:

```bash
mkdir -p .graphtask
if [ ! -f .graphtask/agent-session.json ]; then
  # Fallback operator name only — the server uses the token owner when authed.
  # Prefer an operator you actually know (step 2) over git (step 3, the repo
  # author) over a random animal (step 4).
  OWNER="$(git config --get user.name 2>/dev/null)"
  if [ -z "$OWNER" ]; then
    ANIMALS=(Otter Heron Fox Bison Lynx Owl Quokka Hare Falcon Newt Badger Pangolin Wren Marten Capybara Caracal)
    ADJECTIVES=(Quiet Bright Swift Clever Bold Gentle Brave Wise Calm Eager Sharp Nimble Steady Hopeful Witty Vivid Daring Curious Lively Mellow Kind Keen)
    OWNER="${ADJECTIVES[$((RANDOM % ${#ADJECTIVES[@]}))]} ${ANIMALS[$((RANDOM % ${#ANIMALS[@]}))]}"
  fi
  AGENT_ID="$(cat /proc/sys/kernel/random/uuid)"
  # The "'s <AgentLabel>" suffix names the harness (Claude here); the server
  # parses it so a different harness's skill can send e.g. "…'s Codex".
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
# GRAPHTASK_AGENT_TOKEN. **Recommended on auth-enabled instances** so your work
# is saved to the user's account — without it the §1 check tells the user the
# tradeoff and lets them choose (anonymous still works; it just creates orphan
# graphs not in their "My graphs" sidebar). On no-auth deployments the var is
# unset and the block below is a no-op.
if [ -n "$GRAPHTASK_AGENT_TOKEN" ]; then
  WRITE_HEADERS+=( -H "Authorization: Bearer $GRAPHTASK_AGENT_TOKEN" )
  READ_HEADERS=( -H "Authorization: Bearer $GRAPHTASK_AGENT_TOKEN" )
else
  READ_HEADERS=()
fi
```

**Shell state does NOT survive between separate Bash tool calls.** Env vars and (especially) bash arrays built in one call are gone in the next — and arrays can't be exported anyway — so the one-time identity block above sets `WRITE_HEADERS`/`READ_HEADERS`/`AGENT_ID` for THAT call only. A later write in a fresh Bash call would otherwise ship empty headers (no `Content-Type`, no `X-Writer-*`, no `Authorization`) and go out unattributed or malformed. **Re-derive everything from the persisted files at the top of EVERY bash block** (or keep a whole read-author-write cycle inside one invocation):

```bash
# --- Rehydrate: paste at the TOP of every bash block (needs the §1 files) ---
GT_BASE="${GRAPHTASK_BASE_URL:-http://127.0.0.1:3000}"
AGENT_ID="$(jq -r .id .graphtask/agent-session.json)"
AGENT_NAME="$(jq -r .name .graphtask/agent-session.json)"
GID="$(cat .graphtask/graph-id)"
WRITE_HEADERS=(
  -H 'Content-Type: application/json'
  -H 'X-Writer-Type: agent'
  -H "X-Writer-Id: $AGENT_ID"
  -H "X-Writer-Name: $AGENT_NAME"
)
READ_HEADERS=()
if [ -n "$GRAPHTASK_AGENT_TOKEN" ]; then
  WRITE_HEADERS+=( -H "Authorization: Bearer $GRAPHTASK_AGENT_TOKEN" )
  READ_HEADERS=( -H "Authorization: Bearer $GRAPHTASK_AGENT_TOKEN" )
fi
```

**Every write `curl` below should use `"${WRITE_HEADERS[@]}"` in place of the bare `-H 'Content-Type: application/json'`.** Reads (`GET`) only need `"${READ_HEADERS[@]}"` when you're accessing a private graph owned by the authed user — public reads work without it.

After any write to a graph, record the gid so the optional cleanup hook (below) can depart your presence on session end:

```bash
grep -qxF "$GID" .graphtask/agent-session-graphs 2>/dev/null || echo "$GID" >> .graphtask/agent-session-graphs
```

See [Presence lifecycle](#presence-lifecycle) below for how your avatar gets cleaned up between turns.

## Presence lifecycle

Your writes drop `🤖 <operator>'s Claude` into the canvas avatar bar (the operator = the token owner on authed instances; see [Agent identity](#agent-identity-do-this-once-per-session)). Two things can clear it:

- **Claude Code lifecycle hooks** (set up at install time, outside this skill): a `Stop` hook departs your presence on every graph you've touched at the end of each turn, and `SessionStart` clears stale identity files. With hooks installed, the avatar blinks in on your first write and out the moment you finish responding.
- **Server-side idle reaper** — sweeps inactive presence after ~30 minutes. The safety net if hooks aren't installed or a session ends ungracefully.

You don't manage the hooks yourself. The thing you DO need to do — keep doing — is appending touched gids to `.graphtask/agent-session-graphs` after every write so the hook (if present) knows which graphs to depart from.

## Listing graphs and naming

`GET /api/graphs` returns the graphs the **current authenticated viewer** can see (owned + member-of). On a no-auth instance it returns `[]` — there is no signed-in viewer to scope to, so nothing is listed; legacy un-owned graphs stay reachable only by their id/URL. It is not a public directory; private graphs only reachable by id stay reachable by id.

Graph names are not globally unique — duplicate-name `POST` and `PATCH` both succeed (200/201). Don't expect 409 on name conflicts.

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

# Token check (auth-enabled instances): a token saves what you create to the
# user's account. WITHOUT one you can still work — anonymously — but the graph
# lands with owner_user_id NULL: not in their "My graphs" sidebar, reachable
# only by URL. Anonymous is allowed; the rule is just DON'T slide into it
# silently. If there's no token, surface the message below to the user and
# RECOMMEND minting one, then let them decide (provide a token, or say "go ahead
# anonymously"). Do NOT exit — anonymous is a supported path, not an error.
AUTH_ENABLED=$(echo "$CONFIG" | jq -r .auth_enabled)
if [ "$AUTH_ENABLED" = "true" ] && [ -z "$GRAPHTASK_AGENT_TOKEN" ]; then
  cat >&2 <<EOF
No GRAPHTASK_AGENT_TOKEN set — I can work anonymously, but anything I create
won't be saved to your account (it won't show in your "My graphs" sidebar and is
reachable only by its URL). To save your work to your account, mint a token:
  • open $GT_BASE → sign in → Settings (Cmd/Ctrl+K) → Agent tokens → generate
  • export GRAPHTASK_AGENT_TOKEN=gt_...          # this shell
  • echo GRAPHTASK_AGENT_TOKEN=gt_... >> ~/.zshrc    # future shells
Then I'll pick it up automatically. Or tell me to go ahead anonymously.
EOF
  # Relay the above to the user in your own words and recommend a token. Then
  # continue per their choice — anonymous writes below are fine once they've
  # knowingly opted in (or if they're not reachable to answer).
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

## The universal schema (E15)

graphtask's one primitive — markdown nodes + edges + status — carries a small, server-typed vocabulary so the SAME graph serves execution plans AND deep research. Everything here is ADDITIVE and OPTIONAL: a plain task graph that never sets these fields behaves exactly as before. There is no separate "research mode" — research is just an application of this one schema.

### Edge `purpose` — the field you set on every edge

Each edge carries a `purpose` (the relationship it encodes, directed source → target). `purpose` is canonical; the server DERIVES a structural `type` from it and emits both:

| `purpose` | meaning (source → target) | derived `type` |
|---|---|---|
| `required for` | source is a **prerequisite** of target (the old `dependency`) | `dependency` — DAG, cycle-checked, walked by ready/blockers/unblocks (§5) |
| `supports` | source is **evidence FOR** target | `related` |
| `contradicts` | source is **evidence AGAINST** target | `related` |
| `related to` | loose association (the **default**) | `related` |

- Set `purpose` on every edge write (`POST /edges`, `/edges/bulk`, `/batch`, `PATCH /edges/:id`) — it's the only edge *relationship* field you send (the server also accepts `meta` for edge `color`/`curve`). The server stores the derived `type` and emits BOTH on reads, so the canvas and every dependency query are unchanged. A legacy `type` is no longer accepted as input. `POST /edges`, `/edges/bulk`, and `/batch` reject a write with no `purpose`; `PATCH /edges/:id` treats an omitted `purpose` as "keep the existing relationship".
- ONLY `required for` is cycle-checked and traversed by §5's status queries. `supports`/`contradicts` are directed SIGNED relations read by the inconsistency scan; `related to` is undirected association. Use `supports`/`contradicts` for genuine evidence relations (a `reference` --supports--> a claim; a finding --contradicts--> another); reserve `required for` for real prerequisites.

### Node reserved fields (frontmatter `meta`)

All optional, validated only WHEN PRESENT — no migration (they live in `meta`):

| field | type | meaning |
|---|---|---|
| `type` | open string (≤40) | node kind. Absent = a work/knowledge node. `reference` is the one server-recognized value — an external citation/source. |
| `significance` | number 0.0–1.0 (one-decimal convention) | how much this node matters. UNIVERSAL (plans + research). |
| `confidence` | number 0.0–1.0 (one-decimal) | how sure we are (a finding) / source reliability (a `reference`). Research-tier. |
| `verified_at` | ISO-8601 datetime | when the claim was last DELIBERATELY re-checked. Distinct from the automatic `updated_at`. Research-tier. |

These survive a body-rewriting agent PATCH that omits them (merge-protected like `x`/`y`); send an explicit `null` to clear one (e.g. a re-verify run resetting a stale `verified_at`).

### Role predicates (derived, never stored)
- **claim** = `confidence` set AND `type` ≠ `reference` — a node that ASSERTS something, with a sureness.
- **open question** = `status: todo` AND no `confidence` — an unanswered question.
- **reference** = `type: reference` — an external source.

### Conventions (HARD — keep the vocabulary consistent or read-time filtering rots)
- **Never put `confidence` on an open question.** The moment a node has confidence it READS as an assertion; an open question with confidence is a category error. To remove a `confidence` value set by mistake you must send `confidence: null` — omitting it preserves the old value (merge protection), so the node stays hidden from `/ready`. Same for clearing a stale `verified_at`.
- **A finding is born at `review` (or `done`), never `todo`.** `todo` means "open question, not yet answered" — that's what `/ready` hands back as work to do. The instant you record a finding (you set `confidence`), give it a real status: `review` for a first-pass claim awaiting human confirmation, `done` only on explicit human say-so, and a `type: reference` source is `done` once located. Leaving a confidence-bearing node at `todo` is the same category error as the bullet above — and `/ready` filters such nodes out, so a finding stuck at `todo` silently goes missing from BOTH the work queue and the answered-knowledge view.
- **`verified_at` = a deliberate re-check, not any edit.** A typo fix bumps `updated_at` automatically — it must NOT touch `verified_at`. Set `verified_at` only when you actually re-confirmed the claim against sources.
- **`confidence` and `verified_at` are research-tier — for findings/claims and `reference` sources ONLY.** Don't put them on plan / coding / decision / task nodes: a design preference or task estimate is not a research sureness, and a node with `confidence` reads as a *claim* (it'll surface in research queries). For how much a task/decision matters use `significance` (the one reserved field that's universal and belongs on a plain task); put trade-offs and option preferences in the body or model them as `contradicts`/`supports` between option nodes.
- **Findings get NO `type`.** A finding/claim is identified by its `confidence` + `status`, **not** a type label — leave `type` ABSENT on findings. `type` is reserved for a genuine node KIND a reader acts on — `reference` (a source). Do NOT invent per-finding category/topic types (`commercialization`, `finding/market`, `timeline`, …): that proliferating, per-session vocabulary IS the cross-session encoding drift the reserved fields exist to kill (two sessions invent two schemes and filtering breaks). Categorize a finding by its searchable body + `significance`, never a `type` vocabulary. Use `type: reference` (one word, server-recognized) for sources — not "source", not a topic.
- **Findings are SEPARATE nodes**, never prose embedded in a question's body — so each finding carries its own `confidence`/`verified_at` and retrieval/filtering is per-finding and token-efficient.
- **Completeness of retrieval FIRST, scrutinize confidence LATER.** Build the full picture, then filter by confidence at READ time — don't drop low-confidence nodes while building.
- **Filters choose what to SHOW / SEED, never what to TRAVERSE.** Read-time filters (see [Read-side queries](#read-side-queries-e15-filters-frontier-inconsistency)) apply at the output; on `/context` a low-confidence node bridging two matching nodes is KEPT and marked `bridge:true` so connectivity stays honest.

### Completion gates — run BOTH after finishing graph work
1. **Stop at `review`, never set `done`** (§3) — `done` is the human's call.
2. **Run the inconsistency scan when you finish a body of graph work** — and per-task only when that task added or changed a `supports`/`contradicts` edge: `POST /inconsistencies`; if it returns tensions, SURFACE them (name the loop / its nodes) for the human and NEVER auto-resolve (don't delete or flip a `contradicts` edge). On a graph with no signed (`supports`/`contradicts`) edges the scan is always empty, so it's a no-op you can skip. Framing: like git merge conflicts — the tool surfaces the conflict; the analyst resolves it.

## 2. Build the graph

**Materialize what you already know up front.** The graph is the artifact the user reviews — they want to see structure on the canvas, not get nodes one at a time. For plan-shaped graphs, lay down the **entire DAG** before starting the first task. For research / mapping / freeform graphs, lay down the **starting nodes and connections you already know about**, then grow the graph as you learn.

**One node = one user-meaningful concept or unit of work.** Don't create a node per file edit, per git commit, or per sentence of notes. Granularity should match what a human would read in a status update or scan as a single concept.

For each node, write a real markdown body — title alone is never enough. The body is what the human sees when reviewing or exploring. See section 3 for what to put in the body at each status.

The example below is plan-shaped (`required for` edges for ordering). For a research / mapping shape, swap `"purpose":"required for"` for `"purpose":"related to"` (or `supports`/`contradicts` for evidence relations) and use whichever frontmatter status fits the depth ladder (e.g. `todo` = unexplored, `review` = drafted). The bulk-edge mechanics are identical regardless of shape. (See [The universal schema (E15)](#the-universal-schema-e15) for the full `purpose` vocabulary.)

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

# Bulk dependencies — transactional, all-or-nothing. `purpose: required for`
# derives the cycle-checked `dependency` type.
curl -sS -X POST "$GT_BASE/api/graphs/$GID/edges/bulk" \
  "${WRITE_HEADERS[@]}" \
  -d "{\"edges\":[
    {\"source_id\":$T1,\"target_id\":$T2,\"purpose\":\"required for\"},
    {\"source_id\":$T2,\"target_id\":$T3,\"purpose\":\"required for\"}
  ]}"
```

`POST /edges/bulk` semantics: validates every edge, opens a transaction, inserts them all, then runs cycle detection across the resulting graph. **Any failure rolls everything back** and returns `400`/`409` with `{ error, failedAt: <index> }`. Fix the offending edge and retry the whole batch — never assume partial application.

### Write-side structure — author a graph that stays navigable

§6 below is the READ side (how to pull context out of a graph). These four rules are the WRITE side — how to author nodes and edges so the graph is a faithful, navigable map. They matter because **write-time structure determines read quality**: the connections you author are exactly what lets a reader (or the retriever's traversal) reach a related node two hops away. A/B-validated on fresh build agents — each rule helped or was neutral, none regressed, and together they lifted blind multi-hop answer quality and cut "I can't answer from this" responses ~5× while keeping the graph *leaner*, not denser.

1. **Author the connective tissue.** When two parts of the graph relate only *through* an intermediate concept, create that intermediate as its own **bridge node** and wire the cross-cluster `related` edges to it — rather than leaving the two ends unconnected, or faking a direct A–B edge. Bridge nodes carry the multi-hop payload: B is reached from A by stepping through the bridge. When you add or revise a node, ask *"what does this connect to that isn't already linked — and is there a missing middle concept between them?"* and model the real intermediate. A graph that only links the obvious near-neighbors loses exactly the cross-region connections that make it worth more than a flat list.

2. **Name a node's neighbors in its body.** In a node's markdown body, name the neighboring concepts it connects to — the entities/topics on the other end of its `related` edges. This is truthful (a faithful description of a concept mentions what it relates to) *and* it lifts retrieval: those neighbor names are what hybrid search matches to surface this node as a *seed*, from which traversal reaches the rest of the neighborhood. A node whose body never mentions its neighbors is an island to the retriever even when the edges exist.

3. **A `related` edge is a genuine semantic link.** It should encode a real, specific relationship — not a loose "these are both about the same broad topic" vibe. The edge's value is its *selectivity*: it tells the reader (and the traversal) that *these two nodes specifically* inform each other. Before adding one, be able to state the relationship in a few words ("X supplies Y", "X competes with Y", "X bridges Y and Z"). If you can't name it, it's probably noise — leave it out. A graph where everything relates to everything carries no information, and traversal from any seed drags in half the graph.

4. **Optimize for TRUTH, not the retriever (anti-hairball).** A faithful graph — real concepts, real intermediates, real relationships — is *already* the retrieval-optimal one, because retrieval rides on genuine structure. So do **not** add edges "to help search": a phantom edge that doesn't reflect a real relationship corrupts both the artifact and retrieval precision (an over-connected hairball has high coverage but near-zero precision — every pack drags in half the graph and the reader drowns). Connectivity is a *consequence* of modeling the domain honestly, never a target to maximize. Rules 1–2 are about modeling real structure faithfully — they are not licence to over-connect.

## 3. Status discipline and node body content

Status enum: `todo` → `in_progress` → `review` → `done`. Each transition should bring **new body content** that justifies the status. Don't bump status without updating the body — the body is the artifact, regardless of graph shape.

The body content should always justify the current status. What "justify" means depends on what the node represents:

| Status | Who sets it | Body content (any graph shape) |
|---|---|---|
| `todo` | You (during graph creation) | The starting frame. Execution nodes: the approach, what needs to be done, known constraints. Research / mapping nodes: the question or claim, what we want to know, what's open. |
| `in_progress` | You (when you actually start) | Running notes: what you're investigating, what you've ruled out, files / sources you're touching. Update as you go. |
| `review` | You (when you think it's done) | Self-contained synthesis ready for the human. Execution nodes: what you did, files changed, how to verify. Research / mapping nodes: the synthesized finding with sources and reasoning. **This is what the human reads to confirm.** |
| `done` | **Only the human** | Their confirmation that they accept the node. **Never write this yourself unless the user explicitly asks you to** ("mark X as done", "finish X off"). That permission applies to *that node only* — don't infer permission for siblings, parents, or the rest of the graph. |

A **report** is the whole-graph analogue of a node's `review` body — that same review-tier synthesis for the ENTIRE graph, long-form markdown a human reads instead of clicking every node. It's a separate artifact (the report API — see the API reference) — **never** a graph node — so it inherits the same `review`/`done` discipline: you draft it, the human owns whether it's canonical, and you never produce or overwrite one on your own initiative (§8).

**Read before you write, and send OCC fields.** Always GET the task right before you PATCH it AND include `base_version` + `base_content` in the PATCH body. Without those, the server falls back to "blind replace" and your write silently overwrites any UI-managed frontmatter keys (positions `x`/`y`, `color`, `background-image`) that exist on the row but aren't in your new content. With OCC fields the server runs a three-way merge that preserves the fixed list of protected keys you didn't touch. **The merge only protects that fixed key list, though — `title`/`status`/`body` are writer-wins.** Because the OCC dance sends the content you just fetched as `base_content`, base == current, so the merge can't detect a concurrent human edit to those fields: whatever you PATCH overwrites them. So GET first, READ the returned title/body/status, fold any human changes into your new content, and only then PATCH — never rewrite from memory.

**Keep related task bodies in sync.** When work on one task surfaces information that affects another (e.g., you find that the schema migration also needs a new index, which is a different task), update *that* task's body to reflect the new finding. The graph is a living context document, not a one-shot plan. Each task body should be accurate to the current state of the work.

**Hard rule: before transitioning any task to `in_progress`, check its blockers.**

```bash
BLOCKERS=$(curl -sS "$GT_BASE/api/graphs/$GID/tasks/$TID/blockers" | jq 'length')
```

If `BLOCKERS > 0`, **do not start the task.** Pause and tell the user the task is blocked by [list with statuses], and ask whether to proceed anyway. `review` counts as blocking too — even though the agent finished its part, the human hasn't confirmed, so downstream work isn't safe to begin.

Only proceed if (a) blockers is zero, or (b) the user explicitly OKs starting while blocked. Don't rely on what you remember from when you first laid out the graph — the user may have deleted, retitled, or rearranged tasks since.

For readiness queries (section 5), `review` and `in_progress` count as not-yet-done — downstream tasks won't be classified as ready until every prerequisite is `done`.

PATCH replaces the entire `content` blob (frontmatter + body). The OCC pattern below is the **only safe way to update a task**: GET first, capture `version` + `content`, then PATCH with those as `base_version` + `base_content`. The server's three-way merge then preserves any UI-managed keys (`x`/`y` positions, `color`, `background-image`) that aren't in your new content — but it does NOT shield `title`/`status`/`body`, so base your new content on what you just GET-ed, not on memory.

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
  # IMPORTANT: $NEW_CONTENT must already fold in the human's CURRENT
  # title/body/status. base_content is the row we just fetched, so the merge
  # only shields the fixed protected-key list — title/status/body are
  # writer-wins, and a blind rewrite WILL clobber a concurrent human edit. Read
  # CUR_JSON (below) before composing $NEW_CONTENT; don't rewrite from memory.
  local TID="$1"
  local NEW_CONTENT="$2"
  local CUR_JSON
  CUR_JSON=$(curl -sS "$GT_BASE/api/graphs/$GID/tasks/$TID")
  local CUR_VERSION
  CUR_VERSION=$(echo "$CUR_JSON" | jq -r .version)
  local CUR_CONTENT
  CUR_CONTENT=$(echo "$CUR_JSON" | jq -r .content)
  local RESP
  RESP=$(curl -sS -X PATCH "$GT_BASE/api/graphs/$GID/tasks/$TID" \
    "${WRITE_HEADERS[@]}" \
    -d "$(jq -nc \
      --arg c "$NEW_CONTENT" \
      --argjson v "$CUR_VERSION" \
      --arg b "$CUR_CONTENT" \
      '{content: $c, base_version: $v, base_content: $b}')")
  # Confirm the write landed: the response must be the updated row, not an
  # error. On failure follow §7 — re-fetch on 410/404, retry once on 409 with
  # the body's `current` row as the new base, fix-and-retry on 400.
  if echo "$RESP" | jq -e '.error' >/dev/null 2>&1; then
    echo "patch_task: write FAILED for $TID — $(echo "$RESP" | jq -r '.error')" >&2
    return 1
  fi
  echo "$RESP"
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

Notice the PATCH body has no `x`/`y`, `color`, or `background-image` keys, but the user's drag positions, color tweaks, and chosen node image will survive. The server's mergeFields treats those keys as **protected from agent removal** — when the writer is an agent and the new content omits one of them, the merge preserves the current value rather than reading the omission as "remove this key". Task protections: `x`, `y`, `color`, `background-image`, plus the E15 research fields `significance`, `confidence`, `verified_at` (see 'Node reserved fields' above). Edge protections: `meta.color`, `meta.curve`.

This protection only covers that fixed list. Custom frontmatter keys you drop from a rewritten content blob are still treated as removals — if you want them to survive across PATCHes, include them yourself (read existing frontmatter from `base_content`, splice in your changes, send the merged blob).

**Escape hatch.** If you legitimately want to clear a protected key (e.g. user asks you to reset a node's position), send the key with an explicit `null` value. `null` is defined, so the protection short-circuit doesn't fire and the clear lands.

**Without OCC fields, the PATCH falls back to blind replace** and you'll silently wipe any UI keys the human is managing. Always send `base_version` + `base_content`.

**After everything is in `review`, stop.** Summarize in chat what you submitted and let the user review on the canvas. Don't poll the graph waiting for the human to mark things `done` — they'll use the UI. Your job ends at `review`.

## 4. Update edge purpose or endpoints

Change an edge's `purpose` (e.g. `related to` → `supports`, or into/out of `required for`), or repoint it to a different source/target. The server re-derives `type` from the new `purpose`; cycle detection re-runs whenever the result is `required for` (derived `dependency`). See [The universal schema (E15)](#the-universal-schema-e15) for the `purpose` vocabulary.

**Required: announce focus on the edge first** with `announce_focus_edge` (defined in section 3). This is the same "tell viewers what you're about to touch" rule as for tasks — without it, the human can't see which edge you're about to change in time to intercept.

Same OCC rule as tasks (see [§3](#3-status-discipline-and-node-body-content)): GET first, send `base_version` + `base_row` so the server's three-way merge protects UI-managed `meta` keys (`color`, `curve`) the user set on the edge. There is no single-edge GET route — fetch the edge by filtering the edge list (`GET /api/graphs/$GID/edges`), which returns full edge rows (`source_id`, `target_id`, `purpose`, `meta`, `version`) suitable for `base_row`.

```bash
announce_focus_edge "$EID"
CUR=$(curl -sS "$GT_BASE/api/graphs/$GID/edges" | jq --argjson id "$EID" '.[] | select(.id==$id)')
curl -sS -X PATCH "$GT_BASE/api/graphs/$GID/edges/$EID" \
  "${WRITE_HEADERS[@]}" \
  -d "$(jq -nc \
    --argjson v "$(echo "$CUR" | jq .version)" \
    --argjson r "$CUR" \
    '{purpose: "supports", base_version: $v, base_row: $r}')"
```

(Edges use `base_row` instead of `base_content` because they have structured fields, not a content blob.)

## 5. Status-aware traversal (find what to work on next, what's blocking, what gets unblocked)

These queries are most natural on plan-shaped graphs where ordering matters. The **structural** ones (`subtasks`, `ancestors`, `shortest-path`, `leaves`) also work on research / mapping graphs that use `dependency` edges — useful for "what concepts does this finding rest on?" or "what's the chain from entity A to entity B?". The **status-aware** ones (`ready`, `blockers`, `unblocks`) only make sense if the graph has an ordering and a notion of "done." **All of these follow `dependency` edges only — none traverse `related` links.** To navigate a knowledge-base graph wired with `related` edges (search → follow links), see [*Search + traversal: the graph as a knowledge base*](#search--traversal-the-graph-as-a-knowledge-base) in §6.

The server does the recursion — never compute readiness yourself. All three status-aware queries treat `review` and `in_progress` as "not yet done" so a downstream task only becomes ready when every prerequisite is `done`.

```bash
# What can I work on right now? Returns OPEN QUESTIONS — todo tasks with NO
# confidence (per the role predicate) and all recursive prereqs done. A
# confidence-bearing node is a claim/finding, not ready work, so it never
# appears here even if it still sits at todo; re-checking findings is /frontier's
# job. So in a mixed plan+knowledge graph, /ready stays a clean "what to do next".
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

## 6. Search the graph (find / "what does the graph say about X")

When the user asks a **content** question about the graph — "find the node about X", "what does the graph say about Y", "which task covers Z" — don't grep node bodies or answer from memory. Call the search endpoint, then rerank and synthesize from the candidates yourself. `POST /api/graphs/:gid/search` runs the exact hybrid pipeline the browser search box uses (BM25 lexical + dense vectors → RRF, plus 1-hop graph expansion) and returns a ranked candidate list.

```bash
# Ask the retriever. Read-gated, so READ_HEADERS is only needed on a private
# graph; a JSON body means you still send Content-Type.
RESULTS=$(curl -sS -X POST "$GT_BASE/api/graphs/$GID/search" \
  -H 'Content-Type: application/json' "${READ_HEADERS[@]}" \
  -d '{"query":"how does presence cleanup work"}')

# Ranked taskIds, best-first. results = [{taskId, score, source, snippet, meta}].
IDS=$(echo "$RESULTS" | jq -r '.results[].taskId')

# The results carry an optional lexical `snippet` but NOT the full body — pull
# the candidate pool so you can rerank it against the actual question.
for id in $IDS; do
  curl -sS "$GT_BASE/api/graphs/$GID/tasks/$id" "${READ_HEADERS[@]}" \
    | jq '{id, title: .meta.title, content}'
done
```

**You are the reranker.** The retriever is tuned for **recall**, not for getting rank-1 right: on the eval graph the relevant node lands in the top ~50 about 77% of the time and in the top ~100 ~99% (recall@50 0.77, recall@100 0.99) — but it's often buried below less-relevant hits. Reordering that pool against the *real* question is the job, and you — already an LLM reading the bodies against the query — are a stronger reranker than any model the server could call, at no extra cost. So: take the candidate pool, read the bodies, pick the node(s) that actually answer the question, and synthesize from those. This is the whole reason to prefer search over grep — the investigation that motivated this section found that **only reading candidates and reranking against the real query fixes complex / indirect queries**; query rewrite and index-time expansion don't.

**Pool depth.** The endpoint returns the deployment's configured top-K — **~50 by default** (the `SEARCH_TOPK` knob), tuned that deep on purpose: because retrieval is recall-tuned, the right node on a hard / indirect query is usually *somewhere* in the top ~50 but rarely at #1 (on the eval set recall@50 ≈ 0.77 vs recall@20 ≈ 0.48). So the default pool is already the one you should rerank — just call with no `config` and read what comes back. If you ever need to go deeper, **don't** reach for a bare `config:{"topK":N}`: a per-request `config` is normalized over the *lexical-only* defaults, so it silently drops the dense + graph-expansion legs and hands you lexical-only results. Widen instead by raising `SEARCH_TOPK` at the deployment, or — only if you must do it inline — by passing the *whole* hybrid stack, e.g. `config:{"topK":100,"retrievers":["lexical","dense"],"postprocessors":["graphExpand"],"providers":{"embedding":{"backend":"local-onnx"}}}`, and only when it mirrors the deployed retriever (a config naming a different embedding model than the one deployed returns 400).

**Cross-graph.** `POST /api/search` (no `:gid`) runs the same pipeline over every graph the signed-in user owns or is a member of; each result adds `graphId` + `title`, and a `graphs` map (id → name) labels them. Requires a real user — anonymous callers get 401. Reach for it on "search all my graphs for X".

**Errors.** Empty / missing `query` → 400 `{error}`; an invalid `config` → 400 `{error, errors}`.

### Search + traversal: the graph as a knowledge base

Search and traversal are **two complementary ways to pull context out of a graph — reach for both.** Search jumps to the most relevant nodes *by content* (the RAG-style move above); traversal follows the *edges* out of a node to gather what's connected to it. When the graph is itself a knowledge base — nodes are concept / topic pages and `related` edges are the cross-references between them, the way a wiki links articles — the strongest pattern is the one Karpathy calls an **"LLM wiki"**: rather than re-running vector retrieval on every question, **load the index, jump to an entry page, and follow its links.** Here that's: **search to find the entry node(s), then traverse `related` links to read the connected neighborhood, and synthesize from both.**

The index you traverse is `GET /api/graphs/:gid/graph` → `{nodes, links}`: every node (`id`, `title`, `description`, `status`, plus the full `meta` frontmatter — **no body**) plus every edge (`source`, `target`, `purpose` ∈ `required for | supports | contradicts | related to`, the derived `type` ∈ `dependency | related`, and `meta`/`version`). One cheap call gives you the whole structure; then pull only the bodies you need with `GET /tasks/:id`.

```bash
# 1. INDEX — the whole map once (structure only, no bodies).
MAP=$(curl -sS "$GT_BASE/api/graphs/$GID/graph" "${READ_HEADERS[@]}")

# 2. ENTRY — search finds the most relevant node by content (this section, above).
SEED=$(curl -sS -X POST "$GT_BASE/api/graphs/$GID/search" -H 'Content-Type: application/json' \
  "${READ_HEADERS[@]}" -d '{"query":"how does X relate to Y"}' | jq -r '.results[0].taskId')

# 3. TRAVERSE — follow SEED's related links to its neighbors, then read their bodies.
NEIGHBORS=$(echo "$MAP" | jq --argjson s "$SEED" \
  '[.links[] | select(.type=="related") | select(.source==$s or .target==$s)
    | if .source==$s then .target else .source end] | unique')
for id in $(echo "$NEIGHBORS" | jq -r '.[]'); do
  curl -sS "$GT_BASE/api/graphs/$GID/tasks/$id" "${READ_HEADERS[@]}" | jq '{id, title:.meta.title, content}'
done
```

**Which mode for which question:**
- *"What does the graph say about X?"* → **search**, then rerank the pool (above).
- *"What's connected / related to node N?"* → **traverse** N's `related` links from the `/graph` map (above).
- *"How are A and B connected?"* → `GET /graph/shortest-path?from=A&to=B` for a **dependency** chain; for a `related`-link path, walk the `/graph` links yourself.
- *Deep / multi-hop knowledge-base answer* → search for entry points, traverse `related` links a hop or two out, read those bodies, then synthesize — index-then-links, not one-shot retrieval.
- *"Write me a report / brief / summary of the whole graph"* → the same index→entry→traverse→synthesize move applied graph-wide: `GET /graph` is the index, then walk it section by section (by subtree / status / `related` cluster), read the node bodies, and synthesize. Search-as-KB over the whole map, not new machinery — emit long-form markdown and `PUT` it to the report API (§8, API reference).

**Heads-up:** every section-5 endpoint (`subtasks`, `ancestors`, `blockers`, `unblocks`, `ready`, `leaves`) and `shortest-path` traverses **`dependency` edges only** — they're for plan-shaped graphs and won't see `related` links. A knowledge base wired with `related` edges is navigated through the `/graph` map, as above.

## 7. Error handling

The API uses HTTP status codes meaningfully — handle them, don't paper over them:

- **Preflight fails (curl exit code ≠ 0 on `GET /api/graphs`)** — the app isn't reachable. **Stop and ask the user** what URL graphtask is at; don't try to install or start it yourself.
- **400 `cycle`** on `POST /edges` or `/edges/bulk` — your dependency would close a loop. The bulk version returns `failedAt: <index>` so you can identify the offending edge. Drop it (or invert direction) and retry the whole batch.
- **400 on `POST /tasks`** with a frontmatter validation message — check `title` length (≤100), `description` length (≤200), or `status` value.
- **400 on `PATCH /graphs/:id`** with `anon_role must be one of none, viewer, editor` — pass one of those three strings literally.
- **400 on `PATCH /graphs/:id`** with `unknown settings key` / `font must be one of …` / `… must be a 6-digit hex color` — see section 9 for valid `settings` shape.
- **403 on any graph route** — access denied for this caller. See the "Why am I getting 401 / 403?" table near the top to triage by route + verb.
- **404 on a task or edge** — it was likely deleted by the user. Re-fetch `GET /graph` and reconcile your local view; don't assume your cached ids are still valid.
- **409 on a write** — three-way merge fell through (rare; server handles most conflicts silently). Retry once with the `current` row from the 409 body as your new base.
- **410 on a `PATCH /tasks/:id`** — the task was deleted between your read and write. Refetch `GET /graph` and decide whether to recreate or skip.

## 8. What you must not touch

- `meta.x` and `meta.y` on tasks — node positions on the canvas. These are persisted whenever the user drags a node; if you omit them from your PATCH body the server's three-way merge keeps them intact (assuming you sent `base_version` + `base_content` per section 3). Don't include `x`/`y` in your frontmatter.
- `meta.curve` and `meta.color` on edges, and `meta.color` on tasks — those are user UI concerns. Same rule: leave them out of your PATCH; the merge preserves them.
- `meta['background-image']` on tasks — the picture rendered on the node face. Don't set or replace one on your own initiative; only the user picks which image (if any) lives on the canvas. See [Images and agent discretion](#images-and-agent-discretion--hard-rules) for the full rule; same merge protection as the other UI keys, so leaving it out of a PATCH preserves what the user chose.
- The `done` status on tasks — never write it on your own initiative. Only set `done` when the user explicitly says so for a specific task ("mark T1 done", "go ahead and finish off the testing task"). Vague positive feedback ("looks great") is **not** permission. When in doubt, leave it in `review` and ask.
- **Reports** — never generate a report, and never overwrite an existing one, on your own initiative. Generate only when the user explicitly asks ("write me a report / brief / summary of this graph"). When a report already exists and you've just finished a body of work on the graph, you MAY *ask* whether to update it — but asking is the ceiling: regenerating without a yes is the same category error as writing `done` yourself. The report is a separate artifact (`PUT /api/graphs/:gid/report`), never a graph node, so it never touches the graph.
- The graph's `settings` JSONB (font / colors) — also a UI concern. Don't touch unless the user explicitly asks (e.g. "make this graph's background dark green"). See section 9 if so.

## 9. Per-graph appearance settings (do not touch unless asked)

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

## Reference

Reference material below — consult at point of use, not start to finish. The step sections above link in here by anchor.

## Read-side queries (E15): filters, frontier, inconsistency

The query surface for the typed schema above. All are READ-only (a viewer can run them) and never mutate.

### Metadata filters on `/search` and `/context`

Both accept an optional `filter` — a Mongo/Pinecone-style object over node `meta`. Operators: `$eq $ne $gt $gte $lt $lte $in $nin` plus `$and` / `$or`; a flat object is an implicit AND; a bare value is implicit `$eq`. Comparators compare numbers numerically and ISO datetimes chronologically; an ABSENT field fails the comparators but PASSES `$ne` / `$nin` (Mongo semantics — "field ≠ x" is true when the field isn't there).

```bash
# High-confidence, non-reference search hits only. Ranking is untouched — the
# filter just drops non-matching candidates (you still rerank, §6).
curl -sS -X POST "$GT_BASE/api/graphs/$GID/search" -H 'Content-Type: application/json' "${READ_HEADERS[@]}" \
  -d '{"query":"selenium supply","filter":{"confidence":{"$gte":0.7},"type":{"$ne":"reference"}}}'

# Context neighborhood, filtered at OUTPUT. A low-confidence node on the path
# between two matching nodes is RETAINED and marked bridge:true — the filter
# NEVER prunes traversal. `meta` is surfaced on each node when a filter is set.
curl -sS -X POST "$GT_BASE/api/graphs/$GID/context" -H 'Content-Type: application/json' "${READ_HEADERS[@]}" \
  -d '{"query":"how does X relate to Y","filter":{"confidence":{"$gte":0.6}}}'
```

An absent filter → response byte-identical to the pre-filter contract. An invalid filter → 400. Structured fields aren't text-indexed, so filtering never affects relevance ranking.

### Re-verification frontier — "what established knowledge most needs re-checking"

`POST /frontier` returns LOAD-BEARING confidence-bearing nodes that are STALE or LOW-confidence — the maintenance queue a flat doc store can't express (complements `/tasks/ready`). Importance = OUT-degree over `required for` + `supports` edges, so a foundation many things REST ON ranks first.

```bash
curl -sS -X POST "$GT_BASE/api/graphs/$GID/frontier" -H 'Content-Type: application/json' "${READ_HEADERS[@]}" \
  -d '{"minImportance":2,"staleDays":90,"lowConfidenceBelow":0.5,"maxResults":50}'
# → {frontier:[{id,title,status,type,importance,confidence,verified_at,stale,lowConfidence}], truncated, params}
```

All params optional (defaults shown). A node with no `verified_at` counts as stale (never verified). Plain tasks (no `confidence`, not a `reference`) are excluded. Over the cap → `truncated:true`.

### Inconsistency scan — "where does the graph contradict itself"

`POST /inconsistencies` finds DIRECTED cycles in the supports/contradicts subgraph with an ODD number of `contradicts` edges (signed-graph balance). Even-contradicts (mutual disagreement) and pure-supports (circular reasoning) are NOT flagged.

```bash
# Graph-wide — list every tension.
curl -sS -X POST "$GT_BASE/api/graphs/$GID/inconsistencies" -H 'Content-Type: application/json' "${READ_HEADERS[@]}" -d '{}'
# Per-claim — only tensions through node 42 ("is claim X contested?").
curl -sS -X POST "$GT_BASE/api/graphs/$GID/inconsistencies" -H 'Content-Type: application/json' "${READ_HEADERS[@]}" -d '{"start": 42}'
# → {mode, start?, inconsistencies:[{nodes,edges,length,contradicts,balanced}], truncated, scanned, params}
```

Guardrailed (max cycle length / count → `truncated:true`). This IS completion gate (2): run it after writing, surface tensions by name, never auto-resolve.

### Agent-side `purpose` traversal

`GET /graph` already emits `purpose` (and derived `type`) on every link, so you can walk SIGNED relations yourself: `supports` / `contradicts` edges into/out of a node N are its evidence / counter-evidence; `required for` edges are its prerequisites (or use §5's status queries, which traverse `required for` server-side). Combine with the search-then-traverse "LLM wiki" move in §6.

### Which mode for which question
- *"high-confidence answers about X"* → `/search` with a `confidence` filter, then rerank (§6).
- *"the neighborhood of X, trustworthy nodes only, without losing connectivity"* → `/context` with a filter (bridges kept).
- *"what needs re-verifying / what's gone stale"* → `/frontier`.
- *"does the graph contradict itself / is claim X contested"* → `/inconsistencies` (graph-wide / per-claim).
- *"what supports or contradicts N"* → `GET /graph`, then filter N's links by `purpose`.

## Using graphtask with dynamic workflows

This section applies only when the harness running this skill ALSO exposes a dynamic-workflow / multi-agent orchestration tool (e.g. Claude Code's `Workflow`, plus `Agent` for a single subagent). With one, the graph stops being merely where you *record* work and becomes the durable home for work a workflow *does*: the workflow is the engine that executes one node's fan-out; the graph keeps the plan, the dependencies, and the result.

**Two planes — keep them separate.**

- **Graph = control plane** — durable, cross-session, human-in-the-loop: the plan, the dependency DAG, each node's acceptance criteria (its "tests"), status, findings. This is state + memory.
- **Workflow = data plane** — transient, in-session: the engine for ONE node's fan-out / pipeline / loop / adversarial-verify. This is compute.

**The pattern.** A graph node DEFINES a unit of work → a workflow EXECUTES its fan-out and RETURNS structured results → the main loop DISTILLS those back into the node (flip status, write the synthesis into the body) and freezes any heavy artifact to disk. The graph is the source of truth; a workflow's journals are transient scaffolding.

**When to reach for a workflow** (from inside a node): the node's work is many independent, agent-shaped sub-tasks that benefit from structure and verification — an eval/test suite (N runs × arms × answer→judge), a multi-source research sweep, a large audit or migration, multi-perspective analysis. Build the workflow once; parameterize it per run.

**Generating a report (E16) — inline vs workflow.** A human-readable report of the whole graph is search-as-KB (§6) run graph-wide, not new machinery. Start cheap: `GET /graph` for the structure (no bodies). For a **tiny** graph, one inline pass suffices — read the map, pull the node bodies you need, draft the whole report in one go, and `PUT /api/graphs/:gid/report` with the Bearer token (writes 403 / orphan without `Authorization: Bearer $GRAPHTASK_AGENT_TOKEN`). For a **large** graph, escalate to the `report.workflow.js` generator (map → draft sections in parallel → stitch → completeness critic) that RETURNS the markdown for the main loop to `PUT`. NEVER generate on your own initiative (§8); one report per graph, and PUT replaces it.

**When NOT to.**

- Deterministic, measurable work → a plain script, no agents. Agents are the expensive part; never spend one on what a `curl`/`jq`/node script can compute exactly (coverage, counts, diffs, rendering).
- Single-step work → one inline agent, or just do it.
- **Never** automate the plan-walk, status transitions, keep/drop decisions, or review gates into a workflow. Those stay in the main loop, human-in-the-loop — and you NEVER set `done` (§3).

**The tool, briefly.** `agent(prompt, {schema?, label?, phase?, model?, effort?})` spawns a subagent; its final message IS the return value, and with a JSON-Schema `schema` it returns a validated object (parse-free). `parallel(thunks)` runs tasks concurrently and awaits all (a barrier). `pipeline(items, ...stages)` streams each item through every stage with no barrier between them — the default for multi-stage work. `phase(title)` / `log(msg)` drive the progress display. Useful shapes: **fan-out** (N independent finders), **pipeline answer→judge** (the verify shape), **loop-until-dry** (keep finding until K empty rounds), **adversarial verify** (N skeptics try to refute a finding; kill it if the majority do), **judge panel** (score N independent attempts, synthesize the winner).

**The clean contract (HARD RULE).** Workflows COMPUTE and RETURN; the **main loop** SYNCS the graph (announce-focus + OCC, §3). Do not have a workflow write to the plan graph concurrently — collect its results, then write them from the main loop with OCC so the canvas stays consistent and your avatar attribution is right. Spawning agents is **opt-in and costs tokens**: do it only when the user/harness has actually asked for multi-agent orchestration.

**Writing results back — the batch endpoint.** When a workflow returns a set of nodes + edges (a research round, a batch of distilled findings), commit them in ONE call: `POST /api/graphs/:gid/batch`. It upserts many nodes + edges in a single transaction, is idempotent per node via a client `external_id` (re-running a round updates instead of duplicating), and stamps every row with a `run_id` so a run's additions can be inspected or undone. This is the write-back path: it collapses N racing single-writes into one transaction — the real memory win on a small box — and lets a re-run be a safe no-op.

```bash
# Results from the workflow, already structured. external_id is YOUR stable key
# per node (so a re-run upserts, not duplicates); edges reference nodes by that
# external_id (string) or by an existing numeric task id.
curl -sS -X POST "$GT_BASE/api/graphs/$GID/batch" "${WRITE_HEADERS[@]}" -d "$(jq -n \
  --arg run "research-2026-06-21-round1" \
  '{run_id:$run,
    nodes:[ {external_id:"claim:tsmc-capex",
             content:"---\ntitle: TSMC raises 2026 capex\nstatus: review\nconfidence: 0.8\nverified_at: 2026-06-21T00:00:00Z\n---\n## Finding\n…"},
            {external_id:"src:tsmc-q1-call",
             content:"---\ntitle: TSMC Q1 2026 earnings call\nstatus: review\ntype: reference\nconfidence: 0.9\n---\n## Source\n…"} ],
    edges:[ {source:"src:tsmc-q1-call", target:"claim:tsmc-capex", purpose:"supports"},
            {source:"claim:tsmc-capex", target:"entity:tsmc", purpose:"related to"} ]}')"
# Response: {run_id, nodes:[{…,_op:created|updated|unchanged}], edges:[…],
#            created:{…}, updated:{…}, unchanged:{…}}. Re-running the same batch
# reports everything `unchanged` — no version churn, no canvas flash.
```

**YAML caution:** quote any frontmatter title that contains a colon (`title: "Signal: ARR up"`) — an unquoted colon makes the YAML fail to parse and rejects the whole batch.

Agents write status `review`, never `done` (§3 — `done` is the human's call). The batch merge preserves UI-managed keys AND a human's `status` when your content omits them, so a re-run never silently reverts a node a human advanced. Keep the small, fixed node/edge vocabulary the graph already uses.

**Hard-won lessons (validated on a real run, E13.10).**

- **Shape = TWO fan-out workflows with deterministic GLUE between them, not one mega-workflow.** Use agents ONLY for the genuinely-LLM phases (build, judge); use plain node scripts for everything measurable (provision, measure, render, compare). The glue lives in the main loop between workflows. Minimize agents — they're the cost.
- **Concurrency is ~serial on a small box** (the cap is ≈ cores − 2; on 1 core, fan-out just queues). The value of fan-out here is ORGANIZATION + structured verification, **not speed** — set that expectation.
- **Structured output (JSON schema) is the contract** — build summaries and judge verdicts come back parse-free. `pipeline(answer→judge)` is the verification shape; lean on it.
- **Data handoff is the rough edge.** `Workflow` `args` must be inline in the call (you can't reference a file), and the result arrives in the completion notification. So pass SMALL args / file PATHS (not file contents), and persist a workflow's result to disk for the next script to read.
- **Memory is the binding constraint.** Many single writes each trigger a server-side embedding pass; the batch endpoint writes once. On a capable embedding backend, `EMBED_TASKS_PER_PASS` (a deploy env var, default 1 = unchanged) also groups embeddings per pass.
- **Subagents are faithful "fresh sessions."** They inherit env (the `gt_` token), can curl the live API, honor model/effort overrides + schemas, and are lightweight — a no-context `agent()` given only a skill + a task behaves like a brand-new session.

**A working example to ADAPT, not reinvent (committed):** `eval/skill-ab/ab-build.workflow.js` + `ab-aq.workflow.js` are the two fan-out workflows; `provision.js` / `measure.js` / `aggregate.js` / `compare.js` are the deterministic glue. Start from those.

### Example: a deep-research workflow (E15 schema)

A concrete, parameterized research workflow ships at **`.claude/skills/graphtask/workflows/research.workflow.js`** (run it with `Workflow({ scriptPath: ".../research.workflow.js", args: { question, gid, base } })`). Its only required input is a research question. It implements the canonical shape against the universal schema:

**read KB (filtered) → [discover (fan-out) → fetch sources → adversarial 3-vote verify → dedup] looped until dry → completeness critic**, returning verified findings in the small fixed vocabulary:
- each finding → a **claim node** at `status: review` with `confidence` (from the verify vote-margin), `significance`, and `verified_at` — and **no `type`** (it's a claim, identified by confidence + status);
- each source → a **`type: reference`** node, with a **`supports`** edge source→finding;
- a finding that conflicts with another → a **`contradicts`** edge;
- the critic's gaps → **`todo` open-question** nodes (NO confidence).

Per the clean contract, the workflow COMPUTES and RETURNS `{ nodes, edges, openQuestions }`; the MAIN LOOP then does the side-effects:

```bash
# 1. write the round atomically at status review (idempotent on external_id),
#    stamping verified_at with a real timestamp; sources land as reference nodes.
curl -sS -X POST "$GT_BASE/api/graphs/$GID/batch" "${WRITE_HEADERS[@]}" -d "$ROUND_JSON"
# 2. COMPLETION GATE 1 is already honored — everything is `review`, never `done`.
# 3. work the re-verification frontier (stale load-bearing knowledge to re-check):
curl -sS -X POST "$GT_BASE/api/graphs/$GID/frontier" -H 'Content-Type: application/json' "${READ_HEADERS[@]}" -d '{}'
# 4. COMPLETION GATE 2 — run the inconsistency scan and SURFACE any tension by
#    name (never auto-resolve a contradicts edge):
curl -sS -X POST "$GT_BASE/api/graphs/$GID/inconsistencies" -H 'Content-Type: application/json' "${READ_HEADERS[@]}" -d '{}'
```

Rule of thumb: read-only POSTs — `search` / `context` / `frontier` / `inconsistencies` — take `READ_HEADERS` + an explicit `Content-Type`; only mutating calls (e.g. the `batch` write in step 1) take `WRITE_HEADERS`.

Re-running the workflow on the SAME graph next session compounds: the read-KB stage skips what's already confident, the batch write upserts (no duplicates), and the frontier resurfaces what's gone stale. That loop — build → read → re-verify → compound — is the whole point of the typed schema.

**If the Workflow tool is absent**, degrade to a single-agent sequential loop with the same discipline (read the graph → do the work → write back via the batch endpoint → repeat), just without the fan-out.

## API reference

All paths below are `:gid`-scoped (substitute `$GID`). Base URL is `$GT_BASE` (`GRAPHTASK_BASE_URL` env var, default `http://127.0.0.1:3000`).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/config` | `{auth_enabled, provider, viewer_user_id}` — probe first to learn the deployment mode |
| GET | `/api/graphs` | Lists graphs the viewer owns + is a member of; anonymous callers (which includes every caller in auth-off mode) get `[]` — legacy un-owned graphs stay reachable by URL only |
| POST | `/api/graphs` | `{name, description?}` — duplicate names allowed; new graphs default `anon_role='viewer'` and `settings={}` |
| GET | `/api/graphs/:id` | One graph; also returns `viewer_can_edit` / `viewer_can_manage` based on the caller's role |
| PATCH | `/api/graphs/:id` | `{name?, description?, anon_role?, settings?}` — `anon_role` ∈ `none | viewer | editor`; see section 9 for `settings` |
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
| GET | `/api/graphs/:gid/tasks/ready` | Tasks ready to start — open questions (`status:todo`, no `confidence`) with all recursive prereqs `done`; see [§5](#5-status-aware-traversal-find-what-to-work-on-next-whats-blocking-what-gets-unblocked) for the exact predicate |
| GET | `/api/graphs/:gid/tasks/:id/subtasks` | All recursive prerequisites |
| GET | `/api/graphs/:gid/tasks/:id/ancestors` | All recursive dependents |
| GET | `/api/graphs/:gid/tasks/:id/blockers` | Recursive prereqs not yet done |
| GET | `/api/graphs/:gid/tasks/:id/unblocks` | Direct parents that would become ready if this task were done |
| GET | `/api/graphs/:gid/edges` | List edges |
| POST | `/api/graphs/:gid/edges` | `{source_id, target_id, purpose, meta?}` — `purpose` ∈ `required for | supports | contradicts | related to`, **required** (server derives + stores `type`; legacy `type` no longer accepted). See [The universal schema (E15)](#the-universal-schema-e15). |
| POST | `/api/graphs/:gid/edges/bulk` | `{edges: [...]}` — transactional, all-or-nothing; each edge takes `purpose` (required) |
| POST | `/api/graphs/:gid/batch` | `{run_id?, nodes:[{external_id, content, base_content?}], edges:[{source, target, purpose, meta?, external_id?}]}` — transactional UPSERT of nodes + edges in one call. Idempotent per node via `external_id` (re-run → upsert, not duplicate); edges idempotent on their endpoints; every row stamped with `run_id`. Edge `source`/`target` is a numeric task id OR an in-batch/existing `external_id` string; `purpose` is required (one of `required for | supports | contradicts | related to`) and the server derives + stores `type`. Returns `{run_id, nodes, edges, created, updated, unchanged}`. The dynamic-workflow write-back path — see [Using graphtask with dynamic workflows](#using-graphtask-with-dynamic-workflows). |
| PATCH | `/api/graphs/:gid/edges/:id` | Partial update |
| DELETE | `/api/graphs/:gid/edges/:id` | Delete |
| GET | `/api/graphs/:gid/graph` | `{nodes, links}` snapshot |
| GET | `/api/graphs/:gid/graph/shortest-path?from=&to=` | BFS over dependency edges (undirected); returns `{path, cost, tasks}` or empty if disconnected |
| POST | `/api/graphs/:gid/search` | Hybrid (BM25 + dense → RRF, +1-hop expand) search over the graph's nodes; **read-gated** (viewers can run it; never mutates). Body `{query, config?, filter?}` → `{query, results, timings}`; `results` is the ranked list `[{taskId, score, source, snippet, meta}]`. Optional `filter` (E15) post-filters by node `meta` without changing ranking — see [Read-side queries (E15)](#read-side-queries-e15-filters-frontier-inconsistency). For content questions, prefer this over grep — see [§6](#6-search-the-graph-find--what-does-the-graph-say-about-x). |
| POST | `/api/graphs/:gid/context` | Query- or node-seeded k-hop neighborhood WITH bodies (one cohesive KB call); **read-gated**. Body `{query?|seeds?, hops?, maxNodes?, edgeTypes?, alpha?, filter?}`. Optional `filter` (E15) applies at OUTPUT with the bridge rule (a node bridging two matching nodes is kept + marked `bridge:true`) — see [Read-side queries (E15)](#read-side-queries-e15-filters-frontier-inconsistency). |
| POST | `/api/graphs/:gid/frontier` | **E15** re-verification frontier: load-bearing (out-degree of `required for`+`supports`) ∧ (stale ∨ low-confidence) confidence-bearing OR `type: reference` nodes. Body `{minImportance?, staleDays?, lowConfidenceBelow?, maxResults?}` → `{frontier, truncated, params}`. **Read-gated.** |
| POST | `/api/graphs/:gid/inconsistencies` | **E15** signed-cycle scan: directed cycles in the supports/contradicts subgraph with odd `contradicts`. Body `{start?, maxCycleLen?, maxCycles?}` (graph-wide, or per-claim when `start` is a node id) → `{mode, inconsistencies, truncated, scanned}`. **Read-gated.** |
| POST | `/api/search` | Cross-graph search over every graph the signed-in caller owns or is a member of (same set as `GET /api/graphs`). Same body/response, plus each result carries `graphId` + `title` and a `graphs` map (id → name). **401 if anonymous.** |
| GET | `/api/graphs/:gid/events` | SSE stream — used by the browser; you generally don't need to consume this |
| GET/POST | `/api/graphs/:gid/presence` | Live avatar-bar presence. `POST {id, name, type}` announces/refreshes (204; 400 without `id`); `GET` returns the snapshot. The browser owns this; agents normally let the install-time Stop/SessionStart hooks manage it — see [Presence lifecycle](#presence-lifecycle). **Read-gated.** |
| DELETE | `/api/graphs/:gid/presence/:writerId` | Idempotent depart (204 even if absent). What the Stop hook calls for each touched gid at end of turn. |
| GET/POST | `/api/graphs/:gid/selection` | Per-writer focus broadcast (the colored outline + cursor peers see on the canvas). `POST {node_ids, edge_ids, editing, cursor_anchor}` (204; 400 without `X-Writer-Id`) is what `announce_focus`/`announce_focus_edge` (§3) call — one selection per writer, a new POST replaces the prior; `GET` returns the snapshot. **Read-gated** (a viewer may publish their own). |
| DELETE | `/api/graphs/:gid/selection/:writerId` | Clears that writer's selection; idempotent 204. What `clear_focus` (§3) and end-of-turn cleanup call (`:writerId` = your `AGENT_ID`). |
| GET/PUT | `/api/graphs/:gid/prefs/me` | Per-(user, graph) camera-follow toggle. `GET` → `{agent_follow}` (null = unset → client default); `PUT {agent_follow: <bool>}` sets it AND your account-wide default. **Signed-in users only — 401 anonymous**; a UI preference, not an agent write. |
| POST | `/api/graphs/:gid/uploads` | Raw image bytes (`Content-Type: image/png|jpeg|gif|webp|svg+xml`, 5 MB cap). Returns `{id, url, content_type, byte_size}`; reference the URL from a task's `background-image` frontmatter to make it render on the canvas. |
| GET | `/api/graphs/:gid/uploads/:id` | Image bytes; served with the stored content-type, immutable cache headers, and `X-Content-Type-Options: nosniff`. |
| GET | `/api/graphs/:gid/report` | The graph's ONE human-readable report (E16). `200` with `{title, description, body, meta, generated_at, updated_at, source_graph_version, run_id}`, or `404 {error:'no report yet'}`. **Read-gated** — a viewer/anon may read it. |
| PUT | `/api/graphs/:gid/report` | Upsert the report (one per graph; PUT idempotently REPLACES). Body `{title (req, ≤200), description? (≤500), body (markdown), source_graph_version?, run_id?, meta?}`. **Edit-gated** — needs edit access + Bearer token. `generated_at` is preserved across updates; `run_id` preserved when omitted. Writing a report has ZERO impact on the graph (its own table + notify — never bumps `updated_at`/`version`). |

### Markdown frontmatter shape

```yaml
---
title: string (required, ≤100 chars)
description: optional string (≤200 chars)
status: todo | in_progress | review | done   # defaults to todo
type: optional open string (≤40)             # E15; `reference` = an external source
significance: optional number 0.0–1.0        # E15; how much this node matters (universal)
confidence: optional number 0.0–1.0          # E15; how sure (a finding) / source reliability (research-tier)
verified_at: optional ISO-8601 datetime      # E15; last DELIBERATE re-check (≠ auto updated_at)
background-image: optional URL string (≤500 chars)   # UI-managed; see below
---
free-form markdown body
```

Three of the four E15 fields — `significance`, `confidence`, `verified_at` — are validated only when present and merge-protected (a body-rewriting PATCH that omits them keeps them; explicit `null` clears). `type` is validated when present but is NOT merge-protected: a body-rewriting PATCH that omits `type` drops it, so always re-state `type` (e.g. `type: reference`) when you rewrite a node's content. See [The universal schema (E15)](#the-universal-schema-e15) for the predicates and conventions.

`background-image` holds a URL into the graph's uploads (e.g.
`/api/graphs/:gid/uploads/:id`). The canvas renders it inside the node frame
(title above, image below) when present. **UI-managed key** — like
`x`/`y`/`color`, it's on the `protectedFromAgentRemoval` list in the PATCH
merge. Agents that rewrite content shouldn't include it; the server preserves
the existing value when an agent's PATCH omits it. To intentionally clear it,
send an explicit `null`. To upload bytes from a script: `POST
/api/graphs/:gid/uploads` with `Content-Type: image/*` and the raw bytes as
the body (5 MB cap by default; the self-hoster's `GRAPHTASK_UPLOAD_MAX_BYTES`
can change it); response is `{id, url, content_type, byte_size}`.

### Images and agent discretion — HARD RULES

Images cost the user real disk space (bytes live in their Postgres `uploads`
table), so be deliberate about when you add one. Two distinct cases:

**Setting a node's `background-image`** — the picture rendered on the canvas
itself. **Don't set this on your own initiative.** Only set it when the
user explicitly asks for that node to have a background image ("find a
chart for the revenue node and put it as the background", "use this
screenshot as the image for task T3"). A graph full of agent-chosen
background images is noise the user has to clear out; a graph where the
user picked each one is signal.

*Replacing an image that's already there* is more guarded still. When a
node already has a `background-image`, treat the existing one as the user's
deliberate choice and **never overwrite it on your own initiative** — only
replace it when the user explicitly asks you to swap that node's image
("replace the chart on T3 with this newer one"). This mirrors the UI, which
asks the user to confirm "Replace image?" before clobbering an existing
background; the agent's equivalent of that confirmation is to act only on an
explicit replace instruction. If you think a node's current image should
change but the user hasn't asked, surface it as a question rather than
overwriting — e.g. *"T3 already has a background image; want me to replace it
with the updated chart?"*

**Including images in a node's markdown body** — `![alt](url)` inside the
body, surfaced in the side panel when the user opens the node. This is
fair game when the image *materially adds* to the node's content. Use your
judgement:

- *Stock research* — a chart of revenue trends, an earnings-call slide
  with the relevant number circled, an org-chart of subsidiaries → useful,
  include. The company's logo or a generic stock-ticker icon → decorative,
  skip.
- *Concept / research map* — a diagram of the architecture being studied,
  a figure from a referenced paper → useful, include. A photo of the
  author or a generic "code on a screen" stock photo → decorative, skip.
- *Execution plan* — a screenshot of the failing test output you're about
  to fix, a Figma frame of the design being built → useful, include. A
  decorative emoji or a clip-art icon for the task type → decorative,
  skip.

The rule: would a human reviewing this graph next month thank you for the
image, or wish you hadn't bloated their database with it? If you can't
articulate why this specific image helps understanding, leave it out.

**If the user says "no images" / "don't add images" / "skip images"** —
honor that absolutely, for both `background-image` AND body images. Don't
search for them, don't upload them, don't include them via `![]()`. This
is usually a signal that the user is self-hosting or running locally and
doesn't want their Postgres footprint to grow. Even useful images stay out
when the user has said no.

When in doubt, ask: *"This node would be clearer with [the X chart from the
Q3 earnings slide] — should I include it, or are you keeping images out of
the graph?"* One line of confirmation is cheaper than an unwanted upload.

### Edge shape

```json
{
  "source_id": 1,
  "target_id": 2,
  "purpose": "required for",
  "meta": {}
}
```

`purpose` ∈ `required for | supports | contradicts | related to` (E15 — the field you set; required on writes). The server derives the structural `type` (`required for`→`dependency`, the rest→`related`) and emits both; a legacy `type` is no longer accepted as input. `required for` edges form a DAG; the server enforces this with a transactional cycle check on every insert/update (single + bulk). See [The universal schema (E15)](#the-universal-schema-e15).

## Setup (only if the user asks)

If the user says something like "set up graphtask" / "install the skill" / "I followed your steps but the canvas isn't updating":

1. **Skill + hooks** — run the project's installer, which copies this `SKILL.md` to `~/.claude/skills/graphtask/` and merges presence-cleanup hooks (Stop + SessionStart) into `~/.claude/settings.json` with a timestamped backup:
   ```bash
   bash <(curl -fsSL https://raw.githubusercontent.com/lucasness/graphtask/main/install.sh)
   ```
   Override `CLAUDE_HOME` if their config lives somewhere other than `~/.claude`. After the script runs, tell them to **restart Claude Code** so the new hooks load.
2. **`jq`** — recipes parse JSON with it. Install via `brew install jq` (macOS), `apt install jq` (Debian/Ubuntu), or `apk add jq` (Alpine).
3. **`GRAPHTASK_BASE_URL`** — point at the instance they're using. Hosted users: `export GRAPHTASK_BASE_URL=https://graphtask.wafers.live`. Self-hosted: `export GRAPHTASK_BASE_URL=https://graphtask.example.com`. Local users: leave unset; the recipes default to `http://127.0.0.1:3000`. The agent uses this for both API calls AND the URL it prints to the user — so it must be reachable from the user's browser, not just the agent.
4. **`GRAPHTASK_AGENT_TOKEN`** (auth-enabled instances — **recommended** so the user's work is saved to their account) — tell them to open the in-app Agent tokens panel (key icon), click Generate, copy the `gt_…` string from the modal (shown exactly once), and persist it in whichever env mechanism their setup uses (`export` in `~/.zshrc`, a project `.env` loaded by the shell, a wafer `session.env`, etc.). Without it the agent still works anonymously, but creates orphan graphs not tied to their account — so the section 1 check surfaces the tradeoff and lets them choose; it does not hard-block.

If the user reports they can't reach graphtask at all (preflight `curl` fails), don't try to start the server yourself — ask whether they're running it locally and which port, or whether they meant to point at the hosted URL.

