# graphtask

A graph-based task manager. Tasks are nodes; relationships between them are
edges. The app is a single-page Cytoscape.js canvas with a right-side task
inspector and a contextual bottom toolbar.

---

## Stack

- Backend: Express 5 on Node, PostgreSQL with pgRouting, `pg`, and `yaml`.
- Frontend: Vanilla JS, Cytoscape.js, TOAST UI Editor, and CSS using a Flexoki
  dark palette.
- Tests: Vitest and supertest.
- Package manager: npm for the existing project.

---

## Layout

```text
src/
  server.js          starts Express on PORT
  app.js             builds the Express app and mounts routers
  db.js              shared pg pool
  markdown.js        frontmatter parse/serialize, validation, defaults
  routes/
    tasks.js         CRUD on /api/tasks
    edges.js         CRUD and PATCH on /api/edges
    graph.js         graph queries mounted under /api/tasks
    graphApi.js      /api/graph and shortest-path payloads
db/
  schema.sql         tasks, edges, edge_type enum
public/
  index.html         static markup and toolbar structure
  app.js             frontend graph behavior
  style.css          app shell, toolbar, palette, modal styles
tests/               Vitest specs for API, DB, tasks, edges, graph queries
```

---

## Setup

```sh
npm install
createdb graphtask
psql graphtask -f db/schema.sql
DATABASE_URL=postgresql://localhost/graphtask npm start
npm test
```

The tests require the PostgreSQL `pgrouting` extension to be available.

---

## Data Model

```sql
tasks(
  id SERIAL PRIMARY KEY,
  content TEXT NOT NULL,       -- canonical markdown: frontmatter + body
  meta JSONB NOT NULL,         -- structured copy of frontmatter
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)

edges(
  id SERIAL PRIMARY KEY,
  source_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  target_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  type edge_type,              -- dependency | related
  meta JSONB NOT NULL,         -- rendering metadata
  created_at TIMESTAMPTZ,
  UNIQUE(source_id, target_id),
  CHECK(source_id <> target_id)
)
```

- Task `content` is canonical. The server parses frontmatter, validates it, and
  stores a synchronized structured copy in `tasks.meta`.
- Task metadata includes `title`, `status`, optional `description`, optional
  `color`, and optional saved graph coordinates `x`/`y`.
- Edge metadata includes optional `curve` and optional `color`.
- `dependency` edges are directed; `related` edges are visually bidirectional.
- Dependency cycle detection runs on edge create and update. `related` edges can
  form arbitrary loops.
- `edges.meta.curve` is the signed Cytoscape unbundled Bezier offset.
- `edges.meta.color` is a validated 6-digit hex value used for line and arrow
  color.

---

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/tasks` | List tasks |
| POST | `/api/tasks` | Body: `{content}` markdown blob |
| GET | `/api/tasks/:id` | Fetch one task |
| PATCH | `/api/tasks/:id` | Body: `{content}` |
| DELETE | `/api/tasks/:id` | Cascades to edges |
| GET | `/api/tasks/leaves` | Nodes with no incoming dependency edges |
| GET | `/api/tasks/:id/subtasks` | Walk incoming dependency edges to prerequisites |
| GET | `/api/tasks/:id/ancestors` | Walk outgoing dependency edges to dependents |
| GET | `/api/edges` | List edges |
| POST | `/api/edges` | Body: `{source_id, target_id, type, meta?}` |
| PATCH | `/api/edges/:id` | Partial edge update; supports endpoints, type, meta |
| DELETE | `/api/edges/:id` | Delete edge |
| GET | `/api/graph` | Combined `{nodes, links}` canvas payload |
| GET | `/api/graph/shortest-path` | pgRouting shortest-path query |

`markdown.applyDefaults` coerces YAML-parsed title and description values to
strings before validation, so scalar YAML values do not break task saves.

---

## Frontend Model

The frontend has three main regions:

- Canvas: `#cy` fills the viewport. Cytoscape paints nodes and edges. Styling is
  driven by element data (`status`, `color`, `edgeType`, `curve`) and transient
  classes (`selected`, `editing`, `leaf`, `dir-backward`, `edge-type-editing`,
  `edge-hover-target`, `preview`, `phantom`).
- Side panel: `#panel` is a resizable right-side inspector for node title,
  status, and markdown body. Opening it recenters the selected node in the
  visible canvas area.
- Bottom toolbar: `#bottom-bar` is contextual and changes by selection mode.

### Selection Modes

`getSelectionMode()` returns:

- `neutral`: nothing selected. Toolbar shows New (`G`) and Fit (`F`).
- `node`: one or more nodes selected. Toolbar shows Status (`S`), Color (`B`),
  Connect (`E`), and Delete.
