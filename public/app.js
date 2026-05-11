let cy;
let editingTaskId = null;
let richEditor = null;

// Identifies this client as a human writer for server-side conflict
// resolution (see src/writerType.js + docs/optimistic-concurrency.md).
// Sent on every write request so a concurrent agent edit can't silently
// overwrite a human's same-field change.
const WRITE_HEADERS = {
  'Content-Type': 'application/json',
  'X-Writer-Type': 'human',
};

// --- Active graph (multi-graph support) ---
let activeGraphId = null;
// The full row for the active graph (name, description, is_public, settings,
// timestamps). Populated by switchActiveGraph; null when no graph is active.
// Used by getEffectiveSettings to compute per-graph overrides.
let currentGraph = null;
const ACTIVE_GRAPH_STORAGE_KEY = 'graphtask:lastGraphId';
const RECENT_GRAPHS_STORAGE_KEY = 'graphtask:recent';
const RECENTS_CAP = 20;
const PRIVATE_WARN_SUPPRESS_KEY = 'graphtask:hide-private-warn';
const SIDEBAR_COLLAPSED_KEY = 'graphtask:sidebarCollapsed';

function apiBase() {
  if (activeGraphId == null) {
    throw new Error('no active graph');
  }
  return `/api/graphs/${activeGraphId}`;
}

let editorMode = 'rich'; // 'rich' | 'raw'
let lastSavedContent = '';
let saveTimer = null;
// Timestamp until which scheduleSave should ignore editor change events.
// Set by loadIntoEditor to swallow the synthetic 'change' that
// richEditor.setMarkdown fires — without this we round-trip-PATCH the task,
// which fires a fresh SSE event, which calls loadIntoEditor again, etc.
let _editorSaveSuppressedUntil = 0;
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
// Theme-scoped defaults. The two values below are mutable because the
// active theme drives them — applyThemeDefaults() rewrites them when the
// user toggles between light and dark via Settings → Theme.
//   light → mymind reference (pre-cron design)
//   dark  → Cron Calendar reference (current design)
const THEME_DEFAULTS = {
  light: {
    font: 'inter',
    fontColor: '#3a475a',
    bgColor: '#f7f7f7',
    defaultNodeColor: '#ffffff',
    defaultEdgeColor: '#afb5c1',
  },
  dark: {
    font: 'helvetica',
    fontColor: '#ffffff',
    bgColor: '#0f0d0a',
    defaultNodeColor: '#161412',
    defaultEdgeColor: '#cccccc',
  },
};
let DEFAULT_NODE_COLOR = THEME_DEFAULTS.light.defaultNodeColor;
let DEFAULT_EDGE_COLOR = THEME_DEFAULTS.light.defaultEdgeColor;
function applyThemeDefaults(theme) {
  const t = THEME_DEFAULTS[theme] || THEME_DEFAULTS.light;
  DEFAULT_NODE_COLOR = t.defaultNodeColor;
  DEFAULT_EDGE_COLOR = t.defaultEdgeColor;
  return t;
}
const COLOR_PALETTE_COLUMNS = 5;
// User-pickable node BACKGROUND colors. Default tier is LIGHT per the tier
// rule, but family-light values for adjacent hues (red-light + orange-light,
// purple-light + purple-medium) are too visually similar at swatch size, so
// we substitute the family-medium where needed. Each swatch has a clearly
// different hue / saturation so the picker reads at a glance.
const COLOR_PALETTE = [
  { name: 'Base',     value: '#ffffff' }, // neutral-white
  { name: 'Peach',    value: '#ffd6c4' }, // red-light    (pale pinkish-peach)
  { name: 'Coral',    value: '#e27f6e' }, // red-medium   (saturated coral)
  { name: 'Orange',   value: '#fead81' }, // orange-medium (warm peach)
  { name: 'Yellow',   value: '#fef0bf' }, // yellow-light
  { name: 'Green',    value: '#deffe3' }, // green-light
  { name: 'Blue',     value: '#e2f9ff' }, // blue-light   (icy)
  { name: 'Sky',      value: '#95daf5' }, // blue-medium  (sky)
  { name: 'Lavender', value: '#efd6ff' }, // purple-medium
  { name: 'Muted',    value: '#e5e5e5' }, // neutral-grey
];

// User-pickable FONT colors. Font sits on top of bg, so it needs strong-tier
// saturation for legibility. Strong family colors + slate/black neutrals.
const FONT_COLOR_PALETTE = [
  { name: 'Slate',    value: '#3a475a' }, // deep-slate (default text)
  { name: 'Red',      value: '#ef3230' }, // red-strong
  { name: 'Orange',   value: '#fb5305' }, // main-orange (theme accent)
  { name: 'Amber',    value: '#fe7233' }, // orange-strong
  { name: 'Yellow',   value: '#f6c53e' }, // yellow-strong
  { name: 'Green',    value: '#49ca80' }, // green-strong
  { name: 'Blue',     value: '#43ace6' }, // blue-strong
  { name: 'Purple',   value: '#a45fff' }, // purple-strong
  { name: 'Coral',    value: '#e27f6e' }, // red-medium (warm mid-tone)
  { name: 'Black',    value: '#000000' },
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
  if (typeof task.version === 'number') node.data('version', task.version);
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
      version: typeof task.version === 'number' ? task.version : 0,
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
      version: typeof edge.version === 'number' ? edge.version : 0,
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
        version: typeof node.version === 'number' ? node.version : 0,
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
        version: typeof link.version === 'number' ? link.version : 0,
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
      spacingFactor: 0.75,
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
  { id: 'helvetica', name: 'Helvetica Neue', stack: '"Helvetica Neue", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  { id: 'inter',     name: 'Inter',          stack: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { id: 'garamond',  name: 'EB Garamond',    stack: '"EB Garamond", Garamond, "Times New Roman", serif' },
  { id: 'roboto',    name: 'Roboto',         stack: '"Roboto", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
];
const DEFAULT_SETTINGS = Object.freeze({
  // Dark theme is intentionally not selectable from the UI yet — it's still
  // a work-in-progress. Users default to (and are pinned to) light. The
  // dark code paths remain so we can re-enable the toggle later.
  theme: 'light',
  font: 'inter',
  fontColor: '#3a475a', // deep-slate (light-theme default)
  bgColor: '#f7f7f7',   // neutral-light-grey canvas
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
  // Dark theme is currently disabled — pin everyone to light, even users
  // whose localStorage carries a stale `theme: 'dark'` from earlier testing.
  if (appSettings.theme !== 'light') {
    appSettings.theme = 'light';
    appSettings.font = THEME_DEFAULTS.light.font;
    appSettings.fontColor = THEME_DEFAULTS.light.fontColor;
    appSettings.bgColor = THEME_DEFAULTS.light.bgColor;
  }
  applyThemeDefaults(appSettings.theme);
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings));
  } catch (err) { /* storage unavailable; settings won't persist */ }
}

// Effective settings = active graph's per-graph overrides ∘ app-level Defaults.
// Missing keys on the graph fall back to the user's defaults so a graph never
// "snapshots" the current default — it tracks whatever default is current
// until the user customizes that key explicitly.
function getEffectiveSettings() {
  const gs = (currentGraph && currentGraph.settings) || {};
  return {
    font: gs.font || appSettings.font,
    fontColor: gs.font_color || appSettings.fontColor,
    bgColor: gs.bg_color || appSettings.bgColor,
  };
}

function applySettings() {
  document.documentElement.dataset.theme = appSettings.theme;
  const eff = getEffectiveSettings();
  const fontStack = getFontStack(eff.font);
  document.documentElement.style.setProperty('--app-font', fontStack);
  document.documentElement.style.setProperty('--app-font-color', eff.fontColor);
  const cyEl = document.getElementById('cy');
  if (cyEl) cyEl.style.background = eff.bgColor;
  if (cy) {
    // Re-seat the full theme-scoped style array (the cron and mymind
    // arrays differ in many selectors — selection underlay, status borders,
    // editing colour, etc.), then re-apply per-graph font/colour overrides.
    cy.style().fromJson(cytoscapeStyle(appSettings.theme)).update();
    cy.style().selector('node').style({
      'font-family': fontStack,
      'color': eff.fontColor,
    }).update();
  }
}

function setSettingTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return;
  if (appSettings.theme === theme) return;
  // Each theme has its own canvas/font defaults; switching resets these to
  // the new theme's reference values. Per-graph appearance overrides are
  // untouched (they live on currentGraph.settings, not appSettings).
  const t = applyThemeDefaults(theme);
  appSettings.theme = theme;
  appSettings.font = t.font;
  appSettings.fontColor = t.fontColor;
  appSettings.bgColor = t.bgColor;
  applySettings();
  saveSettings();
  // Toast UI Editor theme is baked in at construction; recreate it so the
  // markdown editor's surface matches the new theme.
  recreateRichEditorForTheme();
}

