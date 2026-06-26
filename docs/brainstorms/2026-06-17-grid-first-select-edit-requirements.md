---
date: 2026-06-17
topic: grid-first-select-edit
---

# Grid-First Browsing: Split Select from Edit

## Summary

The Library should make Grid a fully usable browsing surface in its own
right: a single click *selects* a capture and updates a right-side inspector
in place, without dropping the user into the annotation editor. Entering the
editor becomes an explicit act (an orange **Edit** call-to-action on the tile,
plus `Enter` and double-click). The editor itself becomes a focused takeover
that hides the left navigation rail, which dissolves the current ambiguity
about what filter clicks should do while editing. Grid and Reel are reframed
as two *layouts* of the same browse shell; Edit is an orthogonal *takeover*.

---

## Problem Frame

The user works almost entirely in Grid and rarely uses Reel, but Grid today is
a dead-end browse surface:

- **Select and Edit are the same action.** Single-clicking a grid tile
  dispatches `OPEN_FOCUS` and immediately enters the annotation editor
  (`library-view.ts`, `Library.tsx` `onSelectCell`). There is no lightweight
  "just look at this one" state — every click is a commitment to edit.
- **The right inspector does not exist in Grid.** `DetailRail` returns `null`
  for `view.kind === "grid"`, so a user browsing the grid cannot see a
  capture's metadata, title/description, tags, OCR text, or the L/M/H export
  controls without first entering the editor. (Cart is the lone exception — it
  already shows as a standalone right rail in Grid when non-empty.)
- **The "modes" feel tangled.** Grid, Reel, and Edit (Focus) are modeled as a
  single 3-state union and Focus/Reel render the same Stage + Editor +
  DetailRail. This makes combinations feel like they each need a special rule:
  "what should clicking a left-nav filter do while editing?", "should the
  Grid/Reel toggle work inside Edit?", "if All Captures returns to the grid,
  shouldn't every nav item?". Those questions have no clean answer while the
  three concepts are stacked as one mode dimension.

The root cause is that three independent axes are being treated as one
mode-stack. Separating them is the fix.

### The three axes

| Axis | Control | What it changes |
|---|---|---|
| **Filter** | Left nav (All Captures / Today / Trash / source app / type checkboxes) | *Which* captures are in play |
| **Layout** | Grid ⇄ Reel toggle | *How* the in-play captures are laid out |
| **Edit** | Edit CTA / `Enter` / double-click → exit via ×/Esc/Done | Takeover of *one* capture to annotate |

Filter and Layout belong to a persistent **browse shell** (left nav + right
inspector + select-on-click, shared by Grid and Reel). Edit is a takeover
dropped into from either layout and exited explicitly back to it.

---

## Actors

- A1. Library browser: Scans the grid, clicks captures to inspect metadata,
  copies/exports, and collects items into the cart — mostly without entering
  the editor.
- A2. Annotator: Deliberately opens one capture to annotate it (arrows,
  shapes, highlight, blur, text, crop), then returns to browsing.
- A3. Cart builder: Selects multiple captures across the grid to stage a
  Sizzle Reel.

---

## Key Flows

- F1. Select without editing (Grid)
  - **Trigger:** A1 single-clicks a grid tile.
  - **Actors:** A1
  - **Steps:** The tile becomes the selected capture; the right inspector
    updates in place (Info / OCR / Cart). The user stays in Grid. No editor.
  - **Outcome:** The user reads metadata, copies an export, or adds to cart
    without leaving the grid.
  - **Covered by:** R1, R2, R5–R9

- F2. Enter the editor deliberately
  - **Trigger:** A2 hovers a tile and clicks the orange **Edit** CTA, or
    presses `Enter` on the selected tile, or double-clicks a tile.
  - **Actors:** A2
  - **Steps:** The capture opens as a focused editor takeover. The left nav is
    hidden. The annotation toolbar is available (image captures only).
  - **Outcome:** A distraction-free single-capture editing surface.
  - **Covered by:** R3, R4, R10–R13

- F3. Leave the editor
  - **Trigger:** A2 presses `Esc`, clicks ×, or clicks Done.
  - **Actors:** A2
  - **Steps:** The takeover closes and returns to the originating layout
    (Grid or Reel) with the active filter intact and the prior scroll/anchor
    restored.
  - **Outcome:** The user is back where they were browsing.
  - **Covered by:** R12, R13

- F4. Browse in Reel
  - **Trigger:** A1 toggles to Reel.
  - **Actors:** A1
  - **Steps:** The same filtered set renders as a filmstrip; the left nav
    filters still apply (they define the strip); selecting a frame updates the
    same right inspector. Edit is still entered via the same explicit triggers.
  - **Outcome:** Reel is a second layout of the browse shell, not an
    edit-adjacent mode.
  - **Covered by:** R14, R15

