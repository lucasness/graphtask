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

export default app;
