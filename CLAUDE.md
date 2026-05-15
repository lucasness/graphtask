# CLAUDE.md — graphtask orientation

Notes for future Claude sessions working in this repo. Keep brief; deeper
detail lives in the linked files.

## Layout at a glance

- `public/` — the entire client. Static assets served by Express. The
  app is a single-page vanilla-JS UI; no build step, no bundler.
  - `index.html` — markup + asset links.
  - `style.css` — **all** CSS (tokens + components). One file, ~2800 lines.
  - `app.js` — all client JS.
- `src/` — Node/Express server (auth, graphs, SSE, REST endpoints).
- `db/` — schema + migrations. Postgres.
- `design/DESIGN.md` — prose design spec (see below).
- `tests/` — vitest, run with `npm test`.

## Design system — where things live

**Source of truth: `public/style.css`.**

- The top of the file declares every CSS custom property the app uses:
  `--space-*`, `--text-*`, `--color-*`, `--font-*`, `--radius-*`,
  `--shadow-*`. Both `light` and `dark` themes redefine the full token
  set (see the comment at the top of the file).
- **Two token layers** coexist in that file:
  - *Reference* tokens — raw values: `--neutral-white`, `--main-orange`,
    `--orange-light/medium/strong`, etc. Declared once per theme.
  - *Semantic* tokens — role-based aliases: `--color-pure-white`,
    `--color-ember-orange`, etc. These alias the reference tokens and
    are what component CSS should use. Re-pointing a semantic alias is
    how themes change a role's value without touching components.
- Below the tokens, the rest of the file is component CSS organized
  loosely by region (sidebar → canvas → panel → modal → toast → etc.).
- There is no build step. The HTML `<link>`s `style.css` directly.

**Prose spec: `design/DESIGN.md`.**

- Documents the design language: color roles, type stack, spacing
  rhythm, component patterns. Read this when you need to know *what*
  the design intends, not *how* it's implemented.
- Notable sections:
  - **Foundations → Spacing Scale** — the eight `--space-*` primitives.
  - **Foundations → Form-Modal Rhythm** — the 20px/8px/32px gap
    hierarchy for vertical structure in form modals.
  - **Components** — visual + behavioral spec for each reusable piece
    (eyebrows, pills, swatches, etc.).

There used to be `design/variables.css`, `design/theme.css`, and
`design/tokens.json` here too. They were stale snapshots — never loaded
by the app, and their token names had drifted from the real CSS. They
were deleted; don't recreate them.

## Working in the design system

When you change visual styles:

1. **Edit `public/style.css`.** That's the live system.
2. **If the change is a new pattern, a new token, or a deviation from
   an existing rule, update `design/DESIGN.md`** so the next session
   knows the rule. Small tweaks (pixel nudges, single-component
   adjustments) don't need a doc update.
3. **Don't add new CSS files under `design/`** unless you're also wiring
   them up in `index.html` and updating this file. Drifting reference
   files are how this project got in a confusing state before.

When you want to know "is there a token for this?":

- Search the top of `style.css` for the relevant prefix
  (`--space-`, `--text-`, `--color-`, `--font-`).
- If the value you want isn't a token, prefer adding a token over
  hardcoding — but only when the value will be reused. One-offs can be
  literal.

## Runtime (development)

The app is supervised by the workspace gateway; see the workspace-level
`CLAUDE.md` at `/data/workspace/CLAUDE.md` for the deploy / inspect /
register flows. The app should already be running on port 3000 in this
session.

## Memory

There are several user-memory entries about working on this project at
`/data/claude-home/.claude/projects/-data-workspace/memory/` — UI
patterns, auth gotchas, deferred work. Check `MEMORY.md` there when you
need historical context.