- F5. Inspect a video in Grid
  - **Trigger:** A1 hovers and/or selects a video tile.
  - **Actors:** A1
  - **Steps:** The tile plays on hover; selecting it shows the inspector
    (metadata + GIF/MP4 export grid). No annotation editor opens — there is no
    video editor yet.
  - **Outcome:** Videos are browsable and exportable from Grid; the "Edit" path
    for video is deferred.
  - **Covered by:** R16–R18

---

## Requirements

**Select vs. Edit (the core split)**

- R1. A single click on a grid tile must *select* the capture (update the right
  inspector, set it as the current selection) and must NOT enter the editor.
  Reuse the reserved `SELECT_IN_GRID` view action rather than `OPEN_FOCUS`.
- R2. Selection state in Grid must persist as the user clicks between tiles and
  must clear gracefully if the selected capture is filtered out of the
  current set.
- R3. Entering the editor must be possible via three triggers, all equivalent:
  (a) an orange **Edit** CTA shown on tile hover, (b) `Enter` on the selected
  tile, (c) double-click on a tile.
- R4. The Edit CTA must live in the existing tile hover action affordance
  (alongside the delete control / video play button), not as separate
  chrome.

**Grid inspector (right rail in Grid)**

- R5. `DetailRail` must render in Grid (stop early-returning `null` for
  `view.kind === "grid"`), with a clear empty state when nothing is selected.
- R6. The Grid inspector tab set must be **Info**, **OCR**, and **Cart**. The
  editor-oriented tabs (Chat, Project) are not shown in Grid. The L/M/H copy
  and File export controls live inside the Info panel and come with it.
- R7. When the right rail is **pinned** (the persisted default), selecting a
  tile updates it in place; the rail does not open or close on selection.
- R8. When the right rail is **unpinned**, selecting a tile pops it open
  (peek). It collapses on an explicit event — clicking empty grid space,
  clearing the selection, or `Esc` — NOT on a timer. (No timed auto-hide:
  a panel that disappears mid-read is worse than one that stays.)
- R9. The Cart continues to behave as today (standalone rail when non-empty in
  Grid, auto-pop on first add); folding it into the unified inspector tab set
  must not regress cart collection from grid-tile checkboxes.

**Edit takeover (Focus)**

- R10. Opening a capture in the editor must hide the left navigation rail for
  the duration of the takeover.
- R11. The annotation toolbar (ARROW / SHAPE / HIGHLIGHT / BLUR / TEXT / CROP)
  applies to image captures only, as today.
- R12. The editor must expose an explicit exit (×, `Esc`, and/or Done) that
  returns to the originating layout with the active filter and scroll/return
  anchor preserved. There must be no filter-navigation control inside the
  editor — exit is the only way back to browsing.
- R13. `Enter`/double-click to open and `Esc` to close must round-trip without
  losing selection (the closed-from capture stays selected in Grid/Reel).

**Reel as a browse layout**

- R14. Reel must remain a layout of the browse shell: the left-nav filters
  apply (they define the filmstrip), the right inspector applies, and frame
  selection updates the inspector the same way grid selection does.
- R15. The Grid ⇄ Reel toggle is a pure layout switch. It must not be presented
  as part of the editor takeover; the user exits Edit first, then toggles.

**Video handling (no video editor yet)**

- R16. Video tiles play on hover (as today). The Edit CTA may appear on video
  tiles for visual consistency, but there is **no video editor** to open —
  trim, segment drop, and timeline editing do not exist.
- R17. Until a video editor exists, the Edit path for a video must resolve to
  the existing video surface (native player + GIF/MP4 export grid), not a
  broken/empty annotation canvas. Acceptable resolutions: the CTA is
  image-only, or video "Edit" simply opens the player view. Pick one in
  implementation; do not ship a video Edit CTA that opens an empty editor.
- R18. A real video editor (trim ranges, drop segments, timeline/scrubber) is
  explicitly a **separate future project**, out of scope here. The current
  backend trim-range code exists only for Sizzle sequences and is not a
  user-facing editor.

---

## Out of Scope / Deferred

- **Asset edit chat in Grid.** Deferred. The Chat tab is an edit-surface
  concern; nothing in this change depends on it.
- **Video editor (trim/segment/timeline).** Distinct future project (R18).
- **Multi-select beyond the existing cart mechanism.** This doc covers
  single-selection inspect + cart collection; richer grid multi-select is not
  in scope.

---

## Notes / Architectural Alignment

This change is largely *enabling* existing, intentionally-stubbed
architecture rather than net-new structure:

- The view reducer already reserves a `SELECT_IN_GRID` action (currently
  unused) for exactly this select-without-focus behavior.
- The right-rail pin state and active tab are already lifted to the Library
  top level and persisted (`library.detailRail.{pinned, lastSelectedTab}`),
  so the inspector can be controlled in Grid without new plumbing.
- `DetailRail`'s tab set is already computed dynamically, so restricting it to
  Info / OCR / Cart in Grid is a list filter, not a rewrite.
- Tile hover action affordances already exist (video center-play + action
  rail, delete control), so the Edit CTA slots in rather than introducing a
  new hover layer.
