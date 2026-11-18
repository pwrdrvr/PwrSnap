# Agent rules: Renderer focus, tooltips, layout measures and chrome

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Overlays get Escape, Tab and focus from the renderer's focus hooks

**Every click-opened dialog, popover and menu in the renderer uses
`useModal` / `useDismissable` / `useFocusTrap` / `useMenuNavigation` /
`useFocusReturn` from `apps/desktop/src/renderer/src/lib/`. Don't add an
overlay keydown listener for Escape or Tab.** The Escape listener is the
first window-capture keydown listener, and it stops the key it claims.
That is why the app's own Escape handlers (Library view, editor, Sizzle
inspector) never need a `defaultPrevented` check, and why a second overlay
listener would break the ordering. Rules, measurements and test recipes:
[apps/desktop/src/renderer/src/lib/AGENTS.md](../../apps/desktop/src/renderer/src/lib/AGENTS.md).

## Icon-only controls name themselves with `data-tip`, not `title`

**A control whose meaning a sighted user can only get from its tooltip
opts into the app's fast tooltip with `data-tip` (plus `data-tip-keys` /
`data-tip-detail`), never `title`, and still carries an `aria-label` or
text for its name.** The native tooltip waits out the macOS delay and
restarts it on every pointer move, so an icon took seconds to say anything.
`useFastTooltip` is mounted once per window by `App`. Nothing else mounts
it, and no element carries `data-tip` and `title` together or nested.
Two places keep `title` on purpose: the recording HUD and the float-over
dock, windows too small for an in-page tooltip. Rules and the list:
[apps/desktop/src/renderer/src/lib/AGENTS.md](../../apps/desktop/src/renderer/src/lib/AGENTS.md)
§"Hover tooltips". Pinned by
[fast-tooltip-contract.test.ts](../../apps/desktop/src/renderer/src/lib/__tests__/fast-tooltip-contract.test.ts)
and [useFastTooltip.test.tsx](../../apps/desktop/src/renderer/src/lib/__tests__/useFastTooltip.test.tsx).

## Never mix a post-transform rect with a layout measure

**`getBoundingClientRect()` is POST-TRANSFORM. `offsetWidth` /
`offsetHeight` / `clientWidth` / `clientHeight` and
`ResizeObserverEntry.borderBoxSize` are LAYOUT. Combining one with the
other silently bakes in whatever transform happened to be in flight.**

The editor mounts inside `.psl__focus`, which runs a 180ms
`psl-focus-in` entrance animation from `scale(0.985)` to `scale(1)`
([library.css](../../apps/desktop/src/renderer/src/styles/library.css)).
`useZoomPan` assigns the canvas its final explicit width/height DURING
that window, so anything that measures the canvas at that moment gets a
rect ~1% short.

**And a `ResizeObserver` will not rescue you.** It reports LAYOUT box
changes. A finishing transform changes no layout box, so no further
notification ever arrives — a bad value read inside a callback is not
transient, it is permanent until some unrelated real resize happens.
That is what makes this class so hard to spot: it never self-heals, but
it always disappears the moment you resize the window to look at it.

Three confirmed instances. The first two are in
[Editor.tsx](../../apps/desktop/src/renderer/src/features/editor/Editor.tsx):

- `canvasCssHeight` — the rect was the WRONG KIND. It is divided into
  `TextHtml`'s `offsetWidth` before publishing to
  `text-measure-registry.ts`, so a transform-polluted scale published a
  glyph box ~1% too wide and the selection outline / transform handles /
  hit-test all mis-hugged. Fixed by reading `borderBoxSize`.
- `canvasRect` — the post-transform rect is the RIGHT kind (pointer
  coordinates are post-transform too), it was merely STALE: cached
  `{left: 25.34, width: 1029.33}` against a live `{left: 17.5, width:
  1045}`. Crop DRAGS shrugged this off — CropTool gestures are
  delta-based, and a delta round-trips through the same cached width, so
  the staleness cancels exactly (a drag-tracking test is TAUTOLOGICAL
  here; one passed 8/8 against the un-fixed build). What broke was the
  RENDER: selection + dim drawn at the stale scale inside the live-sized
  canvas — highlighted region ≠ committed region by ~1.5%, dim stopping
  short of the canvas corner. Fixed by re-measuring when the consuming
  tool appears; pinned by `editor-crop-drag.spec.ts` via a deterministic
  replay of the staleness (it re-applies the entrance transform, forces
  re-measures under it, removes it, then asserts render-vs-live).

