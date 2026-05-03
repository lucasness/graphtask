# Graphtask — Style Reference (Light)

> Warm, paper-like canvas. Soft cool-grey shadows, a serif display headline over a four-family sans stack, vibrant ember orange used sparingly as a brand mark, cobalt-purple as the only filled chromatic accent.

**Theme:** light

This design system reads like a notebook on a clean desk. Surfaces are near-white (`#ffffff` / `#f7f7f7`) with a single neutral hairline (`#e5e5e5`); shadows are cool grey rather than black so elevation feels weightless. A small, intentional cast of typefaces does almost all of the visual work: a serif display (Playfair Display) for headings, a humanist sans (Nunito) for uppercase eyebrows and pill button labels, a friendly text sans (DM Sans) for body and hints, and a neutral UI sans (Inter) for controls and lists. Color is rationed: ember orange (`#fb5305`) is the brand mark — eyebrows, the active sidebar bullet, the active-tool outline — never a fill. Cobalt purple (`#a45fff`) is the only chromatic interactive *fill* (focus rings, the checked checkbox, the share-link URL). Outlined pill buttons in green (constructive) and red (destructive) carry the modal action moments. Six status hue families (orange / purple / green / blue / red / yellow), each with light / medium / strong tiers, supply the palette for user-pickable node and font colors.

## Tokens — Colors

### Neutrals

| Name | Value | Token | Role |
|------|-------|-------|------|
| Neutral White | `#ffffff` | `--neutral-white` | Surfaces that sit on the canvas: modal, sidebar, panel, settings card, palette popover, hotkey toast. |
| Neutral Light Grey | `#f7f7f7` | `--neutral-light-grey` | Page canvas, sidebar item hover/active wash, kbd background, editable-heading hover. |
| Neutral Grey | `#e5e5e5` | `--neutral-grey` | Hairline borders on surfaces, inputs, share row, toolbar, hotkey toast. |

### Brand Accent

| Name | Value | Token | Role |
|------|-------|-------|------|
| Main Orange | `#fb5305` | `--main-orange` | Ember accent. Section eyebrows, sidebar section titles, active sidebar bullet, "+ New graph" hover, active tool-button outline. Outline-only — never used as a button fill. |

### Status Families

Each hue has a light / medium / strong tier. Light is the default tier for swatch-style backgrounds; strong is used for typographic accents and outlines.

| Family | Light | Medium | Strong |
|--------|-------|--------|--------|
| Orange | `#ffe3c8` `--orange-light` | `#fead81` `--orange-medium` | `#fe7233` `--orange-strong` |
| Purple | `#f8e5fd` `--purple-light` | `#efd6ff` `--purple-medium` | `#a45fff` `--purple-strong` |
| Green  | `#deffe3` `--green-light`  | `#beecd1` `--green-medium`  | `#49ca80` `--green-strong`  |
| Blue   | `#e2f9ff` `--blue-light`   | `#95daf5` `--blue-medium`   | `#43ace6` `--blue-strong`   |
| Red    | `#ffd6c4` `--red-light`    | `#e27f6e` `--red-medium`    | `#ef3230` `--red-strong`    |
| Yellow | `#fef0bf` `--yellow-light` | `#f6e5a5` `--yellow-medium` | `#f6c53e` `--yellow-strong` |

### Typographic Slate Family

A cool blue-grey neutral ramp for text. Default body text is `--color-deep-slate`; modal headings step up to `--color-midnight-ink` for emphasis.

| Name | Value | Token | Role |
|------|-------|-------|------|
| Midnight Ink | `#000000` | `--color-midnight-ink` | Modal heading, panel heading, settings heading. |
| Graphite Nav | `#24272d` | `--color-graphite-nav` | Sidebar item label, input value, settings item, visibility row text. |
| Deep Slate | `#3a475a` | `--color-deep-slate` | Default canvas text on the cytoscape graph. |
| Storm | `#4a5465` | `--color-storm` | Body color, modal paragraph, sidebar "+ New graph" label, toolbar text. |
| Steel | `#717286` | `--color-steel` | Subtitle metadata, share hint, secondary captions. |
| Slate | `#748297` | `--color-slate` | Outlined Slate Pill default border + label color. |
| Ash | `#afb5c1` | `--color-ash` | Placeholder text, empty-state copy, default edge color. |
| Chalk | `#a6a8aa` | `--color-chalk` | Reserved for future low-emphasis chrome. |

