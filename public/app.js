let cy;
let editingTaskId = null;
let richEditor = null;

// --- Active graph (multi-graph support) ---
let activeGraphId = null;
const ACTIVE_GRAPH_STORAGE_KEY = 'graphtask:lastGraphId';

function apiBase() {
  if (activeGraphId == null) {
    throw new Error('no active graph');
  }
  return `/api/graphs/${activeGraphId}`;
}

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
const STATUS_ORDER = ['todo', 'in_progress', 'review', 'done'];
const STATUS_LABELS = {
  todo: 'Todo',
  in_progress: 'In progress',
  review: 'Review',
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
const EDGE_WEIGHT_MIN = 0.10;
const EDGE_WEIGHT_MAX = 0.90;
// Below this perpendicular distance, the curve is visually a straight line
// and weight has no perceptible effect — snap it to 0.5 to keep the data
// canonical.
const CURVE_SNAP_DISTANCE = 3;

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

// Canonical {distance, weight} for an edge or link. Tolerates the legacy
// number form (perpendicular offset only, weight implicitly 0.5) so old
// data and any in-flight requests keep working.
function getEdgeCurveData(edgeOrLink) {
  const meta = typeof edgeOrLink.data === 'function'
    ? edgeOrLink.data('meta')
    : edgeOrLink.meta;
  const c = meta && meta.curve;
  if (c == null) return { distance: 0, weight: 0.5 };
  if (typeof c === 'number') {
    return { distance: Number.isFinite(c) ? c : 0, weight: 0.5 };
  }
  const distance = Number(c.distance);
  const weight = Number(c.weight);
  return {
    distance: Number.isFinite(distance) ? distance : 0,
    weight: Number.isFinite(weight) ? weight : 0.5,
  };
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
      curveDistance: getEdgeCurveData({ meta }).distance,
      curveWeight: getEdgeCurveData({ meta }).weight,
      meta,
    },
  });
}

async function fetchGraph() {
  const res = await fetch(`${apiBase()}/graph`);
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
        curveDistance: getEdgeCurveData(link).distance,
        curveWeight: getEdgeCurveData(link).weight,
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
  const res = await fetch(`${apiBase()}/tasks/leaves`);
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
  const p = el.querySelector('p');
  const noGraph = activeGraphId == null;
  const noNodes = cy && cy.nodes().length === 0;
  if (noGraph || noNodes) {
    p.textContent = noGraph
      ? 'Click here for a new task'
      : 'Click anywhere to create your first task';
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

function directionIconSvg(direction) {
  const common = 'width="16" height="16" viewBox="0 0 256 256" fill="currentColor"';
  if (direction === 'backward') {
    return `<svg ${common} aria-hidden="true"><path d="M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z"/></svg>`;
  }
  if (direction === 'related') {
    return `<svg ${common} aria-hidden="true"><path d="M237.66,133.66l-32,32a8,8,0,0,1-11.32-11.32L212.69,136H43.31l18.35,18.34a8,8,0,0,1-11.32,11.32l-32-32a8,8,0,0,1,0-11.32l32-32a8,8,0,0,1,11.32,11.32L43.31,120H212.69l-18.35-18.34a8,8,0,0,1,11.32-11.32l32,32A8,8,0,0,1,237.66,133.66Z"/></svg>`;
  }
  return `<svg ${common} aria-hidden="true"><path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z"/></svg>`;
}

function getSelectedEdgeDirection() {
  const selectedEdges = cy.edges('.selected').filter((edge) => !edge.id().startsWith('__'));
  if (selectedEdges.length !== 1) return 'forward';
  const edge = selectedEdges[0];
  if (edgeTypeEditing && edgeTypeEditing.edgeId === edge.id()) {
    return edgeTypeEditing.currentDirection;
  }
  return edge.data('edgeType') === 'related' ? 'related' : 'forward';
}

function directionLabel(direction) {
  if (direction === 'backward') return 'Backward dependency';
  if (direction === 'related') return 'Related';
  return 'Forward dependency';
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
    const btnDirection = document.getElementById('btn-direction-edge');
    const iconEl = document.getElementById('tb-edge-direction-icon');
    const editingThis = isEdgeEditSelected();
    const direction = getSelectedEdgeDirection();
    dirEl.innerHTML = selectionSummaryHtml(editingThis);
    iconEl.innerHTML = directionIconSvg(direction);
    btnDirection.title = editingThis
      ? `${directionLabel(direction)}. Enter to confirm. Esc to cancel.`
      : `${directionLabel(direction)}. Press E to change.`;
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
    document.getElementById('tb-edge-creating-direction-icon').innerHTML = directionIconSvg(direction);
  }
}

// --- App settings (Cmd+K) ---
const SETTINGS_KEY = 'graphtask:settings';
const FONTS = [
  { id: 'inter', name: 'Inter', stack: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { id: 'garamond', name: 'EB Garamond', stack: '"EB Garamond", Garamond, "Times New Roman", serif' },
  { id: 'roboto', name: 'Roboto', stack: '"Roboto", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
];
const DEFAULT_SETTINGS = Object.freeze({
  font: 'inter',
  fontColor: '#CECDC3', // matches --tx
  bgColor: '#100F0F',   // matches --bg
});
let appSettings = { ...DEFAULT_SETTINGS };

function getFontStack(id) {
  return (FONTS.find((f) => f.id === id) || FONTS[0]).stack;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      appSettings = { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch (err) {
    appSettings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings));
  } catch (err) { /* storage unavailable; settings won't persist */ }
}

function applySettings() {
  const fontStack = getFontStack(appSettings.font);
  document.documentElement.style.setProperty('--app-font', fontStack);
  document.documentElement.style.setProperty('--app-font-color', appSettings.fontColor);
  const cyEl = document.getElementById('cy');
  if (cyEl) cyEl.style.background = appSettings.bgColor;
  if (cy) {
    cy.style().selector('node').style({
      'font-family': fontStack,
      'color': appSettings.fontColor,
    }).update();
  }
}

function setSettingFont(id) {
  if (!FONTS.find((f) => f.id === id)) return;
  appSettings.font = id;
  applySettings();
  saveSettings();
}
function setSettingFontColor(value) {
  appSettings.fontColor = value;
  applySettings();
  saveSettings();
}
function setSettingBgColor(value) {
  appSettings.bgColor = value;
  applySettings();
  saveSettings();
}

// --- Selection color palette ---
let colorPaletteState = {
  open: false,
  activeIndex: 0,
  target: 'selection', // 'selection' | 'settings-bg' | 'settings-font-color'
};

function findPaletteIndexForColor(value) {
  const target = normalizeColor(value);
  const idx = COLOR_PALETTE.findIndex((c) => normalizeColor(c.value) === target);
  return idx >= 0 ? idx : 0;
}

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
    // Settings palette pops down from the Cmd+K search bar (which sits high on
    // screen); selection palette pops up from a toolbar button at the bottom.
    const preferBelow = colorPaletteState.target !== 'selection';
    if (preferBelow) {
      top = anchorRect.bottom + 10;
      if (top + paletteRect.height > window.innerHeight - 8) {
        top = anchorRect.top - paletteRect.height - 10;
      }
    } else {
      top = anchorRect.top - paletteRect.height - 10;
      if (top < 8) top = anchorRect.bottom + 10;
    }
  }

  left = Math.min(window.innerWidth - paletteRect.width - 8, Math.max(8, left));
  top = Math.min(window.innerHeight - paletteRect.height - 8, Math.max(8, top));
  palette.style.left = `${left}px`;
  palette.style.top = `${top}px`;
}

