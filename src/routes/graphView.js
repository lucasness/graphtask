import { Router } from 'express';
import pool from '../db.js';

const router = Router({ mergeParams: true });

router.get('/shortest-path', async (req, res) => {
  const { gid } = req.params;
  const from = parseInt(req.query.from);
  const to = parseInt(req.query.to);

  if (!from || !to || isNaN(from) || isNaN(to))
    return res.status(400).json({ error: 'from and to must be valid integers' });

  // pgr_dijkstra takes a SQL string. Build it at execution time with format()
  // so we can scope to this graph_id without injection risk (%L quotes literals).
  const result = await pool.query(
    `SELECT seq, node, edge, cost, agg_cost FROM pgr_dijkstra(
       format(
         'SELECT e.id, e.source_id AS source, e.target_id AS target,
                 1.0::float AS cost
          FROM edges e
          WHERE e.type = %L AND e.graph_id = %L',
         'dependency', $3::text
       ),
       $1::bigint, $2::bigint, directed => false
     )`,
    [from, to, gid]
  );

  if (result.rows.length === 0) {
    return res.json({ path: [], cost: null, tasks: [] });
  }

  const path = result.rows.map((r) => Number(r.node));
  const totalCost = result.rows[result.rows.length - 1].agg_cost;

  const tasks = await pool.query(
    `SELECT id, meta->>'title' AS title, meta->>'status' AS status
     FROM tasks WHERE id = ANY($1) AND graph_id = $2 ORDER BY array_position($1, id)`,
    [path, gid]
  );

  res.json({ path, cost: totalCost, tasks: tasks.rows });
});

router.get('/', async (req, res) => {
  const { gid } = req.params;
  const nodes = await pool.query(
    `SELECT id, meta->>'title' AS title, meta->>'description' AS description,
            meta->>'status' AS status, meta
     FROM tasks WHERE graph_id = $1 ORDER BY id`,
    [gid]
  );
  const links = await pool.query(
    `SELECT id, source_id AS source, target_id AS target, type, meta
     FROM edges WHERE graph_id = $1 ORDER BY id`,
    [gid]
  );
  res.json({ nodes: nodes.rows, links: links.rows });
});

export default router;