The third is in
[VideoTimeline.tsx](../../apps/desktop/src/renderer/src/features/shared/VideoTimeline.tsx),
and it is the cleanest example of why the ResizeObserver is no rescue:

- `width` — the strip's own size, measured once in a `useLayoutEffect`
  with `getBoundingClientRect()` and thereafter only from a
  `ResizeObserver`. The video stage mounts inside `.psl__focus`, so the
  mount measure landed mid-`psl-focus-in` and came back ~1.5% short
  (measured: **985 on a 1000px strip**); the finishing transform changed
  no layout box, so the observer never fired again and the short value
  was permanent. It sizes the out handle, the ticks, the playhead and
  the filmstrip request, so the out handle and the ruler parked ~14px
  inside the right edge and the right scrim dimmed that band even at
  FULL CLIP. The IN handle is `left: 0` and looked perfect throughout —
  which is how it reads as "the right handle is broken" rather than "the
  strip is mis-measured". Drags were unaffected: `secAt()` re-reads a
  live rect per pointer event, the same render-wrong/gesture-right split
  as `canvasRect` above. Fixed by measuring `clientWidth` /
  `contentBoxSize`; pinned by `VideoTimeline.test.tsx` §"sizes off the
  layout box, not a transform-polluted rect", which stands the two boxes
  apart (rect 788, layout 800) and asserts the sized output follows 800.

Rules:

- Sizing something that will be compared against a layout measure? Use a
  layout measure. `ResizeObserverEntry.borderBoxSize[0].blockSize` is the
  fractional, transform-independent equivalent of `rect.height` (block
  axis — height only under a horizontal writing mode).
- **Sizing the coordinate space of absolutely-positioned children? That
  space is the PADDING box** — `clientWidth` / `clientHeight`, and
  nothing else. A bordered element fed its own border-box width puts the
  far edge 1px per border past where `left: <width>` lands, and under
  `overflow: hidden` the overshoot is clipped rather than visible. That
  was a second, quieter defect in `VideoTimeline`: the out handle
  rendered 6 of its 8px with its rounded corner cut off, while the in
  handle at `left: 0` was flush.
  - **`contentBoxSize` is the wrong box here**, and it is the one you
    reach for after reading the rule above it. The content box excludes
    padding; the containing block does not. Measured in Chromium on a
    `border: 1px; padding: 0 10px` box: a child at `left: 0` lands on the
    padding edge, `clientWidth` reads 498 and
    `contentBoxSize[0].inlineSize` reads 478. Zero padding is the only
    reason they ever look interchangeable, and a measure that is right at
    mount and wrong after the first resize is worse than one that is
    always wrong.
- Mapping pointer coordinates? The post-transform rect is correct — but
  **a cached `DOMRect` is only valid until something moves**, and a
  ResizeObserver never tells you an element MOVED. Re-read at the moment
  of use, or make the cache's deps include whatever brings the consumer
  on screen.
- **Linux E2E green proves nothing here.** This is a race against a CSS
  animation; xvfb timing wins it and macOS loses it. Only the macOS
  runner can catch a recurrence.

Full investigation, measurements, and the two wrong hypotheses it
replaced:
[docs/solutions/2026-08-28-text-outline-stale-canvas-scale.md](../../docs/solutions/2026-08-28-text-outline-stale-canvas-scale.md).

## Focus rings

**Every keyboard focus indicator is drawn in `--focus-ring`, reaches 3:1
against what it sits on, and is on screen when the control has focus.
Measure the last part in a browser: reading the CSS does not show it.**
Owners: the `--focus-ring` token in
[tokens.css](../../apps/desktop/src/renderer/src/styles/tokens.css) and the
global `:where(:focus-visible)` rule in
[app.css](../../apps/desktop/src/renderer/src/styles/app.css). Pinned by
[focus-ring-contract.test.ts](../../apps/desktop/src/renderer/src/styles/__tests__/focus-ring-contract.test.ts)
(every stylesheet) and
[theme-contract.test.ts](../../apps/desktop/src/renderer/src/styles/__tests__/theme-contract.test.ts)
(the token and its contrast).

