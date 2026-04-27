import { Router } from 'express';
import pool from '../db.js';

const router = Router();

// Edge semantics: source_id → target_id means "source is prerequisite of target"
// Arrow direction = execution order

// Must be defined before /:id routes
// Leaves = tasks with no incoming dependency edges (no prerequisites, can start immediately)
router.get('/leaves', async (_req, res) => {
  const result = await pool.query(`
    SELECT t.* FROM tasks t
    WHERE NOT EXISTS (
      SELECT 1 FROM edges e
      WHERE e.target_id = t.id AND e.type = 'dependency'
    )
    ORDER BY t.id
  `);
  res.json(result.rows);
});

// Subtasks = all prerequisites (things that must be done before this task)
// Walk incoming dependency edges backward
router.get('/:id/subtasks', async (req, res) => {
  const { id } = req.params;
  const exists = await pool.query('SELECT 1 FROM tasks WHERE id = $1', [id]);
  if (exists.rows.length === 0) return res.status(404).json({ error: 'not found' });

  const result = await pool.query(
    `WITH RECURSIVE subtasks AS (
      SELECT source_id AS id FROM edges
      WHERE target_id = $1 AND type = 'dependency'
      UNION
      SELECT e.source_id FROM edges e
      JOIN subtasks s ON e.target_id = s.id
      WHERE e.type = 'dependency'
    )
    SELECT t.* FROM tasks t JOIN subtasks s ON t.id = s.id ORDER BY t.id`,
    [id]
  );
  res.json(result.rows);
});

// Ancestors = all dependents (things that depend on this task being done)
// Walk outgoing dependency edges forward
router.get('/:id/ancestors', async (req, res) => {
  const { id } = req.params;
  const exists = await pool.query('SELECT 1 FROM tasks WHERE id = $1', [id]);
  if (exists.rows.length === 0) return res.status(404).json({ error: 'not found' });

  const result = await pool.query(
    `WITH RECURSIVE ancestors AS (
      SELECT target_id AS id FROM edges
      WHERE source_id = $1 AND type = 'dependency'
      UNION
      SELECT e.target_id FROM edges e
      JOIN ancestors a ON e.source_id = a.id
      WHERE e.type = 'dependency'
    )
    SELECT t.* FROM tasks t JOIN ancestors a ON t.id = a.id ORDER BY t.id`,
    [id]
  );
  res.json(result.rows);
});

export default router;