function openColorPalette(anchor, target = 'selection') {
  if (target === 'selection') {
    if (edgeCreation || !hasColorableSelection()) return false;
    if (anchor === undefined) anchor = getColorPaletteAnchor();
  }
  if (edgeTypeEditing) cancelEdgeTypeEdit();
  if (statusEditing) cancelStatusEdit();

  renderColorPalette();
  const palette = document.getElementById('color-palette');
  if (!palette) return false;

  colorPaletteState.open = true;
  colorPaletteState.target = target;
  palette.classList.remove('hidden');
  let initialIndex;
  if (target === 'settings-bg') initialIndex = findPaletteIndexForColor(appSettings.bgColor);
  else if (target === 'settings-font-color') initialIndex = findPaletteIndexForColor(appSettings.fontColor);
  else initialIndex = getSelectionColorIndex();
  setActiveColorSwatch(initialIndex);
  positionColorPalette(anchor);
  setActiveColorSwatch(colorPaletteState.activeIndex, true);
  return true;
}

function closeColorPalette() {
  const palette = document.getElementById('color-palette');
  if (palette) palette.classList.add('hidden');
  colorPaletteState.open = false;
  colorPaletteState.target = 'selection';
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
    const taskRes = await fetch(`${apiBase()}/tasks/${taskId}`);
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
  const target = colorPaletteState.target;
  closeColorPalette();
  if (target === 'settings-bg') setSettingBgColor(color.value);
  else if (target === 'settings-font-color') setSettingFontColor(color.value);
  else applySelectionColor(color.value);
}

// --- Settings overlay (Cmd+K) ---
let settingsState = {
  open: false,
  mode: 'menu', // 'menu' | 'font'
  activeIndex: 0,
};

function settingsAnchorFromCmdBar() {
  // Capture the search bar's current rect so the palette can anchor to where
  // the cmd+K bar was, even after we close the settings overlay (which would
  // otherwise hide the element and zero out its rect).
  const search = document.getElementById('settings-search');
  if (!search) return null;
  const rect = search.getBoundingClientRect();
  return { getBoundingClientRect: () => rect };
}

function getSettingsItems() {
  if (settingsState.mode === 'font') {
    return [
      ...FONTS.map((f) => ({
        label: f.name,
        kbd: null,
        active: appSettings.font === f.id,
        previewStack: f.stack,
        onSelect: () => { setSettingFont(f.id); closeSettings(); },
      })),
      {
        label: 'Text color',
        kbd: 'C',
        colorDot: appSettings.fontColor,
        onSelect: () => {
          const anchor = settingsAnchorFromCmdBar();
          closeSettings();
          openColorPalette(anchor, 'settings-font-color');
        },
      },
    ];
  }
  return [
    {
      label: 'Font',
      kbd: 'F',
      previewStack: getFontStack(appSettings.font),
      onSelect: () => { settingsState.mode = 'font'; settingsState.activeIndex = 0; clearSettingsSearch(); renderSettings(); },
    },
    {
      label: 'Background',
      kbd: 'B',
      colorDot: appSettings.bgColor,
      onSelect: () => {
        const anchor = settingsAnchorFromCmdBar();
        closeSettings();
        openColorPalette(anchor, 'settings-bg');
      },
    },
  ];
}

