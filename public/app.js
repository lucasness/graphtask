let cy;
let editingTaskId = null;
let richEditor = null;
let editorMode = 'rich'; // 'rich' | 'raw'
let lastSavedContent = '';
let saveTimer = null;
let saveInFlight = false;
let pendingSave = false;
let savedFadeTimer = null;

// Pending node state for click-to-create flow
let pendingNode = null;       // ghost cy node before first save
let pendingPosition = null;   // {x, y} world coords for the new node
let pendingEdgesForNewNode = null;
let pendingViewportBeforeCreate = null;

// Cytoscape's modifier key (Mac uses cmd/meta, others ctrl)
function isCmd(e) {
  return e && (e.metaKey || e.ctrlKey);
}

// --- Node overlap prevention ---
// Pushes `node` out of any overlap with other nodes, leaving at least
// NODE_GAP world-units of space between bounding boxes. Iterates because a
// push that resolves one collision can create another. Returns true if the
// node was moved.
const NODE_GAP = 12;
const STATUS_ORDER = ['todo', 'in_progress', 'done'];
const STATUS_LABELS = {
  todo: 'Todo',
  in_progress: 'In progress',
  done: 'Done',
};
const DEFAULT_NODE_COLOR = '#282726';
const DEFAULT_EDGE_COLOR = '#878580';
const COLOR_PALETTE_COLUMNS = 5;
const COLOR_PALETTE = [
  { name: 'Base', value: '#282726' },
  { name: 'Red', value: '#D14D41' },
  { name: 'Orange', value: '#DA702C' },
  { name: 'Yellow', value: '#D0A215' },
  { name: 'Green', value: '#879A39' },
  { name: 'Cyan', value: '#3AA99F' },
  { name: 'Blue', value: '#4385BE' },
  { name: 'Purple', value: '#8B7EC8' },
  { name: 'Magenta', value: '#CE5D97' },
  { name: 'Muted', value: '#878580' },
];
const EDGE_CURVE_LIMIT = 500;

function resolveNodeOverlap(node) {
  if (!node || node.empty()) return false;
  const MAX_ITER = 30;
  let pushed = false;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let any = false;
    const myBB = node.boundingBox();
    const others = cy.nodes().filter((n) => n.id() !== node.id() && n.id() !== '__edge_target__');
    for (let i = 0; i < others.length; i++) {
      const other = others[i];
      const oBB = other.boundingBox();
      const ovX = Math.min(myBB.x2, oBB.x2) - Math.max(myBB.x1, oBB.x1);
      const ovY = Math.min(myBB.y2, oBB.y2) - Math.max(myBB.y1, oBB.y1);
      // Already separated by at least NODE_GAP on one axis → no overlap
      if (ovX <= -NODE_GAP || ovY <= -NODE_GAP) continue;
      const myPos = node.position();
      const oPos = other.position();
      const pushX = ovX + NODE_GAP;
      const pushY = ovY + NODE_GAP;
      // Push along whichever axis needs less movement
      if (pushX <= pushY) {
        const sign = (myPos.x - oPos.x) >= 0 ? 1 : -1;
        node.position({ x: myPos.x + sign * pushX, y: myPos.y });
      } else {
        const sign = (myPos.y - oPos.y) >= 0 ? 1 : -1;
        node.position({ x: myPos.x, y: myPos.y + sign * pushY });
      }
      any = true;
      pushed = true;
      break;
    }
    if (!any) return pushed;
  }
  return pushed;
}

function resolveAllOverlaps() {
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    cy.nodes().forEach((n) => {
      if (n.id() === '__pending__' || n.id() === '__edge_target__') return;
      if (resolveNodeOverlap(n)) changed = true;
    });
    if (!changed) break;
  }
}

// --- Markdown frontmatter helpers ---
const FENCE = '---';

function parseFrontmatter(text) {
  if (!text || !text.startsWith(FENCE + '\n')) {
    return { meta: {}, body: text || '' };
  }
  const end = text.indexOf('\n' + FENCE, FENCE.length);
  if (end === -1) return { meta: {}, body: text };
  const yamlStr = text.slice(FENCE.length + 1, end);
  const body = text.slice(end + FENCE.length + 2);
  const meta = {};
  for (const line of yamlStr.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
        v = v.slice(1, -1);
      }
      meta[m[1]] = v;
    }
  }
  return { meta, body };
}

function buildContent(meta, body) {
  const lines = [FENCE];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null || v === '') continue;
    const needsQuote = /[:#&*!|>'"%@`]/.test(String(v)) || /^\s|\s$/.test(String(v));
    lines.push(`${k}: ${needsQuote ? `'${String(v).replace(/'/g, "''")}'` : v}`);
  }
  lines.push(FENCE);
  lines.push(body || '');
  return lines.join('\n');
}

function roundPosition(value) {
  return Math.round(value * 100) / 100;
}

function roundCurve(value) {
  return Math.round(value * 100) / 100;
}

function getEdgeCurve(edgeOrLink) {
  const meta = typeof edgeOrLink.data === 'function'
    ? edgeOrLink.data('meta')
    : edgeOrLink.meta;
  const curve = Number(meta && meta.curve);
  return Number.isFinite(curve) ? curve : 0;
}

// In-place updates so autosave doesn't re-run cytoscape layout
function updateGraphNode(task) {
  if (!cy) return;
  const node = cy.getElementById(String(task.id));
  if (!node || node.empty()) return;
  const meta = task.meta || {};
  node.data('title', meta.title || 'Untitled');
  node.data('description', meta.description || '');
  node.data('status', meta.status || 'todo');
  node.data('color', meta.color || DEFAULT_NODE_COLOR);
  node.data('meta', meta);
}

function addGraphNode(task) {
  if (!cy) return;
  const meta = task.meta || {};
  cy.add({
    group: 'nodes',
    data: {
      id: String(task.id),
      taskId: task.id,
      title: meta.title || 'Untitled',
      description: meta.description || '',
      status: meta.status || 'todo',
      color: meta.color || DEFAULT_NODE_COLOR,
      meta,
    },
  });
}

function addGraphEdge(edge) {
  if (!cy || !edge) return;
  const meta = edge.meta || {};
  cy.add({
    group: 'edges',
    data: {
      id: `e${edge.id}`,
      source: String(edge.source_id),
      target: String(edge.target_id),
      edgeType: edge.type,
      color: meta.color || DEFAULT_EDGE_COLOR,
      curve: getEdgeCurve({ meta }),
      meta,
    },
  });
}

async function fetchGraph() {
  const res = await fetch('/api/graph');
  const data = await res.json();

  const elements = [];

  for (const node of data.nodes) {
    elements.push({
      group: 'nodes',
      data: {
        id: String(node.id),
        taskId: node.id,
        title: node.title || 'Untitled',
        description: node.description || '',
        status: node.status || 'todo',
        color: (node.meta && node.meta.color) || DEFAULT_NODE_COLOR,
        meta: node.meta || {},
      },
    });
  }

  for (const link of data.links) {
    elements.push({
      group: 'edges',
      data: {
        id: `e${link.id}`,
        source: String(link.source),
        target: String(link.target),
        edgeType: link.type,
        color: (link.meta && link.meta.color) || DEFAULT_EDGE_COLOR,
        curve: getEdgeCurve(link),
        meta: link.meta || {},
      },
    });
  }

  const isFirstLoad = cy.elements().length === 0;
  const savedZoom = cy.zoom();
  const savedPan = { ...cy.pan() };

  hideCurveHandle();
  cy.elements().remove();
  cy.add(elements);

  let hasPositions = false;
  cy.nodes().forEach((n) => {
    const meta = n.data('meta');
    if (meta && meta.x !== undefined && meta.y !== undefined) {
      n.position({ x: meta.x, y: meta.y });
      hasPositions = true;
    }
  });

  if (!hasPositions && elements.length > 0) {
    cy.layout({
      name: 'breadthfirst',
      directed: true,
      spacingFactor: 1.5,
      avoidOverlap: true,
    }).run();
  }

  resolveAllOverlaps();

  if (isFirstLoad && elements.length > 0) {
    cy.fit(undefined, 50);
  } else if (!isFirstLoad) {
    cy.zoom(savedZoom);
    cy.pan(savedPan);
  }

  updateEmptyState();
  updateLeafHighlights();
  // fetchGraph wipes element classes (incl. .selected) — resync the toolbar
  updateToolbar();
}

async function updateLeafHighlights() {
  const res = await fetch('/api/tasks/leaves');
  const leaves = await res.json();
  const leafIds = new Set(leaves.map((t) => String(t.id)));

  cy.nodes().forEach((n) => {
    if (leafIds.has(n.id())) {
      n.addClass('leaf');
    } else {
      n.removeClass('leaf');
    }
  });
}

