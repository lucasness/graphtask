// Single-node reading page (/g/<gid>/n/<id>) — see public/node.html.
//
// Why this page exists: a citation in the reader used to click through to
// /g/<gid>?node=<id>, which cold-boots the whole SPA in a new tab (cytoscape,
// the 534KB editor bundle, the graphs list, the graph, SSE, presence) and paints
// three visible stages — empty canvas, then the graph, then the side panel —
// before showing you the one node you asked for. This page answers the same
// question off ONE read, with no canvas at all.
//
// Reads only. Nothing here writes to the graph, joins presence, or opens SSE.
import { resolveNodeRoute, nodeHref } from '/route-parse.js';
import { withReaderParam } from '/reader-pick.js';

const FENCE = '---';

// Node bodies are stored as frontmatter + markdown. The parsed fields come back
// from the API as `meta`, so this only has to drop the fence — the fuller
// sibling that also parses the YAML is parseFrontmatter() in app.js.
function stripFrontmatter(text) {
  if (!text || !text.startsWith(FENCE + '\n')) return text || '';
  const end = text.indexOf('\n' + FENCE, FENCE.length);
  if (end === -1) return text;
  return text.slice(end + FENCE.length + 2);
}

const STATUS_LABELS = {
  todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done',
};

// Edge purpose → how it reads from THIS node's side. The stored purpose is
// directed source→target (src/edgePurpose.js), so an incoming edge has to be
// phrased in the passive/inverse or the page would claim the opposite of what
// the graph says. 'related to' is symmetric enough to read the same both ways.
const OUTGOING_LABEL = {
  'required for': 'Required for',
  supports: 'Supports',
  contradicts: 'Contradicts',
  'related to': 'Related to',
};
const INCOMING_LABEL = {
  'required for': 'Requires',
  supports: 'Supported by',
  contradicts: 'Contradicted by',
  'related to': 'Related to',
};
// Evidence first, then dependency, then the catch-all — the order a reader
// arriving from a citation cares about.
const GROUP_ORDER = [
  'Supports', 'Supported by', 'Contradicts', 'Contradicted by',
  'Required for', 'Requires', 'Related to',
];

const $ = (id) => document.getElementById(id);

function showStatus(message) {
  const el = $('node-status');
  el.querySelector('p').textContent = message;
  el.classList.remove('hidden');
}

// Every string from the API lands via textContent or the Viewer's sanitizer —
// this page never assembles markup from graph content.
function setText(id, value) {
  const el = $(id);
  el.textContent = value || '';
  return el;
}

function formatUtc(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function renderMeta(meta, task) {
  const el = $('node-meta');
  el.textContent = '';
  const status = meta.status;
  if (status) {
    const dot = document.createElement('span');
    dot.className = 'node-status-dot';
    dot.dataset.status = status;
    el.appendChild(dot);
    el.appendChild(document.createTextNode(STATUS_LABELS[status] || status));
  }
  const bits = [];
  // A bare 0.9 reads as a version number; the graph's own vocabulary is a
  // confidence score, so say so.
  if (meta.confidence != null && meta.confidence !== '') {
    bits.push(`confidence ${meta.confidence}`);
  }
  const updated = formatUtc(task.updated_at);
  if (updated) bits.push(`updated ${updated}`);
  if (bits.length) {
    el.appendChild(document.createTextNode((status ? ' · ' : '') + bits.join(' · ')));
  }
}

// The node's edges as text rows. `graph` is one /graph read: nodes carry the
// titles, links carry the edges, so no per-neighbour fetch is needed.
function renderConnections(graph, id, gid, from) {
  const section = $('node-connections');
  const titles = new Map((graph.nodes || []).map((n) => [String(n.id), n.title]));
  const groups = new Map();
  for (const link of graph.links || []) {
    const source = String(link.source);
    const target = String(link.target);
    const isOut = source === id;
    const isIn = target === id;
    // A self-edge can't exist (schema CHECK source_id != target_id), so these
    // are genuinely exclusive.
    if (!isOut && !isIn) continue;
    const otherId = isOut ? target : source;
    // Legacy edges predating the locked `purpose` vocabulary fall back to the
    // catch-all rather than being dropped from the page.
    const label = (isOut ? OUTGOING_LABEL : INCOMING_LABEL)[link.purpose] || 'Related to';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push({ id: otherId, title: titles.get(otherId) || `Node #${otherId}` });
  }
  if (groups.size === 0) return;

  const h = document.createElement('h2');
  h.textContent = 'Connections';
  section.appendChild(h);
  const ordered = [...groups.keys()].sort(
    (a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b),
  );
  for (const label of ordered) {
    const group = document.createElement('div');
    group.className = 'node-conn-group';
    const eyebrow = document.createElement('div');
    eyebrow.className = 'node-conn-label';
    eyebrow.textContent = label;
    group.appendChild(eyebrow);
    const ul = document.createElement('ul');
    for (const entry of groups.get(label)) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = nodeHref(gid, entry.id, from);
      a.appendChild(document.createTextNode(entry.title)); // textContent — XSS-safe
      li.appendChild(a);
      ul.appendChild(li);
    }
    group.appendChild(ul);
    section.appendChild(group);
  }
  section.classList.remove('hidden');
}

