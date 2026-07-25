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