function updateEmptyState() {
  const el = document.getElementById('empty-state');
  if (cy.nodes().length === 0) {
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// --- Selection-driven toolbar ---
function getSelectionCounts() {
  if (!cy) return { nodes: 0, edges: 0, total: 0 };
  const nodes = cy.nodes('.selected').length;
  const edges = cy.edges('.selected').length;
  return { nodes, edges, total: nodes + edges };
}

function getSelectionMode() {
  if (!cy) return 'neutral';
  if (edgeCreation) return 'edge-creating';
  const { nodes, edges } = getSelectionCounts();
  if (nodes > 0 && edges === 0) return 'node';
  if (edges > 0 && nodes === 0) return 'edge';
  if (nodes > 0 && edges > 0) return 'mixed';
  return 'neutral';
}

function selectionSummaryHtml(showSave = false) {
  const { total } = getSelectionCounts();
  return `
    <span class="tb-selection-summary">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <circle cx="4" cy="4" r="2"/>
        <circle cx="12" cy="4" r="2"/>
        <circle cx="8" cy="12" r="2"/>
        <path d="M5.8 5.1 7.1 9.9M10.2 5.1 8.9 9.9M6 4h4"/>
      </svg>
      <span>${total}</span>
      ${showSave ? '<span class="tb-save-hint"><kbd>Enter</kbd> Save</span>' : ''}
    </span>
  `;
}

function isStatusEditSelected() {
  const nodes = cy.nodes('.selected');
  return !!statusEditing && nodes.length === 1 && statusEditing.nodeId === nodes[0].id();
}

function isEdgeEditSelected() {
  const edges = cy.edges('.selected');
  return !!edgeTypeEditing && edges.length === 1 && edgeTypeEditing.edgeId === edges[0].id();
}

function updateToolbar() {
  const mode = getSelectionMode();
  const tbNeutral = document.getElementById('tb-neutral');
  const tbMixed = document.getElementById('tb-mixed');
  const tbNode = document.getElementById('tb-node');
  const tbEdge = document.getElementById('tb-edge');
  const tbCreating = document.getElementById('tb-edge-creating');
  tbNeutral.classList.toggle('hidden', mode !== 'neutral');
  tbMixed.classList.toggle('hidden', mode !== 'mixed');
  tbNode.classList.toggle('hidden', mode !== 'node');
  tbEdge.classList.toggle('hidden', mode !== 'edge');
  tbCreating.classList.toggle('hidden', mode !== 'edge-creating');

  if (mode === 'node') {
    const labelEl = document.getElementById('tb-node-status-label');
    const editingThis = isStatusEditSelected();
    document.getElementById('tb-node-count').innerHTML = selectionSummaryHtml(editingThis);
    labelEl.textContent = editingThis
      ? STATUS_LABELS[statusEditing.currentStatus]
      : 'Status';
    document.getElementById('btn-status').title = editingThis
      ? 'Cycle status. Enter to confirm. Esc to cancel.'
      : 'Cycle status';
  } else if (mode === 'mixed') {
    document.getElementById('tb-mixed-count').innerHTML = selectionSummaryHtml(false);
  } else if (mode === 'edge') {
    const dirEl = document.getElementById('tb-edge-direction');
    const ctrlEl = document.getElementById('tb-edge-controls');
    const editingThis = isEdgeEditSelected();
    dirEl.innerHTML = selectionSummaryHtml(editingThis);
    ctrlEl.innerHTML = editingThis
      ? '<kbd>E</kbd> cycle · <kbd>Esc</kbd> cancel'
      : '<kbd>E</kbd> cycle direction';
  } else if (mode === 'edge-creating') {
    const { direction } = edgeCreation;
    const sources = edgeCreation.sources || [edgeCreation.source].filter(Boolean);
    const srcTitle = sources.length === 1
      ? (sources[0].data('title') || '?')
      : `${sources.length} nodes`;
    const arrow = direction === 'related' ? '↔'
      : direction === 'backward' ? '←' : '→';
    const previewText = direction === 'backward'
      ? `? → ${srcTitle}`
      : `${srcTitle} ${arrow} ?`;
    document.getElementById('tb-edge-creating-count').innerHTML = selectionSummaryHtml(false);
    document.getElementById('tb-edge-creating-preview').textContent =
      previewText;
  }
}

// --- Selection color palette ---
let colorPaletteState = {
  open: false,
  activeIndex: 0,
};

function normalizeColor(value) {
  return String(value || '').trim().toUpperCase();
}

function getColorableSelection() {
  const nodes = [];
  const edges = [];
  if (!cy) return { nodes, edges };

  cy.nodes('.selected').forEach((node) => {
    if (node.id() === '__edge_target__') return;
    nodes.push(node);
  });
  cy.edges('.selected').forEach((edge) => {
    if (edge.id().startsWith('__')) return;
    edges.push(edge);
  });
  return { nodes, edges };
}

function hasColorableSelection() {
  const { nodes, edges } = getColorableSelection();
  return nodes.length > 0 || edges.length > 0;
}

function getSelectionColorIndex() {
  const { nodes, edges } = getColorableSelection();
  const colors = [
    ...nodes.map((node) => node.data('color') || DEFAULT_NODE_COLOR),
    ...edges.map((edge) => edge.data('color') || DEFAULT_EDGE_COLOR),
  ];
  if (colors.length === 0) return 0;
  const first = normalizeColor(colors[0]);
  const allMatch = colors.every((color) => normalizeColor(color) === first);
  if (!allMatch) return 0;
  const idx = COLOR_PALETTE.findIndex((color) => normalizeColor(color.value) === first);
  return idx >= 0 ? idx : 0;
}

function getColorPaletteAnchor() {
  const mode = getSelectionMode();
  const id = mode === 'mixed'
    ? 'btn-color-selection'
    : mode === 'edge'
      ? 'btn-color-edge'
      : 'btn-color-node';
  return document.getElementById(id);
}

function renderColorPalette() {
  const palette = document.getElementById('color-palette');
  if (!palette || palette.dataset.rendered === 'true') return;

  COLOR_PALETTE.forEach((color, index) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch';
    swatch.style.backgroundColor = color.value;
    swatch.setAttribute('role', 'option');
    swatch.setAttribute('aria-label', color.name);
    swatch.dataset.index = String(index);
    swatch.addEventListener('click', () => commitColorPalette(index));
    palette.appendChild(swatch);
  });
  palette.dataset.rendered = 'true';
}

function setActiveColorSwatch(index, focus = false) {
  const palette = document.getElementById('color-palette');
  if (!palette) return;
  const nextIndex = (index + COLOR_PALETTE.length) % COLOR_PALETTE.length;
  colorPaletteState.activeIndex = nextIndex;
  palette.querySelectorAll('.color-swatch').forEach((swatch) => {
    const active = Number(swatch.dataset.index) === nextIndex;
    swatch.classList.toggle('active', active);
    swatch.setAttribute('aria-selected', active ? 'true' : 'false');
    swatch.tabIndex = active ? 0 : -1;
    if (active && focus) swatch.focus();
  });
}

function moveActiveColorSwatch(rowDelta, colDelta) {
  const rows = Math.ceil(COLOR_PALETTE.length / COLOR_PALETTE_COLUMNS);
  const currentRow = Math.floor(colorPaletteState.activeIndex / COLOR_PALETTE_COLUMNS);
  const currentCol = colorPaletteState.activeIndex % COLOR_PALETTE_COLUMNS;
  let nextRow = (currentRow + rowDelta + rows) % rows;
  let nextCol = (currentCol + colDelta + COLOR_PALETTE_COLUMNS) % COLOR_PALETTE_COLUMNS;
  let nextIndex = nextRow * COLOR_PALETTE_COLUMNS + nextCol;

  while (nextIndex >= COLOR_PALETTE.length) {
    nextRow = (nextRow + (rowDelta >= 0 ? 1 : -1) + rows) % rows;
    nextIndex = nextRow * COLOR_PALETTE_COLUMNS + nextCol;
  }

  setActiveColorSwatch(nextIndex, true);
}

function positionColorPalette(anchor) {
  const palette = document.getElementById('color-palette');
  if (!palette) return;
  const paletteRect = palette.getBoundingClientRect();
  const anchorRect = anchor && anchor.getBoundingClientRect();
  let left = (window.innerWidth - paletteRect.width) / 2;
  let top = window.innerHeight - paletteRect.height - 72;

  if (anchorRect) {
    left = anchorRect.left + (anchorRect.width / 2) - (paletteRect.width / 2);
    top = anchorRect.top - paletteRect.height - 10;
    if (top < 8) top = anchorRect.bottom + 10;
  }

  left = Math.min(window.innerWidth - paletteRect.width - 8, Math.max(8, left));
  top = Math.min(window.innerHeight - paletteRect.height - 8, Math.max(8, top));
  palette.style.left = `${left}px`;
  palette.style.top = `${top}px`;
}

function openColorPalette(anchor = getColorPaletteAnchor()) {
  if (edgeCreation || !hasColorableSelection()) return false;
  if (edgeTypeEditing) cancelEdgeTypeEdit();
  if (statusEditing) cancelStatusEdit();

  renderColorPalette();
  const palette = document.getElementById('color-palette');
  if (!palette) return false;

  colorPaletteState.open = true;
  palette.classList.remove('hidden');
  setActiveColorSwatch(getSelectionColorIndex());
  positionColorPalette(anchor);
  setActiveColorSwatch(colorPaletteState.activeIndex, true);
  return true;
}

function closeColorPalette() {
  const palette = document.getElementById('color-palette');
  if (palette) palette.classList.add('hidden');
  colorPaletteState.open = false;
}

function handleColorPaletteKey(e) {
  if (!colorPaletteState.open) return false;
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    moveActiveColorSwatch(0, 1);
    return true;
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    moveActiveColorSwatch(0, -1);
    return true;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveActiveColorSwatch(1, 0);
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveActiveColorSwatch(-1, 0);
    return true;
  }
  if (e.key === 'Home') {
    e.preventDefault();
    setActiveColorSwatch(0, true);
    return true;
  }
  if (e.key === 'End') {
    e.preventDefault();
    setActiveColorSwatch(COLOR_PALETTE.length - 1, true);
    return true;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    commitColorPalette(colorPaletteState.activeIndex);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeColorPalette();
    return true;
  }
  return false;
}

function setNodeColorData(node, color) {
  const meta = { ...(node.data('meta') || {}), color };
  node.data('meta', meta);
  node.data('color', color);
  if (!node.data('taskId') && pendingNode && node.id() === pendingNode.id()) {
    panelLoadedMeta = { ...panelLoadedMeta, color };
  }
}

function setEdgeColorData(edge, color) {
  const meta = { ...(edge.data('meta') || {}), color };
  edge.data('meta', meta);
  edge.data('color', color);
}

async function persistNodeColor(node, color) {
  const taskId = node.data('taskId');
  if (!taskId) return;

  let content;
  if (String(editingTaskId) === String(taskId)) {
    const titleVal = document.getElementById('field-title').value.trim();
    if (!titleVal) throw new Error('Title required');
    const statusVal = document.getElementById('field-status').value;
    content = buildContent({ ...panelLoadedMeta, title: titleVal, status: statusVal, color }, readEditorBody());
  } else {
    const taskRes = await fetch(`/api/tasks/${taskId}`);
    if (!taskRes.ok) throw new Error('load failed');
    const task = await taskRes.json();
    const parsed = parseFrontmatter(task.content);
    content = buildContent({ ...(parsed.meta || {}), color }, parsed.body);
  }

  const res = await updateTask(taskId, content);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Could not update color');
  }
  const saved = await res.json();
  updateGraphNode(saved);
  if (String(editingTaskId) === String(taskId)) {
    panelLoadedMeta = { ...panelLoadedMeta, color };
    lastSavedContent = content;
  }
}

async function persistEdgeColor(edge, color) {
  const res = await updateEdgeMeta(edge, { color });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Could not update color');
  }
  const saved = await res.json();
  const meta = saved.meta || {};
  edge.data('meta', meta);
  edge.data('color', meta.color || DEFAULT_EDGE_COLOR);
}

async function applySelectionColor(color) {
  const { nodes, edges } = getColorableSelection();
  if (nodes.length === 0 && edges.length === 0) return;

  nodes.forEach((node) => setNodeColorData(node, color));
  edges.forEach((edge) => setEdgeColorData(edge, color));

  try {
    for (const node of nodes) {
      await persistNodeColor(node, color);
    }
    for (const edge of edges) {
      await persistEdgeColor(edge, color);
    }
    showHint('Color updated');
  } catch (err) {
    showHint(err.message || 'Could not update color');
    await fetchGraph();
  } finally {
    updateToolbar();
  }
}

