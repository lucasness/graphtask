import YAML from 'yaml';

const FENCE = '---';

export function parseMarkdown(text) {
  if (!text || !text.startsWith(FENCE + '\n')) {
    return { meta: {}, body: text || '', frontmatterError: null };
  }

  const end = text.indexOf('\n' + FENCE, FENCE.length);
  if (end === -1) {
    return { meta: {}, body: text, frontmatterError: null };
  }

  const yamlStr = text.slice(FENCE.length + 1, end);
  const body = text.slice(end + FENCE.length + 2); // skip \n---\n

  // `frontmatterError` distinguishes "the YAML failed to parse" (e.g. an
  // unquoted colon in a title) from "valid YAML that simply has no title".
  // Without it both collapse to the misleading "title is required" — callers
  // can surface the real cause instead.
  let meta;
  let frontmatterError = null;
  try {
    meta = YAML.parse(yamlStr) || {};
  } catch (e) {
    meta = {};
    frontmatterError = e.message;
  }

  return { meta, body, frontmatterError };
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

const VALID_STATUSES = ['todo', 'in_progress', 'review', 'done'];

export function validateMeta(meta) {
  if (!meta.title || typeof meta.title !== 'string' || meta.title.trim() === '') {
    return 'title is required';
  }
  if (typeof meta.title === 'string' && meta.title.length > 100) {
    return 'title must be 100 characters or less';
  }
  if (meta.description !== undefined && typeof meta.description === 'string' && meta.description.length > 200) {
    return 'description must be 200 characters or less';
  }
  if (meta.status && !VALID_STATUSES.includes(meta.status)) {
    return 'status must be todo, in_progress, review, or done';
  }
  // background-image is an optional URL string. Capped at 500 chars so the
  // frontmatter stays scannable — the bytes themselves live in the uploads
  // table, not in this string.
  const bg = meta['background-image'];
  if (bg !== undefined && bg !== null && bg !== '') {
    if (typeof bg !== 'string') {
      return 'background-image must be a string';
    }
    if (bg.length > 500) {
      return 'background-image must be 500 characters or less';
    }
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
  if (result['background-image'] !== undefined && result['background-image'] !== null) {
    result['background-image'] = String(result['background-image']);
  }
  result.status = result.status || 'todo';
  return result;
}