function getFilteredSettingsItems() {
  const search = document.getElementById('settings-search');
  const q = (search ? search.value : '').trim().toLowerCase();
  const items = getSettingsItems();
  if (!q) return items;
  return items.filter((it) => it.label.toLowerCase().includes(q));
}

function clearSettingsSearch() {
  const search = document.getElementById('settings-search');
  if (search) search.value = '';
}

function renderSettings() {
  const list = document.getElementById('settings-results');
  if (!list) return;
  list.innerHTML = '';
  const items = getFilteredSettingsItems();
  if (items.length === 0) {
    settingsState.activeIndex = 0;
    return;
  }
  if (settingsState.activeIndex >= items.length) settingsState.activeIndex = items.length - 1;
  if (settingsState.activeIndex < 0) settingsState.activeIndex = 0;
  items.forEach((it, idx) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'settings-item' + (idx === settingsState.activeIndex ? ' active' : '');
    if (it.previewStack) row.style.fontFamily = it.previewStack;
    const label = document.createElement('span');
    label.textContent = it.label + (it.active ? ' ✓' : '');
    row.appendChild(label);
    const right = document.createElement('span');
    right.style.display = 'inline-flex';
    right.style.alignItems = 'center';
    right.style.gap = '8px';
    if (it.colorDot) {
      const dot = document.createElement('span');
      dot.className = 'settings-color-dot';
      dot.style.background = it.colorDot;
      right.appendChild(dot);
    }
    if (it.kbd) {
      const kbd = document.createElement('kbd');
      kbd.textContent = it.kbd;
      right.appendChild(kbd);
    }
    row.appendChild(right);
    row.addEventListener('click', () => it.onSelect());
    list.appendChild(row);
  });
}

function openSettings() {
  if (settingsState.open) return;
  closeColorPalette();
  settingsState.open = true;
  settingsState.mode = 'menu';
  settingsState.activeIndex = 0;
  document.getElementById('settings-overlay').classList.remove('hidden');
  clearSettingsSearch();
  renderSettings();
  // Default to hotkey mode: blur whatever was focused (panel input, gear
  // button, etc.) so document-level keydown captures hotkeys cleanly. The
  // search input stays unfocused until the user clicks it or presses '/'.
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }
}

function closeSettings() {
  if (!settingsState.open) return;
  settingsState.open = false;
  document.getElementById('settings-overlay').classList.add('hidden');
}

function handleSettingsKey(e) {
  if (!settingsState.open) return false;
  const search = document.getElementById('settings-search');
  // Search mode = the input itself is focused. In that mode hotkey letters
  // type into the box (so the user can search for "Font") instead of jumping.
  const isSearching = e.target === search;
  const items = getFilteredSettingsItems();

  // Esc always closes the whole overlay, regardless of submode or focus —
  // matches how Esc behaves everywhere else in the app.
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSettings();
    return true;
  }
  // '/' toggles search mode in either direction so the user is never trapped
  // inside the input.
  if (e.key === '/') {
    e.preventDefault();
    if (isSearching) {
      search.blur();
      clearSettingsSearch();
      settingsState.activeIndex = 0;
      renderSettings();
    } else {
      search.focus();
    }
    return true;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (items.length > 0) {
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      settingsState.activeIndex = (settingsState.activeIndex + delta + items.length) % items.length;
      renderSettings();
    }
    return true;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (items[settingsState.activeIndex]) items[settingsState.activeIndex].onSelect();
    return true;
  }
  // Hotkey jump (F/B/C) only when not in search mode.
  if (!isSearching && e.key.length === 1) {
    const k = e.key.toLowerCase();
    const match = items.find((it) => it.kbd && it.kbd.toLowerCase() === k);
    if (match) {
      e.preventDefault();
      match.onSelect();
      return true;
    }
  }
  return false;
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
  // Use cy.width()/height() (cy container) rather than window.innerWidth so
  // the sidebar's width is excluded — node.renderedPosition() is also in
  // cy-container coords.
  const targetX = (cy.width() - panelWidth) / 2;
  const targetY = cy.height() / 2;
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
  const status = document.getElementById('save-status');
  if (status) { status.textContent = ''; status.dataset.kind = ''; status.classList.remove('saved-fade'); }

  if (task) {
    title.textContent = 'Edit Task';
    fetch(`${apiBase()}/tasks/${editingTaskId}`)
      .then((r) => r.json())
      .then((full) => { loadIntoEditor(full.content); });
  } else {
    title.textContent = 'New Task';
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
  node.addClass('inline-title-edit');
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
    n.removeClass('inline-title-edit');
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
    const res = await fetch(`${apiBase()}/tasks/${editingTaskId}`);
    const full = await res.json();
    loadIntoEditor(full.content);
  } catch (err) {
    console.error('Failed to load task for editing:', err);
    return;
  }

  showTitleOverlay();
  updateToolbar();
}