### Semantic Roles (light theme aliases)

These names are referenced by component CSS so per-theme remapping stays at the token layer.

| Role | Maps to | Used for |
|------|---------|----------|
| `--color-ember-orange` | `--main-orange` | Brand accent (outline-only). |
| `--color-cobalt-link` | `--purple-strong` | Filled chromatic interactive: focus rings, checked checkbox, link URL, rubber-band selection. |
| `--color-canvas-white` | `--neutral-light-grey` | Page canvas. |
| `--color-pure-white` | `--neutral-white` | Surfaces (modal, sidebar, panel, popovers). |
| `--color-blush-tint` | `--neutral-light-grey` | Hover / active item wash. |
| `--color-mist` | `--neutral-grey` | Hairline borders. |
| `--red` | `--red-strong` | Conventional warning red (private warn, destructive button). |

## Tokens — Typography

Four typefaces, each with a clear role. Typeface choice does the hierarchy work — weight contrast within a family is minimal.

### Playfair Display — Display headings · `--font-display`
- **Stack:** `'Playfair Display', 'EB Garamond', Garamond, 'Times New Roman', serif`
- **Weights:** 400
- **Sizes:** 22px (empty state), 24px (settings), 28px (modal h3, panel h2)
- **Letter spacing:** -0.04em (modal/panel) · -0.02em (empty state)
- **Role:** Modal headings, panel headings, settings card heading, empty-state cue. Always weight 400 — the typeface carries the emphasis, not the weight.

### Nunito — Eyebrows + Pill labels · `--font-label`
- **Stack:** `'Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
- **Weights:** 600
- **Sizes:** 11px (eyebrows), 12px (small pill label), 14px (modal action pill label)
- **Letter spacing:** 0.125em (eyebrows) · 0.053em (pill labels)
- **Case:** UPPERCASE
- **Role:** Section eyebrows, sidebar section titles, all uppercase pill button labels.

### DM Sans — Body + Captions · `--font-body`
- **Stack:** `'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
- **Weights:** 400
- **Sizes:** 12px (toolbar text, sidebar meta), 13px (modal paragraph, share hint), 15px (body text), 16px (default body)
- **Line height:** 1.55
- **Role:** Modal paragraphs, share hints, toolbar captions, sidebar meta, modal body text.

### Inter — UI controls · `--font-ui`
- **Stack:** `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
- **Weights:** 500
- **Sizes:** 13px (tool button, hotkey toast), 14px (settings item, appearance label), 15px (modal input, sidebar item, visibility row)
- **Role:** Form inputs, sidebar list items, toolbar buttons, settings list, default per-graph canvas font.

### Type Scale

| Role | Size | Line Height | Letter Spacing | Token |
|------|------|-------------|----------------|-------|
| body-sm | 13px | 1.55 | normal | `--text-body-sm` |
| caption | 15px | 1.55 | — | `--text-caption` |
| body | 16px | 1.55 | — | `--text-body` |
| subheading | 18px | — | — | `--text-subheading` |
| heading-sm | 28px | 1.1 | -0.04em | `--text-heading-sm` |

## Tokens — Spacing & Shapes

**Base unit:** 4px

**Density:** comfortable (smaller scale than the dark cron reference; this surface holds inputs and lists, not landing-page hero blocks).

### Spacing Scale (theme-invariant)

| Name | Value | Token |
|------|-------|-------|
| 1 | 4px  | `--space-1` |
| 2 | 8px  | `--space-2` |
| 3 | 12px | `--space-3` |
| 4 | 16px | `--space-4` |
| 5 | 20px | `--space-5` |
| 6 | 24px | `--space-6` |
| 8 | 32px | `--space-8` |

### Border Radius

| Element | Token | Value |
|---------|-------|-------|
| Small / generic | `--radius-md` | 12px |
| Form inputs, share row | `--radius-cardsalt` | 12px |
| Modal, settings card, palette popover | `--radius-cards` | 16px |
| All buttons (pill) | `--radius-buttons` | 100px |
| Tag chip | `--radius-tags` | 36px |
| Fully round | `--radius-full` | 9999px |

### Shadows

Cool grey, soft, low-spread. No black, no chromatic tint — elevation should feel like paper lifting, not glow.

```
--shadow-sm: rgba(140, 142, 151, 0.32) 0 4px 7px -4px;
--shadow-md:
  rgba(140, 142, 151, 0.32) 0 4px 7px -4px,
  rgba(140, 142, 151, 0.16) 0 12px 24px -8px;