function commitColorPalette(index) {
  const color = COLOR_PALETTE[index];
  if (!color) return;
  closeColorPalette();
  applySelectionColor(color.value);
}

// --- Panel ---
let panelLoadedMeta = {};

function loadIntoEditor(content) {
  const { meta, body } = parseFrontmatter(content);
  panelLoadedMeta = meta;
  document.getElementById('field-title').value = meta.title || '';
  document.getElementById('field-status').value = meta.status || 'todo';
  document.getElementById('raw-editor').value = body;
  if (richEditor) richEditor.setMarkdown(body, false);
  lastSavedContent = content;
}

function readEditorBody() {
  if (editorMode === 'raw') return document.getElementById('raw-editor').value;
  return richEditor ? richEditor.getMarkdown() : '';
}

function setEditorMode(next) {
  if (next === editorMode) return;
  const rich = document.getElementById('rich-editor');
  const raw = document.getElementById('raw-editor');
  const btnRich = document.getElementById('mode-rich');
  const btnRaw = document.getElementById('mode-raw');

  if (next === 'raw') {
    raw.value = richEditor ? richEditor.getMarkdown() : raw.value;
    rich.classList.add('hidden');
    raw.classList.remove('hidden');
    btnRich.classList.remove('active');
    btnRaw.classList.add('active');
    btnRich.setAttribute('aria-selected', 'false');
    btnRaw.setAttribute('aria-selected', 'true');
  } else {
    if (richEditor) richEditor.setMarkdown(raw.value);
    raw.classList.add('hidden');
    rich.classList.remove('hidden');
    btnRaw.classList.remove('active');
    btnRich.classList.add('active');
    btnRaw.setAttribute('aria-selected', 'false');
    btnRich.setAttribute('aria-selected', 'true');
  }
  editorMode = next;
}

// Pan the canvas so `node` lands at the center of the visible area
// (the part of the viewport NOT covered by the side panel).
function centerNodeInVisibleArea(node) {
  if (!node || node.empty()) return;
  const panel = document.getElementById('panel');
  const panelWidth = panel.classList.contains('hidden')
    ? 0
    : panel.getBoundingClientRect().width;
  const targetX = (window.innerWidth - panelWidth) / 2;
  const targetY = window.innerHeight / 2;
  const pos = node.renderedPosition();
  const dx = targetX - pos.x;
  const dy = targetY - pos.y;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  cy.animate({ panBy: { x: dx, y: dy } }, { duration: 220, easing: 'ease-out' });
}

function captureViewport() {
  if (!cy) return null;
  return {
    pan: { ...cy.pan() },
    zoom: cy.zoom(),
  };
}

function restoreViewport(snapshot) {
  if (!cy || !snapshot) return;
  cy.stop();
  cy.animate(
    { pan: snapshot.pan, zoom: snapshot.zoom },
    { duration: 220, easing: 'ease-out' }
  );
}

function showPanel(task) {
  editingTaskId = task ? task.data('taskId') : null;
  const panel = document.getElementById('panel');
  const title = document.getElementById('panel-title');
  const btnDelete = document.getElementById('btn-delete');
  const status = document.getElementById('save-status');
  if (status) { status.textContent = ''; status.dataset.kind = ''; status.classList.remove('saved-fade'); }

  if (task) {
    title.textContent = 'Edit Task';
    btnDelete.classList.remove('hidden');
    fetch(`/api/tasks/${editingTaskId}`)
      .then((r) => r.json())
      .then((full) => { loadIntoEditor(full.content); });
  } else {
    title.textContent = 'New Task';
    btnDelete.classList.add('hidden');
    loadIntoEditor('---\ntitle: \nstatus: todo\n---\n');
    if (status) { status.textContent = 'Add a title to create'; status.dataset.kind = 'hint'; }
  }

  setEditorMode('rich');
  panel.classList.remove('hidden');
  if (task) centerNodeInVisibleArea(task);
  // Do NOT auto-focus a panel field — selection alone shouldn't redirect keystrokes.
  // The user enters edit mode by clicking into a field, or by double-clicking the node.
}

function hidePanel() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (typeof window.__flushSave === 'function') window.__flushSave();
  }
  const panel = document.getElementById('panel');
  const wasOpen = !panel.classList.contains('hidden');
  const panelWidth = wasOpen ? panel.getBoundingClientRect().width : 0;
  panel.classList.add('hidden');
  editingTaskId = null;
  hideTitleOverlay();
  // If a ghost was never saved (no title), drop it now
  const hadGhost = !!(pendingNode && pendingNode.id() === '__pending__' && !pendingNode.removed());
  const viewportToRestore = hadGhost ? pendingViewportBeforeCreate : null;
  clearPendingEdgesForNewNode();
  if (hadGhost) pendingNode.remove();
  pendingNode = null;
  pendingPosition = null;
  pendingViewportBeforeCreate = null;
  if (hadGhost) updateToolbar();
  // Keep what was at the old visible-area center still at the new
  // (now-wider) visible-area center after the panel disappears.
  if (viewportToRestore) {
    restoreViewport(viewportToRestore);
  } else if (wasOpen && panelWidth > 0 && cy) {
    cy.animate({ panBy: { x: panelWidth / 2, y: 0 } }, { duration: 220, easing: 'ease-out' });
  }
}

function isPanelOpen() {
  return !document.getElementById('panel').classList.contains('hidden');
}

// --- Click-to-create flow ---
function getActiveNode() {
  if (pendingNode && !pendingNode.removed()) return pendingNode;
  if (editingTaskId) {
    const n = cy.getElementById(String(editingTaskId));
    if (n && !n.empty()) return n;
  }
  return null;
}

function showTitleOverlay() {
  const input = document.getElementById('node-title-overlay');
  const node = getActiveNode();
  if (!node) return;
  input.textContent = node.data('title') || '';
  input.classList.remove('hidden');
  node.addClass('editing');
  syncNodeToOverlay();
  positionTitleOverlay();
  // Defer focus so layout settles
  setTimeout(() => {
    input.focus();
    placeCaretAtEnd(input);
  }, 0);
}

function hideTitleOverlay() {
  const input = document.getElementById('node-title-overlay');
  input.classList.add('hidden');
  cy.nodes('.editing').forEach((n) => {
    n.removeClass('editing');
    n.removeStyle('width');
    n.removeStyle('height');
  });
}

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Resize the active cytoscape node so its frame wraps the overlay content.
// Cytoscape only applies the stylesheet `padding` when width/height are
// 'label'-driven; explicit numeric width/height are taken as the total frame
// size. We add the padding manually so the node has the same breathing room
// it would have when not in edit mode.
//
// The overlay is HTML and lives in screen-pixel space; the cytoscape node
// lives in world-unit space. We scale the overlay's font-size and max-width
// with cy.zoom() so the overlay visually matches cytoscape's own label
// (which uses world-unit font-size and so scales naturally with zoom).
const NODE_EDIT_PAD = 28;        // matches cytoscape `padding: '14px'` × 2
const OVERLAY_BASE_FONT = 13;    // matches cytoscape node `font-size`
const OVERLAY_BASE_MAX_W = 140;  // matches cytoscape node `text-max-width`

function syncNodeToOverlay() {
  const input = document.getElementById('node-title-overlay');
  if (input.classList.contains('hidden')) return;
  const node = getActiveNode();
  if (!node) return;
  const z = cy.zoom();
  input.style.fontSize = (OVERLAY_BASE_FONT * z) + 'px';
  input.style.maxWidth = (OVERLAY_BASE_MAX_W * z) + 'px';
  const w = Math.max(60, input.offsetWidth / z) + NODE_EDIT_PAD;
  const h = Math.max(20, input.offsetHeight / z) + NODE_EDIT_PAD;
  node.style({ width: w, height: h });
}

function positionTitleOverlay() {
  const input = document.getElementById('node-title-overlay');
  if (input.classList.contains('hidden')) return;
  const node = getActiveNode();
  if (!node) return;
  const pos = node.renderedPosition();
  const rect = document.getElementById('cy').getBoundingClientRect();
  input.style.left = (rect.left + pos.x) + 'px';
  input.style.top = (rect.top + pos.y) + 'px';
}

function removePendingEdgePreviews(intent = pendingEdgesForNewNode) {
  if (!intent || !intent.previewEdges) return;
  intent.previewEdges.forEach((edge) => {
    if (edge && !edge.removed()) edge.remove();
  });
  intent.previewEdges = [];
}

function clearPendingEdgesForNewNode() {
  removePendingEdgePreviews();
  pendingEdgesForNewNode = null;
}

function cancelPendingNode() {
  const hadGhost = !!(pendingNode && pendingNode.id() === '__pending__' && !pendingNode.removed());
  const viewportToRestore = hadGhost ? pendingViewportBeforeCreate : null;
  clearPendingEdgesForNewNode();
  if (hadGhost) pendingNode.remove();
  pendingNode = null;
  pendingPosition = null;
  pendingViewportBeforeCreate = null;
  hideTitleOverlay();
  if (isPanelOpen() && !editingTaskId) {
    document.getElementById('panel').classList.add('hidden');
  }
  if (viewportToRestore) restoreViewport(viewportToRestore);
  if (hadGhost) updateToolbar();
}

async function startEditingNode(node) {
  cancelPendingNode();
  cy.nodes().not(node).removeClass('selected');
  cy.edges().removeClass('selected');
  node.addClass('selected');

  pendingNode = node;
  pendingPosition = node.position();
  editingTaskId = node.data('taskId');

  // Always refetch so panelLoadedMeta and the body editor have current content
  // (autosave reconstructs the full markdown on every keystroke).
  try {
    const res = await fetch(`/api/tasks/${editingTaskId}`);
    const full = await res.json();
    loadIntoEditor(full.content);
  } catch (err) {
    console.error('Failed to load task for editing:', err);
    return;
  }

  showTitleOverlay();
  updateToolbar();
}

