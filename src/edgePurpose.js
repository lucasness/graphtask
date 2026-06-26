// E15.A1 — pure edge `purpose` derivation. Kept dependency-free (no db, no
// express) so it's trivially unit-testable and importable without spinning up
// the DB pool. `purpose` is the canonical (and only accepted) edge field on
// writes; `type` is the derived-internal structural column the cycle/traversal
// SQL still keys off and reads still emit.

// The structural edge types (the derived-internal column). 'required for' is
// the only purpose that derives 'dependency'.
export const VALID_TYPES = ['dependency', 'related'];

// The four canonical purposes (directed source → target). Locked vocabulary.
export const EDGE_PURPOSES = ['required for', 'supports', 'contradicts', 'related to'];
export const DEFAULT_PURPOSE = 'related to';

export function purposeToType(purpose) {
  return purpose === 'required for' ? 'dependency' : 'related';
}

// Resolve the canonical purpose + derived type from a write body. `purpose` is
// REQUIRED on every write (create / bulk / batch / patch); a legacy `type` is
// no longer accepted as input. Returns { purpose, type } or { error }.
export function resolveEdgeKind(body = {}) {
  const purpose = body.purpose;
  if (purpose === undefined || purpose === null) {
    return {
      error:
        "purpose is required (one of 'required for', 'supports', 'contradicts', 'related to')",
    };
  }
  if (!EDGE_PURPOSES.includes(purpose)) {
    return {
      error:
        "purpose must be one of 'required for', 'supports', 'contradicts', 'related to'",
    };
  }
  return { purpose, type: purposeToType(purpose) };
}
