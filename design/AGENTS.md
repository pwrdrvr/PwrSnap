# PwrSnap — Project Notes for Claude

These are persistent instructions for any session working in this project. Read this **before** touching brand marks, logos, wordmarks, or hotkey copy.

---

## 1. The PwrSnap brand mark — there is exactly ONE

**There are many marks like it, but this one is mine.** If you find yourself drawing a lightning bolt, a "P" glyph, a camera, a shutter, or anything else inside the PwrSnap tile, **stop**. The mark is a **stack of three offset rounded rectangles** — the "stacked screenshots" metaphor. Nothing else.

> Direction matters. **Front is bottom-LEFT, back is top-RIGHT.** If you draw front at bottom-right (or top-left), the mark is wrong — that is the "reversed" version the user has flagged twice now.

One mark, several renderings. Every one of them draws the same idea — three
stroked rounded rectangles on a diagonal, front at full strength, mid at
**0.55**, back at **0.3** — and the in-app mark IS the app icon's glyph:

| Rendering | Where | Geometry | Color |
|---|---|---|---|
| **App icon** | `apps/desktop/scripts/generate-app-icon.swift` | 1024 box; `450 × 340` rects, `rx=48`, stroke `56`, offsets `±64 / ±80` | `#e8743a` (the icon orange — see §3) |
| **In-app SVG** (title strips, tray, float-over) | `apps/desktop/src/renderer/src/features/shared/BrandMark.tsx` → `PwrSnapMark` | the icon's glyph, same 1024-box coordinates with y flipped: rects at `(223,422)` front, `(287,342)` mid, `(351,262)` back; viewBox `195 195 634 634` | `currentColor`, pinned to `var(--accent)` on the `<svg>` itself |
| **Tray icon** (menubar / notification area PNGs) | `apps/desktop/scripts/generate-tray-icon.mjs` → `tray-icon-glyph.mjs` | the icon's glyph, READ from `generate-app-icon.swift`; the same viewBox `195 195 634 634` as the in-app SVG | template black / `#ff8a1f` |
| Design handoff (reference only) | `design/src/AppIcons.jsx` → `APP_ICONS.pwrsnap`, `design/src/FloatOver.jsx` → `FoMark` | viewBox `0 0 24 24`; three `13 × 13` squares, `rx=2.5` | three explicit tints: `--accent-deep`, a copper midpoint, `--accent` |

**What ships is the first three rows, and all three are one drawing.** The
in-app mark was a separate, squarer drawing (`58 × 46` rects, stroke `9`, in a
128 box) until 2026-09, when it was redrawn from the icon for the Pwr-family
title strip; the family rule is that each app's strip mark is its icon glyph.
The tray was a scaled-up copy of that squarer drawing (`78 × 62` rects,
stroke `13`) and was redrawn from the icon in the same change. The design-handoff version is the
original Claude Design drawing, kept verbatim under `design/` as a visual
reference (see the repository AGENTS.md); do not port its squares or its three
tints into the app. If the mark itself is redrawn, redraw the shipped
renderings together — and the two JSX copies in `design/src/` together, since
`PwrSnap Float-Over.html` does not load `AppIcons.jsx`.

### The in-app SVG

- **`currentColor`, pinned to the accent.** The `<svg>` sets
  `color: var(--accent)` on itself, so the strokes are tangerine whatever text
  color surrounds the mark — the property the old "never `currentColor`" rule
  was protecting. Do not remove that style and let the color inherit.
- **Same numbers as the icon.** Any change to the icon's mark is a change to
  `BrandMark.tsx` too. `BrandMark.test.tsx` re-derives every rect from the
  Swift constants and fails if either side moves alone. The tray PNGs need no
  edit, only a rerun of `pnpm --filter @pwrsnap/desktop tray-icon`: their
  generator reads the Swift constants itself, and `tray-icon.test.mjs`
  re-renders every committed PNG and fails when one is stale.
- **Fills its box, ink centred.** The viewBox is the glyph's own bounds
  (x 195–829, y 234–790, stroke included) squared about their centre — the
  Pwr-family convention PwrGit's mark uses too. A flex parent that centres
  the box therefore centres the drawn mark, which is how the title strips put
  it on their y=20 centreline (see "The Pwr-family title strip" in the
  repository AGENTS.md).
- **Sizes.** 20px in every window's title strip (the Pwr-family mark size),
  16px in the tray header, 12px in the tray menubar facsimile and the
  float-over header.