async function main() {
  const route = resolveNodeRoute(location.pathname);
  if (!route) {
    showStatus('That isn’t a node link.');
    return;
  }
  const { gid, id } = route;
  const from = new URLSearchParams(location.search).get('from');

  if (from === 'report') {
    const back = $('node-back');
    // Built through reader-pick, which is the single home for `view=reader` —
    // not re-typed here. A second hand-written copy of that literal drifts the
    // moment the param changes, and this link would then quietly land on the
    // canvas instead of the report, with nothing to signal it.
    back.href = `/g/${encodeURIComponent(gid)}${withReaderParam('', true)}`;
    back.textContent = '← Back to the report';
    back.classList.remove('hidden');
  }
  const openInGraph = $('node-open-graph');
  openInGraph.href = `/g/${encodeURIComponent(gid)}?node=${encodeURIComponent(id)}`;

  // Both reads go out together: the body paints as soon as the task lands and
  // the connections fill in behind it, so the heavier /graph read never gates
  // the thing the reader actually clicked for.
  const taskReq = fetch(`/api/graphs/${encodeURIComponent(gid)}/tasks/${encodeURIComponent(id)}`);
  const graphReq = fetch(`/api/graphs/${encodeURIComponent(gid)}/graph`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  let res;
  try {
    res = await taskReq;
  } catch {
    showStatus('Could not load this node — check your connection.');
    return;
  }
  // 403 = the graph is readable but this viewer isn't allowed; 404 = no such
  // node, OR the read gate refusing a graph they can't see at all. Same split
  // the reader draws for reports.
  if (res.status === 403) { showStatus('You don’t have access to this node.'); return; }
  if (res.status === 404) { showStatus('That node no longer exists.'); return; }
  if (!res.ok) { showStatus('Could not load this node.'); return; }

  const task = await res.json();
  const meta = task.meta || {};
  const title = meta.title || `Node #${id}`;

  document.title = `${title} — graphtask`;
  if (meta.type) {
    setText('node-eyebrow', meta.type).classList.remove('hidden');
  }
  setText('node-title', title);
  setText('node-desc', meta.description);
  renderMeta(meta, task);
  $('node-header').classList.remove('hidden');

  const body = stripFrontmatter(task.content || '');
  if (body.trim()) {
    // `toastui.Editor` IS the Viewer class in the viewer-only bundle (the full
    // bundle's Editor.factory({viewer:true}) doesn't exist here). Same bundled
    // sanitizer either way.
    new toastui.Editor({
      el: $('node-body'),
      initialValue: body,
      usageStatistics: false,
    });
  } else {
    const empty = document.createElement('p');
    empty.className = 'node-body-empty';
    empty.textContent = 'This node has no body yet.';
    $('node-body').appendChild(empty);
  }
  $('node-footer').classList.remove('hidden');

  const graph = await graphReq;
  if (graph) renderConnections(graph, id, gid, from);
}

main();
