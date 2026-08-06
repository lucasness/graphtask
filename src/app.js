import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import graphsRouter from './routes/graphs.js';
import tasksRouter from './routes/tasks.js';
import edgesRouter from './routes/edges.js';
import batchRouter from './routes/batch.js';
import graphViewRouter from './routes/graphView.js';
import presenceRouter from './routes/presence.js';
import membersRouter from './routes/members.js';
import meRouter from './routes/me.js';
import graphPrefsRouter from './routes/graphPrefs.js';
import selectionRouter from './routes/selection.js';
import uploadsRouter from './routes/uploads.js';
import reportsRouter from './routes/reports.js';
import searchRouter from './routes/search.js';
import searchAllRouter from './routes/searchAll.js';
import reportsAllRouter from './routes/reportsAll.js';
import contextRouter from './routes/context.js';
import frontierRouter from './routes/frontier.js';
import decisionsAtRiskRouter from './routes/decisionsAtRisk.js';
import inconsistencyRouter from './routes/inconsistency.js';
import structureRouter from './routes/structure.js';
import { startSse, subscribe, unsubscribe, tryReserveSlot, releaseSlot, broadcastPresence } from './sse.js';
import { writerType } from './writerType.js';
import { getAdapter } from './auth/index.js';
import { verifyAuth } from './auth/middleware.js';
import { requireGraph, requireGraphForMethod } from './auth/require.js';
import * as presence from './presence.js';
import * as selectionState from './selectionState.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(writerType);

// Auth wiring. The adapter is selected once at boot from AUTH_PROVIDER; its
// middlewares (e.g. Clerk's session reader) run before verifyAuth so that
// verifyAuth can attribute the request to a user row. With AUTH_PROVIDER=none
// (the default) verifyAuth itself is a no-op: req.user stays null.
const authAdapter = await getAdapter();
for (const mw of authAdapter.middlewares()) app.use(mw);
app.use(verifyAuth);

app.use(express.static(path.join(__dirname, '..', 'public')));

// Frontend bootstrap: tells the browser whether to load Clerk JS and which
// publishable key to use. Auth-off deployments get `{auth_enabled: false}` and
// render no sign-in chrome.
app.get('/api/config', (req, res) => {
  const provider = authAdapter.provider;
  res.json({
    auth_enabled: provider !== 'none',
    provider,
    publishable_key: authAdapter.publishableKey?.() ?? null,
    // The frontend needs the internal user UUID (not Clerk's user_xxx id)
    // to partition the sidebar by `graph.owner_user_id`. Exposed only when
    // the request resolved to a signed-in user; null otherwise.
    viewer_user_id: req.user?.id ?? null,
  });
});

// Server-sent events for live graph updates. Pushes one event per task/edge
// mutation, payload `{ graph_id, kind, op }`. Browser subscribes via
// EventSource and refetches the graph on each event. canRead-gated so that
// auth-on instances don't leak private graph traffic to anonymous viewers.
app.get('/api/graphs/:gid/events', requireGraph('read'), (req, res) => {
  const { gid } = req.params;
  // Cap concurrent SSE connections to stay below the process fd ceiling.
  // Browsers using EventSource will retry automatically after Retry-After.
  if (!tryReserveSlot()) {
    res.set('Retry-After', '10').status(503).json({ error: 'too many concurrent viewers; please retry' });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(`: connected\n\n`);
  subscribe(gid, res);
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch {}
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe(gid, res);
    releaseSlot();
    try { res.end(); } catch {}
  });
});

