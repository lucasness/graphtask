import { Router } from 'express';
import pool from '../db.js';
import { parseMarkdown, serializeMarkdown, validateMeta, applyDefaults } from '../markdown.js';
import { mergeFields } from '../merge.js';
import { requireIntegerParam } from './_validate.js';

// Tasks store frontmatter (meta) + body in a single markdown blob. To do
// field-level three-way merge, we flatten {meta, body} into one object.
// Using a non-conventional key for body to avoid colliding with any meta key.
const BODY_KEY = '__body__';
function flattenTask(meta, body) {
  return { ...meta, [BODY_KEY]: body };
}
function unflattenTask(flat) {
  const meta = { ...flat };
  const body = meta[BODY_KEY] || '';
  delete meta[BODY_KEY];
  return { meta, body };
}

// mergeParams so :gid from the parent mount is visible here.
const router = Router({ mergeParams: true });
const validateId = requireIntegerParam('id');

// ---- task CRUD ----

router.post('/', async (req, res) => {
  const { gid } = req.params;
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  const { meta: rawMeta, body, frontmatterError } = parseMarkdown(content);
  if (frontmatterError)
    return res.status(400).json({ error: `frontmatter is not valid YAML — quote any title containing a colon (${frontmatterError})` });
  const meta = applyDefaults(rawMeta);

  const err = validateMeta(meta);
  if (err) return res.status(400).json({ error: err });

  const normalized = serializeMarkdown(meta, body);

  try {
    const result = await pool.query(
      `INSERT INTO tasks (graph_id, content, meta, last_modified_by, last_modified_by_user)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [gid, normalized, JSON.stringify(meta), req.writerType, req.user?.id ?? null]
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
  const { content, base_version, base_content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  const writerParsed = parseMarkdown(content);
  if (writerParsed.frontmatterError)
    return res.status(400).json({ error: `frontmatter is not valid YAML — quote any title containing a colon (${writerParsed.frontmatterError})` });
  const writerMeta = applyDefaults(writerParsed.meta);
  const writerBody = writerParsed.body;
  const validationErr = validateMeta(writerMeta);
  if (validationErr) return res.status(400).json({ error: validationErr });

  const currentRes = await pool.query(
    `SELECT t.*, g.owner_user_id AS graph_owner_user_id
       FROM tasks t
       JOIN graphs g ON g.id = t.graph_id
      WHERE t.id = $1 AND t.graph_id = $2`,
    [id, gid]
  );
  if (currentRes.rows.length === 0) {
    return res.status(410).json({ error: 'task no longer exists' });
  }
  const cur = currentRes.rows[0];

  let mergedMeta = writerMeta;
  let mergedBody = writerBody;

  // Three-way merge whenever the client opts in by sending both base_version
  // and base_content — NOT only when a concurrent write is detected. The
  // protected-key preservation (UI-managed x/y/color/background-image and the
  // research fields significance/confidence/verified_at) must apply on EVERY
  // agent PATCH that rebuilds content from scratch, even with no contention:
  // an agent that omits those keys would otherwise blind-wipe them on the
  // common no-concurrent-write path. When base_version === cur.version (no
  // concurrent write) base equals current, so the merge degenerates to
  // "writer's edits win, omitted-protected keys kept" — the same result as a
  // plain replace except the protected keys survive. (batch.js already merges
  // unconditionally for this reason; this aligns the single-task PATCH.)
  // Without base fields, fall back to simple replace — backward compat for
  // clients that don't yet send the base.
  const hasBaseFields =
    base_version !== undefined &&
    base_content !== undefined;

  if (hasBaseFields) {
    const baseParsed = parseMarkdown(base_content);
    const baseMeta = applyDefaults(baseParsed.meta);
    const currentParsed = parseMarkdown(cur.content);
    const currentMeta = applyDefaults(currentParsed.meta);

    const { merged } = mergeFields(
      flattenTask(baseMeta, baseParsed.body),
      flattenTask(writerMeta, writerBody),
      flattenTask(currentMeta, currentParsed.body),
      {
        writerType: req.writerType,
        currentWriterType: cur.last_modified_by,
        writerOwnerId: req.user?.id ?? null,
        currentOwnerId: cur.last_modified_by_user ?? null,
        graphOwnerId: cur.graph_owner_user_id ?? null,
        // UI-managed frontmatter keys: the canvas writes these whenever a
        // user drags or recolors a node. Agents that rebuild content from
        // scratch typically don't include them, so without this list they'd
        // silently wipe user state on every PATCH. The three E15.A2 research
        // fields ride the same protection: a body-rewriting agent PATCH that
        // omits significance/confidence/verified_at must not wipe a value a
        // human or an earlier verify pass set (explicit null still clears).
        protectedFromAgentRemoval: [
          'x', 'y', 'color', 'background-image',
          'significance', 'confidence', 'verified_at',
        ],
      },
    );
    const out = unflattenTask(merged);
    const mergedErr = validateMeta(out.meta);
    if (mergedErr) {
      return res.status(409).json({
        error: 'version_conflict',
        detail: `merged result invalid: ${mergedErr}`,
        current: cur,
      });
    }
    mergedMeta = out.meta;
    mergedBody = out.body;
  }

  const normalized = serializeMarkdown(mergedMeta, mergedBody);
  const result = await pool.query(
    `UPDATE tasks
        SET content = $1,
            meta = $2,
            version = version + 1,
            last_modified_by = $3,
            last_modified_by_user = $4,
            updated_at = NOW()
      WHERE id = $5 AND graph_id = $6
    RETURNING *`,
    [normalized, JSON.stringify(mergedMeta), req.writerType, req.user?.id ?? null, id, gid]
  );
  if (result.rows.length === 0) {
    return res.status(410).json({ error: 'task no longer exists' });
  }
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