// Toast UI Editor instance — built once at startup, recreated on theme switch.
function createRichEditor() {
  const editor = new toastui.Editor({
    el: document.getElementById('rich-editor'),
    height: '100%',
    initialEditType: 'wysiwyg',
    previewStyle: 'vertical',
    hideModeSwitch: true,
    usageStatistics: false,
    theme: appSettings.theme === 'dark' ? 'dark' : 'default',
    toolbarItems: [
      ['heading'],
      ['bold', 'italic'],
      ['ul', 'ol'],
    ],
  });
  // Toast UI only adds `.active` to toolbar buttons when the cursor sits
  // inside text that already carries the mark. It doesn't reflect
  // "armed" state — when you click Bold without a selection, ProseMirror
  // records bold in `storedMarks` (apply to next char), but the toolbar
  // stays visually idle. Sync the class ourselves from the underlying
  // ProseMirror state so the visual cue reflects what will happen if the
  // user starts typing.
  editor.on('caretChange', () => syncToolbarActiveMarks(editor));
  return editor;
}
function syncToolbarActiveMarks(editor) {
  const inner = editor.getCurrentModeEditor && editor.getCurrentModeEditor();
  if (!inner || !inner.view) return;
  const state = inner.view.state;
  const marks = state.storedMarks || state.selection.$from.marks();
  const names = new Set(marks.map((m) => m.type.name));
  const tb = document.querySelector('.toastui-editor-defaultUI-toolbar');
  if (!tb) return;
  const toggle = (cls, on) => {
    const btn = tb.querySelector(`.${cls}.toastui-editor-toolbar-icons`);
    if (btn) btn.classList.toggle('active', on);
  };
  toggle('bold', names.has('strong'));
  toggle('italic', names.has('emph') || names.has('em'));
}

