// E15.A1 — pure edge `purpose` derivation. Kept dependency-free (no db, no
// express) so it's trivially unit-testable and importable without spinning up
// the DB pool. `purpose` is the canonical edge field; `type` is the
// derived-internal structural column the cycle/traversal SQL still keys off.

// The structural edge types (the derived-internal column). 'required for' is
// the only purpose that derives 'dependency'.
export const VALID_TYPES = ['dependency', 'related'];

// The four canonical purposes (directed source → target). Locked vocabulary.
export const EDGE_PURPOSES = ['required for', 'supports', 'contradicts', 'related to'];
export const DEFAULT_PURPOSE = 'related to';

export function purposeToType(purpose) {
  return purpose === 'required for' ? 'dependency' : 'related';
}

// Back-compat shim: a legacy client (incl. the canvas) may still send `type`.
// Map it to a purpose so those callers keep working unchanged.
export function typeToPurpose(type) {
  return type === 'dependency' ? 'required for' : 'related to';
}

// Resolve the canonical purpose + derived type from a write body. `purpose`
// wins when present; otherwise a legacy `type` is accepted (deprecated). A body
// carrying neither is rejected — purpose is required on writes. Returns
// { purpose, type } or { error }.
export function resolveEdgeKind(body = {}) {
  let purpose = body.purpose;
  if (purpose === undefined || purpose === null) {
    if (body.type !== undefined && body.type !== null) {
      if (!VALID_TYPES.includes(body.type)) return { error: 'type must be dependency or related' };
      purpose = typeToPurpose(body.type);
    } else {
      return {
        error:
          "purpose is required (one of 'required for', 'supports', 'contradicts', 'related to')",
      };
    }
  } else if (!EDGE_PURPOSES.includes(purpose)) {
    return {
      error:
        "purpose must be one of 'required for', 'supports', 'contradicts', 'related to'",
    };
  }
  return { purpose, type: purposeToType(purpose) };
}
