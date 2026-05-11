import { Router } from 'express';
import pool from '../db.js';
import { mergeFields, flattenJsonb, unflattenJsonb } from '../merge.js';

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
        'INSERT INTO graphs (name, description, last_modified_by) VALUES ($1, $2, $3) RETURNING *',
        [name.trim(), description ?? null, req.writerType]
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
  const { name, description, is_public, settings, base_version, base_row } = req.body;

  // Caller has to ask for at least one field change. base_row / base_version
  // don't count — they describe intent for the merge, not the write itself.
  if (
    name === undefined &&
    description === undefined &&
    is_public === undefined &&
    settings === undefined
  ) {
    return res.status(400).json({ error: 'nothing to update' });
  }

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

  const curRes = await pool.query('SELECT * FROM graphs WHERE id = $1', [req.params.id]);
  if (curRes.rows.length === 0) return res.status(410).json({ error: 'graph no longer exists' });
  const existing = curRes.rows[0];

  // Build the writer's intended full row from their base view + partial
  // changes. Settings is a shallow merge so writers can patch individual
  // appearance keys without overwriting the rest; explicit `null` clears
  // a key back to the app default.
  const base = base_row || existing;
  let writerSettings = { ...(base.settings || {}) };
  if (settings !== undefined) {
    for (const [k, v] of Object.entries(settings)) {
      if (v === null) delete writerSettings[k];
      else writerSettings[k] = v;
    }
  }
  const writerRow = {
    name: name !== undefined ? name.trim() : base.name,
    description: description !== undefined ? description : base.description,
    is_public: is_public !== undefined ? is_public : base.is_public,
    settings: writerSettings,
  };

  // Three-way merge fires only when the client opted in (base_row +
  // base_version) AND a concurrent write happened. Otherwise the writer's
  // row is the final row (backward compat for older clients).
  let finalRow;
  if (base_row && base_version !== undefined && base_version !== existing.version) {
    const { merged } = mergeFields(
      flattenJsonb(base, 'settings'),
      flattenJsonb(writerRow, 'settings'),
      flattenJsonb(existing, 'settings'),
      req.writerType,
      existing.last_modified_by,
    );
    const unflat = unflattenJsonb(merged, 'settings');
    finalRow = {
      name: unflat.name,
      description: unflat.description,
      is_public: unflat.is_public,
      settings: unflat.settings || {},
    };
  } else {
    finalRow = writerRow;
  }

  const result = await pool.query(
    `UPDATE graphs
        SET name = $1,
            description = $2,
            is_public = $3,
            settings = $4::jsonb,
            version = version + 1,
            last_modified_by = $5,
            updated_at = NOW()
      WHERE id = $6
    RETURNING *`,
    [
      finalRow.name,
      finalRow.description,
      finalRow.is_public,
      JSON.stringify(finalRow.settings || {}),
      req.writerType,
      req.params.id,
    ],
  );
  if (result.rows.length === 0) return res.status(410).json({ error: 'graph no longer exists' });
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