function recreateRichEditorForTheme() {
  if (!richEditor) return;
  const md = richEditor.getMarkdown();
  try { richEditor.destroy(); } catch {}
  richEditor = createRichEditor();
  richEditor.setMarkdown(md, false);
  richEditor.on('change', scheduleSave);
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

// Font color picker uses a strong-tier palette; everything else (node bg,
// canvas bg) uses the light-tier COLOR_PALETTE.
function getActivePalette() {
  return colorPaletteState.target === 'settings-font-color' ? FONT_COLOR_PALETTE : COLOR_PALETTE;
}

function findPaletteIndexForColor(value) {
  const target = normalizeColor(value);
  const idx = getActivePalette().findIndex((c) => normalizeColor(c.value) === target);
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
  if (!palette) return;
  const active = getActivePalette();
  // Skip re-render if the same palette is already laid out — keyed by target
  // so swapping between bg-picker and font-picker correctly rebuilds.
  const paletteKey = colorPaletteState.target === 'settings-font-color' ? 'font' : 'bg';
  if (palette.dataset.rendered === paletteKey) return;
  palette.innerHTML = '';
  active.forEach((color, index) => {
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
  palette.dataset.rendered = paletteKey;
}

function setActiveColorSwatch(index, focus = false) {
  const palette = document.getElementById('color-palette');
  if (!palette) return;
  const len = getActivePalette().length;
  const nextIndex = (index + len) % len;
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
  const len = getActivePalette().length;
  const rows = Math.ceil(len / COLOR_PALETTE_COLUMNS);
  const currentRow = Math.floor(colorPaletteState.activeIndex / COLOR_PALETTE_COLUMNS);
  const currentCol = colorPaletteState.activeIndex % COLOR_PALETTE_COLUMNS;
  let nextRow = (currentRow + rowDelta + rows) % rows;
  let nextCol = (currentCol + colDelta + COLOR_PALETTE_COLUMNS) % COLOR_PALETTE_COLUMNS;
  let nextIndex = nextRow * COLOR_PALETTE_COLUMNS + nextCol;

  while (nextIndex >= len) {
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

  // Set the target BEFORE rendering so renderColorPalette picks the right
  // palette (font vs bg). If we render first, we'd render with the previous
  // target's palette and the swatches wouldn't match the picker's purpose.
  colorPaletteState.target = target;
  renderColorPalette();
  const palette = document.getElementById('color-palette');
  if (!palette) return false;

  colorPaletteState.open = true;
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
    setActiveColorSwatch(getActivePalette().length - 1, true);
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
  let base = null;
  if (String(editingTaskId) === String(taskId)) {
    const titleVal = document.getElementById('field-title').value.trim();
    if (!titleVal) throw new Error('Title required');
    const statusVal = document.getElementById('field-status').value;
    content = buildContent({ ...panelLoadedMeta, title: titleVal, status: statusVal, color }, readEditorBody());
    if (panelLoadedVersion !== null && panelLoadedContent !== null) {
      base = { version: panelLoadedVersion, content: panelLoadedContent };
    }
  } else {
    const taskRes = await fetch(`${apiBase()}/tasks/${taskId}`);
    if (!taskRes.ok) throw new Error('load failed');
    const task = await taskRes.json();
    const parsed = parseFrontmatter(task.content);
    content = buildContent({ ...(parsed.meta || {}), color }, parsed.body);
    base = task;
  }

  const res = await updateTask(taskId, content, base);
  if (!res.ok) {
    if (handleConflictStatus(res, 'task')) {
      await fetchGraph();
      return;
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Could not update color');
  }
  const saved = await res.json();
  updateGraphNode(saved);
  if (String(editingTaskId) === String(taskId)) {
    panelLoadedMeta = { ...panelLoadedMeta, color };
    panelLoadedVersion = saved.version ?? panelLoadedVersion;
    panelLoadedContent = saved.content ?? panelLoadedContent;
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
  if (typeof saved.version === 'number') edge.data('version', saved.version);
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
  const color = getActivePalette()[index];
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
  // Theme sub-mode is intentionally unreachable from the menu while dark is
  // a work-in-progress. The case is kept so re-enabling the entry below is
  // a one-line change.
  if (settingsState.mode === 'theme') {
    return [
      { label: 'Light', kbd: null, active: appSettings.theme === 'light', onSelect: () => { setSettingTheme('light'); closeSettings(); } },
      { label: 'Dark',  kbd: null, active: appSettings.theme === 'dark',  onSelect: () => { setSettingTheme('dark');  closeSettings(); } },
    ];
  }
  return [
    // To re-enable theme switching, restore this entry:
    //   { label: 'Theme', kbd: 'T', onSelect: () => { settingsState.mode = 'theme'; settingsState.activeIndex = 0; clearSettingsSearch(); renderSettings(); } },
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
// Base for OCC three-way merge on PATCH: the version + content the panel
// last loaded from the server. Sent as `base_version` / `base_content` so
// the server can reconcile a concurrent edit instead of clobbering it.
// Refreshed on every load and after every successful save.
let panelLoadedVersion = null;
let panelLoadedContent = null;

function loadIntoEditor(content, task = null) {
  // richEditor.setMarkdown below fires a synthetic 'change' event, which
  // would normally schedule a save. That save would PATCH the task with
  // editor-roundtripped content (lossy whitespace), which fires a fresh
  // SSE event back to us — infinite loop / "double focus" bug. Suppress
  // scheduleSave for a brief window so the synthetic change is ignored
  // but real user edits a moment later still save normally.
  _editorSaveSuppressedUntil = Date.now() + 200;
  const { meta, body } = parseFrontmatter(content);
  panelLoadedMeta = meta;
  panelLoadedVersion = task && typeof task.version === 'number' ? task.version : null;
  panelLoadedContent = task && typeof task.content === 'string' ? task.content : null;
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
      .then((full) => { loadIntoEditor(full.content, full); });
  } else {
    title.textContent = 'New Task';
    loadIntoEditor('---\ntitle: \nstatus: todo\n---\n');
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
    loadIntoEditor(full.content, full);
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
    status.textContent = '';
    status.dataset.kind = '';
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
    const baseRow = edge && !edge.removed() ? edgeBaseRow(edge) : null;
    const res = await patchWithRetry(
      `${apiBase()}/edges/${rawId}`,
      (base) => {
        const body = { source_id: newSourceId, target_id: newTargetId, type: newType };
        if (base) {
          body.base_row = base;
          body.base_version = base.version;
        }
        return body;
      },
      baseRow,
      'edge',
    );
    if (!res.ok) {
      if (!handleConflictStatus(res, 'edge')) {
        const err = await res.json().catch(() => ({}));
        showHint(err.error || 'Could not update edge');
      }
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
    let base = null;
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
      if (panelLoadedVersion !== null && panelLoadedContent !== null) {
        base = { version: panelLoadedVersion, content: panelLoadedContent };
      }
    } else {
      const taskRes = await fetch(`${apiBase()}/tasks/${taskId}`);
      if (!taskRes.ok) throw new Error('fetch failed');
      const task = await taskRes.json();
      const parsed = parseFrontmatter(task.content);
      const meta = { ...(parsed.meta || {}), status: currentStatus };
      content = buildContent(meta, parsed.body);
      base = task;
    }

    const res = await updateTask(taskId, content, base);
    if (!res.ok) {
      if (!handleConflictStatus(res, 'task')) {
        const err = await res.json().catch(() => ({}));
        showHint(err.error || 'Could not update status');
      }
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
      panelLoadedVersion = saved.version ?? panelLoadedVersion;
      panelLoadedContent = saved.content ?? panelLoadedContent;
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

// Map a non-OK write response to a user-facing toast for the two OCC
// outcomes the server can return: 409 version_conflict (concurrent write
// occurred and the server couldn't auto-merge) and 410 Gone (row was
// deleted while we were editing). Returns true if the status was handled
// here, false to let the caller fall back to a generic failure message.
// Callers should refetch graph state after a true return.
function handleConflictStatus(res, label = 'item') {
  if (res.status === 410) {
    showHint(`This ${label} was deleted elsewhere`);
    return true;
  }
  if (res.status === 409) {
    showHint(`${label} changed elsewhere — refreshing`);
    return true;
  }
  return false;
}

// Snapshot helpers — produce the `base_row` the server uses to do a
// three-way merge against concurrent writes. Values come from local state
// (cytoscape data for edges, currentGraph / the closure's `graph` for
// graphs) so they reflect what the user was looking at when they made
// the edit.
function edgeBaseRow(edge) {
  if (!edge || edge.removed()) return null;
  const v = edge.data('version');
  return {
    source_id: parseInt(edge.data('source'), 10),
    target_id: parseInt(edge.data('target'), 10),
    type: edge.data('edgeType'),
    meta: edge.data('meta') || {},
    version: typeof v === 'number' ? v : 0,
  };
}
function graphBaseRow(graph) {
  if (!graph) return null;
  return {
    name: graph.name,
    description: graph.description ?? null,
    is_public: !!graph.is_public,
    settings: graph.settings || {},
    version: typeof graph.version === 'number' ? graph.version : 0,
  };
}

// Defensive 409 retry: server resolves disjoint cases itself, so this only
// fires when the merge can't be auto-resolved (e.g. validation fails on the
// merged result). Retry once with the server-supplied `current` as the new
// base — if THAT still 409s, surface the toast.
async function patchWithRetry(url, buildBody, baseRow, label = 'item') {
  let res = await fetch(url, {
    method: 'PATCH',
    headers: WRITE_HEADERS,
    body: JSON.stringify(buildBody(baseRow)),
  });
  if (res.status !== 409) return res;
  const cloned = res.clone();
  let body;
  try { body = await cloned.json(); } catch { return res; }
  if (body?.error !== 'version_conflict' || !body.current) return res;
  const freshBase = { ...body.current, version: body.current.version };
  const retry = await fetch(url, {
    method: 'PATCH',
    headers: WRITE_HEADERS,
    body: JSON.stringify(buildBody(freshBase)),
  });
  return retry;
}

// --- API calls ---
async function createTask(content) {
  return fetch(`${apiBase()}/tasks`, {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify({ content }),
  });
}

// `base` is { version, content } from the most recent server read of this
// task. When supplied, the server can three-way merge a concurrent edit
// instead of clobbering it. Omitted on writes that don't have a base
// available (e.g. first PATCH after a fresh-page race) — the server falls
// back to last-write-wins for those.
async function updateTask(id, content, base = null) {
  const body = { content };
  if (base && typeof base.version === 'number' && typeof base.content === 'string') {
    body.base_version = base.version;
    body.base_content = base.content;
  }
  return fetch(`${apiBase()}/tasks/${id}`, {
    method: 'PATCH',
    headers: WRITE_HEADERS,
    body: JSON.stringify(body),
  });
}

// Re-run the breadthfirst layout with tight spacing, persist the new
// positions, and zoom-to-fit. Use when manual placements have left the graph
// sprawling and you want to start over with a clean compact arrangement.
// Destructive of any custom node positions — that's the point.
async function tidyAndFit() {
  if (!cy || cy.elements().length === 0) return;
  cy.layout({
    name: 'breadthfirst',
    directed: true,
    spacingFactor: 0.75,
    avoidOverlap: true,
    fit: false,
  }).run();
  resolveAllOverlaps();
  cy.fit(undefined, 50);
  // Persist each node's new position so it survives reloads. Done in
  // parallel; persistNodePosition swallows individual failures with a hint.
  await Promise.all(
    cy.nodes()
      .filter((n) => n.data('taskId') && !n.id().startsWith('__'))
      .map((n) => persistNodePosition(n))
  );
  showHint('Tidied & fit');
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
    const updateRes = await updateTask(taskId, content, task);
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
    headers: WRITE_HEADERS,
    body: JSON.stringify({ source_id, target_id, type }),
  });
}

async function updateEdgeMeta(edge, metaPatch) {
  const rawId = String(edge.id()).replace(/^e/, '');
  const url = `${apiBase()}/edges/${rawId}`;
  const baseRow = edgeBaseRow(edge);
  return patchWithRetry(
    url,
    (base) => {
      const body = { meta: metaPatch };
      if (base) {
        body.base_row = base;
        body.base_version = base.version;
      }
      return body;
    },
    baseRow,
    'edge',
  );
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
    if (typeof saved.version === 'number') edge.data('version', saved.version);
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
    const title = document.getElementById('delete-modal-title');
    const desc = document.getElementById('delete-modal-desc');
    const btnConfirm = document.getElementById('delete-confirm');
    const btnCancel = document.getElementById('delete-cancel');
    desc.textContent = message;
    const originalTitle = title.textContent;
    const originalConfirmText = btnConfirm.textContent;
    if (opts.title) title.textContent = opts.title;
    if (opts.confirmText) btnConfirm.textContent = opts.confirmText;

    function close(result) {
      modal.classList.add('hidden');
      title.textContent = originalTitle;
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
  graphs: [],   // public graphs from GET /api/graphs
  recents: [],  // browser-local visit history; see RECENT_GRAPHS_STORAGE_KEY
};

// Recent-graphs persistence — purely client-side. The server does not know
// which graphs you've visited; that's the privacy model. Each entry caches
// {id, name, is_public, last_visited_at} so the sidebar can render without
// a round-trip; entries are refreshed lazily by fetchGraphsList.
function recentsRead() {
  try {
    const raw = localStorage.getItem(RECENT_GRAPHS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r) => r && typeof r.id === 'string');
  } catch { return []; }
}

function recentsWrite(list) {
  try {
    localStorage.setItem(
      RECENT_GRAPHS_STORAGE_KEY,
      JSON.stringify(list.slice(0, RECENTS_CAP))
    );
  } catch {}
}

function recentsUpsert(graph) {
  if (!graph || typeof graph.id !== 'string') return;
  const list = recentsRead();
  const i = list.findIndex((r) => r.id === graph.id);
  if (i >= 0) list.splice(i, 1);
  list.unshift({
    id: graph.id,
    name: graph.name,
    is_public: !!graph.is_public,
    last_visited_at: new Date().toISOString(),
  });
  recentsWrite(list);
  sidebar.recents = list;
}

function recentsRemove(id) {
  const list = recentsRead().filter((r) => r.id !== id);
  recentsWrite(list);
  sidebar.recents = list;
}

// Sidebar collapse state. Driven by `.collapsed` on `#sidebar`; CSS hides
// the title, list, and bottom-spacer text, leaving the expand and gear
// icons. Persisted across reloads.
function isSidebarCollapsed() {
  const el = document.getElementById('sidebar');
  return !!(el && el.classList.contains('collapsed'));
}

function setSidebarCollapsed(collapsed) {
  const el = document.getElementById('sidebar');
  if (!el) return;
  el.classList.toggle('collapsed', !!collapsed);
  // The canvas, bottom toolbar, and panel all anchor off `--sidebar-w` so
  // they reflow when the sidebar shrinks. Keep that var in sync.
  document.documentElement.style.setProperty('--sidebar-w', collapsed ? '48px' : '240px');
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {}
  // Cytoscape sized off the parent — let it know the viewport changed.
  if (typeof cy !== 'undefined' && cy) {
    requestAnimationFrame(() => { try { cy.resize(); } catch {} });
  }
}

function applySidebarCollapsedFromStorage() {
  let stored = '0';
  try { stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) || '0'; } catch {}
  setSidebarCollapsed(stored === '1');
}

// All time display in this app is UTC so the same graph reads identically
// to any viewer regardless of their browser tz. Two formats:
//   formatUtc      → MM/DD/YY        (compact, default)
//   formatUtcLong  → YYYY-MM-DD HH:MM UTC (full, on hover/click in modal)
function formatUtc(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCFullYear() % 100)}`;
}
function formatUtcLong(iso) {
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
  sidebar.recents = recentsRead();
  renderSidebar();
  // Lazy refresh of recents: fetch each cached entry to update name/is_public
  // and drop entries the user no longer has access to (404).
  refreshRecents();
}

async function refreshRecents() {
  const list = recentsRead();
  let changed = false;
  for (const r of list) {
    try {
      const res = await fetch(`/api/graphs/${encodeURIComponent(r.id)}`);
      if (res.status === 404) {
        const after = recentsRead().filter((e) => e.id !== r.id);
        recentsWrite(after);
        sidebar.recents = after;
        changed = true;
        continue;
      }
      if (!res.ok) continue;
      const row = await res.json();
      if (row.name !== r.name || !!row.is_public !== !!r.is_public) {
        const current = recentsRead();
        const i = current.findIndex((e) => e.id === r.id);
        if (i >= 0) {
          current[i] = { ...current[i], name: row.name, is_public: !!row.is_public };
          recentsWrite(current);
          sidebar.recents = current;
          changed = true;
        }
      }
    } catch { /* network/transient — leave the cached entry alone */ }
  }
  if (changed) renderSidebar();
}

function renderSidebar() {
  const list = document.getElementById('sidebar-list');
  if (!list) return;
  list.innerHTML = '';

  const publicGraphs = sidebar.graphs;
  const publicIds = new Set(publicGraphs.map((g) => g.id));
  // Recents section excludes anything already shown in Public.
  const recentEntries = sidebar.recents.filter((r) => !publicIds.has(r.id));

  if (publicGraphs.length > 0) {
    list.appendChild(makeSectionHeader('Public'));
    for (const g of publicGraphs) list.appendChild(makeSidebarItem(g, { source: 'public' }));
  }
  if (recentEntries.length > 0) {
    list.appendChild(makeSectionHeader('Recently visited'));
    for (const r of recentEntries) list.appendChild(makeSidebarItem(r, { source: 'recent' }));
  }
  updateEmptyStates();
}

function makeSectionHeader(text) {
  const h = document.createElement('div');
  h.className = 'sb-section';
  h.textContent = text;
  return h;
}

function makeSidebarItem(graphLike, { source }) {
  const item = document.createElement('div');
  item.className = 'sb-item' + (graphLike.id === activeGraphId ? ' active' : '');
  item.dataset.graphId = String(graphLike.id);
  if (graphLike.description) item.title = graphLike.description;

  // Status dot in the left gutter, on the title row. Orange when this is the
  // active graph, grey otherwise (orange comes from the .active class).
  const dot = document.createElement('span');
  dot.className = 'sb-dot';
  item.appendChild(dot);

  const name = document.createElement('div');
  name.className = 'sb-name';
  name.appendChild(document.createTextNode(graphLike.name));
  item.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'sb-meta';
  const stamp = graphLike.updated_at || graphLike.last_visited_at;
  meta.textContent = stamp ? relativeTime(stamp) : '';
  item.appendChild(meta);

  // Lock icon for any row currently known to be private. Absolutely positioned
  // in the row's left gutter so the title and timestamp share the same X.
  // Recents cache is_public; the public list never gets one.
  if (source === 'recent' && !graphLike.is_public) {
    const lock = document.createElement('i');
    lock.className = 'ph ph-lock-simple sb-lock';
    lock.title = 'Private — only people with the URL can see this graph';
    item.appendChild(lock);
  }

  const menuBtn = document.createElement('button');
  menuBtn.className = 'sb-menu-btn';
  menuBtn.textContent = '⋮';
  menuBtn.title = 'Graph options';
  menuBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Public rows already carry full metadata (name, description, created_at,
    // updated_at, is_public) from GET /api/graphs. Recents cache only the
    // subset we need to render — fetch the full row so the modal can show
    // description / created_at and produce a clean diff on Save.
    if (source === 'public') {
      openGraphEditModal(graphLike);
      return;
    }
    try {
      const res = await fetch(`/api/graphs/${encodeURIComponent(graphLike.id)}`);
      if (!res.ok) {
        alert('Could not open graph options');
        return;
      }
      openGraphEditModal(await res.json());
    } catch {
      alert('Could not open graph options');
    }
  });
  item.appendChild(menuBtn);

  item.addEventListener('click', () => {
    if (graphLike.id !== activeGraphId) switchActiveGraph(graphLike.id, { pushState: true });
  });

  return item;
}

function updateEmptyStates() {
  const sidebarEmpty = document.getElementById('sidebar-empty');
  const nothingToShow =
    sidebar.graphs.length === 0 && sidebar.recents.length === 0;
  if (sidebarEmpty) sidebarEmpty.classList.toggle('hidden', !nothingToShow);
  // Refresh the canvas-level empty-state hint so its copy matches
  // whether or not a graph is active.
  if (typeof updateEmptyState === 'function') updateEmptyState();
}

// Single edit modal — Save commits name + description; Delete confirms then removes.
let _graphModalClose = null;

// Convergence point for Cmd+K, the toolbar Settings button, and the
// post-create modal's Settings button. Toggles the modal closed if it's
// already open. No-op when there's no active graph (empty home page).
async function openGraphSettings() {
  if (_graphModalClose) { _graphModalClose(); return; }
  if (activeGraphId == null) return;
  try {
    const res = await fetch(`/api/graphs/${encodeURIComponent(activeGraphId)}`);
    if (!res.ok) return;
    openGraphEditModal(await res.json());
  } catch {}
}

function openGraphEditModal(graph) {
  // If the modal was already open (e.g. clicking ⋮ on another graph), tear
  // down the previous instance's listeners before binding new ones.
  if (_graphModalClose) _graphModalClose();

  const modal = document.getElementById('graph-modal');
  const nameInput = document.getElementById('graph-modal-name');
  const nameError = document.getElementById('graph-modal-name-error');
  const descInput = document.getElementById('graph-modal-desc');
  const createdEl = document.getElementById('graph-modal-created');
  const urlInput = document.getElementById('graph-modal-url');
  const copyBtn = document.getElementById('graph-modal-copy');
  const rotateBtn = document.getElementById('graph-modal-rotate');
  const privateCheckbox = document.getElementById('graph-modal-private');
  const visibilityLabel = document.getElementById('graph-modal-visibility-label');
  const fontPicker = document.getElementById('graph-modal-font');
  const fontSwatchesEl = document.getElementById('graph-modal-font-swatches');
  const bgSwatchesEl = document.getElementById('graph-modal-bg-swatches');
  const saveBtn = document.getElementById('graph-modal-save');
  const deleteBtn = document.getElementById('graph-modal-delete');

  nameInput.textContent = graph.name || '';
  nameError.textContent = '';
  nameError.classList.add('hidden');
  descInput.value = graph.description || '';
  // Checkbox is now "Private" — checked = private, unchecked = public.
  // Inverse of the wire-level `is_public` flag.
  privateCheckbox.checked = !graph.is_public;
  // Label copy reflects current state so toggling has an obvious visual
  // effect beyond just the checkbox fill. Save-link warning rides along
  // with the Private state since that's where it's relevant.
  function syncVisibilityLabel() {
    visibilityLabel.innerHTML = privateCheckbox.checked
      ? 'Private <span class="visibility-hint">(save your link somewhere!)</span>'
      : 'Public';
  }
  syncVisibilityLabel();
  privateCheckbox.addEventListener('change', syncVisibilityLabel);

  // Created-at toggles between compact (default) and full UTC datetime.
  // Hover previews the full form; click sticks it. Modal always opens
  // collapsed — no persistence across opens.
  let createdExpanded = false;
  function renderCreated() {
    createdEl.textContent = `Created ${
      createdExpanded ? formatUtcLong(graph.created_at) : formatUtc(graph.created_at)
    }`;
  }
  function onCreatedEnter() {
    createdEl.textContent = `Created ${formatUtcLong(graph.created_at)}`;
  }
  function onCreatedLeave() { renderCreated(); }
  function onCreatedClick() { createdExpanded = !createdExpanded; renderCreated(); }
  renderCreated();
  createdEl.addEventListener('mouseenter', onCreatedEnter);
  createdEl.addEventListener('mouseleave', onCreatedLeave);
  createdEl.addEventListener('click', onCreatedClick);

  // Per-graph appearance overrides. Each per-key state has two pieces:
  //   customized → did the user explicitly set this key (vs. inheriting)?
  //   value      → if customized, what hex/font-id?
  // The color picker always shows *something* — when not customized, it
  // shows the effective app default so the user sees the graph's current
  // appearance. The "Reset" button clears `customized` and snaps the input
  // back to the app default.
  const initialSettings = (graph.settings && typeof graph.settings === 'object') ? graph.settings : {};
  const appearance = {
    font: { initial: initialSettings.font || null, current: initialSettings.font || null },
    font_color: { initial: initialSettings.font_color || null, customized: !!initialSettings.font_color },
    bg_color: { initial: initialSettings.bg_color || null, customized: !!initialSettings.bg_color },
  };

  // Custom font picker — native <select> popups ignore per-option
  // font-family on macOS, so we render a controlled menu we can style.
  // The trigger label inherits the chosen option's inline font-family so
  // the closed picker also shows the choice in its own face.
  const fontTrigger = fontPicker.querySelector('.font-picker-trigger');
  const fontValueEl = fontPicker.querySelector('.font-picker-value');
  const fontMenu = fontPicker.querySelector('.font-picker-menu');
  const fontOptions = Array.from(fontPicker.querySelectorAll('.font-picker-option'));

  function applyFontSelection(value) {
    appearance.font.current = value || null;
    const opt = fontOptions.find((o) => o.dataset.value === (value || '')) || fontOptions[0];
    fontValueEl.textContent = opt.textContent;
    fontValueEl.style.fontFamily = opt.style.fontFamily || '';
    fontOptions.forEach((o) => {
      o.classList.toggle('active', o === opt);
      o.setAttribute('aria-selected', o === opt ? 'true' : 'false');
    });
  }
  function openFontMenu() {
    fontMenu.classList.remove('hidden');
    fontTrigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onFontDocClick, true);
    document.addEventListener('keydown', onFontDocKey, true);
  }
  function closeFontMenu() {
    fontMenu.classList.add('hidden');
    fontTrigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onFontDocClick, true);
    document.removeEventListener('keydown', onFontDocKey, true);
  }
  function onFontTriggerClick() {
    if (fontMenu.classList.contains('hidden')) openFontMenu();
    else closeFontMenu();
  }
  function onFontOptionClick(e) {
    const btn = e.currentTarget;
    applyFontSelection(btn.dataset.value);
    closeFontMenu();
  }
  function onFontDocClick(e) {
    if (!fontPicker.contains(e.target)) closeFontMenu();
  }
  function onFontDocKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeFontMenu(); }
  }

  applyFontSelection(appearance.font.current || '');
  fontTrigger.addEventListener('click', onFontTriggerClick);
  fontOptions.forEach((o) => o.addEventListener('click', onFontOptionClick));

  // Render the inline swatch grids for Text + Background. Picking the same
  // color as the app default clears the per-graph override (acts as reset
  // without a dedicated button).
  function renderSwatches(container, palette, key) {
    const appDefault = key === 'font_color' ? appSettings.fontColor : appSettings.bgColor;
    const effective = appearance[key].customized
      ? (appearance[key].initial || appDefault)
      : appDefault;
    container.innerHTML = '';
    palette.forEach((color) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch';
      btn.style.backgroundColor = color.value;
      btn.title = color.name;
      btn.setAttribute('aria-label', color.name);
      if (normalizeColor(color.value) === normalizeColor(effective)) {
        btn.classList.add('active');
      }
      btn.addEventListener('click', () => {
        if (normalizeColor(color.value) === normalizeColor(appDefault)) {
          appearance[key].customized = false;
        } else {
          appearance[key].customized = true;
          appearance[key].initial = color.value;
        }
        container.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('active'));
        btn.classList.add('active');
      });
      container.appendChild(btn);
    });
  }
  renderSwatches(fontSwatchesEl, FONT_COLOR_PALETTE, 'font_color');
  renderSwatches(bgSwatchesEl, COLOR_PALETTE, 'bg_color');
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
    privateCheckbox.removeEventListener('change', syncVisibilityLabel);
    createdEl.removeEventListener('mouseenter', onCreatedEnter);
    createdEl.removeEventListener('mouseleave', onCreatedLeave);
    createdEl.removeEventListener('click', onCreatedClick);
    fontTrigger.removeEventListener('click', onFontTriggerClick);
    fontOptions.forEach((o) => o.removeEventListener('click', onFontOptionClick));
    closeFontMenu();
    nameInput.removeEventListener('blur', onNameBlur);
    nameInput.removeEventListener('keydown', onNameKey);
    nameInput.removeEventListener('input', clearNameError);
    modal.removeEventListener('click', onBackdrop);
    document.removeEventListener('keydown', onKey, true);
  }
  function showNameError(msg) {
    nameError.textContent = msg;
    nameError.classList.remove('hidden');
  }
  function clearNameError() {
    nameError.textContent = '';
    nameError.classList.add('hidden');
  }
  // Autosave-on-blur for the inline-editable graph name. Empty input reverts
  // to the last saved name; conflicts (409) and other server errors surface
  // via the inline #graph-modal-name-error. The bottom Save button still runs
  // independently for description/visibility/appearance.
  async function onNameBlur() {
    const next = nameInput.textContent.trim();
    if (!next) {
      nameInput.textContent = graph.name || '';
      clearNameError();
      return;
    }
    if (next === graph.name) {
      clearNameError();
      return;
    }
    try {
      const baseRow = graphBaseRow(graph);
      const res = await patchWithRetry(
        `/api/graphs/${graph.id}`,
        (base) => {
          const body = { name: next };
          if (base) {
            body.base_row = base;
            body.base_version = base.version;
          }
          return body;
        },
        baseRow,
        'graph',
      );
      if (!res.ok) {
        if (handleConflictStatus(res, 'graph')) {
          await fetchGraphsList();
          return;
        }
        const e = await res.json().catch(() => ({}));
        showNameError(e.error || 'Could not save name.');
        return;
      }
      const updated = await res.json();
      graph.name = updated.name;
      graph.version = updated.version;
      nameInput.textContent = updated.name;
      clearNameError();
      if (graph.id === activeGraphId) currentGraph = updated;
      fetchGraphsList();
    } catch {
      showNameError('Could not save name.');
    }
  }
  function onNameKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      nameInput.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      nameInput.textContent = graph.name || '';
      clearNameError();
      nameInput.blur();
    }
  }
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(urlInput.value);
      const icon = copyBtn.querySelector('i');
      if (icon) {
        const original = icon.className;
        icon.className = 'ph ph-check';
        setTimeout(() => { icon.className = original; }, 1200);
      }
    } catch {
      urlInput.select();
    }
  }
  async function onRotate() {
    const ok = await confirmDelete(
      'Current link will no longer exist.',
      { title: 'Rotate link?', confirmText: 'Rotate' }
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
      const oldId = graph.id;
      graph.id = updated.id;
      setShareUrl(updated.id);
      // The old id is now invalid; replace it in the recents list.
      recentsRemove(oldId);
      recentsUpsert(updated);
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
    const nextName = nameInput.textContent.trim();
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
    const nextPublic = !privateCheckbox.checked;
    if (nextPublic !== !!graph.is_public) body.is_public = nextPublic;

    // Per-graph appearance: send a partial settings patch when any of the
    // three changed. null means "revert to default" — server strips nulls
    // out of the merged JSONB so the key disappears.
    const settingsPatch = {};
    const fontInitial = initialSettings.font || null;
    const nextFont = appearance.font.current || null;
    if (nextFont !== fontInitial) settingsPatch.font = nextFont; // may be null
    for (const key of ['font_color', 'bg_color']) {
      const initialHex = initialSettings[key] || null;
      const nextHex = appearance[key].customized
        ? (appearance[key].initial || null)
        : null;
      if (nextHex !== initialHex) settingsPatch[key] = nextHex;
    }
    if (Object.keys(settingsPatch).length > 0) body.settings = settingsPatch;

    if (Object.keys(body).length === 0) { close(); return; }
    try {
      const baseRow = graphBaseRow(graph);
      const res = await patchWithRetry(
        `/api/graphs/${graph.id}`,
        (base) => {
          const out = { ...body };
          if (base) {
            out.base_row = base;
            out.base_version = base.version;
          }
          return out;
        },
        baseRow,
        'graph',
      );
      if (!res.ok) {
        if (handleConflictStatus(res, 'graph')) {
          close();
          await fetchGraphsList();
          return;
        }
        const e = await res.json().catch(() => ({}));
        alert(e.error || 'Save failed');
        return;
      }
      const updated = await res.json();
      // Reflect new appearance / metadata immediately. If the user edited
      // the active graph (the common case), update currentGraph and re-apply
      // visual settings so the canvas reflects the change without a reload.
      if (graph.id === activeGraphId) {
        currentGraph = updated;
        applySettings();
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
    recentsRemove(graph.id);
    if (graph.id === activeGraphId) {
      activeGraphId = null;
      currentGraph = null;
      try { localStorage.removeItem(ACTIVE_GRAPH_STORAGE_KEY); } catch {}
      history.replaceState({}, '', '/');
      if (cy) cy.elements().remove();
      applySettings();
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
    // Enter while editing the name is handled by onNameKey (commit-blur).
    // Escape on the name field reverts; outside the name field, it closes.
    if (e.key === 'Escape' && e.target !== nameInput) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  saveBtn.addEventListener('click', onSave);
  deleteBtn.addEventListener('click', onDelete);
  copyBtn.addEventListener('click', onCopy);
  rotateBtn.addEventListener('click', onRotate);
  nameInput.addEventListener('blur', onNameBlur);
  nameInput.addEventListener('keydown', onNameKey);
  nameInput.addEventListener('input', clearNameError);
  modal.addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onKey, true);
  _graphModalClose = close;
  modal.classList.remove('hidden');
  // Open the modal scrolled to the top, but don't auto-focus the name
  // anymore — clicking it is the affordance. Auto-focusing felt aggressive
  // for a heading.
  modal.scrollTop = 0;
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
        headers: WRITE_HEADERS,
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
  // Fire only on explicit creation. New graphs default to private; the user
  // needs to know they should bookmark the URL or flip to public. Honors the
  // "Never show again" preference in localStorage.
  showPrivateWarning(created);
}

// Post-create privacy warning. Bails immediately if the user previously chose
// "Never show again". Settings button opens the graph edit modal so they can
// flip is_public / copy URL / rotate without an extra click; Dismiss closes.
let _privateWarnClose = null;
function showPrivateWarning(graph) {
  try {
    if (localStorage.getItem(PRIVATE_WARN_SUPPRESS_KEY) === '1') return;
  } catch {}
  if (_privateWarnClose) _privateWarnClose();

  const modal = document.getElementById('private-warn-modal');
  const suppressEl = document.getElementById('private-warn-suppress');
  const settingsBtn = document.getElementById('private-warn-settings');
  const dismissBtn = document.getElementById('private-warn-dismiss');

  suppressEl.checked = false;

  function persistSuppressIfChecked() {
    if (!suppressEl.checked) return;
    try { localStorage.setItem(PRIVATE_WARN_SUPPRESS_KEY, '1'); } catch {}
  }
  function close() {
    _privateWarnClose = null;
    modal.classList.add('hidden');
    settingsBtn.removeEventListener('click', onSettings);
    dismissBtn.removeEventListener('click', onDismiss);
    modal.removeEventListener('click', onBackdrop);
    document.removeEventListener('keydown', onKey, true);
  }
  function onSettings() {
    persistSuppressIfChecked();
    close();
    openGraphEditModal(graph);
  }
  function onDismiss() {
    persistSuppressIfChecked();
    close();
  }
  function onBackdrop(e) { if (e.target === modal) onDismiss(); }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDismiss(); }
  }

  settingsBtn.addEventListener('click', onSettings);
  dismissBtn.addEventListener('click', onDismiss);
  modal.addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onKey, true);
  _privateWarnClose = close;
  modal.classList.remove('hidden');
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
          headers: WRITE_HEADERS,
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
  // In parallel: load the graph contents and the graph row metadata. The
  // metadata write to recents is best-effort — if the graph doesn't exist,
  // fetchGraph will surface the failure.
  const [, graphRow] = await Promise.all([
    fetchGraph(),
    fetch(`/api/graphs/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  if (graphRow) {
    currentGraph = graphRow;
    recentsUpsert(graphRow);
    renderSidebar();
    applySettings();
  }
  if (typeof updateToolbar === 'function') updateToolbar();
  openGraphEventStream(id);
}

// Live-update plumbing: open one EventSource per active graph. When the
// server emits a change (any task/edge mutation in this graph), do a
// selection-preserving refetch. The native EventSource auto-reconnects on
// drop, so we don't need our own retry loop here.
let _graphEventSource = null;
let _graphEventTimer = null;
// Most recent event payload from this burst, used for agent-follow targeting.
let _graphEventLastPayload = null;

// Track the last user-driven interaction (mousedown / keydown / wheel)
// so agent-follow doesn't yank the camera mid-drag or while typing. Idle
// threshold: 2 seconds.
let _lastUserInteractionAt = 0;
function noteUserInteraction() { _lastUserInteractionAt = Date.now(); }
function userInteractedRecently() { return Date.now() - _lastUserInteractionAt < 2000; }
['pointerdown', 'keydown', 'wheel'].forEach((evt) => {
  window.addEventListener(evt, noteUserInteraction, true);
});

function openGraphEventStream(id) {
  if (_graphEventSource) {
    try { _graphEventSource.close(); } catch {}
    _graphEventSource = null;
  }
  if (!id) return;
  const es = new EventSource(`/api/graphs/${id}/events`);
  es.onmessage = (e) => {
    if (id !== activeGraphId) return;
    try { _graphEventLastPayload = JSON.parse(e.data); } catch { _graphEventLastPayload = null; }
    // Coalesce bursts (e.g. a bulk-edges insert fires N notifications).
    if (_graphEventTimer) clearTimeout(_graphEventTimer);
    _graphEventTimer = setTimeout(() => {
      _graphEventTimer = null;
      const payload = _graphEventLastPayload;
      _graphEventLastPayload = null;
      refreshFromEvent(payload);
    }, 150);
  };
  es.onerror = () => {
    // Native EventSource will auto-reconnect; no-op here. Keep the handler
    // so errors don't bubble to the console as unhandled.
  };
  _graphEventSource = es;
}

async function refreshFromEvent(payload) {
  if (!cy) return;
  // Two scenarios are unsafe for a full fetchGraph (which wipes & rebuilds):
  //   - The creation ghost is on the canvas — its row doesn't exist in the DB
  //     yet, so a refresh would wipe it.
  //   - An inline title overlay is bound to a cy node — wiping that node leaves
  //     the overlay anchored to a removed reference.
  // In both cases we still want the canvas data for OTHER nodes/edges to stay
  // in sync with concurrent edits. Fall back to a surgical update for the
  // single affected element instead of a full refresh.
  const ghostActive = pendingNode && !pendingNode.removed() && pendingNode.id() === '__pending__';
  const titleOverlayActive = cy.$('.inline-title-edit').length > 0;
  if (ghostActive || titleOverlayActive) {
    if (payload && payload.id != null) {
      if (payload.kind === 'tasks' && payload.op === 'UPDATE') {
        try {
          const r = await fetch(`${apiBase()}/tasks/${payload.id}`);
          if (r.ok) updateGraphNode(await r.json());
        } catch {}
      } else if (payload.kind === 'edges' && payload.op === 'UPDATE') {
        try {
          const r = await fetch(`${apiBase()}/edges`);
          if (r.ok) {
            const edges = await r.json();
            const fresh = edges.find((e) => e.id === payload.id);
            const cyEdge = cy.getElementById(`e${payload.id}`);
            if (fresh && cyEdge && !cyEdge.empty()) {
              cyEdge.data('edgeType', fresh.type);
              cyEdge.data('meta', fresh.meta || {});
              cyEdge.data('color', (fresh.meta && fresh.meta.color) || DEFAULT_EDGE_COLOR);
              if (typeof fresh.version === 'number') cyEdge.data('version', fresh.version);
            }
          }
        } catch {}
      }
    }
    return;
  }

  // Capture pre-refresh status so we can tell whether this UPDATE was a
  // status change (flash with status color) vs body-only edit (purple).
  let preStatus = null;
  if (
    payload &&
    payload.kind === 'tasks' &&
    payload.id != null &&
    payload.op !== 'INSERT'
  ) {
    const preNode = cy.getElementById(String(payload.id));
    if (preNode && !preNode.empty()) preStatus = preNode.data('status');
  }

  const selectedNodeIds = cy.nodes('.selected').map((n) => n.id());
  const selectedEdgeIds = cy.edges('.selected').map((e) => e.id());
  // pendingNode's cy reference goes stale after fetchGraph wipes elements;
  // remember its id so we can re-bind to the new node below.
  const pendingNodeId =
    pendingNode && !pendingNode.removed() && pendingNode.id() !== '__pending__'
      ? pendingNode.id()
      : null;
  await fetchGraph();
  if (pendingNodeId) {
    const refreshed = cy.getElementById(pendingNodeId);
    if (refreshed && !refreshed.empty()) {
      pendingNode = refreshed;
    } else {
      // The row the panel was editing was deleted elsewhere — close the panel
      // rather than leave the user staring at a dangling form.
      pendingNode = null;
      hidePanel();
      showHint('This task was deleted elsewhere');
    }
  }
  selectedNodeIds.forEach((id) => {
    const n = cy.getElementById(id);
    if (n && !n.empty()) n.addClass('selected');
  });
  selectedEdgeIds.forEach((id) => {
    const e = cy.getElementById(id);
    if (e && !e.empty()) e.addClass('selected');
  });
  if (typeof updateToolbar === 'function') updateToolbar();

  // Agent-follow: when an external (SSE-delivered) edit lands on a task and
  // the user isn't actively interacting, animate the camera to the affected
  // node, briefly flash it, and (for UPDATE) open the side panel so the user
  // can see what the agent changed — same UX as if they'd clicked it.
  if (
    payload &&
    payload.kind === 'tasks' &&
    payload.id != null &&
    payload.op !== 'DELETE' &&
    !userInteractedRecently()
  ) {
    const node = cy.getElementById(String(payload.id));
    if (node && !node.empty()) {
      followAgentEdit(node, payload.op, classifyFlashKind(payload.op, preStatus, node));
    }
  }
}

// Pick a visually-meaningful flash class:
//   INSERT          → dashed blue border, mimicking a user-created new node
//   status changed  → underlay matching the new status color
//   body-only       → purple underlay
function classifyFlashKind(op, preStatus, node) {
  if (op === 'INSERT') return 'agent-flash-insert';
  const newStatus = node.data('status');
  if (newStatus !== preStatus) return `agent-flash-status-${newStatus}`;
  return 'agent-flash-body';
}

function followAgentEdit(node, op, flashClass) {
  node.addClass(flashClass);
  setTimeout(() => { try { node.removeClass(flashClass); } catch {} }, 1200);

  // UPDATE → open the side panel showing the new content.
  // INSERT → just pan; don't force the panel open every time a new node lands.
  if (op === 'UPDATE') {
    showPanel(node);
  } else {
    centerNodeInVisibleArea(node);
  }
}

function parseGraphIdFromPath() {
  const m = location.pathname.match(/^\/g\/([a-z0-9]+)\/?$/);
  return m ? m[1] : null;
}

async function bootSidebar() {
  await fetchGraphsList();
  // Resolve which graph to open: URL → localStorage → first public → none.
  // The URL-supplied id is bearer-token equivalent and must be honored even
  // if the graph is private (and therefore not in sidebar.graphs). Same for
  // the stored last-active id — if it's been deleted, switchActiveGraph
  // will surface that, and recentsRefresh will eventually drop it.
  let target = parseGraphIdFromPath();
  if (target == null) {
    try { target = localStorage.getItem(ACTIVE_GRAPH_STORAGE_KEY) || null; } catch {}
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
  if (id != null) {
    if (id !== activeGraphId) switchActiveGraph(id, { pushState: false });
  } else if (id == null && activeGraphId != null) {
    // Falling back to /: clear per-graph appearance overrides.
    currentGraph = null;
    applySettings();
    activeGraphId = null;
    if (cy) cy.elements().remove();
    renderSidebar();
    updateEmptyStates();
  }
});

// --- Cytoscape style arrays — one per theme.
// We deliberately keep both arrays in full (including the rules that don't
// differ between themes) so the toggle is byte-for-byte exact and easy to
// audit. The dark array is the cron-reference design; the light array is
// the prior mymind-reference design.
function cytoscapeStyleDark() {
  return [
    {
      selector: 'node',
      style: {
        'shape': 'round-rectangle',
        'background-color': 'data(color)',
        'border-color': '#cccccc',
        'border-width': 1,
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
        'padding': '16px',
        'text-overflow-wrap': 'whitespace',
      },
    },
    { selector: 'node[status = "in_progress"]', style: { 'border-color': '#ffffff', 'border-width': 2 } },
    { selector: 'node[status = "review"]', style: { 'border-color': '#ff4700', 'border-width': 2, 'border-style': 'dashed', 'border-dash-pattern': [6, 4] } },
    { selector: 'node[status = "done"]', style: { 'border-color': '#cccccc', 'border-opacity': 0.35, 'opacity': 0.55 } },
    { selector: 'node[color]', style: { 'background-color': 'data(color)' } },
    { selector: 'node.selected', style: { 'underlay-color': '#ff4700', 'underlay-opacity': 0.22, 'underlay-padding': 6 } },
    { selector: 'node.agent-flash-insert', style: { 'border-color': '#ff4700', 'border-style': 'dashed', 'border-width': 3, 'border-dash-pattern': [6, 4] } },
    { selector: 'node.agent-flash-status-todo', style: { 'underlay-color': '#cccccc', 'underlay-opacity': 0.35, 'underlay-padding': 10 } },
    { selector: 'node.agent-flash-status-in_progress', style: { 'underlay-color': '#ffffff', 'underlay-opacity': 0.45, 'underlay-padding': 10 } },
    { selector: 'node.agent-flash-status-review', style: { 'underlay-color': '#ff4700', 'underlay-opacity': 0.5, 'underlay-padding': 10 } },
    { selector: 'node.agent-flash-status-done', style: { 'underlay-color': '#cccccc', 'underlay-opacity': 0.2, 'underlay-padding': 10 } },
    { selector: 'node.agent-flash-body', style: { 'underlay-color': '#ffffff', 'underlay-opacity': 0.25, 'underlay-padding': 10 } },
    { selector: 'node.selected.status-editing-todo, node.selected.status-editing-in_progress, node.selected.status-editing-done', style: { 'border-color': '#ff4700', 'border-width': 2.5 } },
    { selector: 'node.editing', style: { 'border-color': '#ff4700', 'border-style': 'dashed', 'border-width': 3, 'border-dash-pattern': [6, 4] } },
    { selector: 'node.inline-title-edit', style: { 'text-opacity': 0 } },
    { selector: 'edge', style: { 'width': 1.5, 'line-color': 'data(color)', 'curve-style': 'unbundled-bezier', 'control-point-distances': 'data(curveDistance)', 'control-point-weights': 'data(curveWeight)' } },
    { selector: 'edge[edgeType = "dependency"]', style: { 'target-arrow-shape': 'triangle', 'target-arrow-color': 'data(color)', 'line-color': 'data(color)', 'width': 2 } },
    { selector: 'edge[edgeType = "related"]', style: { 'target-arrow-shape': 'triangle', 'target-arrow-color': 'data(color)', 'source-arrow-shape': 'triangle', 'source-arrow-color': 'data(color)', 'line-color': 'data(color)', 'width': 2 } },
    { selector: 'edge.selected', style: { 'underlay-color': '#ff4700', 'underlay-opacity': 0.22, 'underlay-padding': 5, 'z-index': 9 } },
    { selector: 'edge.edge-type-editing', style: { 'line-style': 'dashed', 'line-dash-pattern': [8, 6] } },
    { selector: 'edge.highlighted', style: { 'line-color': '#ff4700', 'target-arrow-color': '#ff4700', 'width': 3.5, 'z-index': 10 } },
    { selector: 'edge.dir-backward', style: { 'target-arrow-shape': 'none', 'source-arrow-shape': 'triangle', 'source-arrow-color': 'data(color)' } },
    { selector: 'node.edge-hover-target', style: { 'border-color': '#ff4700', 'border-width': 2 } },
    { selector: 'node.phantom', style: { 'width': 1, 'height': 1, 'background-opacity': 0, 'border-width': 0, 'label': '', 'events': 'no' } },
    { selector: 'edge.preview', style: { 'opacity': 0.6, 'events': 'no', 'z-index': 8 } },
    { selector: 'node:active, edge:active, core:active', style: { 'overlay-opacity': 0 } },
  ];
}
function cytoscapeStyleLight() {
  // Palette mapping (May 2026):
  //   Tier rule: light → fill, medium → text, strong → border / highlight.
  //   in_progress         → bg blue-light #e2f9ff, text blue-medium #95daf5, border blue-strong #43ace6
  //   review              → bg yellow-light #fef0bf, text yellow-medium #f6e5a5, border yellow-strong #f6c53e
  //   done                → bg green-light #deffe3, text green-medium #beecd1, border green-strong #49ca80
  //   selection / main    → main-orange #fb5305 (selection underlay, edge.selected, status-editing-todo)
  //   agent-edit / hover  → purple-strong #a45fff (.editing, agent-flash-insert/body, edge-hover-target)
  //   warning             → red-strong #ef3230 (edge.highlighted)
  //   default todo border → neutral-grey #e5e5e5 (todo has no family hue)
  return [
    {
      selector: 'node',
      style: {
        'shape': 'round-rectangle',
        'background-color': 'data(color)',
        'border-color': '#e5e5e5',
        'border-width': 3,
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
        'padding': '16px',
        'text-overflow-wrap': 'whitespace',
      },
    },
    // Three-tier per-status palette: light = fill, medium = text, strong = border.
    // (todo has no status hue and falls through to the default body text color.)
    { selector: 'node[status = "in_progress"]', style: { 'background-color': '#e2f9ff', 'border-color': '#43ace6', 'color': '#43ace6' } },
    { selector: 'node[status = "review"]',      style: { 'background-color': '#fef0bf', 'border-color': '#f6c53e', 'color': '#f6c53e' } },
    { selector: 'node[status = "done"]',        style: { 'background-color': '#deffe3', 'border-color': '#49ca80', 'color': '#49ca80' } },
    { selector: 'node[color]', style: { 'background-color': 'data(color)' } },
    { selector: 'node.selected', style: { 'underlay-color': '#fb5305', 'underlay-opacity': 0.35, 'underlay-padding': 6 } },
    { selector: 'node.agent-flash-insert', style: { 'border-color': '#a45fff', 'border-style': 'dashed', 'border-width': 3.5, 'border-dash-pattern': [6, 4] } },
    { selector: 'node.agent-flash-status-todo',        style: { 'underlay-color': '#e5e5e5', 'underlay-opacity': 0.55, 'underlay-padding': 10 } },
    { selector: 'node.agent-flash-status-in_progress', style: { 'underlay-color': '#43ace6', 'underlay-opacity': 0.45, 'underlay-padding': 10 } },
    { selector: 'node.agent-flash-status-review',      style: { 'underlay-color': '#f6c53e', 'underlay-opacity': 0.45, 'underlay-padding': 10 } },
    { selector: 'node.agent-flash-status-done',        style: { 'underlay-color': '#49ca80', 'underlay-opacity': 0.45, 'underlay-padding': 10 } },
    { selector: 'node.agent-flash-body', style: { 'underlay-color': '#a45fff', 'underlay-opacity': 0.35, 'underlay-padding': 10 } },
    { selector: 'node.selected.status-editing-todo',        style: { 'border-color': '#fb5305', 'border-width': 1.5 } },
    { selector: 'node.selected.status-editing-in_progress', style: { 'border-color': '#43ace6', 'border-width': 2.5 } },
    { selector: 'node.selected.status-editing-done',        style: { 'border-color': '#49ca80', 'border-width': 2.5 } },
    { selector: 'node.editing', style: { 'border-color': '#a45fff', 'border-style': 'dashed', 'border-width': 3.5, 'border-dash-pattern': [6, 4] } },
    { selector: 'node.inline-title-edit', style: { 'text-opacity': 0 } },
    { selector: 'edge', style: { 'width': 1.5, 'line-color': 'data(color)', 'curve-style': 'unbundled-bezier', 'control-point-distances': 'data(curveDistance)', 'control-point-weights': 'data(curveWeight)' } },
    { selector: 'edge[edgeType = "dependency"]', style: { 'target-arrow-shape': 'triangle', 'target-arrow-color': 'data(color)', 'line-color': 'data(color)', 'width': 2 } },
    { selector: 'edge[edgeType = "related"]', style: { 'target-arrow-shape': 'triangle', 'target-arrow-color': 'data(color)', 'source-arrow-shape': 'triangle', 'source-arrow-color': 'data(color)', 'line-color': 'data(color)', 'width': 2 } },
    { selector: 'edge.selected', style: { 'underlay-color': '#fb5305', 'underlay-opacity': 0.35, 'underlay-padding': 5, 'z-index': 9 } },
    { selector: 'edge.edge-type-editing', style: { 'line-style': 'dashed', 'line-dash-pattern': [8, 6] } },
    { selector: 'edge.highlighted', style: { 'line-color': '#ef3230', 'target-arrow-color': '#ef3230', 'width': 3.5, 'z-index': 10 } },
    { selector: 'edge.dir-backward', style: { 'target-arrow-shape': 'none', 'source-arrow-shape': 'triangle', 'source-arrow-color': 'data(color)' } },
    { selector: 'node.edge-hover-target', style: { 'border-color': '#a45fff', 'border-width': 2 } },
    { selector: 'node.phantom', style: { 'width': 1, 'height': 1, 'background-opacity': 0, 'border-width': 0, 'label': '', 'events': 'no' } },
    { selector: 'edge.preview', style: { 'opacity': 0.6, 'events': 'no', 'z-index': 8 } },
    { selector: 'node:active, edge:active, core:active', style: { 'overlay-opacity': 0 } },
  ];
}
function cytoscapeStyle(theme) {
  return theme === 'light' ? cytoscapeStyleLight() : cytoscapeStyleDark();
}

// --- Initialize ---
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  cy = cytoscape({
    container: document.getElementById('cy'),
    style: cytoscapeStyle(appSettings.theme),
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
    // Cmd+K opens *graph* settings (the graph edit modal) when there's an
    // active graph. App-level Defaults live behind the gear icon. Cmd+K is
    // a no-op on the empty home page.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openGraphSettings();
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
      case 't':
      case 'T':
        tidyAndFit();
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
  document.getElementById('btn-tidy').addEventListener('click', tidyAndFit);
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
  richEditor = createRichEditor();

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
      const base = (panelLoadedVersion !== null && panelLoadedContent !== null)
        ? { version: panelLoadedVersion, content: panelLoadedContent }
        : null;
      const res = wasNew
        ? await createTask(content)
        : await updateTask(editingTaskId, content, base);
      if (!res.ok) {
        if (handleConflictStatus(res, 'task')) {
          showSaveStatus('', '');
          await fetchGraph();
          return;
        }
        showSaveStatus('Save failed', 'error');
        return;
      }
      const saved = await res.json();
      // Refresh the OCC base so the next edit is anchored to what just landed.
      if (saved && typeof saved.version === 'number') {
        panelLoadedVersion = saved.version;
        panelLoadedContent = saved.content;
      }
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
    // Suppress saves caused by loadIntoEditor's synthetic editor change.
    if (Date.now() < _editorSaveSuppressedUntil) return;
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
  document.getElementById('btn-settings').addEventListener('click', openGraphSettings);
  document.getElementById('settings-search').addEventListener('input', () => {
    settingsState.activeIndex = 0;
    renderSettings();
  });
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'settings-overlay') closeSettings();
  });
  applySettings();

  // Sidebar wiring. The "+ New Graph" header button creates graphs; the
  // collapsed-only `+` button does the same from the skinny strip. The
  // bottom-pinned gear opens app-level Defaults.
  const collapseBtn = document.getElementById('sidebar-collapse-btn');
  const expandBtn = document.getElementById('sidebar-expand-btn');
  const newBtn = document.getElementById('sidebar-new-btn');
  const newBtnCollapsed = document.getElementById('sidebar-new-btn-collapsed');
  const appSettingsBtn = document.getElementById('app-settings-btn');
  if (collapseBtn) collapseBtn.addEventListener('click', () => setSidebarCollapsed(true));
  if (expandBtn) expandBtn.addEventListener('click', () => setSidebarCollapsed(false));
  if (newBtn) newBtn.addEventListener('click', () => { createGraphFromUI(); });
  if (newBtnCollapsed) newBtnCollapsed.addEventListener('click', () => { createGraphFromUI(); });
  if (appSettingsBtn) appSettingsBtn.addEventListener('click', () => {
    if (isSidebarCollapsed()) setSidebarCollapsed(false);
    openSettings();
  });
  applySidebarCollapsedFromStorage();

  // Boot sidebar — fetches graphs, resolves active graph, loads its data.
  // Replaces the old single-graph fetchGraph() bootstrap.
  bootSidebar().then(() => {
    if (activeGraphId != null) updateToolbar();
  });
});