function createNodeAt(pos, options = {}) {
  cancelPendingNode();
  pendingViewportBeforeCreate = captureViewport();
  // Clear any prior selection so the new node is the only one selected
  cy.nodes().removeClass('selected');
  cy.edges().removeClass('selected');

  pendingPosition = { x: pos.x, y: pos.y };
  const ghost = cy.add({
    group: 'nodes',
    data: {
      id: '__pending__',
      taskId: null,
      title: '',
      description: '',
      status: 'todo',
      color: DEFAULT_NODE_COLOR,
      meta: { status: 'todo', x: pos.x, y: pos.y },
    },
  });
  ghost.position(pos);
  ghost.addClass('selected');
  pendingNode = ghost;

  // Open the panel in "new task" mode with x/y seeded into frontmatter
  editingTaskId = null;
  panelLoadedMeta = {};
  const panel = document.getElementById('panel');
  document.getElementById('panel-title').textContent = 'New Task';
  document.getElementById('btn-delete').classList.add('hidden');
  const status = document.getElementById('save-status');
  if (status) {
    status.textContent = 'Add a title to create';
    status.dataset.kind = 'hint';
    status.classList.remove('saved-fade');
  }
  loadIntoEditor(`---\ntitle: \nstatus: todo\nx: ${pos.x}\ny: ${pos.y}\n---\n`);
  setEditorMode('rich');
  panel.classList.remove('hidden');
  if (resolveNodeOverlap(ghost)) {
    const fp = ghost.position();
    pendingPosition = fp;
    panelLoadedMeta.x = fp.x;
    panelLoadedMeta.y = fp.y;
  }
  if (options.edgeIntent) {
    attachPendingEdgesToNewNode(ghost, options.edgeIntent);
  }
  centerNodeInVisibleArea(ghost);

  showTitleOverlay();
  updateToolbar();
}

function attachPendingEdgesToNewNode(ghost, edgeIntent) {
  const sources = (edgeIntent.sources || [])
    .map((source) => {
      if (source && typeof source.data === 'function') {
        return { nodeId: source.id(), taskId: source.data('taskId') };
      }
      return source;
    })
    .filter((source) => source && source.nodeId && source.taskId);
  if (sources.length === 0) return;
  pendingEdgesForNewNode = {
    sources,
    direction: edgeIntent.direction || 'forward',
    previewEdges: [],
  };
  rebuildPendingNewNodePreviewEdges(ghost);
}

function rebuildPendingNewNodePreviewEdges(ghost = pendingNode) {
  if (!pendingEdgesForNewNode || !ghost || ghost.removed()) return;
  removePendingEdgePreviews(pendingEdgesForNewNode);
  const { sources, direction } = pendingEdgesForNewNode;
  const isRelated = direction === 'related';
  pendingEdgesForNewNode.previewEdges = sources.map((sourceInfo, idx) => {
    const source = cy.getElementById(String(sourceInfo.nodeId));
    if (!source || source.empty()) return null;
    const fromId = direction === 'backward' ? ghost.id() : source.id();
    const toId = direction === 'backward' ? source.id() : ghost.id();
    return cy.add({
      group: 'edges',
      data: {
        id: `__pending_edge_${idx}__`,
        source: fromId,
        target: toId,
        edgeType: isRelated ? 'related' : 'dependency',
        color: DEFAULT_EDGE_COLOR,
        curve: 0,
        meta: {},
      },
      classes: 'preview',
    });
  }).filter(Boolean);
}

async function createPendingEdgesForSavedNode(newTaskId, intent) {
  if (!intent) return;
  const isRelated = intent.direction === 'related';
  let created = 0;
  const failures = [];
  for (const source of intent.sources) {
    const sourceTaskId = source.taskId;
    if (!sourceTaskId || String(sourceTaskId) === String(newTaskId)) continue;
    const fromId = intent.direction === 'backward' ? newTaskId : sourceTaskId;
    const toId = intent.direction === 'backward' ? sourceTaskId : newTaskId;
    const res = await createEdge(fromId, toId, isRelated ? 'related' : 'dependency');
    if (res.ok) {
      created += 1;
      addGraphEdge(await res.json());
    } else {
      const err = await res.json().catch(() => ({}));
      failures.push(err.error || 'Could not create edge');
    }
  }
  if (failures.length > 0) {
    showHint(created > 0
      ? `Created ${created}, skipped ${failures.length}`
      : failures[0]);
  } else if (created > 1) {
    showHint(`Created ${created} edges`);
  }
}

// --- Edge creation ---
// Active when the user has hit "E" (or the Connect button) with one or more
// nodes selected. We add a phantom node that tracks the cursor and preview
// edges from the selected sources to the phantom; clicking a real node commits.
let edgeCreation = null;

function startEdgeCreation() {
  if (edgeCreation) return;
  const sources = cy.nodes('.selected')
    .filter((n) => n.id() !== '__pending__' && n.data('taskId'))
    .toArray();
  if (sources.length === 0) return;
  if (isPanelOpen()) hidePanel();

  const center = sources.reduce((acc, source) => {
    const pos = source.position();
    return { x: acc.x + pos.x, y: acc.y + pos.y };
  }, { x: 0, y: 0 });
  center.x /= sources.length;
  center.y /= sources.length;

  const phantom = cy.add({
    group: 'nodes',
    data: { id: '__edge_target__' },
    classes: 'phantom',
    position: center,
  });
  edgeCreation = { sources, phantom, direction: 'forward', previewEdges: [] };
  rebuildPreviewEdge();
  document.addEventListener('mousemove', onEdgeCreationMouseMove);
  updateToolbar();
}

function cancelEdgeCreation() {
  if (!edgeCreation) return;
  const previewEdges = edgeCreation.previewEdges || [edgeCreation.previewEdge].filter(Boolean);
  previewEdges.forEach((edge) => {
    if (edge && !edge.removed()) edge.remove();
  });
  if (edgeCreation.phantom && !edgeCreation.phantom.removed()) {
    edgeCreation.phantom.remove();
  }
  cy.nodes('.edge-hover-target').removeClass('edge-hover-target');
  document.removeEventListener('mousemove', onEdgeCreationMouseMove);
  edgeCreation = null;
  updateToolbar();
}

function createPendingNodeFromEdgeCreation(pos) {
  if (!edgeCreation) return;
  const sources = (edgeCreation.sources || [edgeCreation.source])
    .filter((source) => source && !source.removed() && source.data('taskId'));
  const direction = edgeCreation.direction;
  cancelEdgeCreation();
  createNodeAt(pos, { edgeIntent: { sources, direction } });
}

async function commitEdgeCreation(targetNode) {
  if (!edgeCreation) return;
  if (!targetNode || targetNode.empty()) return;
  if (!targetNode.data('taskId')) return;
  const sources = (edgeCreation.sources || [edgeCreation.source])
    .filter((source) => source && !source.removed() && source.data('taskId') && source.id() !== targetNode.id());
  if (sources.length === 0) {
    cancelEdgeCreation();
    return;
  }
  const { direction } = edgeCreation;
  const isRelated = direction === 'related';
  const targetTaskId = targetNode.data('taskId');
  cancelEdgeCreation();
  let created = 0;
  const failures = [];
  try {
    for (const source of sources) {
      const sourceTaskId = source.data('taskId');
      const fromId = direction === 'backward' ? targetTaskId : sourceTaskId;
      const toId = direction === 'backward' ? sourceTaskId : targetTaskId;
      const res = await createEdge(fromId, toId, isRelated ? 'related' : 'dependency');
      if (res.ok) {
        created += 1;
      } else {
        const err = await res.json().catch(() => ({}));
        failures.push(err.error || 'Could not create edge');
      }
    }
    if (created > 0) await fetchGraph();
    if (failures.length > 0) {
      showHint(created > 0
        ? `Created ${created}, skipped ${failures.length}`
        : failures[0]);
    } else if (created > 1) {
      showHint(`Created ${created} edges`);
    }
  } catch {
    showHint('Could not create edges');
  }
}

// Cycle order for the in-progress edge: forward → related → backward → forward
const EDGE_DIRECTION_ORDER = ['forward', 'related', 'backward'];

function cycleEdgeCreationDirection() {
  if (!edgeCreation) return;
  const idx = EDGE_DIRECTION_ORDER.indexOf(edgeCreation.direction);
  edgeCreation.direction = EDGE_DIRECTION_ORDER[(idx + 1) % EDGE_DIRECTION_ORDER.length];
  rebuildPreviewEdge();
  updateToolbar();
}

function rebuildPreviewEdge() {
  if (!edgeCreation) return;
  const { phantom, direction } = edgeCreation;
  const sources = edgeCreation.sources || [edgeCreation.source].filter(Boolean);
  const previewEdges = edgeCreation.previewEdges || [edgeCreation.previewEdge].filter(Boolean);
  previewEdges.forEach((edge) => {
    if (edge && !edge.removed()) edge.remove();
  });
  const isRelated = direction === 'related';
  edgeCreation.previewEdges = sources.map((source, idx) => {
    const fromId = direction === 'backward' ? phantom.id() : source.id();
    const toId = direction === 'backward' ? source.id() : phantom.id();
    return cy.add({
      group: 'edges',
      data: {
        id: `__preview_edge_${idx}__`,
        source: fromId,
        target: toId,
        edgeType: isRelated ? 'related' : 'dependency',
        color: DEFAULT_EDGE_COLOR,
        curve: 0,
        meta: {},
      },
      classes: 'preview',
    });
  });
}

function onEdgeCreationMouseMove(e) {
  if (!edgeCreation || !edgeCreation.phantom) return;
  const cyRect = document.getElementById('cy').getBoundingClientRect();
  const x = e.clientX - cyRect.left;
  const y = e.clientY - cyRect.top;
  const z = cy.zoom();
  const pan = cy.pan();
  edgeCreation.phantom.position({
    x: (x - pan.x) / z,
    y: (y - pan.y) / z,
  });
}

// --- Existing-edge type editing ---
// When the user selects an edge and presses E, we cycle its direction/type
// optimistically (visual updates immediately). The change isn't persisted
// until the user presses Enter; Esc or moving focus elsewhere reverts it.
let edgeTypeEditing = null;

function cycleSelectedEdgeType() {
  const selectedEdges = cy.edges('.selected').filter((e) => !e.id().startsWith('__'));
  if (selectedEdges.length !== 1) return;
  const edge = selectedEdges[0];

  // Switching to a different edge → revert the previous edit first
  if (edgeTypeEditing && edgeTypeEditing.edgeId !== edge.id()) {
    cancelEdgeTypeEdit();
  }
  if (!edgeTypeEditing) {
    const type = edge.data('edgeType');
    edgeTypeEditing = {
      edge,
      edgeId: edge.id(),
      originalType: type,
      originalSourceTaskId: edge.source().data('taskId'),
      originalTargetTaskId: edge.target().data('taskId'),
      currentDirection: type === 'related' ? 'related' : 'forward',
    };
  }
  // forward → related → backward → forward
  const idx = EDGE_DIRECTION_ORDER.indexOf(edgeTypeEditing.currentDirection);
  edgeTypeEditing.currentDirection =
    EDGE_DIRECTION_ORDER[(idx + 1) % EDGE_DIRECTION_ORDER.length];
  applyEdgeTypeVisual();
  updateToolbar();
}

