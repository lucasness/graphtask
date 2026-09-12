// E18.1 — the event vocabulary and the JS mirror of the SQL classifiers.
//
// PURE MODULE. It imports nothing — no `pg`, no `db.js`, no express — for the
// same reason planRegions.js / signedCycles.js / edgePurpose.js do: the fold
// (E18.1 STEP 3) and the asOf reader have to be unit-testable with no database,
// and the classifier parity test (STEP 4) has to be able to hold this file and
// `gt_classify_node` / `gt_classify_edge` side by side.
//
// The DB is the authority at write time: the row triggers in db/schema.sql call
// the SQL classifiers and stamp `payload.kinds`. These functions exist so that
//   (a) a reader can re-derive kinds from a `changes` object without a round
//       trip, and
//   (b) the parity test fails loudly the moment the two implementations drift.
// Every function below is a line-for-line translation of its SQL counterpart;
// if you change one, change both, and the parity test will tell you if you did.

// The complete `kind` vocabulary, in the same order as the `events_kind_valid`
// CHECK in db/schema.sql. `kind` is TEXT + CHECK and never an enum precisely so
// E18.2/E18.4 can add a value with a one-block edit and no 55P04 boot risk.
export const EVENT_KINDS = Object.freeze([
  'node.created',
  'node.patched',
  'node.removed',
  'status.changed',
  'field.set',
  'claim.verified',
  'decision.made',
  'decision.reopened',
  'edge.added',
  'edge.removed',
  'edge.retyped',
  'edge.rewired',
  'edge.patched',
  'graph.id_rotated',
  'graph.deleted',
]);

// The meta keys `gt_classify_node` reads by name. Anything OUTSIDE this set
// that appears in `changes` also contributes `node.patched` — which is what
// makes a body rewrite, an `external_id` change or a brand-new meta key
// visible instead of silently classified as one of the named transitions.
export const NODE_SEMANTIC_KEYS = Object.freeze([
  'meta.decided_at',
  'meta.verified_at',
  'meta.status',
  'meta.confidence',
  'meta.significance',
]);

// Same idea for edges. `meta` is diffed under a `meta.` prefix, so a curve or
// colour tweak lands outside this set and reads as `edge.patched`.
export const EDGE_SEMANTIC_KEYS = Object.freeze([
  'source_id',
  'target_id',
  'purpose',
  'type',
]);

// `ch ? 'k'` in SQL is key EXISTENCE, not truthiness: a change to JSON null
// still counts. Object.prototype.hasOwnProperty is the exact equivalent.
function present(changes, key) {
  return !!changes && Object.prototype.hasOwnProperty.call(changes, key);
}

// `ch #>> '{k,to}' IS NOT NULL` in SQL. `#>>` yields SQL NULL for a missing
// path AND for a JSON null, and a text rendering for everything else — so
// `!= null` in JS (which catches both `null` and `undefined`) is exact.
// Note this is deliberately NOT a truthiness test: `to: ""` and `to: 0` are
// "set" on both sides.
function toIsSet(changes, key) {
  if (!present(changes, key)) return false;
  const entry = changes[key];
  if (entry === null || entry === undefined) return false;
  return entry.to !== null && entry.to !== undefined;
}

// `(ch - ARRAY[...]) <> '{}'::jsonb` — is anything left after removing the
// named keys?
function hasKeysOutside(changes, keys) {
  if (!changes) return false;
  for (const k of Object.keys(changes)) {
    if (!keys.includes(k)) return true;
  }
  return false;
}

// Mirror of gt_classify_node(ch jsonb) RETURNS text[].
//
// `changes` is the `payload.changes` object: `{ "<field>": {from, to}, ... }`,
// with meta keys prefixed `meta.`. Returns the kinds array in the SAME ORDER
// the SQL builds it — order is load-bearing, because `headline()` takes ks[0].
export function classifyNode(changes) {
  const ks = [];
  if (present(changes, 'meta.decided_at')) {
    ks.push(toIsSet(changes, 'meta.decided_at') ? 'decision.made' : 'decision.reopened');
  }
  if (toIsSet(changes, 'meta.verified_at')) ks.push('claim.verified');
  if (present(changes, 'meta.status')) ks.push('status.changed');
  if (present(changes, 'meta.confidence') || present(changes, 'meta.significance')) {
    ks.push('field.set');
  }
  if (ks.length === 0 || hasKeysOutside(changes, NODE_SEMANTIC_KEYS)) ks.push('node.patched');
  return ks;
}

// Mirror of gt_classify_edge(ch jsonb) RETURNS text[].
//
// `edge.rewired` is a kind of its own (not a flavour of `edge.patched`)
// because E18.4 worldlines need a rewire to close one validity interval and
// open another — the same reason `edge.retyped` is separate.
export function classifyEdge(changes) {
  const ks = [];
  if (present(changes, 'source_id') || present(changes, 'target_id')) ks.push('edge.rewired');
  if (present(changes, 'purpose') || present(changes, 'type')) ks.push('edge.retyped');
  if (ks.length === 0 || hasKeysOutside(changes, EDGE_SEMANTIC_KEYS)) ks.push('edge.patched');
  return ks;
}

// Mirror of gt_headline(ks text[]).
//
// A route may PROMOTE a mechanically-derived kind to the headline by setting
// `gt.intent`; it can never invent one. `gt.intent='decision.made'` on a
// status-only change is ignored, because the DB — not the caller — is the
// authority on what actually changed. In SQL a NULL intent makes
// `NULL = ANY(ks)` NULL, i.e. falsy, and the CASE falls through to ks[1]
// (1-based); this returns ks[0].
export function headline(kinds, intent = null) {
  const ks = Array.isArray(kinds) ? kinds : [];
  if (intent && ks.includes(intent)) return intent;
  return ks.length > 0 ? ks[0] : null;
}

// E18.2 hook, deliberately inert in v1.
//
// Every event already carries `payload.node_kind` (the node's `meta.type` at
// event time), so the decay question — "does a CLAIM about the world go stale,
// while an extracted MEASUREMENT does not?" — is answerable as a pure function
// over data E18.1 already captures, with no schema change and no new capture
// path. Returning `null` (not `false`) is the point: it means "E18.1 takes no
// position", so a caller can tell "not eligible" from "not yet decided".
export function isDecayEligible(_event, _nodeMeta) {
  return null;
}
