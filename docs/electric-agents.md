# Plan — Electric Agents for graphtask

## Status: deferred (2026-05-04)

After investigation we decided **not to migrate to Electric at this time**. The plan below remains a useful blueprint for later. This section records why we deferred.

### What we'd gain

| Claimed win | Honest assessment |
|---|---|
| Race-free concurrent human+Claude editing | Real, but small — the same-instant collision is rare for graphtask's profile, and Postgres-level optimistic concurrency solves the lost-update problem with ~100 LOC and no new infra. |
| Cross-device execution resume | **Not delivered by the migration.** Cross-device *viewing* already works via SSE. Real "resume the agent from another device" needs a server-side Claude runtime, which can write directly to Postgres. The migration is at best a future prerequisite. |
| Reconnect-from-offset on disconnect | Modest — closing the laptop and re-opening triggers a full state fetch today, which is fine for a notetaking tool. |

### What we'd pay

- Process count goes 2 → 4 (Postgres, Electric Elixir sync service, projection worker, agent runtime).
- Local dev becomes multi-process orchestration; Docker becomes multi-service compose.
- Debugging path lengthens: "read row from `tasks`" → "trace event through stream offset, projection state, materialization."
- Onboarding: Postgres knowledge → Postgres + stream model + projection idempotency + offset tracking.
- Refactor surface: `src/sse.js`, all routes, `db/schema.sql`, `public/app.js`, plus two new long-lived workers.

### What the current architecture is good at

One server, one DB, one language. State queryable in `psql`. Failure modes are 30 years of well-understood Postgres folklore. `pg_notify` → SSE is dumb but works for one-writer-many-readers.

### Cheaper alternative we are adopting

Postgres-level optimistic concurrency: add a `version` column to `tasks`/`edges`/`graphs`, conditional UPDATE with version check, 409 on conflict, client retries with fresh state. Solves the actual lost-update bug currently latent in `src/routes/tasks.js:117` (full-row replacement on PATCH) without any new infrastructure.

### When to revisit this plan

Reconsider Electric adoption when **any** of these become true:

1. We commit to building a server-side Claude runtime (hosted agent sessions) and want stream-as-truth as its substrate.
2. Real-time multi-user collaboration (more than one human editing the same graph live) becomes a product requirement.
3. The lost-update / merge story under OCC starts producing user-visible friction (e.g., frequent 409 retries that hurt UX).
4. Electric ships a managed runtime that genuinely removes the operational cost we'd otherwise eat.

The technical content below is preserved as the blueprint for that future migration.

---

## Context

graphtask today: Postgres holds `graphs` / `tasks` / `edges`; row triggers emit `pg_notify('graph_change')`; `src/sse.js` LISTENs and fans out to per-graph SSE subscribers; the browser reconnects via `EventSource`. URL = bearer token (16-char random graph IDs); no auth.

Electric Agents (released 2026-04-29) ships OSS Durable Streams + StreamDB + reactive queries (TanStack DB) under Apache 2.0, plus a forthcoming managed agent runtime.

We did a greedy value analysis of Electric's four headline wins for graphtask. The user answered:

- Usage pattern is **dual-mode**: agent-driven *and* human-only notetaking, across coding and operational/corporate work.
- **Wanted:** (1) concurrent human+Claude editing without races, (3) cross-device execution resume.
- **Skipped:** forking and supervisor agents — judged as code-only wins because real-world ops are not reversible.

This locks the direction: we want race-free multi-writer state and durable agent execution; we do not need agent-as-stream identity, forking semantics, or meta-agent infra.

## Recommended approach — hybrid

**Adopt Electric's data primitives for the sync layer; treat execution-resume as a separate runtime concern.**

Concretely:

1. **Each graph is a Durable Stream.** Mutations (task created, edge added, status changed, etc.) are appended as ordered events. Postgres becomes a materialized view derived from the stream by a subscriber, not the source of truth.
2. **Browser uses Electric's reactive query** to read the stream. Replaces `EventSource`. Reconnect-from-offset, multi-tab, and ordered cross-writer visibility come for free.
3. **Human and Claude both write to the stream.** Ordered append guarantees both sides see each other's edits in a consistent sequence — this is the win the user actually asked for. We still need a small **field-level merge policy** (e.g. last-writer-wins per field with timestamps) for cases where both edit the same task simultaneously.
4. **Cross-device execution resume is a separate piece** — a server-side Claude runtime that writes to the same stream. The user's URL points at the stream; Claude writes there from wherever it runs. We can:
   - wait for Electric's managed agent runtime ("coming soon"), or
   - build a simple long-lived worker (Inngest, plain Node/Bun service, etc.) that holds the Claude session and forwards tool calls to graph mutations.

