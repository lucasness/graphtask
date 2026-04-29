import { Router } from 'express';
import pool from '../db.js';

const router = Router();

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const NAME_UNIQUE_INDEX = 'graphs_name_norm_uniq';
const NAME_CONFLICT_MSG = 'a graph with this name already exists';

function isNameConflict(err) {
  return err.code === '23505' && err.constraint === NAME_UNIQUE_INDEX;
}

function validateName(name) {
  if (typeof name !== 'string') return 'name is required';
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'name is required';
  if (name.length > NAME_MAX) return `name must be ${NAME_MAX} characters or less`;
  return null;
}

function validateDescription(description) {
  if (description === undefined || description === null) return null;
  if (typeof description !== 'string') return 'description must be a string';
  if (description.length > DESCRIPTION_MAX)
    return `description must be ${DESCRIPTION_MAX} characters or less`;
  return null;
}

router.get('/', async (_req, res) => {
  const result = await pool.query(
    'SELECT * FROM graphs ORDER BY updated_at DESC, id DESC'
  );
  res.json(result.rows);
});

router.post('/', async (req, res) => {
  const { name, description } = req.body;
  const nameErr = validateName(name);
  if (nameErr) return res.status(400).json({ error: nameErr });
  const descErr = validateDescription(description);
  if (descErr) return res.status(400).json({ error: descErr });

  // graphs.id has a Postgres DEFAULT that generates a random string. On the
  // negligible chance of an id collision, retry with a fresh DEFAULT. A name
  // collision is a user error and surfaces as 409.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await pool.query(
        'INSERT INTO graphs (name, description) VALUES ($1, $2) RETURNING *',
        [name.trim(), description ?? null]
      );
      return res.status(201).json(result.rows[0]);
    } catch (err) {
      if (isNameConflict(err)) return res.status(409).json({ error: NAME_CONFLICT_MSG });
      if (err.code !== '23505') throw err; // unique_violation on id — retry
    }
  }
  res.status(500).json({ error: 'failed to allocate graph id' });
});

router.get('/:id', async (req, res) => {
  const result = await pool.query('SELECT * FROM graphs WHERE id = $1', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json(result.rows[0]);
});

router.patch('/:id', async (req, res) => {
  const { name, description } = req.body;

  if (name !== undefined) {
    const err = validateName(name);
    if (err) return res.status(400).json({ error: err });
  }
  if (description !== undefined) {
    const err = validateDescription(description);
    if (err) return res.status(400).json({ error: err });
  }

  const sets = [];
  const params = [];
  if (name !== undefined) {
    params.push(name.trim());
    sets.push(`name = $${params.length}`);
  }
  if (description !== undefined) {
    params.push(description);
    sets.push(`description = $${params.length}`);
  }
  if (sets.length === 0) {
    return res.status(400).json({ error: 'nothing to update' });
  }
  sets.push('updated_at = NOW()');
  params.push(req.params.id);

  let result;
  try {
    result = await pool.query(
      `UPDATE graphs SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
  } catch (err) {
    if (isNameConflict(err)) return res.status(409).json({ error: NAME_CONFLICT_MSG });
    throw err;
  }
  if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json(result.rows[0]);
});

router.delete('/:id', async (req, res) => {
  const result = await pool.query(
    'DELETE FROM graphs WHERE id = $1 RETURNING id',
    [req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json({ deleted: result.rows[0].id });
});

// Rotate a graph's ID. The URL is the bearer token in the no-auth privacy
// model — rotating invalidates any previously shared link. ON UPDATE CASCADE
// on tasks/edges FKs propagates the new id automatically.
router.post('/:id/rotate-id', async (req, res) => {
  const oldId = req.params.id;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await pool.query(
        `UPDATE graphs
            SET id = generate_short_graph_id(), updated_at = NOW()
          WHERE id = $1
        RETURNING *`,
        [oldId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
      return res.json(result.rows[0]);
    } catch (err) {
      if (err.code !== '23505') throw err; // unique_violation — retry
    }
  }
  res.status(500).json({ error: 'failed to allocate graph id' });
});

export default router;