```

### Layout

- **Sidebar width:** 240px
- **Panel width:** 600px (resizable, min 320px, max 95vw)
- **Modal padding:** 32px
- **Modal max-width (form):** 520px

## Components

### Outlined Slate Pill (default modal button — Cancel / Dismiss / Reset / Clear)
**Role:** Interactive — secondary

Background: transparent. Text + border: Slate (`#748297`). Border radius: 100px (`--radius-buttons`). Padding: 10px 22px. Font: Nunito 600, 14px, UPPERCASE, letter-spacing 0.053em. Hover: text + border darken to Graphite Nav (`#24272d`). Active press: scale(0.96), 120ms cubic-bezier(0.2, 0, 0, 1).

### Outlined Green Pill (primary CTA — Save / Confirm)
**Role:** Interactive — constructive

Same shape as Slate Pill. Border + text: `--green-strong` (`#49ca80`). Hover: 10% green-strong fill via color-mix; text + border stay green-strong. Use exactly one per modal, paired with Slate (Cancel) or Red (Delete).

### Outlined Red Pill (danger — Delete / Rotate)
**Role:** Interactive — destructive

Same shape as Slate Pill. Border + text: `--red` / `--red-strong` (`#ef3230`). Hover: 10% red fill via color-mix.

### Section Eyebrow
**Role:** Typographic label

Nunito 600, 11px, UPPERCASE, letter-spacing 0.125em, color `--color-ember-orange`. Sits above a section group inside a modal. Use sparingly — one per section, only when the controls below aren't self-evident from a placeholder.

### Modal Heading (inline-editable)
**Role:** Heading

Playfair Display, 28px, weight 400, line-height 1.1, letter-spacing -0.04em, color `--color-midnight-ink`. Inline-editable: subtle blush-tint background on hover/focus, 6px radius, 2px 6px padding offset to the left so the text baseline stays stationary. Empty state shows the `data-placeholder` attribute in `--color-ash`.

### Modal Subtitle (metadata)
**Role:** Caption

DM Sans, 13px, color `--color-steel`, `font-variant-numeric: tabular-nums` so timestamps don't reflow.

### Form Input
**Role:** Interactive — entry

Background: `--color-pure-white`. Border: 1px `--color-mist` (`#e5e5e5`). Border radius: 12px (`--radius-cardsalt`). Padding: 10px 14px. Font: Inter 15px, color `--color-graphite-nav`. Placeholder: `--color-ash`. Focus: border `--color-cobalt-link`, 3px box-shadow ring at 18% cobalt opacity.

### Custom Checkbox
**Role:** Interactive — toggle

14px square, 1px `--border-strong` (`--color-ash`) border, 3px radius. Checked: filled `--color-cobalt-link`, white SVG checkmark inset. Hit area extended to ~24px via invisible `::before`.

### Color Swatch
**Role:** Selection chip

22px square (modal appearance picker) or 28px (palette popover), 1px `--color-mist` border, 4px radius. 5-column grid, 6px gap (modal) / 12px gap (popover). Active state: 2px `--color-graphite-nav` outset ring.

### Tool Button (toolbar)
**Role:** Interactive — toolbar action

Inter 500, 13px. Padding 6px 12px. Default: transparent background + transparent border, color `--color-storm`. Hover: `--color-blush-tint` background. Active (selected): transparent background, `--color-ember-orange` border + text.

### Sidebar Item
**Role:** Navigation row

