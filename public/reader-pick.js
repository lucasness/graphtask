// Reader report-selection order. Pure, DOM-free ES module — same single-home
// contract as reader-toc.js: the browser loads it via a <script type="module">
// shim onto window.ReaderPick (see index.html) and vitest imports it directly.
//
// The order encodes the fix for the shared-link footgun: a /g/<id> URL names a
// graph, so THAT graph's report is what the link promises — the active graph
// always comes first, and the remembered last-read report is only a fallback
// for graphs with no report of their own (the resume-reading default when
// entering the reader from a report-less working graph). The trailing active
// entry re-paints the active graph's capability-aware empty-state CTA when the
// remembered report turns out to be gone or unreadable too.
export function readerFallbackChain(activeGid, lastGid) {
  const chain = [activeGid];
  if (lastGid != null && lastGid !== activeGid) chain.push(lastGid, activeGid);
  return chain;
}

// --- ?view=reader share param -----------------------------------------------
// A shared link should carry the sender's view: reader mode itself is a
// per-browser localStorage flag, so without a URL signal a receiver always
// lands on the canvas. The param is per-load INTENT, not a preference — the
// receiver's sticky flag is never written by honoring it.

export function readerRequestedInSearch(search) {
  try { return new URLSearchParams(search || '').get('view') === 'reader'; } catch { return false; }
}

// Return `search` with view=reader set (on) or removed (off), preserving every
// other param. Returns '' (not '?') when nothing remains, so callers can
// always write pathname + result.
export function withReaderParam(search, on) {
  const p = new URLSearchParams(search || '');
  if (on) p.set('view', 'reader'); else p.delete('view');
  const s = p.toString();
  return s ? `?${s}` : '';
}