async function createNodeAt(pos, options = {}) {
  // First click on a fresh install lazily creates a graph so the user
  // can start sketching tasks immediately.
  await ensureActiveGraph();
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
        curveDistance: 0,
        curveWeight: 0.5,
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
        curveDistance: 0,
        curveWeight: 0.5,
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
    edge.addClass('edge-type-editing');
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
  edge.addClass('edge-type-editing');
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

  const { edge, edgeId, originalType, originalSourceTaskId, originalTargetTaskId, currentDirection } = state;
  const isRelated = currentDirection === 'related';
  const isBackward = currentDirection === 'backward';
  const newType = isRelated ? 'related' : 'dependency';
  const newSourceId = isBackward ? originalTargetTaskId : originalSourceTaskId;
  const newTargetId = isBackward ? originalSourceTaskId : originalTargetTaskId;

  // Nothing actually changed
  if (!isBackward && newType === originalType) {
    if (edge && !edge.removed()) {
      edge.removeClass('edge-type-editing');
      edge.removeClass('dir-backward');
      edge.data('edgeType', originalType);
    }
    updateToolbar();
    return;
  }

  if (edge && !edge.removed()) edge.removeClass('edge-type-editing');
  const rawId = String(edgeId).replace(/^e/, '');
  try {
    const res = await fetch(`${apiBase()}/edges/${rawId}`, {
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
    edge.removeClass('edge-type-editing');
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
      const taskRes = await fetch(`${apiBase()}/tasks/${taskId}`);
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
  // cy.width()/height() are the cy container's size (already excludes the
  // sidebar); pan() is in cy-container coords, so screenX/Y must be too.
  const screenX = (cy.width() - panelWidth) / 2;
  const screenY = cy.height() / 2;
  const z = cy.zoom();
  const pan = cy.pan();
  createNodeAt({ x: (screenX - pan.x) / z, y: (screenY - pan.y) / z });
}

// --- API calls ---
async function createTask(content) {
  return fetch(`${apiBase()}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

async function updateTask(id, content) {
  return fetch(`${apiBase()}/tasks/${id}`, {
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
    const taskRes = await fetch(`${apiBase()}/tasks/${taskId}`);
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
  await fetch(`${apiBase()}/tasks/${id}`, { method: 'DELETE' });
}

async function createEdge(source_id, target_id, type) {
  return fetch(`${apiBase()}/edges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id, target_id, type }),
  });
}