- **The token is `--focus-ring: var(--accent)`**, the same name and value
  as PwrAgent (docs/UI-THEME.md) and PwrGit. It measures 8.6:1 on
  `--bg-app` in dark and 4.6:1 in light. Never ring in `--accent-border`:
  eleven rules did, at about 2.2:1. The light block does not redeclare the
  token, and `design/ds/colors_and_type.css` mirrors it.
- **The global rule is the default, at zero specificity.** A control with no
  `:focus-visible` rule gets `outline: 2px solid var(--focus-ring)` 1px
  out, not Chromium's pale-blue `outline: auto`. Before this rule, most of
  the app drew the Chromium ring.
- **Placement.**
  - A bordered or filled control keeps the default, 1px out.
  - A row or scroller that runs edge to edge inside an `overflow`
    ancestor insets its ring with `outline-offset: -2px`.
  - A borderless text link sits 2px off, with `border-radius: var(--radius-sm)`.
  - A borderless field rings its wrapper via
    `:has(<field>:focus-visible)`. Key it on the field, not on
    `:focus-within`, when sibling buttons ring themselves.
- **`outline: none` in a focus rule must be followed by a ring for the same
  selector.** That ring can be later in the file, in the same block (the
  hollow trim handle), or on a `:has()` wrapper. The contract test enforces
  this, because a shared `:hover, :focus-visible { outline: 0 }` block
  reads as harmless in review. Four stylesheets shipped one with nothing
  after it.

Things that hid rings that were correctly styled. Each of these shipped:

- **Opacity fades the outline with everything else the element paints.**
  A dimmed control un-dims while focused. One that is unavailable
  (`aria-disabled`, busy) joins the "Focused while unavailable" block in
  app.css, which swaps the fade for a muted paint at opacity 1.
- **Scrolling stops at the border box.** When Tab lands on a control partly
  past a scroller's edge, Chromium scrolls only until the control's border
  box is in view, which cuts the ring. The global rule therefore carries
  `scroll-margin: 4px` (the ring's reach + 1). A sticky header needs
  `scroll-padding` on its scroller as well: the grid uses 36px.
  **Horizontally, Chromium does not scroll a partly visible target at
  all** (measured on Electron 41, and on a bare page). Reel frames call
  `scrollIntoView` on keyboard focus for that reason.
- **Something painted on top.**
  - A positioned later sibling covers the ring: lift the focused control
    with `z-index`.
  - Positioned children cover an element's own inset outline (timeline
    clips and regions): draw the ring on a positioned `::after`.
  - Over media or a dark shadow, add the halo
    `box-shadow: 0 0 0 4px var(--bg-app)`.
  - Canvas layers stack at their own `layer.z_index` (1000+), so editor
    chrome inside `.editor-canvas` uses `Z_INDEX_CHROME`. The crop overlay
    sat at 5, under every arrow.