function applyEdgeTypeVisual() {
  if (!edgeTypeEditing) return;
  const { edge, currentDirection } = edgeTypeEditing;
  edge.removeClass('dir-backward');
  if (currentDirection === 'related') {
    edge.data('edgeType', 'related');
  } else if (currentDirection === 'backward') {
    edge.data('edgeType', 'dependency');
    edge.addClass('dir-backward');
  } else {
    edge.data('edgeType', 'dependency');
  }
}

async function commitEdgeTypeEdit() {
  if (!edgeTypeEditing) return;
  const state = edgeTypeEditing;
  edgeTypeEditing = null;

  const { edgeId, originalType, originalSourceTaskId, originalTargetTaskId, currentDirection } = state;
  const isRelated = currentDirection === 'related';
  const isBackward = currentDirection === 'backward';
  const newType = isRelated ? 'related' : 'dependency';
  const newSourceId = isBackward ? originalTargetTaskId : originalSourceTaskId;
  const newTargetId = isBackward ? originalSourceTaskId : originalTargetTaskId;

  // Nothing actually changed
  if (!isBackward && newType === originalType) {
    updateToolbar();
    return;
  }

  const rawId = String(edgeId).replace(/^e/, '');
  try {
    const res = await fetch(`/api/edges/${rawId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_id: newSourceId, target_id: newTargetId, type: newType }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showHint(err.error || 'Could not update edge');
      await fetchGraph();
      return;
    }
    showHint('Edge type changed');
    await fetchGraph();
  } catch {
    showHint('Could not update edge');
    await fetchGraph();
  }
}

// Reverts the optimistic visual back to the original type and discards the edit
function cancelEdgeTypeEdit() {
  if (!edgeTypeEditing) return;
  const { edge, originalType } = edgeTypeEditing;
  if (edge && !edge.removed()) {
    edge.removeClass('dir-backward');
    edge.data('edgeType', originalType);
  }
  edgeTypeEditing = null;
  updateToolbar();
}

// --- Existing-node status editing ---
// S cycles a selected node's status optimistically. Enter persists it; Esc or
// changing selection restores the original status.
let statusEditing = null;

function statusClass(status) {
  return `status-editing-${status}`;
}

function clearStatusEditClasses(node) {
  node.removeClass('status-editing');
  STATUS_ORDER.forEach((status) => node.removeClass(statusClass(status)));
}

function cycleSelectedNodeStatus() {
  const selectedNodes = cy.nodes('.selected').filter((n) => n.id() !== '__pending__' && n.data('taskId'));
  if (selectedNodes.length !== 1) return;
  const node = selectedNodes[0];

  if (statusEditing && statusEditing.nodeId !== node.id()) {
    cancelStatusEdit();
  }
  if (!statusEditing) {
    const status = node.data('status') || 'todo';
    statusEditing = {
      node,
      nodeId: node.id(),
      taskId: node.data('taskId'),
      originalStatus: status,
      currentStatus: status,
    };
  }

  const idx = STATUS_ORDER.indexOf(statusEditing.currentStatus);
  const nextIdx = idx === -1 ? 0 : (idx + 1) % STATUS_ORDER.length;
  statusEditing.currentStatus = STATUS_ORDER[nextIdx];
  applyStatusVisual();
  updateToolbar();
}

function applyStatusVisual() {
  if (!statusEditing) return;
  const { node, currentStatus } = statusEditing;
  if (!node || node.removed()) return;
  clearStatusEditClasses(node);
  node.data('status', currentStatus);
  node.addClass('status-editing');
  node.addClass(statusClass(currentStatus));
}

async function commitStatusEdit() {
  if (!statusEditing) return;
  const state = statusEditing;
  statusEditing = null;

  const { node, taskId, originalStatus, currentStatus } = state;
  if (node && !node.removed()) clearStatusEditClasses(node);

  if (currentStatus === originalStatus) {
    updateToolbar();
    return;
  }

  try {
    let content;
    if (String(editingTaskId) === String(taskId)) {
      const titleVal = document.getElementById('field-title').value.trim();
      if (!titleVal) {
        showHint('Title required');
        if (node && !node.removed()) node.data('status', originalStatus);
        updateToolbar();
        return;
      }
      const meta = { ...panelLoadedMeta, title: titleVal, status: currentStatus };
      content = buildContent(meta, readEditorBody());
    } else {
      const taskRes = await fetch(`/api/tasks/${taskId}`);
      if (!taskRes.ok) throw new Error('fetch failed');
      const task = await taskRes.json();
      const parsed = parseFrontmatter(task.content);
      const meta = { ...(parsed.meta || {}), status: currentStatus };
      content = buildContent(meta, parsed.body);
    }

    const res = await updateTask(taskId, content);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showHint(err.error || 'Could not update status');
      if (node && !node.removed()) node.data('status', originalStatus);
      await fetchGraph();
      return;
    }
    const saved = await res.json();
    updateGraphNode(saved);
    if (String(editingTaskId) === String(taskId)) {
      const statusField = document.getElementById('field-status');
      statusField.value = currentStatus;
      panelLoadedMeta = { ...panelLoadedMeta, status: currentStatus };
      lastSavedContent = content;
    }
    showHint(`Status: ${STATUS_LABELS[currentStatus]}`);
    await updateLeafHighlights();
    updateToolbar();
  } catch {
    showHint('Could not update status');
    if (node && !node.removed()) node.data('status', originalStatus);
    await fetchGraph();
  }
}

function cancelStatusEdit() {
  if (!statusEditing) return;
  const { node, originalStatus } = statusEditing;
  if (node && !node.removed()) {
    clearStatusEditClasses(node);
    node.data('status', originalStatus);
  }
  statusEditing = null;
  updateToolbar();
}

// Create a new node at the world position corresponding to the center of
// the currently visible canvas area (viewport minus the side panel, if any).
// Overlap resolution + re-centering happens inside createNodeAt.
function createNodeAtCenter() {
  const panel = document.getElementById('panel');
  const panelWidth = panel.classList.contains('hidden')
    ? 0
    : panel.getBoundingClientRect().width;
  const screenX = (window.innerWidth - panelWidth) / 2;
  const screenY = window.innerHeight / 2;
  const z = cy.zoom();
  const pan = cy.pan();
  createNodeAt({ x: (screenX - pan.x) / z, y: (screenY - pan.y) / z });
}

// --- API calls ---
async function createTask(content) {
  return fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

async function updateTask(id, content) {
  return fetch(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

async function persistNodePosition(node) {
  if (!node || node.empty() || node.removed()) return;
  const taskId = node.data('taskId');
  if (!taskId) return;

  const pos = node.position();
  const x = roundPosition(pos.x);
  const y = roundPosition(pos.y);
  const meta = { ...(node.data('meta') || {}), x, y };
  node.data('meta', meta);

  if (String(editingTaskId) === String(taskId)) {
    panelLoadedMeta = { ...panelLoadedMeta, x, y };
  }

  try {
    const taskRes = await fetch(`/api/tasks/${taskId}`);
    if (!taskRes.ok) throw new Error('load failed');
    const task = await taskRes.json();
    const parsed = parseFrontmatter(task.content);
    const content = buildContent({ ...(parsed.meta || {}), x, y }, parsed.body);
    const updateRes = await updateTask(taskId, content);
    if (!updateRes.ok) throw new Error('save failed');
    const saved = await updateRes.json();
    updateGraphNode(saved);
    if (String(editingTaskId) === String(taskId)) {
      panelLoadedMeta = { ...panelLoadedMeta, x, y };
    }
  } catch {
    showHint('Could not save position');
  }
}

async function deleteTask(id) {
  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
}

async function createEdge(source_id, target_id, type) {
  return fetch('/api/edges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id, target_id, type }),
  });
}

async function updateEdgeMeta(edge, metaPatch) {
  const rawId = String(edge.id()).replace(/^e/, '');
  return fetch(`/api/edges/${rawId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meta: metaPatch }),
  });
}

// --- Hint toast ---
let hintTimeout;
function showHint(text) {
  const el = document.getElementById('hotkey-hint');
  const inner = document.getElementById('hotkey-hint-text');
  inner.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(hintTimeout);
  hintTimeout = setTimeout(() => el.classList.add('hidden'), 2000);
}

function clearSelection() {
  closeColorPalette();
  if (edgeTypeEditing) cancelEdgeTypeEdit();
  if (statusEditing) cancelStatusEdit();
  cy.nodes().removeClass('selected');
  cy.edges().removeClass('selected');
  cy.edges().removeClass('highlighted');
  hideCurveHandle();
  updateToolbar();
}

function elementFocusPoint(ele) {
  if (!ele || ele.empty()) return null;
  if (ele.isNode()) return ele.position();
  const midpoint = ele.midpoint();
  return midpoint || null;
}

function isDirectionalCandidate(from, to, direction) {
  if (!from || !to) return false;
  const EPS = 1e-6;
  if (direction === 'ArrowUp') return to.y < from.y - EPS;
  if (direction === 'ArrowDown') return to.y > from.y + EPS;
  if (direction === 'ArrowLeft') return to.x < from.x - EPS;
  if (direction === 'ArrowRight') return to.x > from.x + EPS;
  return false;
}

function nearestElementInDirection(current, candidates, direction) {
  const from = elementFocusPoint(current);
  if (!from) return null;

  let best = null;
  let bestScore = Infinity;
  candidates.forEach((candidate) => {
    if (candidate.id() === current.id()) return;
    const to = elementFocusPoint(candidate);
    if (!isDirectionalCandidate(from, to, direction)) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const score = dx * dx + dy * dy;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  });
  return best;
}

function moveSelection(direction) {
  if (edgeCreation || edgeTypeEditing || statusEditing) return false;
  if (pendingNode) return false;

  const selectedNodes = cy.nodes('.selected').filter((n) => n.id() !== '__pending__' && n.id() !== '__edge_target__');
  const selectedEdges = cy.edges('.selected').filter((edge) => !edge.id().startsWith('__'));
  const isNodeFocus = selectedNodes.length === 1 && selectedEdges.length === 0;
  const isEdgeFocus = selectedEdges.length === 1 && selectedNodes.length === 0;
  if (!isNodeFocus && !isEdgeFocus) return false;

  const current = isNodeFocus ? selectedNodes[0] : selectedEdges[0];
  const candidates = isNodeFocus
    ? cy.nodes().filter((n) => n.id() !== '__pending__' && n.id() !== '__edge_target__')
    : cy.edges().filter((edge) => !edge.id().startsWith('__'));
  const next = nearestElementInDirection(current, candidates, direction);
  if (!next) return false;

  if (isNodeFocus) {
    cy.nodes().removeClass('selected');
    cy.edges().removeClass('selected');
    next.addClass('selected');
    if (isPanelOpen()) showPanel(next);
  } else {
    cy.nodes().removeClass('selected');
    cy.edges().removeClass('selected');
    next.addClass('selected');
    if (isPanelOpen()) hidePanel();
    showCurveHandle(next);
  }
  updateToolbar();
  return true;
}