// :gid is an opaque short string; no format validation here. A bad id just
// won't match any row and the guard returns 404. Each sub-router carries the
// guard that matches its access shape: tasks/edges use the method-pick
// (GET=read, write=edit); the graph view + presence are read-only surfaces;
// the graphs router applies per-route guards internally because PATCH/DELETE
// require `manage`, not `edit`.
app.use('/api/graphs', graphsRouter);
app.use('/api/graphs/:gid/tasks', requireGraphForMethod, tasksRouter);
app.use('/api/graphs/:gid/edges', requireGraphForMethod, edgesRouter);
// Batch upsert (E14.1): nodes + edges in one transactional, idempotent call for
// dynamic-workflow write-back. A write surface, so method-pick guard (edit).
app.use('/api/graphs/:gid/batch', requireGraphForMethod, batchRouter);
app.use('/api/graphs/:gid/graph', requireGraph('read'), graphViewRouter);
// Search reads the graph's nodes and never mutates, so it's read-scoped even
// though it's a POST (the query rides in the body). A viewer can search.
app.use('/api/graphs/:gid/search', requireGraph('read'), searchRouter);
// Cross-graph search has no :gid to guard — it derives its own scope (owned +
// member graphs) from req.user inside the handler, and 401s anonymous callers.
app.use('/api/search', searchAllRouter);
// Cross-graph report rail (E16.5): like the graph LIST, it derives its own
// scope (owned + member graphs that have a report) from req.user and returns []
// for anonymous callers — no :gid to guard, and no 401 (an anon viewer simply
// owns nothing, exactly as the sidebar shows them).
app.use('/api/reports', reportsAllRouter);
// Context-pack (#457/E13): one-call k-hop neighborhood WITH bodies. Reads the
// graph + reuses the pooled search model; read-scoped like /search even though
// it's a POST (the query/seeds ride in the body).
app.use('/api/graphs/:gid/context', requireGraph('read'), contextRouter);
app.use('/api/graphs/:gid/frontier', requireGraph('read'), frontierRouter);
app.use('/api/graphs/:gid/decisions/at-risk', requireGraph('read'), decisionsAtRiskRouter);
app.use('/api/graphs/:gid/inconsistencies', requireGraph('read'), inconsistencyRouter);
app.use('/api/graphs/:gid/structure', requireGraph('read'), structureRouter);
app.use('/api/graphs/:gid/presence', requireGraph('read'), presenceRouter);
app.use('/api/graphs/:gid/selection', requireGraph('read'), selectionRouter);
app.use('/api/graphs/:gid/prefs', requireGraph('read'), graphPrefsRouter);
app.use('/api/graphs/:gid/uploads', requireGraphForMethod, uploadsRouter);
// The graph's human-readable report (E16). A write surface (GET=read report,
// PUT=upsert report), so the method-pick guard: a viewer/anon reads, an editor
// writes. The report lives outside tasks/edges, so this never mutates the graph.
app.use('/api/graphs/:gid/report', requireGraphForMethod, reportsRouter);
app.use('/api/graphs/:gid/members', membersRouter);
app.use('/api/me', meRouter);

startSse();
presence.startReaper();
presence.startActiveSweep();
presence.onChange((graphId, op, writer) => {
  broadcastPresence(graphId, { graph_id: graphId, kind: 'presence', op, writer });
  // When a writer leaves (Stop hook DELETE, sendBeacon on unload, idle reaper),
  // wipe their selection state so peers' colored outlines and cursor labels
  // disappear in the same SSE round-trip rather than lingering.
  if (op === 'depart') selectionState.clearSelection(graphId, writer.id);
});

// Fan out per-writer selection changes. The frame shape rides on
// broadcastPresence (it's a generic per-graph SSE channel; clients route
// by `kind`). Payload from selectionState includes writer_id + the
// node_ids/edge_ids/editing/cursor_anchor snapshot.
selectionState.onChange((graphId, op, payload) => {
  broadcastPresence(graphId, { graph_id: graphId, kind: 'selection', op, ...payload });
});

// Single-node permalink (/g/:gid/n/:id) — a standalone reading page, NOT the
// SPA. It renders one node's markdown off a single API read instead of booting
// cytoscape + the editor bundle + SSE to show you one node, which is what the
// reader's citation click-throughs target. Must sit above the SPA fallback
// below, which would otherwise hand this path index.html. Access control is
// unchanged: the page is a shell, and the /api reads it makes are gated exactly
// as before (a viewer with no access gets a 403 and the page says so).
app.get('/g/:gid/n/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'node.html'));
});

// SPA fallback: client-side routes like /g/:gid only exist in the frontend.
// On a fresh page load (paste URL, refresh, bookmark) the browser does a real
// GET and would otherwise 404. Serve index.html instead so the JS can read
// the URL and resolve the active graph. Only triggers for HTML navigations
// — asset requests (which advertise Accept: */* or specific MIME types) fall
// through to a normal 404 so a missing /style.css doesn't silently get HTML.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/')) return next();
  const accept = req.headers.accept || '';
  if (!accept.includes('text/html')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

export default app;