- **`decorative` next to the wordmark.** Where the wordmark sits beside it and
  already names the app, the mark is `aria-hidden`; alone, it is
  `role="img"` with `aria-label="PwrSnap"`.
- **Hard stack, per instance.** Each tier is masked by the stroke bands of
  the tiers in front (next section). The mask ids come from `useId`, stripped
  to `[A-Za-z0-9_-]`, because the mark renders several times per page and a
  shared id would point every instance at the first one's masks.

### The stack is a HARD STACK, never a blend

Wherever the mark is rendered with **per-tier alpha** instead of three opaque
tints (the native generators: `apps/desktop/scripts/generate-app-icon.swift`,
`apps/desktop/scripts/tray-icon-glyph.mjs`), painting back → mid → front with
plain source-over is *correct alpha compositing and the wrong mark*: the 0.3 back
stroke shows through the 0.55 mid stroke and each crossing lights up as a
brighter, more saturated patch — a fourth tone the palette never specified.

Front and mid are **immutable in color and opacity anywhere they are visible**;
the back rect is simply *behind* them. So every tier must be **knocked out**
wherever a tier in front of it covers:

- Swift/CoreGraphics — stroke each tier inside a clip built from
  `CGPath.copy(strokingWithWidth:)` outlines of the tiers in front (bounds + ring
  path, `.evenOdd`, clips intersected sequentially).
- SVG — a `maskUnits="userSpaceOnUse"` luminance mask per tier, with the covering
  tiers' stroke bands painted black into it.

Antialiasing is unaffected: the knockout's partial coverage at a boundary is
exactly `1 − (covering tier's coverage)`, the same weight source-over would have
applied. No seams. PwrGit hit the sibling version of this bug (its dim branch arc
+ ring doubling up) and fixed it with a `beginTransparencyLayer` — that trick
flattens *within* one tier only and is **not** sufficient here, where the
compounding is *between* tiers of different alpha.

Touching either generator means regenerating and committing the assets:
`pnpm --filter @pwrsnap/desktop generate:app-icon` (which also writes the
Icon Composer package `build/icon.icon/`; there is no `.icns` to build) and
`pnpm --filter @pwrsnap/desktop tray-icon`.

### Don'ts

- ❌ Don't draw a lightning bolt. (Crept in during an unknown refactor; permanently retired.)
- ❌ Don't draw a "P" glyph as the brand mark. (`FoMark` was previously a P-shape; corrected.)
- ❌ Don't reverse the offset direction.
- ❌ Don't let the mark's color inherit from its surroundings — `currentColor` is fine only because the `<svg>` pins its own `color` to `--accent`.
- ❌ Don't invent a fourth layer, a tile background inside the SVG, a frame, a shutter, or any "extra detail." Three rects, that's it.
- ❌ Don't let the tiers blend into each other. See "hard stack" above.

---

## 2. The PwrSnap wordmark

- **One word**, two colors: `Pwr<span class="a">Snap</span>` — "Pwr" in `--text-primary` (bone-white), "Snap" in `--accent` (tangerine).
- Letter-spacing `-0.01em` — the Pwr-family value PwrAgent and PwrGit use. Reads as "PwrSnap", not "Pwr Snap" — no visible gap. (Earlier revisions of this file said `-0.03em`; the app ships `-0.01em`.)
- In a window's title strip it is `700 17px/1` Geist Sans, cap-height trimmed (`text-box: trim-both cap alphabetic`) so its capitals centre on the strip's y=20 line. The tray and float-over headers keep their own smaller sizes.
- **Wrap both fragments in a single span** when the parent is a flex container with `gap`. Otherwise the bare "Pwr" text node becomes its own anonymous flex item and the `gap` opens a visible space between "Pwr" and "Snap". In the app that span is `PwrSnapWordmark` (`.pwrsnap-wordmark`) in `BrandMark.tsx`.

---

## 3. Suite color tokens (PwrAgent is system-of-record)

- `--bg-app` is **pure black `#000000`**, not warm near-black.
- `--accent` is **tangerine `#ff8a1f`**, not burnt copper. This is the wordmark
  + all in-app UI accent — the same token PwrAgent uses for the "Agent" half of
  its wordmark.
- The **macOS app icon** uses a separate, deeper orange **`#e8743a`** — *not*
  `--accent`. Two intentional oranges; don't unify them. PwrAgent uses the same
  split (UI `#ff8a1f`, icon `#e8743a`). Full notes:
  `docs/solutions/2026-05-31-brand-oranges-and-app-icon.md` in the PwrSnap repo.