async function updateEdgeMeta(edge, metaPatch) {
  const rawId = String(edge.id()).replace(/^e/, '');
  return fetch(`${apiBase()}/edges/${rawId}`, {
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

  const tangent = { x: dx / length, y: dy / length };
  const normal = { x: -tangent.y, y: tangent.x };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const { distance, weight: rawWeight } = getEdgeCurveData(edge);

  // Clamp weight to per-edge bounds derived from node sizes — keeps the
  // handle visibly outside both nodes even if a stale value was persisted
  // before nodes resized.
  const { wMin, wMax } = getEdgeWeightBounds(source, target, length);
  const weight = Math.max(wMin, Math.min(wMax, rawWeight));

  // Render the handle ON the curve at B(t=weight) — the bezier sample at the
  // weight parameter. Tangential position along S→T is the smoothstep
  // s(w) = w²(3-2w); perpendicular displacement at that t is 2(1-w)w·d.
  const s = weight * weight * (3 - 2 * weight);
  const tangentialOffset = (s - 0.5) * length;
  const perpendicularOffset = 2 * weight * (1 - weight) * distance;
  const handle = {
    x: mid.x + tangent.x * tangentialOffset + normal.x * perpendicularOffset,
    y: mid.y + tangent.y * tangentialOffset + normal.y * perpendicularOffset,
  };
  return { mid, tangent, normal, length, handle };
}

// Inverse of smoothstep s(w) = w²(3-2w) for y in [0,1] → w in [0,1].
// Closed form via the trigonometric solution to the cubic 2w³ - 3w² + y = 0.
function inverseSmoothstep(y) {
  if (y <= 0) return 0;
  if (y >= 1) return 1;
  return 0.5 - Math.sin(Math.asin(1 - 2 * y) / 3);
}

// Distance from the center of an axis-aligned rectangle to its boundary
// along a given direction. min(hw/|dx|, hh/|dy|) — pick whichever side the
// ray hits first. Treats nodes as their bounding rect; close enough for
// rounded rects too, slightly conservative at the corners.
function rectRadiusAlongDirection(width, height, dirX, dirY) {
  const hw = width / 2;
  const hh = height / 2;
  const ax = Math.abs(dirX);
  const ay = Math.abs(dirY);
  const tX = ax > 1e-9 ? hw / ax : Infinity;
  const tY = ay > 1e-9 ? hh / ay : Infinity;
  const t = Math.min(tX, tY);
  return Number.isFinite(t) ? t : Math.max(hw, hh);
}

// Per-edge dynamic weight bounds so the handle never lands inside either
// node. The keep-out zone is the actual rect radius along the edge direction
// plus a visual margin, expressed as a fraction along S→T and converted to
// a weight via inverse smoothstep. Intersected with the static
// [EDGE_WEIGHT_MIN, MAX] range.
const EDGE_HANDLE_MARGIN = 18;
function getEdgeWeightBounds(source, target, length) {
  const a = source.position();
  const b = target.position();
  const dirX = (b.x - a.x) / length;
  const dirY = (b.y - a.y) / length;
  const sourceR = rectRadiusAlongDirection(source.width(), source.height(), dirX, dirY);
  const targetR = rectRadiusAlongDirection(target.width(), target.height(), dirX, dirY);
  const fMin = (sourceR + EDGE_HANDLE_MARGIN) / length;
  const fMax = 1 - (targetR + EDGE_HANDLE_MARGIN) / length;
  if (fMin >= fMax) return { wMin: 0.5, wMax: 0.5 };
  const wMin = Math.max(EDGE_WEIGHT_MIN, inverseSmoothstep(Math.max(0, Math.min(1, fMin))));
  const wMax = Math.min(EDGE_WEIGHT_MAX, inverseSmoothstep(Math.max(0, Math.min(1, fMax))));
  if (wMin >= wMax) return { wMin: 0.5, wMax: 0.5 };
  return { wMin, wMax };
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
  // Don't use Cytoscape's edge.midpoint() — it returns the midpoint of the
  // rendered curve (B(0.5)), not our control point. With our handle-at-
  // control-point model that would visually cap drag reach at ~25% from
  // each endpoint regardless of the underlying weight value.
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
  const geom = getEdgeCurveGeometry(edge);
  if (!geom) return;
  const point = pointerToModelPoint(e);
  const dx = point.x - geom.mid.x;
  const dy = point.y - geom.mid.y;
  const alpha = dx * geom.tangent.x + dy * geom.tangent.y; // along S→T
  const beta = dx * geom.normal.x + dy * geom.normal.y;    // perpendicular

  // Inverse of the geometry: handle is at B(t=w), so the tangential
  // fraction-from-S equals smoothstep(w). Solve for w via inverse smoothstep,
  // then back out d from the perpendicular component, which at t=w is
  // 2(1-w)w·d.
  const fraction = Math.max(0, Math.min(1, alpha / geom.length + 0.5));
  let weight = inverseSmoothstep(fraction);

  // Per-edge dynamic clamp keeps the handle outside both node bodies. We
  // recompute it here because the geometry function uses the same source
  // data — keeping these in sync prevents render/drag drift.
  const { wMin, wMax } = getEdgeWeightBounds(edge.source(), edge.target(), geom.length);
  weight = Math.max(wMin, Math.min(wMax, weight));

  const denom = 2 * weight * (1 - weight);
  // denom is in (0, 0.5] for weight in (0,1), so this stays well-defined.
  let distance = beta / denom;
  distance = Math.max(-EDGE_CURVE_LIMIT, Math.min(EDGE_CURVE_LIMIT, roundCurve(distance)));
  weight = Math.round(weight * 1000) / 1000;

  const meta = { ...(edge.data('meta') || {}), curve: { distance, weight } };
  edge.data('meta', meta);
  edge.data('curveDistance', distance);
  edge.data('curveWeight', weight);
  updateCurveHandlePosition();
}

async function persistEdgeCurve(edge) {
  if (!edge || edge.empty() || edge.removed()) return;
  const curve = getEdgeCurveData(edge);
  try {
    const res = await updateEdgeMeta(edge, { curve });
    if (!res.ok) throw new Error('save failed');
    const saved = await res.json();
    edge.data('meta', saved.meta || {});
    const next = getEdgeCurveData(saved);
    edge.data('curveDistance', next.distance);
    edge.data('curveWeight', next.weight);
    updateCurveHandlePosition();
  } catch {
    showHint('Could not save curve');
  }
}

async function deleteEdgeById(edgeId) {
  await fetch(`${apiBase()}/edges/${edgeId}`, { method: 'DELETE' });
}

function confirmDelete(message, opts = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('delete-modal');
    const desc = document.getElementById('delete-modal-desc');
    const btnConfirm = document.getElementById('delete-confirm');
    const btnCancel = document.getElementById('delete-cancel');
    desc.textContent = message;
    const originalConfirmText = btnConfirm.textContent;
    if (opts.confirmText) btnConfirm.textContent = opts.confirmText;

    function close(result) {
      modal.classList.add('hidden');
      btnConfirm.textContent = originalConfirmText;
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

// --- Sidebar / multi-graph ---

const sidebar = {
  graphs: [],
};

// All time display in this app is UTC. Renders YYYY-MM-DD HH:MM UTC so the
// same graph reads identically to any viewer regardless of their browser tz.
function formatUtc(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

function relativeTime(iso) {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

async function fetchGraphsList() {
  const res = await fetch('/api/graphs');
  if (!res.ok) throw new Error('failed to load graphs');
  sidebar.graphs = await res.json();
  renderSidebar();
}

function renderSidebar() {
  const list = document.getElementById('sidebar-list');
  if (!list) return;
  list.innerHTML = '';
  for (const g of sidebar.graphs) {
    const item = document.createElement('div');
    item.className = 'sb-item' + (g.id === activeGraphId ? ' active' : '');
    item.dataset.graphId = String(g.id);
    if (g.description) item.title = g.description;

    const name = document.createElement('div');
    name.className = 'sb-name';
    name.textContent = g.name;
    item.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'sb-meta';
    meta.textContent = relativeTime(g.updated_at);
    item.appendChild(meta);

    const menuBtn = document.createElement('button');
    menuBtn.className = 'sb-menu-btn';
    menuBtn.textContent = '⋮';
    menuBtn.title = 'Graph options';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openGraphEditModal(g);
    });
    item.appendChild(menuBtn);

    item.addEventListener('click', () => {
      if (g.id !== activeGraphId) switchActiveGraph(g.id, { pushState: true });
    });

    list.appendChild(item);
  }
  updateEmptyStates();
}

function updateEmptyStates() {
  const sidebarEmpty = document.getElementById('sidebar-empty');
  const noGraphs = sidebar.graphs.length === 0;
  if (sidebarEmpty) sidebarEmpty.classList.toggle('hidden', !noGraphs);
  // Refresh the canvas-level empty-state hint so its copy matches
  // whether or not a graph is active.
  if (typeof updateEmptyState === 'function') updateEmptyState();
}

// Single edit modal — Save commits name + description; Delete confirms then removes.
let _graphModalClose = null;
function openGraphEditModal(graph) {
  // If the modal was already open (e.g. clicking ⋮ on another graph), tear
  // down the previous instance's listeners before binding new ones.
  if (_graphModalClose) _graphModalClose();

  const modal = document.getElementById('graph-modal');
  const nameInput = document.getElementById('graph-modal-name');
  const descInput = document.getElementById('graph-modal-desc');
  const createdEl = document.getElementById('graph-modal-created');
  const urlInput = document.getElementById('graph-modal-url');
  const copyBtn = document.getElementById('graph-modal-copy');
  const rotateBtn = document.getElementById('graph-modal-rotate');
  const saveBtn = document.getElementById('graph-modal-save');
  const deleteBtn = document.getElementById('graph-modal-delete');

  nameInput.value = graph.name;
  descInput.value = graph.description || '';
  createdEl.textContent = formatUtc(graph.created_at);
  function setShareUrl(id) {
    urlInput.value = `${location.origin}/g/${id}`;
  }
  setShareUrl(graph.id);

  function close() {
    _graphModalClose = null;
    modal.classList.add('hidden');
    saveBtn.removeEventListener('click', onSave);
    deleteBtn.removeEventListener('click', onDelete);
    copyBtn.removeEventListener('click', onCopy);
    rotateBtn.removeEventListener('click', onRotate);
    modal.removeEventListener('click', onBackdrop);
    document.removeEventListener('keydown', onKey, true);
  }
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(urlInput.value);
      const original = copyBtn.textContent;
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = original; }, 1200);
    } catch {
      urlInput.select();
    }
  }
  async function onRotate() {
    const ok = await confirmDelete(
      'Rotate this graph’s URL? Anyone holding the current link will lose access.',
      { confirmText: 'Rotate' }
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/graphs/${graph.id}/rotate-id`, { method: 'POST' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(e.error || 'Rotate failed');
        return;
      }
      const updated = await res.json();
      const wasActive = graph.id === activeGraphId;
      graph.id = updated.id;
      setShareUrl(updated.id);
      if (wasActive) {
        activeGraphId = updated.id;
        try { localStorage.setItem(ACTIVE_GRAPH_STORAGE_KEY, updated.id); } catch {}
        history.replaceState({ graphId: updated.id }, '', `/g/${updated.id}`);
      }
      await fetchGraphsList();
    } catch {
      alert('Rotate failed');
    }
  }
  async function onSave() {
    const nextName = nameInput.value.trim();
    const nextDescRaw = descInput.value;
    if (!nextName) {
      nameInput.focus();
      return;
    }
    const body = {};
    if (nextName !== graph.name) body.name = nextName;
    const trimmedDesc = nextDescRaw.trim();
    const newDesc = trimmedDesc === '' ? null : nextDescRaw;
    if (newDesc !== (graph.description ?? null)) body.description = newDesc;
    if (Object.keys(body).length === 0) { close(); return; }
    try {
      const res = await fetch(`/api/graphs/${graph.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(e.error || 'Save failed');
        return;
      }
      close();
      await fetchGraphsList();
    } catch {
      alert('Save failed');
    }
  }
  async function onDelete() {
    const ok = await confirmDelete(
      `Delete "${graph.name}"? This removes all its tasks and edges.`
    );
    if (!ok) return;
    await fetch(`/api/graphs/${graph.id}`, { method: 'DELETE' });
    close();
    if (graph.id === activeGraphId) {
      activeGraphId = null;
      try { localStorage.removeItem(ACTIVE_GRAPH_STORAGE_KEY); } catch {}
      history.replaceState({}, '', '/');
      if (cy) cy.elements().remove();
    }
    await fetchGraphsList();
    if (!activeGraphId && sidebar.graphs.length > 0) {
      await switchActiveGraph(sidebar.graphs[0].id, { pushState: true });
    } else {
      updateEmptyStates();
    }
  }
  function onBackdrop(e) { if (e.target === modal) close(); }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && e.target === nameInput) {
      e.preventDefault();
      onSave();
    }
  }

  saveBtn.addEventListener('click', onSave);
  deleteBtn.addEventListener('click', onDelete);
  copyBtn.addEventListener('click', onCopy);
  rotateBtn.addEventListener('click', onRotate);
  modal.addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onKey, true);
  _graphModalClose = close;
  modal.classList.remove('hidden');
  nameInput.focus();
  nameInput.select();
}