let curveHandleEdge = null;
let curveHandleDragging = false;

function getEdgeCurveGeometry(edge) {
  if (!edge || edge.empty() || edge.removed()) return null;
  const source = edge.source();
  const target = edge.target();
  if (!source || !target || source.empty() || target.empty()) return null;

  const a = source.position();
  const b = target.position();
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return null;

  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const normal = { x: -dy / length, y: dx / length };
  const curve = getEdgeCurve(edge);
  const handle = {
    x: mid.x + normal.x * (curve / 2),
    y: mid.y + normal.y * (curve / 2),
  };
  return { mid, normal, handle };
}

function modelToViewportPoint(pos) {
  const rect = document.getElementById('cy').getBoundingClientRect();
  const pan = cy.pan();
  const zoom = cy.zoom();
  return {
    x: rect.left + pos.x * zoom + pan.x,
    y: rect.top + pos.y * zoom + pan.y,
  };
}

function pointerToModelPoint(e) {
  const rect = document.getElementById('cy').getBoundingClientRect();
  const pan = cy.pan();
  const zoom = cy.zoom();
  return {
    x: (e.clientX - rect.left - pan.x) / zoom,
    y: (e.clientY - rect.top - pan.y) / zoom,
  };
}

function getEdgeHandlePoint(edge) {
  if (!edge || edge.empty() || edge.removed()) return null;
  const midpoint = edge.midpoint && edge.midpoint();
  if (midpoint && Number.isFinite(midpoint.x) && Number.isFinite(midpoint.y)) {
    return midpoint;
  }
  const geometry = getEdgeCurveGeometry(edge);
  return geometry ? geometry.handle : null;
}

function updateCurveHandlePosition() {
  const handle = document.getElementById('edge-curve-handle');
  if (!curveHandleEdge || curveHandleEdge.empty() || curveHandleEdge.removed()) {
    hideCurveHandle();
    return;
  }
  const handlePoint = getEdgeHandlePoint(curveHandleEdge);
  if (!handlePoint) {
    hideCurveHandle();
    return;
  }
  const point = modelToViewportPoint(handlePoint);
  handle.style.left = `${point.x}px`;
  handle.style.top = `${point.y}px`;
}

function showCurveHandle(edge) {
  if (!edge || edge.empty() || edge.removed() || edge.id().startsWith('__')) return;
  curveHandleEdge = edge;
  const handle = document.getElementById('edge-curve-handle');
  handle.classList.remove('hidden');
  updateCurveHandlePosition();
}

function hideCurveHandle() {
  if (curveHandleDragging) return;
  curveHandleEdge = null;
  const handle = document.getElementById('edge-curve-handle');
  handle.classList.add('hidden');
  handle.classList.remove('dragging');
}

function scheduleCurveHandleHide(edge) {
  setTimeout(() => {
    const handle = document.getElementById('edge-curve-handle');
    if (curveHandleDragging || handle.matches(':hover')) return;
    if (edge && edge.hasClass && edge.hasClass('selected')) return;
    if (curveHandleEdge && edge && curveHandleEdge.id() !== edge.id()) return;
    hideCurveHandle();
  }, 80);
}

function setEdgeCurveFromPointer(edge, e) {
  const geometry = getEdgeCurveGeometry(edge);
  if (!geometry) return;
  const point = pointerToModelPoint(e);
  const rawHandleOffset =
    (point.x - geometry.mid.x) * geometry.normal.x +
    (point.y - geometry.mid.y) * geometry.normal.y;
  const rawCurve = rawHandleOffset * 2;
  const curve = Math.max(-EDGE_CURVE_LIMIT, Math.min(EDGE_CURVE_LIMIT, roundCurve(rawCurve)));
  const meta = { ...(edge.data('meta') || {}), curve };
  edge.data('meta', meta);
  edge.data('curve', curve);
  updateCurveHandlePosition();
}

async function persistEdgeCurve(edge) {
  if (!edge || edge.empty() || edge.removed()) return;
  const curve = getEdgeCurve(edge);
  try {
    const res = await updateEdgeMeta(edge, { curve });
    if (!res.ok) throw new Error('save failed');
    const saved = await res.json();
    edge.data('meta', saved.meta || {});
    edge.data('curve', getEdgeCurve(saved));
    updateCurveHandlePosition();
  } catch {
    showHint('Could not save curve');
  }
}

async function deleteEdgeById(edgeId) {
  await fetch(`/api/edges/${edgeId}`, { method: 'DELETE' });
}

function confirmDelete(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('delete-modal');
    const desc = document.getElementById('delete-modal-desc');
    const btnConfirm = document.getElementById('delete-confirm');
    const btnCancel = document.getElementById('delete-cancel');
    desc.textContent = message;

    function close(result) {
      modal.classList.add('hidden');
      btnConfirm.removeEventListener('click', onConfirm);
      btnCancel.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    function onConfirm() { close(true); }
    function onCancel() { close(false); }
    function onBackdrop(e) { if (e.target === modal) close(false); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    }

    btnConfirm.addEventListener('click', onConfirm);
    btnCancel.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    modal.classList.remove('hidden');
    btnConfirm.focus();
  });
}

async function deleteSelected() {
  if (!document.getElementById('delete-modal').classList.contains('hidden')) return;
  const nodes = cy.nodes('.selected').filter((n) => n.id() !== '__pending__' && n.data('taskId'));
  const edges = cy.edges('.selected');
  if (nodes.length === 0 && edges.length === 0) return;

  const parts = [];
  if (nodes.length) parts.push(`${nodes.length} ${nodes.length === 1 ? 'task' : 'tasks'}`);
  if (edges.length) parts.push(`${edges.length} ${edges.length === 1 ? 'edge' : 'edges'}`);
  if (!(await confirmDelete(`Delete ${parts.join(' and ')}?`))) return;

  for (const n of nodes) {
    await deleteTask(n.data('taskId'));
  }
  for (const e of edges) {
    const rawId = String(e.id()).replace(/^e/, '');
    await deleteEdgeById(rawId);
  }
  if (isPanelOpen()) hidePanel();
  clearSelection();
  await fetchGraph();
}

