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