We are NOT adopting agent-as-stream identity, forking offsets, or supervisor-agent patterns. The graph remains the source of truth; the agent is a writer.

## What changes in graphtask

| Area | File(s) | Change |
|---|---|---|
| SSE fan-out | `src/sse.js` | Delete. Replaced by Electric reactive query on the client. |
| pg_notify triggers | `db/schema.sql` (`bump_graph_updated_at`, `bump_on_*_change`) | Remove. Stream is the event source; Postgres becomes the projection. |
| Schema | `db/schema.sql` | Add an event log table (or use Electric's storage); existing `tasks`/`edges` become the materialized projection. |
| Mutation routes | `src/routes/*.js` (HTTP API hit by Claude) | Append to stream instead of (or in addition to) writing rows directly. |
| Browser client | `public/app.js` | Replace `new EventSource(...)` with Electric's reactive-query subscription. |
| New: projection worker | new file | Stream subscriber that maintains the Postgres materialized state. |
| New: merge policy | inside event-apply path | Field-level LWW (or similar) for concurrent edits to the same task field. |

The surface area is small — `sse.js` is ~80 LOC and the route handlers are thin. This is a refactor, not a rewrite.

## Prerequisites to verify before implementation

1. **Electric OSS lib maturity.** Verify the published packages have TypeScript types, a Node server-side writer SDK, a browser client, and non-toy examples. If immature, the same architectural shape (event-sourced graph, stream-shaped pub/sub) can be implemented in-house against Postgres — the design is not Electric-specific.
2. **Runtime decision for execution resume.** Choose between waiting for Electric's managed runtime vs. running a plain Node/Bun worker that hosts Claude sessions. Probably the latter, since it's available now and graphtask already has Bun/Node tooling.
3. **Concurrency semantics.** Decide the merge policy for same-field concurrent edits. Default suggestion: last-writer-wins per field, with per-field timestamps. CRDTs are overkill for this domain.
4. **Migration story.** Existing graphs need to either be replayed into a fresh stream from current Postgres state, or the projection worker needs to bootstrap from existing rows. Both are tractable.

## Out of scope for this plan

- Forking semantics — explicitly deprioritized.
- Supervisor agents — explicitly deprioritized.
- Auth model changes — graph ID remains the bearer token.
- Replacing Postgres entirely — it stays as the materialized view for SQL queryability.

## Verification

End-to-end test, after implementation:

1. Open the same graph URL on two browser tabs. Edit a task title in tab A; tab B reflects within ~100ms with no manual refetch.
2. Run a Claude session that mutates the same graph; both tabs see Claude's writes interleaved correctly with human edits.
3. Concurrent edit test: tab A edits task title, Claude edits the same task's status simultaneously. Both edits land cleanly per the merge policy; neither is silently dropped.
4. Disconnect a browser for 30 seconds, reconnect. Client resumes from its last offset and replays missed events — no full graph refetch.
5. Existing test suite (`npm test`) passes against the new event-sourced backend.
6. Kill the projection worker mid-stream; restart it; verify Postgres state catches up to the stream tip.

## Decision points still open

- Confirm: keep Postgres as materialized view, not as source of truth.
- Runtime path for execution resume (wait for Electric's, or build a worker now).
- Approve the prerequisite step of verifying Electric lib maturity before committing code.

## Why we are NOT adopting agent-as-stream

Electric's headline framing — *"the agent IS the durable stream; everything else is a projection or subscriber"* — makes the agent's session log the primary identity. In that model, every tool call (including graph mutations) lives on the agent's stream, and the visible graph is just a derived view of those tool calls.

We are not adopting that for graphtask because:

1. **graphtask is dual-mode.** Half its use is agent-driven, half is human-only notetaking. In human-only mode there is no agent to be the spine of the data — but there is still a graph. So an agent-centric source of truth doesn't fit the product.
2. **The graph outlives any single agent run.** Agent sessions are episodic ("decompose this project for me, then go away"). The graph is permanent and may be touched by many sessions, by humans, or by neither. The durable artifact is the **graph**, not the agent.
3. **Forking — the main feature agent-as-stream unlocks — was rejected** as a graphtask feature because real-world operational tasks are not reversible. Without forking, the agent-as-stream framing buys nothing additional over a plain graph-shaped stream.
4. **Multi-agent coordination, supervisor agents, addressable Claude** — also out of scope for this product.

The graph-as-stream variant we *are* adopting keeps the same Electric primitives (Durable Streams, reactive queries, multi-writer ordering) but points them at the artifact users actually care about. We get the race-free concurrent-edit win without committing to the agent-platform philosophy.