// --- Initialize ---
document.addEventListener('DOMContentLoaded', () => {
  cy = cytoscape({
    container: document.getElementById('cy'),
    style: [
      {
        selector: 'node',
        style: {
          'shape': 'round-rectangle',
          'background-color': 'data(color)',
          'border-color': '#403E3C',
          'border-width': 1.5,
          'label': 'data(title)',
          'text-valign': 'center',
          'text-halign': 'center',
          'font-size': '13px',
          'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          'color': '#CECDC3',
          'text-wrap': 'wrap',
          'text-max-width': '140px',
          'width': 'label',
          'height': 'label',
          'padding': '14px',
          'text-overflow-wrap': 'anywhere',
        },
      },
      {
        selector: 'node[status = "in_progress"]',
        style: {
          'border-color': '#DA702C',
          'border-width': 2,
        },
      },
      {
        selector: 'node[status = "done"]',
        style: {
          'border-color': '#879A39',
          'border-width': 2,
        },
      },
      {
        selector: 'node.selected',
        style: {
          'underlay-color': '#CECDC3',
          'underlay-opacity': 0.22,
          'underlay-padding': 5,
        },
      },
      {
        selector: 'node.selected.status-editing-todo',
        style: {
          'border-color': '#403E3C',
          'border-width': 1.5,
        },
      },
      {
        selector: 'node.selected.status-editing-in_progress',
        style: {
          'border-color': '#DA702C',
          'border-width': 2.5,
        },
      },
      {
        selector: 'node.selected.status-editing-done',
        style: {
          'border-color': '#879A39',
          'border-width': 2.5,
        },
      },
      {
        selector: 'node.editing',
        style: {
          'border-color': '#4385BE',
          'border-style': 'dashed',
          'border-width': 2.5,
          'text-opacity': 0,
        },
      },
      {
        selector: 'edge',
        style: {
          'width': 1.5,
          'line-color': 'data(color)',
          'curve-style': 'unbundled-bezier',
          'control-point-distances': 'data(curve)',
          'control-point-weights': 0.5,
        },
      },
      {
        selector: 'edge[edgeType = "dependency"]',
        style: {
          'target-arrow-shape': 'triangle',
          'target-arrow-color': 'data(color)',
          'line-color': 'data(color)',
          'width': 2,
        },
      },
      {
        selector: 'edge[edgeType = "related"]',
        style: {
          'target-arrow-shape': 'triangle',
          'target-arrow-color': 'data(color)',
          'source-arrow-shape': 'triangle',
          'source-arrow-color': 'data(color)',
          'line-color': 'data(color)',
          'width': 2,
        },
      },
      {
        selector: 'edge.selected',
        style: {
          'underlay-color': '#CECDC3',
          'underlay-opacity': 0.22,
          'underlay-padding': 5,
          'z-index': 9,
        },
      },
      {
        selector: 'edge.highlighted',
        style: {
          'line-color': '#D14D41',
          'target-arrow-color': '#D14D41',
          'width': 3.5,
          'z-index': 10,
        },
      },
      // Optimistic visual when an existing dependency edge is being flipped
      {
        selector: 'edge.dir-backward',
        style: {
          'target-arrow-shape': 'none',
          'source-arrow-shape': 'triangle',
          'source-arrow-color': 'data(color)',
        },
      },
      // Transient highlight while hovering a node during edge creation —
      // mirrors the .selected look so the user sees where the edge will land
      {
        selector: 'node.edge-hover-target',
        style: {
          'border-color': '#4385BE',
          'border-width': 3,
        },
      },
      // Edge-creation phantom: invisible cursor-tracker, ignores all events
      {
        selector: 'node.phantom',
        style: {
          'width': 1,
          'height': 1,
          'background-opacity': 0,
          'border-width': 0,
          'label': '',
          'events': 'no',
        },
      },
      // Edge-creation preview: muted version of the real edge style
      {
        selector: 'edge.preview',
        style: {
          'opacity': 0.6,
          'events': 'no',
          'z-index': 8,
        },
      },
    ],
    layout: { name: 'preset' },
    wheelSensitivity: 0.3,
    boxSelectionEnabled: false,
    selectionType: 'additive',
    minZoom: 0.2,
    maxZoom: 1.5,
  });

  // --- Node interactions ---
  cy.on('tap', 'node', (evt) => {
    const node = evt.target;
    if (node.id() === '__pending__' || node.id() === '__edge_target__') return;

    if (edgeCreation) {
      commitEdgeCreation(node);
      return;
    }
    if (edgeTypeEditing) cancelEdgeTypeEdit();
    if (statusEditing && statusEditing.nodeId !== node.id()) cancelStatusEdit();

    if (isCmd(evt.originalEvent)) {
      node.toggleClass('selected');
      if (statusEditing && cy.nodes('.selected').length !== 1) {
        cancelStatusEdit();
      }
    } else {
      cy.nodes().not(node).removeClass('selected');
      cy.edges().removeClass('selected');
      node.addClass('selected');
      hideCurveHandle();
      cancelPendingNode();
      showPanel(node);
    }
    updateToolbar();
  });

  // Edge tap → select / cmd-toggle
  cy.on('tap', 'edge', (evt) => {
    const edge = evt.target;
    if (edge.id().startsWith('__')) return; // ignore preview edge
    if (edgeTypeEditing && edgeTypeEditing.edgeId !== edge.id()) cancelEdgeTypeEdit();
    if (statusEditing) cancelStatusEdit();
    if (isCmd(evt.originalEvent)) {
      edge.toggleClass('selected');
      if (edge.hasClass('selected')) showCurveHandle(edge);
    } else {
      cy.nodes().removeClass('selected');
      cy.edges().not(edge).removeClass('selected');
      edge.addClass('selected');
      cancelPendingNode();
      if (isPanelOpen()) hidePanel();
      showCurveHandle(edge);
    }
    updateToolbar();
  });
  cy.on('mouseover', 'edge', (evt) => {
    const edge = evt.target;
    if (edge.id().startsWith('__')) return;
    showCurveHandle(edge);
  });
  cy.on('mouseout', 'edge', (evt) => {
    const edge = evt.target;
    if (edge.id().startsWith('__')) return;
    scheduleCurveHandleHide(edge);
  });

  // Right-click to delete (still works on a node)
  cy.on('cxttap', 'node', async (evt) => {
    const node = evt.target;
    if (node.id() === '__pending__') return;
    if (confirm(`Delete task "${node.data('title')}"?`)) {
      await deleteTask(node.data('taskId'));
      clearSelection();
      await fetchGraph();
    }
  });

  // Click background — empty space click creates a node; otherwise clears selection
  cy.on('tap', (evt) => {
    if (evt.target !== cy) return;
    if (isCmd(evt.originalEvent)) return; // cmd+click on bg is reserved for box-select start

    if (edgeCreation) {
      createPendingNodeFromEdgeCreation(evt.position);
      return;
    }

    const anySelected = cy.nodes('.selected').length > 0 || cy.edges('.selected').length > 0;
    if (anySelected) {
      clearSelection();
      if (isPanelOpen()) hidePanel();
      return;
    }
    if (pendingNode) {
      cancelPendingNode();
      return;
    }
    createNodeAt(evt.position);
  });

  // Double-click handlers: cmd selects all-of-type; plain dbl-click enters inline edit
  cy.on('dbltap', 'node', (evt) => {
    const node = evt.target;
    if (node.id() === '__pending__') return;
    if (isCmd(evt.originalEvent)) {
      cy.edges().removeClass('selected');
      cy.nodes().addClass('selected');
      updateToolbar();
      return;
    }
    startEditingNode(node);
  });
  cy.on('dbltap', 'edge', (evt) => {
    if (!isCmd(evt.originalEvent)) return;
    cy.nodes().removeClass('selected');
    cy.edges().addClass('selected');
    updateToolbar();
  });

  // After a node is dropped, push it out of any overlap with neighbors.
  cy.on('dragfree', 'node', (evt) => {
    const node = evt.target;
    if (node.id() === '__edge_target__') return;
    resolveNodeOverlap(node);
    const pos = node.position();
    const x = roundPosition(pos.x);
    const y = roundPosition(pos.y);
    if (node.id() === '__pending__') {
      pendingPosition = { x, y };
      panelLoadedMeta = { ...panelLoadedMeta, x, y };
      return;
    }
    persistNodePosition(node);
  });

  // While in edge creation, hovering a candidate target node previews the
  // connection by giving it the same blue ring as a selected node.
  cy.on('mouseover', 'node', (evt) => {
    if (!edgeCreation) return;
    const node = evt.target;
    if (node.id() === '__pending__' || node.id() === '__edge_target__') return;
    const sources = edgeCreation.sources || [edgeCreation.source].filter(Boolean);
    if (sources.some((source) => source.id() === node.id())) return;
    node.addClass('edge-hover-target');
  });
  cy.on('mouseout', 'node', (evt) => {
    evt.target.removeClass('edge-hover-target');
  });

  // --- Cmd+drag box select ---
  // Disable cytoscape's panning whenever cmd/ctrl is held so a drag on the
  // background becomes our rubber-band selection instead of a pan.
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && cy) cy.userPanningEnabled(false);
  });
  window.addEventListener('keyup', (e) => {
    if (!e.metaKey && !e.ctrlKey && cy) cy.userPanningEnabled(true);
  });
  window.addEventListener('blur', () => { if (cy) cy.userPanningEnabled(true); });

  let cmdBoxState = null;

  function showCmdBox(p1, p2) {
    const box = document.getElementById('cmd-box');
    const rect = document.getElementById('cy').getBoundingClientRect();
    const x = Math.min(p1.x, p2.x);
    const y = Math.min(p1.y, p2.y);
    const w = Math.abs(p2.x - p1.x);
    const h = Math.abs(p2.y - p1.y);
    box.style.left = (rect.left + x) + 'px';
    box.style.top = (rect.top + y) + 'px';
    box.style.width = w + 'px';
    box.style.height = h + 'px';
    box.classList.remove('hidden');
  }

  function hideCmdBox() {
    document.getElementById('cmd-box').classList.add('hidden');
  }

  cy.on('tapstart', (evt) => {
    if (evt.target !== cy) return;
    if (!isCmd(evt.originalEvent)) return;
    cmdBoxState = {
      startWorld: { x: evt.position.x, y: evt.position.y },
      startRendered: { x: evt.renderedPosition.x, y: evt.renderedPosition.y },
      additive: evt.originalEvent.shiftKey,
    };
    showCmdBox(cmdBoxState.startRendered, cmdBoxState.startRendered);
  });

  cy.on('tapdrag', (evt) => {
    if (!cmdBoxState) return;
    showCmdBox(cmdBoxState.startRendered, evt.renderedPosition);
  });

  cy.on('tapend', (evt) => {
    if (!cmdBoxState) return;
    const startW = cmdBoxState.startWorld;
    const endW = evt.position;
    const additive = cmdBoxState.additive;
    hideCmdBox();
    cmdBoxState = null;

    // Ignore zero-area drags (essentially a cmd+click on empty space)
    if (Math.abs(endW.x - startW.x) < 2 && Math.abs(endW.y - startW.y) < 2) return;

    const x1 = Math.min(startW.x, endW.x);
    const y1 = Math.min(startW.y, endW.y);
    const x2 = Math.max(startW.x, endW.x);
    const y2 = Math.max(startW.y, endW.y);

    if (!additive) {
      cy.nodes().removeClass('selected');
      cy.edges().removeClass('selected');
    }

    cy.nodes().forEach((n) => {
      if (n.id() === '__pending__') return;
      const bb = n.boundingBox();
      if (bb.x2 >= x1 && bb.x1 <= x2 && bb.y2 >= y1 && bb.y1 <= y2) {
        n.addClass('selected');
      }
    });
    cy.edges().forEach((edge) => {
      const m = edge.midpoint();
      if (m && m.x >= x1 && m.x <= x2 && m.y >= y1 && m.y <= y2) {
        edge.addClass('selected');
      }
    });

    updateToolbar();
  });

  // --- Keyboard shortcuts ---
  document.addEventListener('keydown', (e) => {
    const inField =
      e.target.tagName === 'INPUT' ||
      e.target.tagName === 'TEXTAREA' ||
      e.target.tagName === 'SELECT' ||
      e.target.isContentEditable;
    if (handleColorPaletteKey(e)) return;
    // Esc always works (closes overlay/panel/clears selection/cancels edge)
    if (e.key === 'Escape') {
      if (edgeCreation) {
        cancelEdgeCreation();
        e.preventDefault();
        return;
      }
      if (edgeTypeEditing) {
        cancelEdgeTypeEdit();
        e.preventDefault();
        return;
      }
      if (statusEditing) {
        cancelStatusEdit();
        e.preventDefault();
        return;
      }
      if (!document.getElementById('node-title-overlay').classList.contains('hidden')) {
        // Overlay's own keydown handles Esc; allow it to propagate
        return;
      }
      if (isPanelOpen()) {
        hidePanel();
        e.preventDefault();
      } else {
        clearSelection();
      }
      return;
    }
    // Cmd/Ctrl+Enter commits a new-node create from anywhere — including the
    // body editor where plain Enter inserts a newline.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (!editingTaskId && pendingNode) {
        e.preventDefault();
        window.__commitNewNode();
        return;
      }
    }
    if (inField) return;

    switch (e.key) {
      case 'f':
      case 'F':
        cy.fit(undefined, 50);
        showHint('Zoom to fit');
        break;
      case 'g':
      case 'G':
        createNodeAtCenter();
        break;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        if (moveSelection(e.key)) e.preventDefault();
        break;
      case 'e':
      case 'E':
        // E means: cycle direction in an in-progress edge, OR cycle the type
        // of a selected existing edge, OR start edge creation from a selected
        // node — depending on current state.
        if (edgeCreation) {
          cycleEdgeCreationDirection();
        } else if (cy.edges('.selected').filter((x) => !x.id().startsWith('__')).length === 1) {
          cycleSelectedEdgeType();
        } else {
          startEdgeCreation();
        }
        break;
      case 's':
      case 'S':
        cycleSelectedNodeStatus();
        break;
      case 'b':
      case 'B':
        if (!e.metaKey && !e.ctrlKey && !e.altKey && openColorPalette()) e.preventDefault();
        break;
      case 'Enter':
        if (edgeTypeEditing) {
          e.preventDefault();
          commitEdgeTypeEdit();
        } else if (statusEditing) {
          e.preventDefault();
          commitStatusEdit();
        }
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        deleteSelected();
        break;
    }
  });

  // --- Toolbar buttons ---
  document.getElementById('btn-new-node').addEventListener('click', createNodeAtCenter);
  document.getElementById('btn-status').addEventListener('click', cycleSelectedNodeStatus);
  document.getElementById('btn-color-node').addEventListener('click', (e) => openColorPalette(e.currentTarget));
  document.getElementById('btn-color-edge').addEventListener('click', (e) => openColorPalette(e.currentTarget));
  document.getElementById('btn-color-selection').addEventListener('click', (e) => openColorPalette(e.currentTarget));
  document.getElementById('btn-connect').addEventListener('click', startEdgeCreation);
  document.getElementById('btn-zoom-fit').addEventListener('click', () => {
    cy.fit(undefined, 50);
  });
  document.getElementById('btn-delete-node').addEventListener('click', deleteSelected);
  document.getElementById('btn-delete-edge').addEventListener('click', deleteSelected);
  document.getElementById('btn-delete-selection').addEventListener('click', deleteSelected);
  document.addEventListener('pointerdown', (e) => {
    if (!colorPaletteState.open) return;
    const palette = document.getElementById('color-palette');
    if (palette && palette.contains(e.target)) return;
    if (e.target.closest && e.target.closest('#btn-color-node, #btn-color-edge, #btn-color-selection')) return;
    closeColorPalette();
  });
  window.addEventListener('resize', () => {
    if (colorPaletteState.open) positionColorPalette(getColorPaletteAnchor());
  });

  const curveHandle = document.getElementById('edge-curve-handle');
  curveHandle.addEventListener('pointerdown', (e) => {
    if (!curveHandleEdge) return;
    curveHandleDragging = true;
    curveHandle.classList.add('dragging');
    cy.userPanningEnabled(false);
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (!curveHandleDragging || !curveHandleEdge) return;
    setEdgeCurveFromPointer(curveHandleEdge, e);
  });
  window.addEventListener('pointerup', () => {
    if (!curveHandleDragging) return;
    const edge = curveHandleEdge;
    curveHandleDragging = false;
    curveHandle.classList.remove('dragging');
    cy.userPanningEnabled(true);
    persistEdgeCurve(edge);
  });
  curveHandle.addEventListener('mouseleave', () => {
    if (!curveHandleEdge || curveHandleEdge.hasClass('selected')) return;
    scheduleCurveHandleHide(curveHandleEdge);
  });

  // --- Rich editor ---
  richEditor = new toastui.Editor({
    el: document.getElementById('rich-editor'),
    height: '100%',
    initialEditType: 'wysiwyg',
    previewStyle: 'vertical',
    hideModeSwitch: true,
    usageStatistics: false,
    theme: 'dark',
    toolbarItems: [
      ['heading'],
      ['bold', 'italic'],
      ['ul', 'ol'],
    ],
  });

  document.getElementById('mode-rich').addEventListener('click', () => setEditorMode('rich'));
  document.getElementById('mode-raw').addEventListener('click', () => setEditorMode('raw'));

  // --- Panel focus = edit mode for the selected node ---
  // Clicking into any panel field puts the selected node into edit mode (dashed border).
  // Leaving the panel — by clicking the canvas or another item — exits edit mode.
  const panelEl = document.getElementById('panel');
  panelEl.addEventListener('focusin', () => {
    cy.nodes('.selected').forEach((n) => n.addClass('editing'));
  });
  panelEl.addEventListener('focusout', () => {
    setTimeout(() => {
      // Still focused inside the panel? (e.g., tabbing fields) → keep edit mode
      if (panelEl.contains(document.activeElement)) return;
      // Don't drop edit mode if the inline overlay is what's active
      const overlayVisible = !document.getElementById('node-title-overlay').classList.contains('hidden');
      if (overlayVisible) return;
      cy.nodes('.editing').forEach((n) => {
        n.removeClass('editing');
        n.removeStyle('width');
        n.removeStyle('height');
      });
    }, 0);
  });

  // --- Panel resize ---
  const panel = document.getElementById('panel');
  const handle = document.getElementById('panel-resize-handle');
  let resizing = false;
  handle.addEventListener('mousedown', (e) => {
    resizing = true;
    panel.classList.add('resizing');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const next = window.innerWidth - e.clientX;
    const min = 320;
    const max = window.innerWidth * 0.95;
    panel.style.width = Math.min(max, Math.max(min, next)) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    panel.classList.remove('resizing');
  });

  // --- Autosave ---
  function showSaveStatus(text, kind) {
    const el = document.getElementById('save-status');
    el.textContent = text;
    el.classList.remove('saved-fade');
    el.dataset.kind = kind || '';
    clearTimeout(savedFadeTimer);
    if (kind === 'saved') {
      savedFadeTimer = setTimeout(() => el.classList.add('saved-fade'), 800);
    }
  }
  function clearSaveStatus() {
    const el = document.getElementById('save-status');
    el.textContent = '';
    el.dataset.kind = '';
    el.classList.remove('saved-fade');
    clearTimeout(savedFadeTimer);
  }

  async function performSave() {
    const titleVal = document.getElementById('field-title').value.trim();
    const statusVal = document.getElementById('field-status').value;
    const body = readEditorBody();
    if (!titleVal) return; // server requires a title

    const meta = { ...panelLoadedMeta, title: titleVal, status: statusVal };
    const content = buildContent(meta, body);
    if (content === lastSavedContent) return;

    if (saveInFlight) { pendingSave = true; return; }
    saveInFlight = true;
    showSaveStatus('Saving…', 'saving');

    try {
      const wasNew = !editingTaskId;
      const res = wasNew
        ? await createTask(content)
        : await updateTask(editingTaskId, content);
      if (!res.ok) {
        showSaveStatus('Save failed', 'error');
        return;
      }
      const saved = await res.json();
      if (wasNew && saved && saved.id) {
        editingTaskId = saved.id;
        const edgeIntent = pendingEdgesForNewNode;
        removePendingEdgePreviews(edgeIntent);
        pendingEdgesForNewNode = null;
        const overlayVisible = !document.getElementById('node-title-overlay').classList.contains('hidden');
        // Swap the ghost (if any) for the real node, preserving position
        let pos = pendingPosition;
        if (pendingNode && pendingNode.id() === '__pending__' && !pendingNode.removed()) {
          pos = pendingNode.position();
          pendingNode.remove();
        }
        pendingNode = null;
        pendingViewportBeforeCreate = null;
        addGraphNode(saved);
        const real = cy.getElementById(String(saved.id));
        if (real && !real.empty()) {
          if (pos) real.position(pos);
          real.addClass('selected');
          if (overlayVisible) real.addClass('editing');
          pendingNode = real; // keep tracking so the overlay stays anchored
        }
        await createPendingEdgesForSavedNode(saved.id, edgeIntent);
        await updateLeafHighlights();
        syncNodeToOverlay();
        positionTitleOverlay();
        updateToolbar();
      } else if (saved && saved.id) {
        updateGraphNode(saved);
        await updateLeafHighlights();
      }
      lastSavedContent = content;
      showSaveStatus('✓ Saved', 'saved');
    } catch (err) {
      showSaveStatus('Save failed', 'error');
    } finally {
      saveInFlight = false;
      if (pendingSave) {
        pendingSave = false;
        scheduleSave();
      }
    }
  }

  function scheduleSave() {
    if (!editingTaskId && !pendingNode) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(performSave, 200);
  }

  // Explicit "create the new node now" — wired to Enter in the title overlay,
  // title field, and Cmd+Enter globally.
  window.__commitNewNode = async () => {
    if (editingTaskId) return;
    if (!pendingNode) return;
    const titleVal = document.getElementById('field-title').value.trim();
    if (!titleVal) {
      showHint('Title required');
      return;
    }
    await performSave();
    if (editingTaskId) hideTitleOverlay();
  };

  // Allow hidePanel() to flush a pending save synchronously (existing nodes only)
  window.__flushSave = () => { performSave(); };

  // Title input is mirrored across the panel field, the inline overlay, and the cy node label
  function readTitleFrom(source, e) {
    if (source === 'overlay') {
      // Strip newlines and enforce 50 char cap
      let val = e.target.textContent.replace(/[\r\n]+/g, '');
      if (val.length > 50) {
        val = val.slice(0, 50);
        e.target.textContent = val;
        placeCaretAtEnd(e.target);
      }
      return val;
    }
    return e.target.value;
  }

  function onTitleInput(source) {
    return (e) => {
      const val = readTitleFrom(source, e);
      const overlay = document.getElementById('node-title-overlay');
      const overlayVisible = !overlay.classList.contains('hidden');

      // Mirror text between panel field and overlay
      if (source !== 'field') {
        const fld = document.getElementById('field-title');
        if (fld.value !== val) fld.value = val;
      }
      if (source !== 'overlay' && overlayVisible && overlay.textContent !== val) {
        overlay.textContent = val;
      }

      // Live-update the cytoscape node label ONLY while in edit mode.
      // In selected-only mode, the panel autosave round-trip will update it.
      if (overlayVisible) {
        const node = getActiveNode();
        if (node) node.data('title', val);
        syncNodeToOverlay();
        positionTitleOverlay();
      }

      scheduleSave();
    };
  }
  document.getElementById('field-title').addEventListener('input', onTitleInput('field'));
  document.getElementById('field-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !editingTaskId && pendingNode) {
      e.preventDefault();
      window.__commitNewNode();
    }
  });
  document.getElementById('node-title-overlay').addEventListener('input', onTitleInput('overlay'));
  document.getElementById('node-title-overlay').addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text').replace(/[\r\n]+/g, ' ');
    document.execCommand('insertText', false, text);
  });
  document.getElementById('node-title-overlay').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelPendingNode();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!editingTaskId && pendingNode) {
        // New node — Enter commits the create
        window.__commitNewNode();
      } else {
        // Existing node — just dismiss the inline title editor
        e.target.blur();
        hideTitleOverlay();
      }
    }
  });

  document.getElementById('field-status').addEventListener('change', scheduleSave);
  document.getElementById('raw-editor').addEventListener('input', scheduleSave);
  richEditor.on('change', scheduleSave);

  // Reposition the inline overlay when the canvas moves or the active node moves
  cy.on('pan zoom resize', () => {
    syncNodeToOverlay();
    positionTitleOverlay();
    updateCurveHandlePosition();
  });
  cy.on('position', 'node', (evt) => {
    const node = getActiveNode();
    if (node && evt.target.id() === node.id()) positionTitleOverlay();
    updateCurveHandlePosition();
  });
  window.addEventListener('resize', () => {
    positionTitleOverlay();
    updateCurveHandlePosition();
  });

  document.getElementById('task-form').addEventListener('submit', (e) => e.preventDefault());

  document.getElementById('panel-close').addEventListener('click', hidePanel);

  document.getElementById('btn-delete').addEventListener('click', async () => {
    if (editingTaskId && confirm('Delete this task?')) {
      await deleteTask(editingTaskId);
      hidePanel();
      clearSelection();
      await fetchGraph();
    }
  });

  // Initial render
  fetchGraph().then(() => updateToolbar());
});
