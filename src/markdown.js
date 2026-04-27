import YAML from 'yaml';

const FENCE = '---';

export function parseMarkdown(text) {
  if (!text || !text.startsWith(FENCE + '\n')) {
    return { meta: {}, body: text || '' };
  }

  const end = text.indexOf('\n' + FENCE, FENCE.length);
  if (end === -1) {
    return { meta: {}, body: text };
  }

  const yamlStr = text.slice(FENCE.length + 1, end);
  const body = text.slice(end + FENCE.length + 2); // skip \n---\n

  let meta;
  try {
    meta = YAML.parse(yamlStr) || {};
  } catch {
    meta = {};
  }

  return { meta, body };
}

export function serializeMarkdown(meta, body) {
  const yamlStr = YAML.stringify(meta).trimEnd();
  const parts = [FENCE, yamlStr, FENCE];
  if (body) {
    parts.push(body);
  } else {
    parts.push('');
  }
  return parts.join('\n');
}

const VALID_STATUSES = ['todo', 'in_progress', 'done'];

export function validateMeta(meta) {
  if (!meta.title || typeof meta.title !== 'string' || meta.title.trim() === '') {
    return 'title is required';
  }
  if (typeof meta.title === 'string' && meta.title.length > 50) {
    return 'title must be 50 characters or less';
  }
  if (meta.description !== undefined && typeof meta.description === 'string' && meta.description.length > 150) {
    return 'description must be 150 characters or less';
  }
  if (meta.status && !VALID_STATUSES.includes(meta.status)) {
    return 'status must be todo, in_progress, or done';
  }
  return null;
}

export function applyDefaults(meta) {
  const result = { ...meta };
  // YAML parses unquoted scalars by type (e.g. "1" → number, "2026-04-26" →
  // Date). User-facing text fields must be strings for validation and storage.
  if (result.title !== undefined && result.title !== null) {
    result.title = String(result.title);
  }
  if (result.description !== undefined && result.description !== null) {
    result.description = String(result.description);
  }
  result.status = result.status || 'todo';
  return result;
}