- **A popup left open.**
  - Menus close on Tab (`useMenuNavigation`), and when focus leaves them
    any other way (`closeWhenFocusLeaves`).
  - A non-modal popover right after its trigger closes when focus lands
    past either end (`useDismissable`'s `dismissOnFocusLeave`).
  - A popover portaled to the end of `<body>` traps Tab instead, and
    closes on a `focusin` outside it (see `DeleteConfirm`). Tab past its
    last element would leave the document with no `relatedTarget`, so
    `blur` never learns where focus went.
- **A floating panel stepping aside.** Use `opacity: 0` plus
  `pointer-events: none`, never `visibility: hidden`. A hidden panel's
  buttons leave the tab order, and Tab from the grid skipped the copy
  palette entirely.
- **`aria-modal` holds no focus.** `useModal` focuses the safe button (its
  `initialFocusRef`), traps Tab and restores focus on close. A dialog that
  focus can reach without Tab also contains `focusin`: `ChatApprovalModal`
  and `AiConsentDialog`.

**How it was measured, and how to re-measure:**

1. Build the renderer with Vite against a fake preload bridge.
2. Tab through each surface in Playwright's headless Chromium.
3. At every stop, record the computed outline, the `overflow` ancestors
   that clip it, and the fraction of ring pixels actually on screen
   (classified by hue, saturation and brightness).
4. Walk both themes, at 1280×800 and at each window's minimum size from
   `window.ts`.

The harness is not in the tree. Headless only: a headed walk takes over
the screen, so it belongs in the lab VM (see Workflow above). Two
residuals are known and accepted:

- Chromium reveals only the caret line of a partly visible `<textarea>`.
- The trim handle signals focus with a hollow fill, not an outline.

## The Pwr-family title strip

**Every window's title strip on macOS is the strip PwrGit and PwrAgent draw:
a 40px fill centred on y=20, stoplights at `{ x: 16, y: 13 }`, the brand at
x=96. These numbers are shared across the family — change them in all three
apps together, never in one.** The spec is PwrGit's
`apps/desktop/src/renderer/src/features/chrome/AGENTS.md`, adopted in
[pwrdrvr/PwrGit#361](https://github.com/pwrdrvr/PwrGit/pull/361).

| Part | Value | Where in PwrSnap |
|---|---|---|
| Band | 40px fill; the 1px divider sits *below* it, so every bar's row is `41px` | `grid-template-rows` on `.psl`, `.pss`, `.szl`, `.ps-doc` |
| Stoplights | `{ x: 16, y: 13 }` — a 14px button (measured on macOS 26) centred on y=20; the group ends at x=76 | `MACOS_TRAFFIC_LIGHT_POSITION` in [window.ts](../../apps/desktop/src/main/window.ts) |
| Windows caption strip | `titleBarOverlay` height 40 — the fill, leaving the divider visible under the buttons | `titleBarOverlayForTheme()` in window.ts |
| Brand start | x=96, 20px clear of the stoplights | `--mac-traffic-light-reserve` in [tokens.css](../../apps/desktop/src/renderer/src/styles/tokens.css) |
| Mark | the app icon's glyph (`generate-app-icon.swift` coordinates) as `PwrSnapMark`, 20px, filling its box; `--accent`, 8px to the wordmark, `decorative` (the wordmark names the app) | [BrandMark.tsx](../../apps/desktop/src/renderer/src/features/shared/BrandMark.tsx) |
| Wordmark | `700 17px/1` Geist, `-0.01em`; "Pwr" `--text-primary`, "Snap" `--accent` | `.psl__title`, `.pss__title-brand`, `.szl__title-brand`, `.ps-doc__brand` |
| Centring | text by cap height (`text-box: trim-both cap alphabetic`), chevrons by x-height (`trim-both ex alphabetic`); an ellipsizing crumb gets `padding-block` back for its descenders | the four bar stylesheets |

Three things that bite:

- **The fill must be an even number of points.** `trafficLightPosition` takes
  whole points, so a 14pt button centres on a whole point only. The old 52px
  row had its divider INSIDE it, leaving a 51pt fill whose centre (25.5) no
  stoplight could sit on.
- **Nothing may sit above a bar in its container.** The stoplights are placed
  in window coordinates; the bar is placed in its container's. The Library's
  `.psl` carried a 1px outer border until 2026-09, which put its strip at
  y=1 and its brand at x=97 — its stoplights sat 1.5pt high. The window
  already has an edge: the OS draws it on macOS and Windows, `#root::after`
  on Linux.
- **Toolbar controls have to fit the band.** The tallest Library control is
  28px (search, capture buttons, layout toggles), which leaves 6px either
  side. A taller one does not belong in the strip.

Pinned by
[macos-traffic-light-position.test.ts](../../apps/desktop/src/main/__tests__/macos-traffic-light-position.test.ts)
(the derivation, from the CSS) and
[window-chrome-platform.spec.ts](../../apps/desktop/e2e/window-chrome-platform.spec.ts)
(the reserve, resolved in a real renderer). Neither can see pixels:
**verify a change by measuring, not by eye.** Render each strip at 2× with the
stoplights drawn at their Electron position as 14px circles, and compare each
element's ink centre with y=20. Text baselines snap to device pixels, so
capitals land within about ±0.4px of the line; anything further out is real.
