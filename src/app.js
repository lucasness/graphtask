import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import graphsRouter from './routes/graphs.js';
import tasksRouter from './routes/tasks.js';
import edgesRouter from './routes/edges.js';
import graphViewRouter from './routes/graphView.js';
import presenceRouter from './routes/presence.js';
import membersRouter from './routes/members.js';
import meRouter from './routes/me.js';
import { startSse, subscribe, unsubscribe, tryReserveSlot, releaseSlot, broadcastPresence } from './sse.js';
import { writerType } from './writerType.js';
import { getAdapter } from './auth/index.js';
import { verifyAuth } from './auth/middleware.js';
import { requireGraph, requireGraphForMethod } from './auth/require.js';
import * as presence from './presence.js';

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
app.use('/api/graphs/:gid/graph', requireGraph('read'), graphViewRouter);
app.use('/api/graphs/:gid/presence', requireGraph('read'), presenceRouter);
app.use('/api/graphs/:gid/members', membersRouter);
app.use('/api/me', meRouter);

startSse();
presence.startReaper();
presence.startActiveSweep();
presence.onChange((graphId, op, writer) => {
  broadcastPresence(graphId, { graph_id: graphId, kind: 'presence', op, writer });
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