- `edge`: one or more edges selected. Toolbar shows Color (`B`), Direction
  (`E`), and Delete. For a single edge, Direction shows a right arrow, left
  arrow, or horizontal bidirectional arrow for the current state.
- `mixed`: nodes and edges selected together. Toolbar shows Color (`B`) and
  Delete.
- `edge-creating`: edge creation is in progress. Toolbar shows a preview summary
  and Direction (`E`) for the in-progress edge type.

`updateToolbar()` is called after selection/mode changes and after `fetchGraph()`
because refetching rebuilds Cytoscape elements and clears transient classes.

---

## Editing Flows

### Nodes

- Clicking empty canvas creates a pending Cytoscape node with id `__pending__`.
- Pending nodes are visible immediately but are not persisted until Enter creates
  a task.
- Existing task fields autosave with a short debounce.
- Status cycling is optimistic: `S` changes the visible status; Enter saves and
  Esc restores.
- Inline title editing uses an HTML contenteditable overlay positioned over the
  Cytoscape node. It scales with zoom and resizes the Cytoscape node frame.

### Edges

- Pressing `E` with node(s) selected starts edge creation. A hidden phantom node
  follows the cursor and preview edges connect from the selected sources.
- During edge creation, `E` cycles `forward -> related -> backward -> forward`.
- Clicking a target node commits created edges. Clicking empty canvas starts a
  pending target node and keeps preview edges until that node is saved.
- Pressing `E` with one edge selected starts an optimistic direction/type edit.
  The edge turns dashed while the edit is pending, matching the "press Enter to
  save" pattern used elsewhere.
- Enter saves an edge direction/type edit. Esc restores the original type.
- Backward dependency edits are represented visually with `dir-backward` until
  save, then the server PATCH swaps source/target.
- Hover an edge to reveal the curve handle. Dragging it updates
  `edges.meta.curve` on release.

### Color Palette

- `B` opens a color palette for selected nodes, selected edges, or mixed
  selections.
- Palette values come from the Flexoki dark theme used by the app.
- Swatches show the actual color that will be applied to node fill or edge
  line/arrow color.
- Arrow keys navigate the palette as a two-dimensional 5-column grid. Enter or
  mouse click applies and saves the color.
- Color changes affect background/edge color, not the selection highlight or
  status-edit highlight.

---

## Hot Keys

| Key | Behavior |
|---|---|
| `F` | Fit graph to viewport |
| `G` | Create a node at the visible-area center |
| `S` | Cycle selected node status; Enter saves, Esc cancels |
| `B` | Open color palette for selected nodes/edges |
| `E` | Start edge creation, cycle in-progress edge direction, or cycle selected edge direction |
| `Enter` | Commit pending explicit edit session |
| `Cmd/Ctrl+Enter` | Commit new-node creation from anywhere |
| `Esc` | Cancel current edit, close panel, or clear selection |
| `Backspace/Delete` | Open delete confirmation |
| Arrow keys | Move selection to nearest node/edge in that direction; inside color palette, navigate swatches |
| Cmd/Ctrl drag | Rubber-band select nodes and edge midpoints |

---

## Notable Decisions

- No node overlap: `resolveNodeOverlap()` pushes nodes apart by at least 12 world
  units and persists moved node coordinates.
- Predictable refresh: many mutations use optimistic UI followed by
  `fetchGraph()` after server success or failure.
- Explicit save signals: discrete edits such as new node creation, status edit,
  and edge direction edit require Enter. Pending edge direction edits turn
  dashed to make that requirement visible.
- Flexoki dark UI: app chrome and the color palette share the same color system.
- Single static frontend: `public/app.js` intentionally avoids a build step. If
  it grows much further, splitting by behavior area would be the next cleanup.

---

## Where To Look First

| Want to... | Look at |
|---|---|
| Change node/edge visuals | `public/app.js` Cytoscape `style` array |
| Change toolbar markup | `public/index.html` `#bottom-bar` |
| Change toolbar state | `updateToolbar()` in `public/app.js` |
| Add a keyboard shortcut | Global keydown handler in `public/app.js` |
| Change task metadata | `src/markdown.js`, `src/routes/tasks.js`, `db/schema.sql` |
| Change edge metadata | `src/routes/edges.js` and edge style/persistence in `public/app.js` |
| Debug transient frontend state | Module-scope state in `public/app.js`: `pendingNode`, `edgeCreation`, `edgeTypeEditing`, `statusEditing`, `colorPaletteState` |

---

## Current Caveats

- Multi-node edge creation is fan-out. If the target is also selected, that
  self-edge is skipped.
- The frontend is intentionally not modularized yet.
- OpenGraph preview metadata is not configured for the deployed app.
