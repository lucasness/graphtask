import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import graphsRouter from './routes/graphs.js';
import tasksRouter from './routes/tasks.js';
import edgesRouter from './routes/edges.js';
import graphViewRouter from './routes/graphView.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// :gid is an opaque short string; no format validation here. A bad id just
// won't match any row and the route handlers will return 404.
app.use('/api/graphs', graphsRouter);
app.use('/api/graphs/:gid/tasks', tasksRouter);
app.use('/api/graphs/:gid/edges', edgesRouter);
app.use('/api/graphs/:gid/graph', graphViewRouter);

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
