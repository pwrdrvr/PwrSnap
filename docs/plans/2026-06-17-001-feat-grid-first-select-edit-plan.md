---
title: Grid-First Browsing — split select from edit
type: feat
status: active
date: 2026-06-17
deepened: 2026-06-17
origin: docs/brainstorms/2026-06-17-grid-first-select-edit-requirements.md
origins:
  - docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md
  - docs/plans/2026-05-28-001-feat-sizzle-cart-and-chat-plan.md
---

# Grid-First Browsing — split select from edit

## Enhancement Summary

**Deepened on:** 2026-06-17 — parallel review/research pass (11 agents: TypeScript, frontend-races, architecture, simplicity, performance, security, agent-native, data-integrity, pattern-recognition reviewers + desktop-UX and Electron/React framework researchers).

**Runtime correction:** this app is **React 19.2 + Electron 41** (not React 18). Two consequences used below: automatic batching is total (RO/microtask updates coalesce), and **`yazl`/`archiver` are already MIT direct deps** in `THIRD_PARTY_LICENSES` — Phase 5 needs **no new dependency**.

### Load-bearing corrections to the first-cut plan
1. **Preset vocabulary** — drop the invented `S/M/H`; reuse the existing `RenderPreset = "low" | "med" | "high"` end-to-end. The Zip request is `{ captureIds, presets: RenderPreset[] }`; zip folders are `low/ med/ high/`. (TS + pattern reviewers, unanimous.)
2. **No `data-takeover` attribute** — it's fully derivable from `view.kind === "focus"`. Hide the left nav with `.psl[data-mode="focus"] .psl__left { … }`, matching the existing `data-mode="focus" .psl__grid-wrap { display:none }` rule. (architecture + pattern reviewers.)
3. **`cart:exportZip` `res` is the bare payload, not `Result<…>`** — the command bus wraps every handler in `Result`; the `Commands` map carries the success shape only. Double-wrapping would force the renderer to unwrap twice. (TS reviewer.)
4. **`gridLastSelectedTab` is required-with-default**, not optional `?` — under `exactOptionalPropertyTypes` the resolved settings type must stay total; optionality lives only in `SettingsPatch`. (TS + architecture reviewers.)
5. **No "capability" layer exists** — `bus.register(name, handler)` is the whole registration surface; cart handlers register in `registerCartHandlers()` (`index.ts`), not `command-bus.ts`. Govern the file-writing verb by **principal** (renderer/`ipc` only), not a non-existent capability registry. (architecture + pattern reviewers.)

