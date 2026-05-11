// Three-way merge for optimistic concurrency. Operates on flat objects:
// each key is a "field" with its own conflict resolution. Resource routes
// (tasks, edges, graphs) are responsible for flattening their domain shape
// into and out of this representation — see `docs/optimistic-concurrency.md`.
//
// Policy:
//   - Field changed only by the new writer → writer's value wins.
//   - Field changed only by the other (already in `current`) → current value kept.
//   - Both writers changed the same field:
//       human writer + agent already-applied → human wins.
//       agent writer + human already-applied → human is preserved (current kept).
//       same kind on both sides → writer wins (last-write-wins per field).

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Promote one level of a nested column (a JSONB like `meta` or `settings`)
// into top-level keys of the form `<column>.<subkey>`. Lets mergeFields treat
// two writers touching different keys inside the same JSONB as disjoint
// edits, instead of seeing the JSONB as one same-field collision.
export function flattenJsonb(row, columnName) {
  const flat = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (k === columnName) continue;
    flat[k] = v;
  }
  const nested = (row && row[columnName]) || {};
  for (const [k, v] of Object.entries(nested)) {
    flat[`${columnName}.${k}`] = v;
  }
  return flat;
}

export function unflattenJsonb(flat, columnName) {
  const out = {};
  const nested = {};
  const prefix = `${columnName}.`;
  for (const [k, v] of Object.entries(flat || {})) {
    if (k.startsWith(prefix)) {
      nested[k.slice(prefix.length)] = v;
    } else {
      out[k] = v;
    }
  }
  out[columnName] = nested;
  return out;
}

export function mergeFields(base, writerEdit, current, writerType, currentWriterType) {
  const merged = { ...current };
  const conflicts = [];

  const allKeys = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(writerEdit || {}),
    ...Object.keys(current || {}),
  ]);

  for (const k of allKeys) {
    const b = base?.[k];
    const w = writerEdit?.[k];
    const c = current?.[k];

    const writerChanged = !deepEqual(b, w);
    const otherChanged = !deepEqual(b, c);

    if (!writerChanged) {
      // Writer didn't touch this field — preserve current.
      merged[k] = c;
    } else if (!otherChanged) {
      // Only writer changed it — apply writer's value.
      merged[k] = w;
    } else if (deepEqual(w, c)) {
      // Both ended up at the same value — no real conflict.
      merged[k] = w;
    } else {
      // True same-field conflict.
      conflicts.push(k);
      if (writerType === 'human' && currentWriterType === 'agent') {
        merged[k] = w;
      } else if (writerType === 'agent' && currentWriterType === 'human') {
        merged[k] = c;
      } else {
        merged[k] = w;
      }
    }
  }

  return { merged, conflicts };
}