- `--button-text-on-accent` is `#000000`, not a warm near-black.
- Geist + Geist Mono everywhere; never substitute Inter/Roboto/system fonts.

Tokens live in `ds/colors_and_type.css`. Never hardcode brand colors in component files — reference the token. If a literal hex is unavoidable (e.g. in an SVG attribute that can't take `var()`), use `style={{ stroke: "var(--…)" }}` instead. Native (Swift) icon/DMG generators are outside the token system — they hardcode brand colors and **must use `deviceRGB`** (`calibratedRGB` drifts the rendered pixels lighter; that's what spawned the spurious `#ee894a`).

### Where this lives in Claude Design

This file is exported from the **PwrSnap** project in Claude Design. Two
containers are involved and they are **not** interchangeable:

| | id | holds |
|---|---|---|
| **PwrSnap** (project) | `019deed3-8009-7107-bd1e-68bcd3fd192f` | this product's design work — `PwrSnap Library.html`, `PwrSnap Editor.html`, `PwrSnap Sizzle Reels.html`, `src/*.jsx`, `ds/colors_and_type.css`, `briefs/` |
| **PwrDrvr Design System** | `019debaf-c070-7afe-98db-4c9bbe10e72b` | shared tokens + primitives — the starting point and visual reference for every PwrDrvr product |

**Product work goes in the PwrSnap project, never in the design system.** A brief
or mockup for one PwrSnap feature is not design-system material; putting it there
pollutes the shared reference for PwrAgent, PwrGit, and everything else on it.
(Three PwrSnap briefs had drifted into the design system and were moved back on
2026-08-17.)

> ⚠️ **You cannot find this project by listing.** `DesignSync`'s `list_projects`
> returns **design systems only** — PwrSnap, PwrAgent and PwrGit never appear in
> it. Address the project by the id above. Do not conclude from an empty listing
> that the design system is the only writable target; that inference is exactly
> what caused the drift. `get_project` on the id confirms
> `type: PROJECT_TYPE_PROJECT`, `canEdit: true`, and writes work normally.

Earlier revisions of this file called `019debaf-…` "the PwrAgent design system
project (read-only)". It is neither PwrAgent's nor read-only — its name is
**PwrDrvr Design System** and it is writable.

Note the token file: this project carries its **own** `ds/colors_and_type.css`,
and that is what its mockups resolve against — not the design system's copy. When
checking for palette drift, diff *that* file against `design/ds/colors_and_type.css`
in the repo. All three were identical as of 2026-08-17.

### `PwrSnap README Header.html` — image paths differ between the two copies

That artboard specifies the repository landing page (the download and link
chips in [README.md](../README.md), produced by
`apps/desktop/scripts/generate-readme-chips.swift`). It was authored in this
repo and pushed **up** into the project with `DesignSync`, and its images are
the shipped PNGs rather than a CSS re-drawing of them — an artboard that
re-implemented the chips could agree with itself while disagreeing with the
files GitHub actually serves.

Because it frames real repository files, its image `src`s are the one thing
that is **not** identical in the two copies:

| | spelling |
|---|---|
| repo (`design/`) | `../docs/assets/…` |
| Claude Design project | `docs/assets/…` |

The project carries its own copy of those PNGs (uploaded alongside the
artboard), the way PwrGit's project carries `apps/desktop/build/**`. Push the
repo spelling up by accident and every chip renders as a broken image, with no
error — that is exactly what happened the first time PwrGit wrote its version,
which is why the rule is here rather than left to memory. `ds/colors_and_type.css`
needs no rewrite: the project root maps to this directory.

The generator itself is mirrored at `handoff/generate-readme-chips.swift` in
the project, next to the icon, tray, and DMG generators already there.

---

## 4. Hotkeys

- **Quick Capture is `⌘⇧C`** (was `⌘⇧P` historically; swapped to free `P` for other uses).
- Region `⌘⇧R`, Video Capture `⌘⇧V`, Full Screen `⌘⇧F`, Library `⌘L`, Search `⌘K`.

---

## 5. House style

- Voice: technical, terse, lowercase jargon, no emoji, no marketing gloss. Engineers writing for engineers. See PwrDrvr design system README for full rules.
- No invented copy unless asked — if a section feels empty, that's a layout problem, not a content problem.
