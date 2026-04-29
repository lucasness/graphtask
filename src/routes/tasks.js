import { Router } from 'express';
import pool from '../db.js';
import { parseMarkdown, serializeMarkdown, validateMeta, applyDefaults } from '../markdown.js';
import { requireIntegerParam } from './_validate.js';

// mergeParams so :gid from the parent mount is visible here.
const router = Router({ mergeParams: true });
const validateId = requireIntegerParam('id');

// ---- task CRUD ----

router.post('/', async (req, res) => {
  const { gid } = req.params;
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  const { meta: rawMeta, body } = parseMarkdown(content);
  const meta = applyDefaults(rawMeta);

  const err = validateMeta(meta);
  if (err) return res.status(400).json({ error: err });

  const normalized = serializeMarkdown(meta, body);

  try {
    const result = await pool.query(
      `INSERT INTO tasks (graph_id, content, meta) VALUES ($1, $2, $3) RETURNING *`,
      [gid, normalized, JSON.stringify(meta)]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    if (e.code === '23503') return res.status(404).json({ error: 'graph not found' });
    throw e;
  }
});

router.get('/', async (req, res) => {
  const { gid } = req.params;
  const result = await pool.query(
    'SELECT * FROM tasks WHERE graph_id = $1 ORDER BY created_at DESC',
    [gid]
  );
  res.json(result.rows);
});

// /leaves must come before /:id so the literal route wins
router.get('/leaves', async (req, res) => {
  const { gid } = req.params;
  const result = await pool.query(
    `SELECT t.* FROM tasks t
     WHERE t.graph_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM edges e
         WHERE e.target_id = t.id AND e.type = 'dependency'
       )
     ORDER BY t.id`,
    [gid]
  );
  res.json(result.rows);
});

// Tasks ready to start: status='todo' AND every recursive prerequisite is
// 'done'. Treats 'review' and 'in_progress' as not-yet-done — matches the
// agent convention where 'review' is "agent thinks it's finished, awaiting
// human confirmation."
router.get('/ready', async (req, res) => {
  const { gid } = req.params;
  const result = await pool.query(
    `WITH RECURSIVE prereqs AS (
       SELECT t.id AS root, e.source_id AS prereq
         FROM tasks t
         JOIN edges e ON e.target_id = t.id AND e.type = 'dependency'
        WHERE t.graph_id = $1
       UNION
       SELECT p.root, e.source_id
         FROM prereqs p
         JOIN edges e ON e.target_id = p.prereq AND e.type = 'dependency'
        WHERE e.graph_id = $1
     )
     SELECT t.* FROM tasks t
      WHERE t.graph_id = $1
        AND t.meta->>'status' = 'todo'
        AND NOT EXISTS (
          SELECT 1 FROM prereqs p
          JOIN tasks tp ON tp.id = p.prereq
          WHERE p.root = t.id AND tp.meta->>'status' <> 'done'
        )
      ORDER BY t.id`,
    [gid]
  );
  res.json(result.rows);
});

router.get('/:id', validateId, async (req, res) => {
  const { gid, id } = req.params;
  const result = await pool.query(
    'SELECT * FROM tasks WHERE id = $1 AND graph_id = $2',
    [id, gid]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json(result.rows[0]);
});

router.patch('/:id', validateId, async (req, res) => {
  const { gid, id } = req.params;
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  const { meta: rawMeta, body } = parseMarkdown(content);
  const meta = applyDefaults(rawMeta);

  const err = validateMeta(meta);
  if (err) return res.status(400).json({ error: err });

  const normalized = serializeMarkdown(meta, body);

  const result = await pool.query(
    `UPDATE tasks SET content = $1, meta = $2, updated_at = NOW()
     WHERE id = $3 AND graph_id = $4 RETURNING *`,
    [normalized, JSON.stringify(meta), id, gid]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json(result.rows[0]);
});

router.delete('/:id', validateId, async (req, res) => {
  const { gid, id } = req.params;
  const result = await pool.query(
    'DELETE FROM tasks WHERE id = $1 AND graph_id = $2 RETURNING id',
    [id, gid]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json({ deleted: result.rows[0].id });
});

// ---- graph traversal queries ----
// Edge semantics: source_id → target_id means "source is prerequisite of target".

// Subtasks = all prerequisites (things that must be done before this task)
router.get('/:id/subtasks', validateId, async (req, res) => {
  const { gid, id } = req.params;
  const exists = await pool.query(
    'SELECT 1 FROM tasks WHERE id = $1 AND graph_id = $2',
    [id, gid]
  );
  if (exists.rows.length === 0) return res.status(404).json({ error: 'not found' });

  const result = await pool.query(
    `WITH RECURSIVE subtasks AS (
      SELECT source_id AS id FROM edges
      WHERE target_id = $1 AND type = 'dependency' AND graph_id = $2
      UNION
      SELECT e.source_id FROM edges e
      JOIN subtasks s ON e.target_id = s.id
      WHERE e.type = 'dependency' AND e.graph_id = $2
    )
    SELECT t.* FROM tasks t JOIN subtasks s ON t.id = s.id ORDER BY t.id`,
    [id, gid]
  );
  res.json(result.rows);
});

// Blockers = recursive prerequisites that aren't 'done' yet. Use this to
// answer "what's stopping me from finishing X?" — returns both
// in_progress/review tasks (work in flight) and todo tasks (not started).
router.get('/:id/blockers', validateId, async (req, res) => {
  const { gid, id } = req.params;
  const exists = await pool.query(
    'SELECT 1 FROM tasks WHERE id = $1 AND graph_id = $2',
    [id, gid]
  );
  if (exists.rows.length === 0) return res.status(404).json({ error: 'not found' });

  const result = await pool.query(
    `WITH RECURSIVE chain AS (
      SELECT source_id AS id FROM edges
      WHERE target_id = $1 AND type = 'dependency' AND graph_id = $2
      UNION
      SELECT e.source_id FROM edges e
      JOIN chain c ON e.target_id = c.id
      WHERE e.type = 'dependency' AND e.graph_id = $2
    )
    SELECT t.* FROM tasks t
    JOIN chain c ON t.id = c.id
    WHERE t.meta->>'status' <> 'done'
    ORDER BY t.id`,
    [id, gid]
  );
  res.json(result.rows);
});

// Unblocks = direct parent tasks that would become ready-to-start if THIS
// task were marked 'done'. Single-level only (a parent only becomes ready
// the moment its last blocker finishes; transitive unblocking happens as
// each level resolves). Use this to answer "if I finish review of X, what
// opens up?"
router.get('/:id/unblocks', validateId, async (req, res) => {
  const { gid, id } = req.params;
  const exists = await pool.query(
    'SELECT 1 FROM tasks WHERE id = $1 AND graph_id = $2',
    [id, gid]
  );
  if (exists.rows.length === 0) return res.status(404).json({ error: 'not found' });

  const result = await pool.query(
    `SELECT t.* FROM tasks t
     JOIN edges parent_edge
       ON parent_edge.target_id = t.id
      AND parent_edge.source_id = $1
      AND parent_edge.type = 'dependency'
      AND parent_edge.graph_id = $2
     WHERE t.graph_id = $2
       AND t.meta->>'status' = 'todo'
       AND NOT EXISTS (
         SELECT 1 FROM edges other
         JOIN tasks other_task ON other_task.id = other.source_id
         WHERE other.target_id = t.id
           AND other.type = 'dependency'
           AND other.graph_id = $2
           AND other.source_id <> $1
           AND other_task.meta->>'status' <> 'done'
       )
     ORDER BY t.id`,
    [id, gid]
  );
  res.json(result.rows);
});

// Ancestors = all dependents (things that depend on this task being done)
router.get('/:id/ancestors', validateId, async (req, res) => {
  const { gid, id } = req.params;
  const exists = await pool.query(
    'SELECT 1 FROM tasks WHERE id = $1 AND graph_id = $2',
    [id, gid]
  );
  if (exists.rows.length === 0) return res.status(404).json({ error: 'not found' });

  const result = await pool.query(
    `WITH RECURSIVE ancestors AS (
      SELECT target_id AS id FROM edges
      WHERE source_id = $1 AND type = 'dependency' AND graph_id = $2
      UNION
      SELECT e.target_id FROM edges e
      JOIN ancestors a ON e.source_id = a.id
      WHERE e.type = 'dependency' AND e.graph_id = $2
    )
    SELECT t.* FROM tasks t JOIN ancestors a ON t.id = a.id ORDER BY t.id`,
    [id, gid]
  );
  res.json(result.rows);
});

export default router;