Padding 10px 20px. Label: Inter 500, 15px, letter-spacing -0.01em, color `--color-graphite-nav`. Meta: DM Sans 12px, `--color-steel`, tabular-nums. Hover + active: `--color-blush-tint` wash. Active row: 6px ember bullet at the left edge (`::before`).

### Hotkey Hint Toast
**Role:** Floating ephemeral notice

Floats top-center. `--color-pure-white` background, 1px `--color-mist` border, 100px pill, Inter 500 13px, `--color-graphite-nav`, `--shadow-sm`.

## Do's and Don'ts

### Do
- Use Playfair Display for h2 / h3 only. Body and controls stay in DM Sans / Inter.
- Use ember (`--color-ember-orange`) as a brand mark — section eyebrows, the active sidebar bullet, the active tool-button outline. Outline only.
- Use cobalt (`--color-cobalt-link`) as the only chromatic *fill* — focus rings, the checked checkbox, the link-colored share URL, the rubber-band selection.
- Use the outlined pill family (Slate / Green / Red) for every button. All buttons are 100px radius.
- Pair an outlined Green Pill (constructive) with either a Slate Pill (Cancel) or a Red Pill (Delete). Never two filled colored buttons.
- Use status families' light tier for swatches and surfaces, strong tier for typography and outlines.
- Use `font-variant-numeric: tabular-nums` for timestamps, share URLs, and any numeric value that updates in place.
- Use `text-wrap: pretty` on body paragraphs and `text-wrap: balance` on headings.
- Use cool-grey shadows (`rgba(140, 142, 151, …)`) — never black, never chromatic.

### Don't
- Don't fill ember as a button background. Ember is outline-only across this system.
- Don't introduce a chromatic color outside the six status families plus ember and cobalt.
- Don't use Playfair Display for body, captions, labels, or controls.
- Don't use Nunito anywhere except UPPERCASE eyebrows and pill button labels.
- Don't use sharp 4px corners on buttons — every button shape is a 100px pill.
- Don't drop heavy black shadows for elevation — the system relies on cool-grey, low-spread shadows.
- Don't ship a modal with a colored filled CTA. Constructive uses Outlined Green Pill.
- Don't reach past the slate-family neutrals for text; use Storm / Steel / Slate / Ash, not arbitrary greys.

## Elevation

Elevation is communicated by surface contrast (`--color-pure-white` floating on `--color-canvas-white`) and a soft cool-grey shadow, never by saturation or blur. `--shadow-sm` for one-step lifts (toolbar, hotkey toast); `--shadow-md` for modal-level lifts (modal, settings card, panel, palette popover). Hairline borders (`1px --color-mist`) reinforce edges so surfaces register on a near-white canvas without leaning on shadow alone.

## Imagery

This system has no marketing imagery. UI is the imagery: graph nodes on the cytoscape canvas, swatches in the modal, the sidebar list. Iconography is monochrome glyphs (Phosphor) at 14–18px, sitting in `--color-steel` or inheriting `currentColor`. There is no use of stock photography, illustration, or gradients.

## Layout

Three-region cockpit: a 240px left sidebar (collapses to 48px), a full-bleed cytoscape canvas, and a 600px right-side editing panel that slides in/out. Modals center over the canvas with a `rgba(0, 0, 0, 0.55)` scrim and animate in via a 12px translateY + opacity ramp over 0.7s on `cubic-bezier(0.19, 1, 0.22, 1)` — the "placed, not dropped" easing used throughout the system. Floating chrome (bottom toolbar, hotkey hint) is centered over the canvas region (offset by sidebar width), pill-shaped, with `--shadow-sm`.

## Motion

Two easings, each with one job:

- **Expressive ease (`cubic-bezier(0.19, 1, 0.22, 1)`, 0.7s)** — sidebar collapse/expand, panel open/close, modal enter. Fast-in, slow-out gives a placed-rather-than-dropped feel.
- **Press ease (`cubic-bezier(0.2, 0, 0, 1)`, 120ms)** — every interactive element scales to 0.96 on `:active`. Applied to modal buttons, sidebar icon buttons, sidebar bottom button, sidebar menu button, tool buttons, appearance clear, share row buttons.