### Key improvements folded in
- **Performance (critical):** single-click select must NOT re-render the 700+ cell grid — drive the selected ring via a `SelectionContext` self-subscriber or an imperative `data-selected` attribute (the exact discipline `CartCellCheckbox` already uses), `React.memo` `CellRow`/`CellThumb`, and `useCallback` every grid callback. Keep the inspector a fixed outer-grid track; **peek overlays, it does not steal grid width** (else every select reflows `cellsPerRow`).
- **Races:** one peek cancel-token ref (cancel on edit / click-empty / filter-clear / select-other / unmount / blur); `Enter` reads `viewRef.current` (synchronous) not an effect-synced ref; dispatch `SELECT_IN_GRID` with `history:"replace"` so a double-click doesn't pollute Back; CTA `stopPropagation` on **both** click and dblclick; `pendingOpen`/`editor:open` go through `viewDispatch` with a monotonic seq guard, never a direct `setView`.
- **Phase 5 (the real depth):** render in **main** via the existing `resolveImagePresetFile` (returns file *paths*, never buffers → memory bounded for free); concurrency-cap renders to `min(cpuCount, 4)`; stream into **`yazl`** by path; `mkdtemp` 0700 staging cleaned in `finally` on success/error/**cancel**; bus-boundary validator; per-item liveness (skip trashed/purged/non-image); **partial-failure manifest result** (`ok` if ≥1 file, with succeeded/failed/skipped); zip-slip sanitization + destination symlink/privileged-path defense; cancellable via the bus `cancellationKey`/`AbortSignal`; progress via a `cartExportProgress` broadcast mirroring `sizzle-handlers`.
- **Agent-native parity:** expose the cart lifecycle to the Codex tool allowlist (`export_zip`, `cart_get`, `add_to_cart`/`remove_from_cart`, `reorder_cart`, `create_sizzle_reel`/`add_cart_to_reel`); prefer the **stateless** `export_zip(captureIds)` path so the agent doesn't race the user's global cart. View state (select/pin/tab) stays UI-only.

### New considerations discovered
- **WCAG 1.4.13** forbids timed auto-hide of hover/selection-revealed content — independently validates the "no-timer peek" decision; make collapse strictly event-driven.
- Returning from the editor must **restore scroll + selection** — a near-universal app convention; make it an explicit test for both Grid- and Reel-origin.
- Hover actions (the Edit CTA) must be **mirrored** in the selected-item inspector/context-menu/keyboard, never hover-only.
- Cross-phase ordering hazard: Phase 3 must switch the grid right-col CSS off `data-cart` onto a pinned/peek/cart-derived signal **before** Phase 5 deletes `cartIsOpenInGrid`, or land them atomically.

---

## Overview

Make **Grid** a first-class browsing surface. Today a single click on a grid
tile drops the user straight into the editor takeover; the right inspector
doesn't exist in Grid at all. This plan splits the two levels of engagement:

- **Single click = SELECT** — updates a restricted right inspector in place,
  stays in Grid, no editor.
- **Explicit trigger = EDIT** — an orange **Edit** CTA on tile hover, the
  `Enter` key on the selected tile, or double-click opens the editor as a
  *takeover* that hides the left nav.

It also reframes the three things tangled into one `view.kind` union today —
**Filter** (left nav), **Layout** (Grid ⇄ Reel), **Edit** (single-capture
takeover) — as three independent axes, and upgrades the Cart into a
cross-asset surface that can batch-export selected images as a Zip.

This is almost entirely renderer-side and leans on primitives that already
exist: the reserved-but-undispatched `SELECT_IN_GRID` reducer action (origin:
`docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md`, which
defined it "for future grid-select / cmd-click"), the controlled `DetailRail`
pin/tab state, the `data-cart="open"` precedent for widening the right column,
and the `resolveImagePresetFile` cached render path. The one new server-side
surface is a Zip batch-export verb.

## Problem Statement

From the origin requirements doc
(`docs/brainstorms/2026-06-17-grid-first-select-edit-requirements.md`):

- **Select and Edit are the same action.** `onSelectCell`
  ([Library.tsx:2244-2267](apps/desktop/src/renderer/src/features/library/Library.tsx))
  dispatches `OPEN_FOCUS` on a single click — there is no "just look at this
  one" state.
- **No inspector in Grid.** `DetailRail` hard-returns `null` for
  `view.kind === "grid"`
  ([DetailRail.tsx:497](apps/desktop/src/renderer/src/features/library/DetailRail.tsx)).
- **The "modes" feel tangled.** `data-mode` conflates *layout* (grid pane vs
  Stage) with *takeover*, and the right-rail / left-nav visibility piggyback on
  it. The son's intuition — if "All Captures" returns to Grid from the editor
  then every nav item should — terminates at: the nav doesn't belong in the
  editor at all.

## Proposed Solution

Three independent axes, each with one control:

| Axis | Control | What it changes |
|---|---|---|
| **Filter** | Left nav (All Captures / Today / Trash / source-app / type checkboxes) | *Which* captures are in play |
| **Layout** | Grid ⇄ Reel toggle | *How* the in-play captures are laid out |
| **Edit** | Edit CTA / `Enter` / double-click → exit via ×/Esc/Done | Takeover of *one* capture to annotate |

Filter + Layout belong to a persistent **browse shell** (left nav + right
inspector + select-on-click, shared by Grid and Reel). Edit is an orthogonal
**takeover** entered from either layout and exited explicitly back to it, with
the left nav hidden for its duration.

> **Architectural note (deepened):** keep all three "as one `LibraryView`
> union + outside-the-union state" exactly as today. `focus` *must* stay a
> union `kind` (it makes `selectedRecordId` non-null at compile time — the
> whole reason the union exists); Filter and Layout already live *outside* the
> union (filter state + the grid/reel toggle) and should stay there. So the
> model is already three axes — two outside, one (`focus` vs `grid`/`reel`)
> inside. Sharpen the `LibraryView` doc comment so a future reader doesn't
> misread Grid/Reel as "the layout axis inside the union" and start adding
> `cart`/`peek` kinds.

### Architecture

```
                         ┌───────────────────────── .psl (CSS grid) ─────────────────────────┐
   FILTER axis           │  ┌──────────┐  ┌───────────────────────────┐  ┌────────────────┐   │
   (left nav)  ──────────┼─▶│ psl__left│  │   psl__main (col 2)       │  │  DetailRail     │  │
   selectFilter()        │  │ (filters)│  │  ┌─────────────────────┐  │  │  Info/OCR/[Cart]│  │
                         │  │          │  │  │ Grid pane  | Stage   │  │  │                 │  │
   LAYOUT axis           │  │ hidden   │  │  │ (data-mode toggles   │  │  │  empty-state    │  │
   (Grid⇄Reel) ──────────┼─▶│ when     │  │  │  which is shown)     │  │  │  when nothing   │  │
   TOGGLE_VIEW           │  │ data-mode│  │  └─────────────────────┘  │  │  selected       │  │
                         │  │ ="focus" │  └───────────────────────────┘  └────────────────┘   │
   EDIT axis (takeover)  │   ▲   .psl[data-mode="focus"] .psl__left { display:none }           │
   resolveCellIntent() ──┼───┘  (no new attribute — reuse data-mode; never mutate data-left)   │
   → OPEN_FOCUS          └─────────────────────────────────────────────────────────────────────┘

   selectedRecordId : single source of truth, lives in LibraryView union.
   SELECT_IN_GRID   : sets it in grid (history:"replace", no takeover).  OPEN_FOCUS : takeover.
   resolveCellIntent(trigger, gridCell, ctx) → SELECT | EDIT | OPEN_SIZZLE | NOOP
     ↑ the ONE place click / dblclick / Enter / Edit-CTA / editor:open converge
   selected ring : driven by SelectionContext self-subscriber / data-selected — NOT a grid-wide prop.
```

### Key decisions (carried from origin + locked this session)

1. **Cart is a cross-asset tab, visually separated** from the per-capture tabs
   in the inspector. The standalone grid cart rail (`cartIsOpenInGrid`)
   retires — **one** cart surface. The cart gains a **"Make Zip"** batch export
   (the chosen presets — defaulting to all of **low/med/high** — of all
   selected images in one Zip) alongside "Add to Sizzle Reel"
   (decided 2026-06-17).
2. **Video Edit opens the player takeover** — Stage already renders a native
   `<video>` player and suppresses the annotation toolbar for `kind === "video"`
   ([Stage.tsx:284-316](apps/desktop/src/renderer/src/features/library/Stage.tsx)).
   A real trim/segment editor is a **separate future project**.
3. **Project tiles are exempt** from the select/edit split — single-click still
   opens the Sizzle window
   ([Library.tsx:2248-2250](apps/desktop/src/renderer/src/features/library/Library.tsx)).
4. **Grid inspector tabs = Info + OCR + Cart.** Chat/Project are Focus/Reel-only.
5. **No timed auto-hide.** Pinned (default) → select updates in place. Unpinned
   → select pops a peek that collapses on an explicit event, never a timer.
   This is also a hard accessibility rule (**WCAG 1.4.13** — hover/focus content
   must be dismissable and persistent, never time-limited).

### UX-convention grounding (deepened)

The model matches the established desktop pattern (Apple HIG, Photos, Lightroom,
Capture One, CleanShot X): single-click = select + follow-the-selection
**Inspector** (HIG's named pattern, distinct from a pinned "Info window");
double-click / `Enter` / Edit-CTA = open the heavyweight editor; editor takeover
hides browse chrome; `Esc` = back out, `Done` = finish-and-return. Two
divergences, both deliberate and justified:

- `Enter` = open/edit (Photos model), **not** Finder's `Return` = rename. PwrSnap
  is a media library, so this is correct — but **do not** also bind `Return` to
  inline rename, or the two muscle-memories collide.
- A follow-the-selection inspector that *peeks* when unpinned is fine **only**
  because collapse is event-driven (WCAG 1.4.13). The hover Edit CTA must be
  **mirrored** in the selected-item inspector / context menu / keyboard — never
  the sole path to edit.

Returning from the editor must restore the prior grid **scroll + selection** —
universal app behavior, treated here as a hard requirement with a test.

### One intent resolver (load-bearing)

A single pure function decides what a tile interaction means, so the click,
double-click, `Enter`, Edit-CTA, and `editor:open` IPC paths cannot diverge
(SpecFlow C2; learning:
`docs/solutions/2026-06-07-capture-selector-interaction-and-state.md`).

**Deepened — the resolver must be pure over a *real* discriminated union.**
The actual cell type is a flat `Capture` where `kind === "project"`,
`projectId !== undefined`, and "is a fixture" are *separate runtime checks*
([Library.tsx:2248-2256](apps/desktop/src/renderer/src/features/library/Library.tsx)) —
there is no `GridCell` union today. Add a `toGridCell(capture, ctx)` normalizer
that narrows `Capture → capture | project | fixture` *before* the resolver, so
the resolver stays exhaustive and the `!== undefined` checks don't leak into the
pure function.

```ts
// features/library/resolve-cell-intent.ts  (NEW, pure, unit-tested)
type GridCell =
  | { kind: "capture"; recordId: string; isTrashed: boolean }
  | { kind: "project"; projectId: string }
  | { kind: "fixture" };

type CellIntent =
  | { kind: "select"; recordId: string }
  | { kind: "edit"; recordId: string }          // → OPEN_FOCUS (image annotate OR video player)
  | { kind: "open-sizzle"; projectId: string }
  | { kind: "noop" };

type Trigger = "click" | "dblclick" | "enter" | "edit-cta" | "ipc-open";
function resolveCellIntent(trigger: Trigger, cell: GridCell): CellIntent;
```

Rules: `project` → `open-sizzle` (any trigger); `fixture` → `noop`; trashed
capture → `select` on `click`, `noop` on edit triggers (server already rejects,
[library-handlers.ts:508-514](apps/desktop/src/main/handlers/library-handlers.ts));
`click` → `select`; `dblclick`/`enter`/`edit-cta`/`ipc-open` → `edit`.

---

## Implementation Phases

```
Phase 1  View-model & resolver (pure, no visible change)        ~6-8h
Phase 2  Grid interaction: select vs explicit edit              ~8-10h
Phase 3  Right inspector in Grid (restricted, empty state)      ~10-12h
Phase 4  Edit takeover hides left nav                           ~6-8h
Phase 5  Cart: cross-asset tab + batch Zip export (low/med/high)~14-18h
Phase 6  E2E, polish, solution doc                              ~6-8h
```

Phases 1→4 are sequential. Phase 5 depends on Phase 3 (the inspector hosts the
Cart tab) but is otherwise independent. Phase 6 closes out. *(Simplicity note:
Phase 1 has no user-visible output and Phase 2 is its only consumer — they may
land as one PR; keep split only if you want the resolver/reducer tests green
before any UI churn.)*

---

### Phase 1 — View-model & intent resolver (~6-8h)

**Goal:** All pure logic for select-vs-edit, no visible UI change.

**Files**
- `apps/desktop/src/renderer/src/features/library/library-view.ts` (update)
- `apps/desktop/src/renderer/src/features/library/resolve-cell-intent.ts` (new)
- `…/__tests__/library-view.test.ts` (extend; **rewrite** the grid `FILTER_CHANGED` no-op test at :272)
- `…/__tests__/resolve-cell-intent.test.ts` (new)

**Approach**
- `SELECT_IN_GRID` already no-ops outside grid and sets `selectedRecordId` in
  grid (:121-123) — keep as-is; it gets its first dispatcher in Phase 2. Add an
  early-return if `selectedRecordId` is already that id (avoid a wasted render).
- **`FILTER_CHANGED` in grid (SpecFlow I1):** it currently early-returns for
  grid (:138, with an explicitly-tested no-op). Replace with: identity-stable
  clear when the selection left the visible set —
  `if (state.selectedRecordId === null) return state; return action.visibleIds.includes(state.selectedRecordId) ? state : { kind:"grid", selectedRecordId:null }`.
  **Rewrite** the existing "in grid, ignored" test and update the inline comment.
- **`TOGGLE_VIEW` synthesized-selection (SpecFlow I2):** add
  `readonly selectionSynthesized: boolean` to the `reel` (and `focus`) variants —
  *in the union, not a React ref*, so the reducer stays pure and testable from
  `(state, action)` alone. `TOGGLE_VIEW to:"reel"` sets it `true` when it fell
  back to `fallbackId` (`state.selectedRecordId === null`), `false` otherwise.
  `TOGGLE_VIEW to:"grid"` nulls the grid selection when `selectionSynthesized`.
  `SELECT_IN_GRID` and any real selection reset it to `false`. (TS reviewer #8.)
- Implement `resolveCellIntent` + `toGridCell` per the rule table.

**Test scenarios**
- `SELECT_IN_GRID` sets/keeps grid selection; no-op in focus/reel; same-id is a
  referential no-op.
- `FILTER_CHANGED` clears a grid selection that left `visibleIds`; keeps a still-
  visible one; returns the *same object* when nothing changes (render contract).
- `TOGGLE_VIEW` grid→reel(fallback)→grid leaves `selectedRecordId === null`;
  grid(selected A)→reel→grid keeps A.
- `resolveCellIntent`: project→open-sizzle; trashed→select on click, noop on
  enter/edit-cta; fixture→noop.

**Verification:** `pnpm test` green; no UI change.

---

### Phase 2 — Grid interaction: select vs explicit edit (~8-10h)

**Goal:** Single-click selects; Edit CTA / `Enter` / double-click open the
editor. All routed through `resolveCellIntent`.

**Files**
- `…/Library.tsx` (update — `onSelectCell` :2244, cell JSX :3892-4007, keydown :2138-2235, `viewDispatch` :957)
- `…/styles/library.css` (Edit CTA in `.psl__cell-rail`; `user-select:none` on cells)
- new `SelectionContext` (or imperative `data-selected`) for the selected ring
- `…/__tests__/Library.shortcuts.test.tsx` (extend)

**Approach**
- Rewrite `onSelectCell` to call `resolveCellIntent(trigger, toGridCell(cell), …)`:
  `select` → `SELECT_IN_GRID` **with `history:"replace"`** (grid selection is a
  transient inspector update, not a Back stop — prevents double-click history
  pollution, julik #1); `edit` → `OPEN_FOCUS`; `open-sizzle` → `openSizzleProject`.
- **Performance — selection must not re-render the grid (performance-oracle #1, critical).**
  `view` is root `useState`; `VirtualizedGrid`/`CellRow`/`CellThumb` are **not**
  memoized and `onSelectCell` is a fresh closure each render. Today single-click
  unmounts the grid (OPEN_FOCUS) so the cost is hidden; `SELECT_IN_GRID` keeps it
  mounted, turning select into a full-grid re-render.
  - Do **not** thread `selectedRecordId` as a prop through the grid. Put it in a
    `SelectionContext` read by a tiny `useIsSelected(cellId)` self-subscriber, or
    stamp a `data-selected` attribute imperatively and style the ring in CSS —
    the exact pattern `CartCellCheckbox` already uses (:159-166).
  - `React.memo` `CellRow` + `CellThumb`; `useCallback` every grid callback
    (`onSelectCell`, `preloadFullRes`, `duplicateSizzleProject`,
    `openProjectContextMenu`, `trashCapture`, `restore`, `purge`).
  - **Targets:** select commits < 16 ms @700 captures, < 50 ms @10k; select
    re-renders only the prev + new cell + rail; **zero `cellsPerRow`/`flatRows`
    recompute** when viewport width is unchanged.
- **Edit CTA:** orange button in the existing hover cluster `.psl__cell-rail`
  (:3933-4007). A real `<button>` (keyboard/AX), `stopPropagation` on **both**
  `onClick` and `onDoubleClick` (julik #4 — else CTA click = select+edit, and a
  CTA double-click bubbles to the cell). Image tiles read "Edit"; video tiles
  read "Edit" → player takeover.
- **Double-click:** `onDoubleClick` → `edit`. `onClick` fires first (DOM:
  click→click→dblclick) — that's fine because select is idempotent + `history:"replace"`
  and the takeover paints over it. **No select-debounce** (a 250ms wait makes
  single-click feel laggy). Make `OPEN_FOCUS` idempotent against scroll jitter:
  capture `returnAnchor.scrollTop` *once* at intent time, or have
  `sameLibraryView` ignore `returnAnchor` (it's a side-channel, not identity) —
  else two near-simultaneous opens with 1px-different scroll push two history
  entries (julik #4). Add an "already-opening" guard so a second `edit` within
  the same view-state is dropped.
- **Enter:** add a `kind === "grid"` branch to the document keydown handler
  (:2209+). Read selection from **`viewRef.current.selectedRecordId`** (updated
  *synchronously* in `viewDispatch` :969) — **not** the effect-synced
  `selectedRecordRef`, which is one commit stale and would open the *previous*
  tile on click-then-immediate-Enter (julik #3). No-op when null. Respect the
  existing INPUT/TEXTAREA/contentEditable bail (:2155-2159).
- **Triple/rapid clicks (julik #11):** `SELECT_IN_GRID` while focus is already a
  reducer no-op (good); additionally, when the takeover mounts, drive the grid
  `pointer-events:none` / `display:none` *synchronously* with the `data-mode`
  flip so a trailing click can't land on a newly-revealed editor element.
- Trash view: Edit CTA hidden / edit intent → noop (resolver handles it).

**Test scenarios**
- Click → `SELECT_IN_GRID`, no `OPEN_FOCUS`; exactly one new selection, **no**
  Back-history entry (replace).
- Edit CTA click → one `OPEN_FOCUS`; CTA double-click → still one open.
- Double-click → one `OPEN_FOCUS`, one Back entry; Back from focus lands in grid
  with no synthesized selection.
- Click-then-Enter same tick edits the just-clicked tile (sync `viewRef`).
- Triple-click doesn't leak a click onto the editor.
- React Profiler: select re-renders only old+new cell + rail.

**Verification:** all four edit triggers produce identical view transitions;
click never opens the editor; select is one-frame at 700 captures.

---

### Phase 3 — Right inspector in Grid (restricted) (~10-12h)

**Goal:** Mount `DetailRail` in Grid (Info + OCR + Cart), an empty state,
pinned-updates / unpinned-peek behavior, no Rules-of-Hooks regression.

**Files**
- `…/DetailRail.tsx` (early returns :497-498, tab `useMemo` :424-481, `record===null` branch, orphan-tab effect :489)
- `…/Library.tsx` (`data-right` gate :2535-2541, `--right-col`, pin/tab seed :699-871, new `visibilitychange` handler)
- `…/styles/library.css` (right-col open in grid via pinned/peek/cart signal — **stop keying on `data-cart`**)
- `packages/shared/src/protocol.ts` (required `gridLastSelectedTab` on `LibrarySidebarSettings`)
- `apps/desktop/src/main/settings/desktop-settings-service.ts` (default + parse fill)
- `…/__tests__/DetailRail.test.tsx` (extend hooks-order guard :879)

**Approach**
- **Rules-of-Hooks (highest risk; framework + architecture + TS reviewers).**
  Hoist *every* hook above all branches; push conditions *inside* hooks
  (`useEffect(() => { if (record === null) return; … }, [record])`), never
  `if (record === null) return null;` before a hook. Replace the grid early-
  return with a **render-time JSX branch at the bottom** (empty-state shell vs
  populated). The shell must be **inert**: no `<video>`, no per-capture IPC
  (keep the `record === null` guard on the `codex:enrichment` effect :365 — grid-
  empty fires **zero** per-capture IPC). Extend the guard test to *transition*
  grid-empty ↔ grid-selected ↔ focus in one test (ESLint can't catch a hook
  reached via a nested early return).
- **Restricted tabs:** grid-specific list = Info, OCR, Cart-when-present; drop
  Chat/Project. Cart tab rendered **visually separated** (divider/own group) to
  signal cross-asset state.
- **`gridLastSelectedTab`:** add as a **required** sibling of `lastSelectedTab`
  on `LibrarySidebarSettings`, default `"info"` in `defaultSettings()`, fill in
  `parseV1`; clamp to the grid set via the existing orphan→info effect (:489).
  Additive — **no `schemaVersion` bump** (settings-substrate rules). Keep one
  shared `pinned`.
- **Hydration race (julik #9):** the binary `userTouchedRailRef` is too coarse
  for two fields — track touch **per-field** (or a monotonic `seq` per field,
  the substrate's "late resolutions dropped" pattern) so an untouched field
  still hydrates while a touched one is preserved. The `events:settings:changed`
  broadcast must **not** re-apply grid tab/pin into the window that originated
  the write. Mirror `settingsHydrated` to avoid a first-paint width flash.
- **Pinned → update in place. Unpinned → peek**, collapse on click-empty-grid /
  clear-selection / Esc — **never a timer** (WCAG 1.4.13). One `peekTimerRef`
  with a cancel-token; `armPeek(id)` clears any pending timer first, the fired
  handler bails if `selectedRecordIdRef.current !== id`; cancel on edit /
  click-empty / `FILTER_CHANGED` clear / select-other / **unmount** / **blur**
  (julik #2).
- **Layout (performance-oracle #2):** make the inspector a **fixed outer-grid
  track** (`--right-col`) so pinned-open shifts width **once**; the **peek
  overlays** the grid (absolute/fixed), it does **not** steal grid width — else
  every select/hover reflows `cellsPerRow` over 700 rows. Cross-phase: switch the
  CSS off `data-cart` onto the pinned/peek/cart signal here, **before** Phase 5
  removes `cartIsOpenInGrid` (julik smaller-note).
- **ResizeObserver (julik #7, framework Topic 2):** if the rail self-measures,
  measure an `inline-block` wrapper outside any `overflow:hidden` (CLAUDE.md);
  split read/write across a frame with `requestAnimationFrame` + an idempotent
  `posted` sentinel; let CSS own the width animation and read on `transitionend`;
  **never `flushSync` in an RO callback**. Keep transitions finite (no infinite
  animation — compositor-starvation learning).
- **Window-blur (julik #8):** use `visibilitychange` + `document.hidden` (not
  bare `blur`, which fires for child-window focus). On hidden: cancel the peek
  timer, collapse the peek, pause any *`isConnected`* hover/preview video. Don't
  auto-resume on return.
- **Esc precedence in grid (SpecFlow I4/I10; julik #6), ordered:** search-clear
  → collapse unpinned peek → clear grid selection → no-op. Caveat: the document
  handler bails when an INPUT is focused (:2158), so search-clear when the search
  field has focus must live in the **input's own** `onKeyDown` (+ `stopPropagation`)
  — exactly **one** observable effect per Esc. Unit-test the matrix
  {search y/n} × {peek y/n} × {selection y/n}.

**Test scenarios**
- Grid + no selection → inert empty shell (no video, no per-capture IPC), hooks run.
- Grid + select → Info populates; tabs stay within Info/OCR/Cart.
- Focus-on-Chat → toggle Grid → Grid shows Info; Focus `lastSelectedTab` unchanged.
- Unpinned: select peeks (overlay); click-empty collapses; Esc matrix holds.
- Pinned: select updates in place, no churn, zero `cellsPerRow` recompute.
- Select A then filter A away → enrichment listener for A unsubscribed; a late
  `aiRunUpdated` for A is ignored (julik #10).
- Blur while peek-timer pending → no peek on return; previewing video paused.

**Verification:** `library-right-rail.spec` + `library-source-filter.spec` green;
no first-paint flash; opening the inspector triggers ≤1 `cellsPerRow` recompute,
peek triggers none.

---

### Phase 4 — Edit takeover hides left nav (~6-8h)

**Goal:** Opening the editor hides the left nav; exit restores the originating
layout + scroll + selection; `editor:open` converges with the click path.

**Files**
- `…/Library.tsx` (`pendingOpen` :2070-2099, root `.psl` attrs :2527-2546)
- `…/styles/library.css` (`.psl[data-mode="focus"] .psl__left { display:none }`)
- `…/Stage.tsx` (verify video player takeover path — no structural change)

**Approach**
- **Hide the left nav via the existing `data-mode`** — no new attribute:
  `.psl[data-mode="focus"] .psl__left { display:none }`, mirroring the existing
  `.psl[data-mode="focus"] .psl__grid-wrap { display:none }` (:2964). **Never
  mutate `data-left`** on takeover — visually suppress the nav while *preserving*
  its collapsed/peek/pinned state, so exiting restores precisely the pre-editor
  nav (same preserve-and-restore discipline as `GridReturnAnchor`). Make the
  takeover rule out-specify every `data-left` rule.
- **Preserve editor-canvas invariants** (learning
  `docs/solutions/2026-06-13-editor-crop-invisible-overflow-visible.md`): no
  `overflow:hidden` on `.editor-canvas`; don't flatten `.editor-image-clip`.
- **Converge `editor:open`/`pendingOpen` (SpecFlow C2; julik #5).** `pendingOpen`
  hardcodes `kind:"focus"` and writes `viewRef`/`setView` **directly** (:2077,
  :2097) — route it through `OPEN_FOCUS` via `viewDispatch` so the resolver's
  history-dedupe + the already-opening guard apply. Add a monotonic `seq` on
  `pendingOpen` + `lastIntentSeqRef` so a user click landing after an IPC-open
  bails the stale pending effect ("late resolutions dropped"); clear
  `pendingOpen` *before* any `find`/await so a re-render can't re-enter it. This
  preserves the existing `open_editor` agent tool's parity (it dispatches the
  same `editor:open`).
- **Exit** (×/Esc/Done) → `CLOSE_FOCUS` → originating layout. Grid-origin already
  restores scroll via `returnAnchor` (:2440-2469); **add the Reel-origin return
  target**. Keyboard stays canonical in Focus (learning
  `docs/solutions/2026-06-13-edit-menu-undo-redo-bridge.md`).

**Test scenarios**
- Enter editor from Grid → nav hidden; Esc → Grid, same scroll/filter, tile still selected.
- Enter from Reel → nav hidden; Esc → Reel.
- **Cross-axis:** nav collapsed → open editor → close → nav still collapsed; nav
  pinned-open → open editor → close → nav pinned-open (the coupling-smell guard).
- `editor:open` IPC (simulated Codex/undo) → identical takeover state as dblclick;
  user click after IPC-open resolves deterministically, no flip-flop.
- Editor crop + off-canvas handles still render.

**Verification:** `library-focus-scroll.spec` green; cross-axis nav test green.

---

### Phase 5 — Cart: cross-asset tab + batch Zip export (~14-18h)

**Goal:** Cart lives as a visually-separated inspector tab and can export the
selected images as one Zip at the chosen presets (default low/med/high),
alongside "Add to Sizzle Reel."

**Files**
- `…/CartPanel.tsx` ("Make Zip" + progress / skipped-failed surfacing)
- `apps/desktop/src/main/handlers/cart-handlers.ts` (`cart:exportZip`, `cart:exportZip:cancel`)
- `apps/desktop/src/main/handlers/cart-validators.ts` (`validateCartExportZip`)
- `apps/desktop/src/main/index.ts` (`registerCartHandlers` — registration, **not** command-bus.ts)
- `packages/shared/src/protocol.ts` (req + manifest res types; `CartExportProgressEvent`; `EVENT_CHANNELS.cartExportProgress`)
- `apps/desktop/src/main/render/image-presets.ts` (reuse `resolveImagePresetFile`, `targetWidthForImagePreset`)
- `apps/desktop/src/main/ai/library-tool-allowlist.ts` (agent tools — see Agent-Native section)
- main-process unit tests (handler + validator)

**Architecture (deepened — corrects the first cut).**
- **Render runs in the main process** through the existing coordinator; there is
  **no child-process image renderer** (that's a Phase-6 sizzle aspiration). Build
  the Zip as a loop over **`resolveImagePresetFile(record, preset)`** (the same
  cached entrypoint `clipboard:copy-file` uses) — it returns a **file path + byteSize,
  never a buffer**, so rasters never sit in JS memory and the "stream to disk"
  risk is handled for free. Most cart images are unedited screenshots → High =
  source-reuse (no render); content-addressed cache makes repeats near-free.
- **`res` is the bare payload, not `Result<…>`** (bus wraps). Make it a
  **manifest**:
  ```ts
  // Commands["cart:exportZip"].res
  type CartExportZipResult = {
    path: string | null;            // null when zero succeeded
    fileCount: number; byteSize: number;
    requested: number;              // captureIds × presets
    succeeded: Array<{ captureId: string; preset: RenderPreset }>;
    failed:    Array<{ captureId: string; preset: RenderPreset; reason: string }>;
    skipped:   Array<{ captureId: string; reason: "video"|"trashed"|"purged"|"not_found" }>;
  };
  ```
  **Partial success is `ok`** (≥1 file written, with `failed`/`skipped`
  populated); reserve `err` for zero-success / empty-cart / cancel / pre-flight.
  Write a `MANIFEST.txt` into the zip root.
- **Concurrency + memory (performance-oracle #3):** cap simultaneous renders at
  `min(os.cpus().length, 4)` (a ~20-line async pool, no dep) so peak resident
  raster memory is bounded by the cap, **independent of cart size** (budget
  < ~600 MB for a 100-capture Retina cart). Use **`yazl`** (already MIT) —
  `addFile(path, "low/foo.png")` by path; PNGs are already compressed → **store /
  level 0**, don't re-DEFLATE. Dedup equal resolved widths (DPI ladder collapses
  Med==High on small captures) via the existing `link()`-with-copy-fallback
  helper rather than writing identical bytes twice.
- **Snapshot, not read-through (data-integrity B):** export the `captureIds`
  passed in the request; the handler must **not** call `cart.get()` mid-export, so
  a cart change in another window can't alter the zip.
- **Per-item liveness (data-integrity C; security H3):** resolve each id via
  `getCaptureById` (which returns soft-deleted rows). Skip + count `deleted_at != null`
  ("trashed"), missing ("purged"/"not_found"), and `kind !== "image"` ("video",
  keyed on `kind`, **not** `bundle_format_version`). Self-heal: prune purged ids
  from the live cart and broadcast `cartChanged`.
- **Cancellation (data-integrity E; framework Topic 4):** no native AbortSignal
  over IPC — mirror `sizzle-handlers`: renderer generates a `jobId`; main keeps an
  `AbortController` `Map` keyed by `jobId`; a `cart:exportZip:cancel { jobId }`
  verb aborts; check `signal.aborted` between renders; on abort skip the Save
  dialog, clean temp, return `err{ code:"cancelled" }`. Disable "Make Zip" while
  a job is in flight (no concurrent exports).
- **Progress:** add `EVENT_CHANNELS.cartExportProgress` + `CartExportProgressEvent
  { jobId, phase, ratio, fileCount?, error? }`; `win.webContents.send` per render;
  drive a **determinate** bar (no infinite shimmer). The preload `subscribe`
  wrapper must not leak `ipcRenderer` via the callback.
- **Validator (`validateCartExportZip`, pattern + security H1/H2):** `captureIds`
  non-empty deduped string array; `presets ⊆ {low,med,high}` deduped, default all;
  reject unknown keys; **cardinality cap** (reject oversize carts → disk-fill/OOM
  DoS); above ~200 captures surface an estimate + confirm before starting.
- **No `broadcastCartChanged`** on export (it doesn't mutate the cart), except the
  self-heal prune above.

**Security (security-sentinel — append to ACs).**
- **Zip-slip:** re-run every entry path component through `slugifyFilenameStem`
  immediately before use (the export filename stems are user/AI-generated),
  assert `^[A-Za-z0-9._-]+$`, no `..`; collision-suffix duplicates (`-2`,`-3`) so
  no entry silently overwrites another. yazl's `..` rejection is defense-in-depth,
  not the primary guard.
- **Destination safety:** the **Save dialog is mandatory** (user consents to the
  path; pass the owning window). `resolve()` the chosen path, `lstat` the parent,
  refuse symlinks and privileged prefixes (`~/.ssh`, `~/Library/Keychains`,
  `/private/etc` — mirror `assertSafePastedFile`), write atomically (temp+rename
  in the dest dir). This is the codebase's **first** `showSaveDialog` — treat as
  new attack surface.
- **Temp hygiene:** `mkdtemp(join(tmpdir(),"pwrsnap-cart-zip-"))` (unpredictable),
  0700, `rm(recursive,force)` in `finally` on success/error/**cancel/dialog-cancel**;
  best-effort startup sweep of stale `pwrsnap-cart-zip-*` (tmpdir is OS-volatile
  scratch — the "never wipe persisted state" rule does **not** apply).
- **Error sanitization:** renderer-visible `Result.err` carries a generic message
  + stable `code`; log paths/causes main-side only.
- **Principal:** restrict the file-writing path to `principal === "ipc"` (and the
  agent tool — see below) — there is no general capability layer to lean on.

**Reveal:** `shell.showItemInFolder(path)` (existing idiom). Default archive name
`PwrSnap Export <date>.zip` (avoid Finder's bare `Archive.zip`); folders
`low/ med/ high/`; kebab-case member names, uniqueness-suffixed.

**Test scenarios**
- N images × chosen presets → manifest with succeeded count; `MANIFEST.txt` present.
- Cart mutated in another window mid-export → zip unchanged (snapshot).
- Trashed/purged/non-existent/video ids → skipped+counted, never "failed";
  purged id pruned from cart with broadcast.
- Stem decoding to `../../evil` / containing `/`,`\`,NUL → sanitized entry under
  its preset folder; colliding stems → distinct entries.
- Save-dialog cancel → `err{cancelled}`, temp removed, no error toast.
- Cancel mid-export → loop stops, temp + partial zip removed, `cancelled` reported.
- Re-clicking "Make Zip" while in flight → no second concurrent job.
- Concurrency never exceeds `min(cpuCount,4)`; peak memory cart-size-independent.

**Verification:** main-process handler + validator unit tests green; zip opens
with `low/med/high` structure; security AC checklist passes.

---

### Phase 6 — E2E, polish, solution doc (~6-8h)

**Goal:** Lock behavior with E2E and capture the learnings.

**Files**
- `apps/desktop/e2e/library-grid-select-edit.spec.ts` (new)
- `apps/desktop/e2e/library-cart-zip.spec.ts` (new)
- `docs/solutions/2026-06-17-grid-inspector-and-cart-zip.md` (new)

**Approach**
- **Hover-CTA spec** uses the `expect.poll` re-dispatch pattern (learning
  `2026-06-07-capture-selector...` §5) — re-drive hover inside the poll so an
  environmental mousemove can't flip CTA visibility.
- **Resize/measure** gates assert content-arrival, not a quiet timer (learning
  `2026-06-13-windows-vs2026-runner...`).
- Specs: click selects (no editor, no Back entry); CTA/Enter/dblclick edit;
  takeover hides left nav; Esc returns with scroll+selection intact (Grid- and
  Reel-origin); cart zip produces a file with the manifest. Run the Linux subset
  via `pnpm test:desktop-e2e:docker`.
- Solution doc records: DetailRail-in-grid hooks discipline, the SelectionContext
  self-subscriber for select-without-grid-rerender, and the cart-zip
  render/zip/cancel contract (no prior solution covers these).

**Verification:** new specs green locally + Docker Linux subset.

---

## Agent-Native Parity (deepened — new)

Per the single-command-bus + "Codex is the AI brain" conventions, every user
action should be agent-reachable. The cart namespace (`cart:toggle/remove/reorder/
rename/get/commitTo*`) is shipped but **absent** from `LIBRARY_TOOL_ALLOWLIST`
([library-tool-allowlist.ts:1120-1149](apps/desktop/src/main/ai/library-tool-allowlist.ts)).
Phase 5 should close the gap in the same PR that lands `cart:exportZip` (~6
`defineTool` entries wrapping verbs that exist or are about to):

- `export_zip` → `cart:exportZip`, taking **`captureIds` directly** (stateless —
  the agent doesn't mutate the user's global cart to export); default presets
  low/med/high; rich verifiable `{path,fileCount,byteSize}` output.
- `cart_get` (readOnlyHint), `add_to_cart` / `remove_from_cart` (deterministic,
  not the raw `cart:toggle`), `reorder_cart` (order → scene order on commit).
- `create_sizzle_reel` → `cart:commitToNewProject`, `add_cart_to_reel` →
  `cart:commitToExisting`; document the clear-on-commit side effect.

**Withhold (correctly UI-only):** `SELECT_IN_GRID`, inspector tab/pin/peek — pure
view state; the agent already has `open_in_library`/`open_editor` for navigation.
**Verify, don't regress:** Phase 4's `editor:open` convergence keeps `open_editor`
parity — assert the agent-originated open lands identical takeover state.

---

## Acceptance Criteria

### Functional
- [ ] Single-click selects (inspector updates), does not open the editor, and
      adds **no** Back-history entry.
- [ ] Edit CTA, `Enter` (selected tile), double-click, and the `editor:open` IPC
      each open the editor with **identical** view transitions.
- [ ] A physical click reaching two handlers dispatches exactly **one** intent.
- [ ] Grid inspector = Info + OCR + Cart (Cart visually separated); Chat/Project
      absent; empty state when nothing selected.
- [ ] Pinned: select updates in place. Unpinned: select peeks (overlay);
      collapses on click-empty / clear-selection / Esc / blur — never a timer.
- [ ] Filter-away-selected clears the grid selection; Grid→Reel(fallback)→Grid
      leaves no synthesized selection.
- [ ] Editor hides the left nav; exit restores originating layout + scroll +
      selection; nav's collapsed/pinned state survives the round-trip.
- [ ] Video Edit opens the player takeover; project tile click opens Sizzle;
      trashed tile selects but does not edit.
- [ ] One cart surface in Grid; cart "Make Zip" produces a Zip at the chosen
      presets with a manifest.

### Performance
- [ ] Single-click select < 16 ms @700, < 50 ms @10k; re-renders only old+new
      cell + rail (SelectionContext / `data-selected`, memo, `useCallback`).
- [ ] Inspector open reflows grid width ≤1×; peek overlays (0 `cellsPerRow` recompute).
- [ ] Grid-empty inspector fires 0 per-capture IPC, mounts 0 media elements.
- [ ] Zip render concurrency ≤ `min(cpuCount,4)`; peak raster memory cart-size-independent.

### Security & data-integrity (Phase 5)
- [ ] Boundary validator: non-empty deduped `captureIds`, `presets ⊆ {low,med,high}`,
      cardinality cap, unknown keys rejected.
- [ ] Per-id resolve via `getCaptureById`; trashed/purged/non-image skipped+counted;
      purged ids pruned from cart.
- [ ] Zip entries re-slugified, `^[A-Za-z0-9._-]+$`, no `..`, collision-suffixed.
- [ ] Save dialog mandatory; dest path lstat'd, symlinks + privileged prefixes refused; atomic write.
- [ ] `mkdtemp` 0700 staging removed in `finally` on success/error/cancel/dialog-cancel; startup sweep.
- [ ] Partial failure → `ok` with manifest (succeeded/failed/skipped); zero-success → `err`.
- [ ] Cancellable via `jobId`/`AbortController`; re-export blocked while in flight; renderer-visible errors carry no absolute paths.

### Non-functional
- [ ] No Rules-of-Hooks regression (transition test grid-empty↔selected↔focus).
- [ ] No first-paint width flash; no infinite CSS animations; no `flushSync` in RO callbacks.
- [ ] Keyboard activation canonical in Focus; `Return` not bound to inline rename.
- [ ] Settings change additive (no `schemaVersion` bump); `gridLastSelectedTab` required-with-default.
- [ ] Agent tools added for cart lifecycle + `export_zip`; view-state tools withheld.

### Quality gates
- [ ] `pnpm test` green (reducer, resolver, DetailRail, shortcuts, cart handler/validator).
- [ ] New E2E green locally + Docker Linux subset. License/policy gates unaffected (yazl/archiver already MIT).

## Edge-case decisions (from SpecFlow + deepening)

| # | Case | Decision |
|---|---|---|
| C1 | Two cart surfaces in grid | One — inspector Cart tab; retire `cartIsOpenInGrid` (Phase 5). |
| C2 | `editor:open` bypasses resolver | Route `pendingOpen` through `OPEN_FOCUS` via `viewDispatch` + seq guard (Phase 4). |
| C3 | click vs double-click | `onClick`→select (`history:"replace"`) then `onDblclick`→edit; no select-debounce; cancel pending unpinned-peek on edit; CTA `stopPropagation` on click+dblclick. |
| I1 | Selected tile filtered away | Clear grid selection (identity-stable). |
| I2 | Reel-fallback selection on grid return | `selectionSynthesized` flag in the reel/focus union variants; null on grid return. |
| I3 | `Enter` with no selection | No-op; read sync `viewRef`, not effect-synced ref. |
| I4/I10 | Esc precedence (grid) | search-clear → peek-collapse → selection-clear → no-op; search-clear in the input's own handler. |
| I5 | Empty-state vs `record===null` | Inert JSX shell after all hooks; no video, no per-capture IPC. |
| I6 | Restricted tabs vs persisted tab | Required `gridLastSelectedTab`, clamp to Info/OCR/Cart via existing orphan→info effect. |
| I7 | Trash tiles | Selectable; edit blocked client + server. |
| I8 | Project tiles | Exempt — click opens Sizzle. |
| I9 | Blur mid-hover | `visibilitychange`+`document.hidden`; collapse peek, pause `isConnected` video. |

## Risks & Mitigations

- **Rules-of-Hooks in DetailRail (highest).** Hoist all hooks, conditions inside,
  empty-state is a JSX branch; transition guard test. (`DetailRail.test.tsx:879`,
  `library-right-rail.spec`, `library-source-filter.spec`.)
- **Select re-rendering the grid.** SelectionContext self-subscriber + memo +
  `useCallback`; peek overlays. (performance-oracle.)
- **Impure-seam races.** Cancel-token timers, sync `viewRef` reads, seq guards on
  two-writer `view`, single-effect-per-Esc, RO read/write split. (julik.)
- **Compositor starvation on GPU-less CI.** No looping animations; determinate progress.
- **E2E hover/resize flake.** `expect.poll` re-dispatch + content-arrival gates.
- **Editor relayout breaking crop.** Preserve `.editor-canvas{overflow:visible}` + `.editor-image-clip`.
- **Phase 5 file-write surface.** First `showSaveDialog` in the app — symlink/
  privileged-path/zip-slip defenses are net-new; treat as first-class review.
- **Cross-phase CSS ordering.** Move grid right-col off `data-cart` (Phase 3)
  before deleting `cartIsOpenInGrid` (Phase 5).

## Open Questions (non-blocking)

1. **Zip layout** — `low/ med/ high/` folders (leaning). Decide at implementation.
2. **Videos in a cart Zip** — skipped for v1 (images-only), reported in `skipped`.
3. **Arrow-key movement of grid selection** — out of scope (Enter acts on the
   click-selected tile). Candidate follow-up for keyboard-only browsing.
4. **Grid pin independence** — shipping with pin shared across modes; revisit on demand.
5. **Narrow grid-tab type** — could introduce `LibraryGridSidebarTab = "info"|"ocr"|"cart"`
   for compile-time exclusion; shipping with the existing type + clamp for now.

## Sources & References

### Origin
- [docs/brainstorms/2026-06-17-grid-first-select-edit-requirements.md](docs/brainstorms/2026-06-17-grid-first-select-edit-requirements.md)
  — three-axis reframe, select≠edit, restricted grid inspector, takeover hides
  left nav, no-timer peek, video editor deferred.

### Internal references
- `SELECT_IN_GRID` + reducer: [library-view.ts:57-60,121-155](apps/desktop/src/renderer/src/features/library/library-view.ts)
- Grid cell click / hover rail / keydown / viewDispatch: [Library.tsx:2244,3892,2138,957](apps/desktop/src/renderer/src/features/library/Library.tsx)
- DetailRail early-return / tabs / orphan effect / enrichment: [DetailRail.tsx:497,424,489,364](apps/desktop/src/renderer/src/features/library/DetailRail.tsx)
- Cart self-subscriber precedent: [Library.tsx:159-166](apps/desktop/src/renderer/src/features/library/Library.tsx)
- Cached render path: [image-presets.ts](apps/desktop/src/main/render/image-presets.ts), [coordinator.ts](apps/desktop/src/main/render/coordinator.ts)
- Cart handlers / validators / registration: [cart-handlers.ts](apps/desktop/src/main/handlers/cart-handlers.ts), [cart-validators.ts](apps/desktop/src/main/handlers/cart-validators.ts), [index.ts](apps/desktop/src/main/index.ts)
- Progress/cancel precedent: [sizzle-handlers.ts](apps/desktop/src/main/handlers/sizzle-handlers.ts)
- File-safety precedent: [assertSafePastedFile.ts](apps/desktop/src/main/security/assertSafePastedFile.ts), [bundle-store.ts](apps/desktop/src/main/persistence/bundle-store.ts)
- Agent allowlist: [library-tool-allowlist.ts:1120-1149](apps/desktop/src/main/ai/library-tool-allowlist.ts)
- `RenderPreset` + settings shapes: [protocol.ts:415,1913-1944](packages/shared/src/protocol.ts)
- Stage video branch: [Stage.tsx:284-316](apps/desktop/src/renderer/src/features/library/Stage.tsx)

### Related plans
- Three-state view model (defined `SELECT_IN_GRID`): [docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md](docs/plans/2026-05-05-001-feat-library-three-state-view-model-plan.md)
- Sizzle cart + chat: [docs/plans/2026-05-28-001-feat-sizzle-cart-and-chat-plan.md](docs/plans/2026-05-28-001-feat-sizzle-cart-and-chat-plan.md)
- DPI-aware export presets: [docs/plans/2026-06-14-001-feat-dpi-aware-export-presets-plan.md](docs/plans/2026-06-14-001-feat-dpi-aware-export-presets-plan.md)

### Institutional learnings
- Single-handler + e2e re-dispatch: [docs/solutions/2026-06-07-capture-selector-interaction-and-state.md](docs/solutions/2026-06-07-capture-selector-interaction-and-state.md)
- No-infinite-animation / Library startup: [docs/solutions/2026-06-12-library-startup-black-window-profiling.md](docs/solutions/2026-06-12-library-startup-black-window-profiling.md)
- Editor crop overflow invariants: [docs/solutions/2026-06-13-editor-crop-invisible-overflow-visible.md](docs/solutions/2026-06-13-editor-crop-invisible-overflow-visible.md)
- Keyboard-canonical Focus: [docs/solutions/2026-06-13-edit-menu-undo-redo-bridge.md](docs/solutions/2026-06-13-edit-menu-undo-redo-bridge.md)
- Resize/measure e2e gating: [docs/solutions/2026-06-13-windows-vs2026-runner-image-e2e-flakes.md](docs/solutions/2026-06-13-windows-vs2026-runner-image-e2e-flakes.md)
- Settings substrate (additive + race guard): [docs/solutions/2026-05-12-settings-substrate.md](docs/solutions/2026-05-12-settings-substrate.md)

### External (deepening research)
- Apple HIG — Inspector vs Info window; double-click to open; selection vs focus.
- WCAG 2.1 SC 1.4.13 (Content on Hover or Focus) — no timed auto-hide; dismissable/persistent.
- React 19 Rules of Hooks (hooks above early returns; conditions inside hooks).
- Electron: `dialog.showSaveDialog`/`shell.showItemInFolder`; AbortSignal-not-over-IPC (use a `jobId`+`AbortController` map); `yazl`/`archiver` (MIT, already shipped).