// Lazy-create a graph the first time the user does anything that needs one.
// Race-guarded so two fast clicks don't create two graphs.
let _ensureGraphPromise = null;
// id of a graph that was lazy-created in this session and hasn't yet had a
// task committed in it. If the user backs out before committing, we delete it
// so they don't accumulate empty "Untitled" graphs.
let _lazyCreatedGraphId = null;

function ensureActiveGraph() {
  if (activeGraphId != null) return Promise.resolve();
  if (_ensureGraphPromise) return _ensureGraphPromise;
  _ensureGraphPromise = (async () => {
    // Try "Untitled", then "Untitled 2", "Untitled 3", ... so the lazy-create
    // flow keeps working when the default name is already taken.
    let created = null;
    for (let i = 1; i <= 50; i++) {
      const name = i === 1 ? 'Untitled' : `Untitled ${i}`;
      const res = await fetch('/api/graphs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) { created = await res.json(); break; }
      if (res.status !== 409) throw new Error('failed to create graph');
    }
    if (!created) throw new Error('failed to create graph');
    _lazyCreatedGraphId = created.id;
    await fetchGraphsList();
    await switchActiveGraph(created.id, { pushState: true });
  })().finally(() => { _ensureGraphPromise = null; });
  return _ensureGraphPromise;
}

// If the user lazy-created a graph and then backed out without committing
// any task, delete it. Deferred via setTimeout(0) so an in-flight createNodeAt
// can re-add a ghost before the check runs.
let _lazyCleanupTimer = null;
function maybeCleanupLazyGraph() {
  if (_lazyCreatedGraphId == null) return;
  if (_lazyCreatedGraphId !== activeGraphId) return;
  if (_lazyCleanupTimer) clearTimeout(_lazyCleanupTimer);
  _lazyCleanupTimer = setTimeout(async () => {
    _lazyCleanupTimer = null;
    if (_lazyCreatedGraphId == null) return;
    if (_lazyCreatedGraphId !== activeGraphId) return;
    if (cy && cy.nodes().length > 0) return; // a node is back in play
    const gid = _lazyCreatedGraphId;
    _lazyCreatedGraphId = null;
    try { await fetch(`/api/graphs/${gid}`, { method: 'DELETE' }); } catch {}
    activeGraphId = null;
    try { localStorage.removeItem(ACTIVE_GRAPH_STORAGE_KEY); } catch {}
    history.replaceState({}, '', '/');
    await fetchGraphsList();
    updateEmptyStates();
  }, 0);
}

async function createGraphFromUI() {
  const created = await promptNewGraphName();
  if (!created) return;
  await fetchGraphsList();
  switchActiveGraph(created.id, { pushState: true });
}

// In-app modal replacement for the legacy prompt(). Resolves to the created
// graph row on success, or null on cancel. Validation + name-conflict errors
// render inline so the user can fix and retry without losing what they typed.
function promptNewGraphName() {
  return new Promise((resolve) => {
    const modal = document.getElementById('new-graph-modal');
    const input = document.getElementById('new-graph-name');
    const errorEl = document.getElementById('new-graph-error');
    const createBtn = document.getElementById('new-graph-create');
    const cancelBtn = document.getElementById('new-graph-cancel');

    input.value = '';
    errorEl.classList.add('hidden');
    errorEl.textContent = '';

    function setError(msg) {
      errorEl.textContent = msg;
      errorEl.classList.remove('hidden');
    }
    function clearError() {
      errorEl.classList.add('hidden');
      errorEl.textContent = '';
    }
    function close(result) {
      modal.classList.add('hidden');
      createBtn.removeEventListener('click', onCreate);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      input.removeEventListener('input', clearError);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    async function onCreate() {
      const trimmed = input.value.trim();
      if (!trimmed) {
        setError('Name is required');
        input.focus();
        return;
      }
      createBtn.disabled = true;
      try {
        const res = await fetch('/api/graphs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || 'Failed to create graph');
          input.focus();
          input.select();
          return;
        }
        const created = await res.json();
        close(created);
      } finally {
        createBtn.disabled = false;
      }
    }
    function onCancel() { close(null); }
    function onBackdrop(e) { if (e.target === modal) close(null); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && e.target === input) {
        e.preventDefault();
        onCreate();
      }
    }

    createBtn.addEventListener('click', onCreate);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    input.addEventListener('input', clearError);
    document.addEventListener('keydown', onKey, true);
    modal.classList.remove('hidden');
    input.focus();
  });
}

async function switchActiveGraph(id, { pushState = false } = {}) {
  activeGraphId = id;
  try { localStorage.setItem(ACTIVE_GRAPH_STORAGE_KEY, String(id)); } catch {}
  if (pushState) history.pushState({ graphId: id }, '', `/g/${id}`);
  renderSidebar();
  if (cy) cy.elements().remove();
  await fetchGraph();
  if (typeof updateToolbar === 'function') updateToolbar();
  openGraphEventStream(id);
}

// Live-update plumbing: open one EventSource per active graph. When the
// server emits a change (any task/edge mutation in this graph), do a
// selection-preserving refetch. The native EventSource auto-reconnects on
// drop, so we don't need our own retry loop here.
let _graphEventSource = null;
let _graphEventTimer = null;
function openGraphEventStream(id) {
  if (_graphEventSource) {
    try { _graphEventSource.close(); } catch {}
    _graphEventSource = null;
  }
  if (!id) return;
  const es = new EventSource(`/api/graphs/${id}/events`);
  es.onmessage = () => {
    if (id !== activeGraphId) return;
    // Coalesce bursts (e.g. a bulk-edges insert fires N notifications).
    if (_graphEventTimer) clearTimeout(_graphEventTimer);
    _graphEventTimer = setTimeout(() => {
      _graphEventTimer = null;
      refreshFromEvent();
    }, 150);
  };
  es.onerror = () => {
    // Native EventSource will auto-reconnect; no-op here. Keep the handler
    // so errors don't bubble to the console as unhandled.
  };
  _graphEventSource = es;
}

async function refreshFromEvent() {
  if (!cy) return;
  // Don't disturb a pending creation flow — fetchGraph wipes the canvas.
  if (pendingNode && !pendingNode.removed()) return;
  // Don't disturb an inline title edit either.
  if (cy.$('.inline-title-edit').length > 0) return;

  const selectedNodeIds = cy.nodes('.selected').map((n) => n.id());
  const selectedEdgeIds = cy.edges('.selected').map((e) => e.id());
  await fetchGraph();
  selectedNodeIds.forEach((id) => {
    const n = cy.getElementById(id);
    if (n && !n.empty()) n.addClass('selected');
  });
  selectedEdgeIds.forEach((id) => {
    const e = cy.getElementById(id);
    if (e && !e.empty()) e.addClass('selected');
  });
  if (typeof updateToolbar === 'function') updateToolbar();
}

function parseGraphIdFromPath() {
  const m = location.pathname.match(/^\/g\/([a-z0-9]+)\/?$/);
  return m ? m[1] : null;
}

async function bootSidebar() {
  await fetchGraphsList();
  // Resolve which graph to open: URL → localStorage → first available → none
  let target = parseGraphIdFromPath();
  if (target && !sidebar.graphs.some((g) => g.id === target)) target = null;
  if (target == null) {
    let stored = null;
    try { stored = localStorage.getItem(ACTIVE_GRAPH_STORAGE_KEY); } catch {}
    if (stored && sidebar.graphs.some((g) => g.id === stored)) target = stored;
  }
  if (target == null && sidebar.graphs.length > 0) target = sidebar.graphs[0].id;

  if (target == null) {
    activeGraphId = null;
    updateEmptyStates();
  } else {
    await switchActiveGraph(target, { pushState: parseGraphIdFromPath() !== target });
  }
}

window.addEventListener('popstate', () => {
  const id = parseGraphIdFromPath();
  if (id != null && sidebar.graphs.some((g) => g.id === id)) {
    if (id !== activeGraphId) switchActiveGraph(id, { pushState: false });
  } else if (id == null && activeGraphId != null) {
    activeGraphId = null;
    if (cy) cy.elements().remove();
    renderSidebar();
    updateEmptyStates();
  }
});

// --- Initialize ---
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
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
          'font-family': getFontStack(appSettings.font),
          'color': appSettings.fontColor,
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
        selector: 'node[status = "review"]',
        style: {
          'border-color': '#D0A215',
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
        },
      },
      {
        // Hide the cytoscape label only while the HTML title overlay is
        // rendering on top of the node, to avoid double-rendering. Panel-only
        // edits keep the label visible.
        selector: 'node.inline-title-edit',
        style: {
          'text-opacity': 0,
        },
      },
      {
        selector: 'edge',
        style: {
          'width': 1.5,
          'line-color': 'data(color)',
          'curve-style': 'unbundled-bezier',
          'control-point-distances': 'data(curveDistance)',
          'control-point-weights': 'data(curveWeight)',
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
        selector: 'edge.edge-type-editing',
        style: {
          'line-style': 'dashed',
          'line-dash-pattern': [8, 6],
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
    // Cmd+K toggles the settings overlay from anywhere, including inside fields.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (settingsState.open) closeSettings();
      else openSettings();
      return;
    }
    if (handleSettingsKey(e)) return;
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
  document.getElementById('btn-direction-edge').addEventListener('click', cycleSelectedEdgeType);
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
        // Lazy graph just got real content — don't auto-clean it.
        if (_lazyCreatedGraphId === activeGraphId) _lazyCreatedGraphId = null;
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
          if (overlayVisible) {
            real.addClass('editing');
            real.addClass('inline-title-edit');
          }
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

  // Keep the empty-state placeholder in sync with whether anything (pending
  // node included) is on the canvas, and trigger lazy-graph cleanup when the
  // canvas drops back to zero nodes.
  cy.on('add remove', 'node', () => updateEmptyState());
  cy.on('remove', 'node', () => maybeCleanupLazyGraph());

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

  // --- Settings overlay (Cmd+K) wiring ---
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('settings-search').addEventListener('input', () => {
    settingsState.activeIndex = 0;
    renderSettings();
  });
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'settings-overlay') closeSettings();
  });
  applySettings();

  // Sidebar wiring
  const newBtn = document.getElementById('sidebar-new-btn');
  if (newBtn) newBtn.addEventListener('click', createGraphFromUI);

  // Boot sidebar — fetches graphs, resolves active graph, loads its data.
  // Replaces the old single-graph fetchGraph() bootstrap.
  bootSidebar().then(() => {
    if (activeGraphId != null) updateToolbar();
  });
});
