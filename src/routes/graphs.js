import { Router } from 'express';
import pool from '../db.js';

const router = Router();

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const ALLOWED_SETTINGS_KEYS = ['font', 'font_color', 'bg_color'];
const ALLOWED_FONT_IDS = ['inter', 'garamond', 'roboto'];
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

// Validate a partial settings patch. Each key must be in ALLOWED_SETTINGS_KEYS;
// null clears the key (server merges and strips nulls). Returns an error
// string or null if valid.
function validateSettings(settings) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return 'settings must be an object';
  }
  for (const k of Object.keys(settings)) {
    if (!ALLOWED_SETTINGS_KEYS.includes(k)) return `unknown settings key: ${k}`;
    const v = settings[k];
    if (v === null) continue; // null clears the key
    if (k === 'font') {
      if (typeof v !== 'string' || !ALLOWED_FONT_IDS.includes(v)) {
        return `font must be one of: ${ALLOWED_FONT_IDS.join(', ')}`;
      }
    } else {
      // font_color / bg_color
      if (typeof v !== 'string' || !HEX_COLOR_RE.test(v)) {
        return `${k} must be a 6-digit hex color`;
      }
    }
  }
  return null;
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

// Home-page list: only public graphs. Private graphs are reachable by URL but
// must not be enumerable — that's the privacy model.
router.get('/', async (_req, res) => {
  const result = await pool.query(
    'SELECT * FROM graphs WHERE is_public = TRUE ORDER BY updated_at DESC, id DESC'
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
  // negligible chance of an id collision, retry with a fresh DEFAULT. New
  // graphs default to is_public=false at the schema level.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await pool.query(
        'INSERT INTO graphs (name, description) VALUES ($1, $2) RETURNING *',
        [name.trim(), description ?? null]
      );
      return res.status(201).json(result.rows[0]);
    } catch (err) {
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
  const { name, description, is_public, settings } = req.body;

  if (name !== undefined) {
    const err = validateName(name);
    if (err) return res.status(400).json({ error: err });
  }
  if (description !== undefined) {
    const err = validateDescription(description);
    if (err) return res.status(400).json({ error: err });
  }
  if (is_public !== undefined && typeof is_public !== 'boolean') {
    return res.status(400).json({ error: 'is_public must be a boolean' });
  }
  if (settings !== undefined) {
    const err = validateSettings(settings);
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
  if (is_public !== undefined) {
    params.push(is_public);
    sets.push(`is_public = $${params.length}`);
  }
  if (settings !== undefined) {
    // Merge with existing settings; jsonb_strip_nulls drops keys whose
    // patch value was null, which is the "revert to app default" signal.
    params.push(JSON.stringify(settings));
    sets.push(`settings = jsonb_strip_nulls(settings || $${params.length}::jsonb)`);
  }
  if (sets.length === 0) {
    return res.status(400).json({ error: 'nothing to update' });
  }
  sets.push('updated_at = NOW()');
  params.push(req.params.id);

  const result = await pool.query(
    `UPDATE graphs SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
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
