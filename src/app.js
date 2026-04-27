import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import graphTasksRouter from './routes/graph.js';
import tasksRouter from './routes/tasks.js';
import edgesRouter from './routes/edges.js';
import graphApiRouter from './routes/graphApi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
// graph task routes first so /leaves is matched before /:id
app.use('/api/tasks', graphTasksRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/edges', edgesRouter);
app.use('/api/graph', graphApiRouter);

export default app;