Hover transitions are property-specific (color, border-color, background-color), 200ms `ease`. Never transition `all`.

## Agent Prompt Guide

1. Quick Color Reference:
   - Canvas: `#f7f7f7` (`--color-canvas-white`)
   - Surface: `#ffffff` (`--color-pure-white`)
   - Hairline: `#e5e5e5` (`--color-mist`)
   - Default text: `#3a475a` (`--color-deep-slate`)
   - Body text: `#4a5465` (`--color-storm`)
   - Heading: `#000000` (`--color-midnight-ink`)
   - Caption: `#717286` (`--color-steel`)
   - Brand mark (outline only): `#fb5305` (`--color-ember-orange`)
   - Filled chromatic accent: `#a45fff` (`--color-cobalt-link`)
   - Constructive: `#49ca80` (`--green-strong`)
   - Destructive: `#ef3230` (`--red-strong` / `--red`)

2. Example Component Prompts:
   - **Modal heading:** Playfair Display weight 400, 28px, line-height 1.1, letter-spacing -0.04em, color `--color-midnight-ink`. Inline-editable with blush-tint hover background, 6px radius, 2px 6px padding.
   - **Section eyebrow:** Nunito weight 600, 11px, UPPERCASE, letter-spacing 0.125em, color `--color-ember-orange`. 10px margin below.
   - **Outlined Green Pill (primary):** transparent background, 1px `--green-strong` border, `--green-strong` text, Nunito 600 14px UPPERCASE letter-spacing 0.053em, padding 10px 22px, border-radius 100px. Hover: 10% green-strong fill via color-mix. Active: scale(0.96), 120ms cubic-bezier(0.2, 0, 0, 1).
   - **Form input:** background `--color-pure-white`, 1px `--color-mist` border, 12px radius, padding 10px 14px, Inter 15px color `--color-graphite-nav`. Placeholder `--color-ash`. Focus: border `--color-cobalt-link` + 3px box-shadow at 18% cobalt opacity.
   - **Color swatch grid:** 5-column grid of 22px squares, 6px gap, 1px `--color-mist` border, 4px radius. Active state: 2px `--color-graphite-nav` outset ring.

## Similar Brands

- **mymind** — The closest reference: warm light canvas, serif display headlines over a multi-sans body stack, ember accent reserved as a brand mark, soft cool-grey shadows.
- **Things 3 (light)** — Comparable use of a four-typeface palette, soft elevation, and chromatic accents rationed to a single role each.
- **Linear (light mode)** — Similar approach to outlined chip-style buttons and a small, intentional set of status colors with light/medium/strong tiers.
- **Notion (light mode)** — Shared restraint with chromatic surfaces — neutral canvas, color used as a wash for tags rather than fills for buttons.

## Quick Start

### CSS Custom Properties

