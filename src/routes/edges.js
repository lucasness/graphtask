import { Router } from 'express';
import pool from '../db.js';

const router = Router();
const VALID_TYPES = ['dependency', 'related'];
const MAX_CURVE = 500;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

function normalizeMeta(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'meta must be an object' };
  }
  const meta = {};
  if (raw.curve !== undefined && raw.curve !== null && raw.curve !== '') {
    const curve = Number(raw.curve);
    if (!Number.isFinite(curve) || Math.abs(curve) > MAX_CURVE) {
      return { error: `curve must be a number between -${MAX_CURVE} and ${MAX_CURVE}` };
    }
    meta.curve = Math.round(curve * 100) / 100;
  }
  if (raw.color !== undefined && raw.color !== null && raw.color !== '') {
    const color = String(raw.color).trim();
    if (!HEX_COLOR.test(color)) {
      return { error: 'color must be a 6-digit hex value' };
    }
    meta.color = color;
  }
  return { meta };
}

router.post('/', async (req, res) => {
  const { source_id, target_id, type } = req.body;
  const normalizedMeta = normalizeMeta(req.body.meta || {});
  if (normalizedMeta.error) return res.status(400).json({ error: normalizedMeta.error });

  if (!source_id) return res.status(400).json({ error: 'source_id is required' });
  if (!target_id) return res.status(400).json({ error: 'target_id is required' });
  if (!type || !VALID_TYPES.includes(type))
    return res.status(400).json({ error: 'type must be dependency or related' });
  if (source_id === target_id)
    return res.status(400).json({ error: 'source and target must be different' });

  // Cycle detection for dependency edges
  if (type === 'dependency') {
    const cycle = await pool.query(
      `WITH RECURSIVE chain AS (
        SELECT target_id AS node FROM edges
        WHERE source_id = $1 AND type = 'dependency'
        UNION
        SELECT e.target_id FROM edges e
        JOIN chain c ON e.source_id = c.node
        WHERE e.type = 'dependency'
      )
      SELECT 1 FROM chain WHERE node = $2 LIMIT 1`,
      [target_id, source_id]
    );
    if (cycle.rows.length > 0)
      return res.status(400).json({ error: 'adding this edge would create a cycle' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO edges (source_id, target_id, type, meta)
       VALUES ($1, $2, $3::edge_type, $4) RETURNING *`,
      [source_id, target_id, type, JSON.stringify(normalizedMeta.meta)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'edge already exists' });
    if (err.code === '23503') return res.status(400).json({ error: 'referenced task does not exist' });
    if (err.code === '23514') return res.status(400).json({ error: 'invalid edge' });
    throw err;
  }
});

router.get('/', async (_req, res) => {
  const result = await pool.query('SELECT * FROM edges ORDER BY created_at DESC');
  res.json(result.rows);
});

router.patch('/:id', async (req, res) => {
  const { source_id, target_id, type } = req.body;
  const id = req.params.id;

  if (type !== undefined && !VALID_TYPES.includes(type))
    return res.status(400).json({ error: 'type must be dependency or related' });

  const current = await pool.query('SELECT * FROM edges WHERE id = $1', [id]);
  if (current.rows.length === 0) return res.status(404).json({ error: 'not found' });
  const existing = current.rows[0];

  const newSource = source_id !== undefined ? source_id : existing.source_id;
  const newTarget = target_id !== undefined ? target_id : existing.target_id;
  const newType = type !== undefined ? type : existing.type;
  let newMeta = existing.meta || {};
  if (req.body.meta !== undefined) {
    const normalizedMeta = normalizeMeta(req.body.meta);
    if (normalizedMeta.error) return res.status(400).json({ error: normalizedMeta.error });
    newMeta = { ...newMeta, ...normalizedMeta.meta };
    if (req.body.meta.curve === null) delete newMeta.curve;
    if (req.body.meta.color === null) delete newMeta.color;
  }

  if (newSource === newTarget)
    return res.status(400).json({ error: 'source and target must be different' });

  // Cycle detection for dependency edges, excluding this edge from the graph
  if (newType === 'dependency') {
    const cycle = await pool.query(
      `WITH RECURSIVE chain AS (
        SELECT target_id AS node FROM edges
        WHERE source_id = $1 AND type = 'dependency' AND id <> $3
        UNION
        SELECT e.target_id FROM edges e
        JOIN chain c ON e.source_id = c.node
        WHERE e.type = 'dependency' AND e.id <> $3
      )
      SELECT 1 FROM chain WHERE node = $2 LIMIT 1`,
      [newTarget, newSource, id]
    );
    if (cycle.rows.length > 0)
      return res.status(400).json({ error: 'change would create a cycle' });
  }

  try {
    const result = await pool.query(
      `UPDATE edges SET source_id = $1, target_id = $2, type = $3::edge_type, meta = $4
       WHERE id = $5 RETURNING *`,
      [newSource, newTarget, newType, JSON.stringify(newMeta), id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'edge already exists between these nodes' });
    if (err.code === '23503') return res.status(400).json({ error: 'referenced task does not exist' });
    if (err.code === '23514') return res.status(400).json({ error: 'invalid edge' });
    throw err;
  }
});

router.delete('/:id', async (req, res) => {
  const result = await pool.query('DELETE FROM edges WHERE id = $1 RETURNING id', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json({ deleted: result.rows[0].id });
});

export default router;
