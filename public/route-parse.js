// Client route resolution. Pure, DOM-free ES module — same single-home
// contract as reader-toc.js / reader-pick.js: the browser loads it via a
// <script type="module"> shim onto window.RouteParse (see index.html) and
// vitest imports it directly.
//
// Canonical graph URL: /g/<id>. Human-guessable aliases (/graph/<id>,
// /graphs/<id>) resolve to the same graph with `canonical` set so the caller
// can replaceState the bar to the real shape. Everything else is 'root' or
// 'unknown' — and the caller must NOT quietly treat 'unknown' as root-with-
// fallback while leaving the bogus path in the bar: that's the silent
// misdirection where /graph/<id> (pre-alias) showed the last-active graph
// under an unrelated URL.
const GRAPH_ROUTE_RE = /^\/(g|graph|graphs)\/([a-z0-9]+)\/?$/;

export function resolveRoute(pathname) {
  if (pathname === '/' || pathname === '') return { kind: 'root' };
  const m = GRAPH_ROUTE_RE.exec(pathname || '');
  if (m) return { kind: 'graph', gid: m[2], canonical: `/g/${m[2]}` };
  return { kind: 'unknown' };
}

// Single-node permalink: /g/<gid>/n/<id>. Served by public/node.html — a
// standalone reading page for ONE node, not a view of the SPA (that's the whole
// point: it renders a node's markdown without booting cytoscape, the editor
// bundle, SSE, or presence). Citation click-throughs in the reader target it.
//
// Deliberately a SEPARATE function rather than another `resolveRoute` branch:
// resolveRoute drives the SPA's boot, which never runs on this path, and
// teaching it a fourth `kind` would put a new case in front of bootSidebar for
// no gain. Ids are numeric (tasks.id is SERIAL) and gids are [a-z0-9] — same
// shape GRAPH_ROUTE_RE pins.
const NODE_ROUTE_RE = /^\/g\/([a-z0-9]+)\/n\/([0-9]+)\/?$/;

export function resolveNodeRoute(pathname) {
  const m = NODE_ROUTE_RE.exec(pathname || '');
  if (!m) return null;
  return { gid: m[1], id: m[2], canonical: `/g/${m[1]}/n/${m[2]}` };
}

// The permalink for a node, preserving `from` so a reader-originated chain of
// node→node hops keeps offering "Back to report".
export function nodeHref(gid, id, from) {
  const base = `/g/${encodeURIComponent(gid)}/n/${encodeURIComponent(id)}`;
  return from ? `${base}?from=${encodeURIComponent(from)}` : base;
}