```css
:root {
  /* Neutrals */
  --neutral-white:      #ffffff;
  --neutral-light-grey: #f7f7f7;
  --neutral-grey:       #e5e5e5;

  /* Brand accent */
  --main-orange: #fb5305;

  /* Status — orange */
  --orange-light:  #ffe3c8;
  --orange-medium: #fead81;
  --orange-strong: #fe7233;

  /* Status — purple */
  --purple-light:  #f8e5fd;
  --purple-medium: #efd6ff;
  --purple-strong: #a45fff;

  /* Status — green */
  --green-light:  #deffe3;
  --green-medium: #beecd1;
  --green-strong: #49ca80;

  /* Status — blue */
  --blue-light:  #e2f9ff;
  --blue-medium: #95daf5;
  --blue-strong: #43ace6;

  /* Status — red */
  --red-light:  #ffd6c4;
  --red-medium: #e27f6e;
  --red-strong: #ef3230;

  /* Status — yellow */
  --yellow-light:  #fef0bf;
  --yellow-medium: #f6e5a5;
  --yellow-strong: #f6c53e;

  /* Slate-family neutrals (text) */
  --color-midnight-ink: #000000;
  --color-graphite-nav: #24272d;
  --color-deep-slate:   #3a475a;
  --color-storm:        #4a5465;
  --color-steel:        #717286;
  --color-slate:        #748297;
  --color-ash:          #afb5c1;
  --color-chalk:        #a6a8aa;

  /* Semantic role aliases */
  --color-ember-orange: var(--main-orange);
  --color-cobalt-link:  var(--purple-strong);
  --color-canvas-white: var(--neutral-light-grey);
  --color-pure-white:   var(--neutral-white);
  --color-blush-tint:   var(--neutral-light-grey);
  --color-mist:         var(--neutral-grey);
  --red:                var(--red-strong);

  /* Fonts */
  --font-display: 'Playfair Display', 'EB Garamond', Garamond, 'Times New Roman', serif;
  --font-label:   'Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-body:    'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-ui:      'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

  /* Type scale */
  --text-body-sm: 13px;
  --leading-body-sm: 1.55;
  --tracking-body-sm: normal;
  --text-caption: 15px;
  --leading-caption: 1.55;
  --text-body: 16px;
  --leading-body: 1.55;
  --text-subheading: 18px;
  --text-heading-sm: 28px;

  /* Spacing (theme-invariant) */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;

  /* Layout */
  --sidebar-w: 240px;

  /* Border radius */
  --radius-md: 12px;
  --radius-cardsalt: 12px;
  --radius-cards: 16px;
  --radius-buttons: 100px;
  --radius-tags: 36px;
  --radius-full: 9999px;

  /* Shadows */
  --shadow-sm: rgba(140, 142, 151, 0.32) 0 4px 7px -4px;
  --shadow-md:
    rgba(140, 142, 151, 0.32) 0 4px 7px -4px,
    rgba(140, 142, 151, 0.16) 0 12px 24px -8px;
}
```

### Tailwind v4

```css
@theme {
  /* Neutrals */
  --color-neutral-white:      #ffffff;
  --color-neutral-light-grey: #f7f7f7;
  --color-neutral-grey:       #e5e5e5;

  /* Brand */
  --color-main-orange: #fb5305;

  /* Status — orange */
  --color-orange-light:  #ffe3c8;
  --color-orange-medium: #fead81;
  --color-orange-strong: #fe7233;

  /* Status — purple */
  --color-purple-light:  #f8e5fd;
  --color-purple-medium: #efd6ff;
  --color-purple-strong: #a45fff;

  /* Status — green */
  --color-green-light:  #deffe3;
  --color-green-medium: #beecd1;
  --color-green-strong: #49ca80;

  /* Status — blue */
  --color-blue-light:  #e2f9ff;
  --color-blue-medium: #95daf5;
  --color-blue-strong: #43ace6;

  /* Status — red */
  --color-red-light:  #ffd6c4;
  --color-red-medium: #e27f6e;
  --color-red-strong: #ef3230;

  /* Status — yellow */
  --color-yellow-light:  #fef0bf;
  --color-yellow-medium: #f6e5a5;
  --color-yellow-strong: #f6c53e;

  /* Slate text neutrals */
  --color-midnight-ink: #000000;
  --color-graphite-nav: #24272d;
  --color-deep-slate:   #3a475a;
  --color-storm:        #4a5465;
  --color-steel:        #717286;
  --color-slate:        #748297;
  --color-ash:          #afb5c1;
  --color-chalk:        #a6a8aa;

  /* Fonts */
  --font-display: 'Playfair Display', 'EB Garamond', Garamond, 'Times New Roman', serif;
  --font-label:   'Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-body:    'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-ui:      'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

  /* Type scale */
  --text-body-sm: 13px;
  --text-caption: 15px;
  --text-body: 16px;
  --text-subheading: 18px;
  --text-heading-sm: 28px;

  /* Spacing */
  --spacing-1: 4px;
  --spacing-2: 8px;
  --spacing-3: 12px;
  --spacing-4: 16px;
  --spacing-5: 20px;
  --spacing-6: 24px;
  --spacing-8: 32px;

  /* Border radius */
  --radius-md: 12px;
  --radius-cardsalt: 12px;
  --radius-cards: 16px;
  --radius-buttons: 100px;
  --radius-tags: 36px;
  --radius-full: 9999px;
}
```
