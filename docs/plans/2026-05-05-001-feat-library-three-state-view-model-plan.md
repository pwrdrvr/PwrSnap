---
title: Library three-state view model — Grid · Focus · Reel
type: feat
status: active
date: 2026-05-05
---

# Library three-state view model — Grid · Focus · Reel

## Enhancement Summary

**Deepened on:** 2026-05-05
**Sections enhanced:** Architecture, all 6 phases, Risk Analysis, Deferred, Scope Boundaries, Future Considerations
**Research agents used:** best-practices-researcher · framework-docs-researcher · repo-research-analyst · architecture-strategist · kieran-typescript-reviewer · pattern-recognition-specialist · code-simplicity-reviewer · julik-frontend-races-reviewer · performance-oracle

### Key changes from the original plan

1. **State model is a discriminated union with `useReducer`, not 4 separate `useState`s.** TypeScript reviewer + architecture-strategist agreed: the original `mode` + `selectedId` + `gridScrollRef` + `activeApp` shape allows illegal states like `mode: "focus"` with `selectedId: null`. New shape: `LibraryView` discriminated union where `kind: "focus"` requires non-null `selectedId` at compile time. See **Architecture · State model**.

2. **Keep Grid mounted across all modes; hide via `display: none`.** Performance-oracle and julik-frontend-races-reviewer both flagged this independently. Eliminates three problems at once: (a) async-thumbnail height drift breaking scroll restore, (b) `pwrsnap-cache://` thumbnail re-fetch on every Esc, (c) the entire `gridScrollRef` capture/restore dance — `display:none` preserves `scrollTop` natively. See **Phase B / Phase C**.

3. **Use native `<dialog>` with `showModal()` for the Focus overlay.** Electron 41 ships Chromium 146 (not ~131 as feared) — full support for `<dialog>`, `::backdrop`, and the `closedby="any"` attribute. Replaces ~40 lines of custom focus-trap / inert / Esc-handling with browser primitives. See **Phase C · FocusOverlay**.

4. **Merge `FocusOverlay` + `ReelStage` into one `<Stage dismissible={...}>` component.** Code-simplicity-reviewer was right: the design has them as 80% identical, only differing in the × button and the filmstrip-above. Two components fork inevitably.

5. **`Editor` gets a `chrome: "full" | "embedded" | "chromeless"` discriminator, not a new `chromeless?: boolean` boolean.** TypeScript reviewer: two booleans (`embedded` + `chromeless`) encode three states with mutually-exclusive truthiness — a discriminated union is the typesafe shape and migrates one existing call site.

6. **Tool state lifting uses the controlled-or-uncontrolled React pattern.** `tool` and `onToolChange` are BOTH optional on Editor; if both supplied, controlled (Library owns); if neither, internal `useState` fallback (standalone-window path). Resolves architecture-strategist's standalone-window break risk without renaming or branching call sites.

7. **Decisions made now that the original plan deferred:**
   - **Reel scrubhead → hide it.** Drop the `⌘[ / ⌘]` shortcut, drop the playhead element. Aliasing to ←/→ doesn't earn its CSS complexity.
   - **Filter change while in Focus → bail to Grid.** Filter is a query, query changed, show new result set. Already the plan's recommendation; now committed.
   - **Empty Reel filter → centered "No captures match" message.** Trivial; baked into Phase D acceptance.
   - **Cell pulse → keep, but pure CSS animation on `is-was-open` class added on commit.** No rAF dance needed; `animationend` listener with `{once: true}` cleans up. 600ms (not 250ms) feels right per design feel research.
   - **Tool state across modes → reset on mode change** (option A from julik's review). Predictable beats clever.

8. **Two name corrections.** `selectedId` → `selectedRecordId` (continuity with existing variable). Editor's internal `function Toolbar` → `function EditorToolbar` to avoid collision with the new `<EditToolbar>` component.

9. **One major perf addition: `loading="lazy"` + `content-visibility: auto` on cells, no virtualization library.** Performance-oracle: this is sufficient through ~1000 captures. Virtualization deferred to a future plan gated on real telemetry.

10. **Crop schema is NOT an overlay-union extension.** Architecture-strategist flagged: Crop is a `CaptureMutation` (changes the canonical viewport), not an entry in the overlay list. Added explicit note to Future Considerations so the next agent doesn't extend the overlay union "obviously".

### New Considerations Discovered

- **Editor IPC cancel-safety must be audited BEFORE Phase C** (julik). Rapid mode flips can resolve `library:byId` for an old capture after a new one has mounted. Add cancel guards in Editor's effects as Phase A.7 prep work.
- **`presetMetrics()` is currently inside `TrayMenu.tsx` (not exported).** Repo-research-analyst caught this. Move to `features/shared/` next to `CopyButton.tsx` so the Library's DetailRail can use it without duplication.
- **Filmstrip scroll-left position** should be preserved across Reel ↔ Grid toggles (julik). Same `useRef` pattern as the grid scroll.
- **Focus management** is missing from the original plan. Capture `document.activeElement` on Focus open, restore on close (`<dialog>` does this for free if we use it).
- **Backdrop dismiss uses `mousedown`, not `click`.** A user mid-drag inside the canvas who drags off and releases on the backdrop fires `click` on the backdrop and dismisses Focus mid-stroke. `onMouseDown` with `e.target === e.currentTarget` is the correct pattern.

## Overview

Close the gap between the current Library implementation (a mashed-
together "reel always rendered above grid" surface where the
Grid / Reel toggle is decoration) and the design's three-state model
(`design/PwrSnap Library.html`):

```
①  Grid    (default landing) — day-grouped cells fill main area
②  Focus   (single-image edit, reached by clicking a Grid cell) —
            big stage + floating × + bottom-center edit toolbar +
            detail rail with L/M/H copy
③  Reel    (always-open stage + filmstrip across top) — same
            stage + toolbar + detail rail as Focus
```

Selection persists across all transitions; the Grid/Reel segmented
control toggles between ① and ③; clicking a cell from Grid opens ②;
Esc / × / ← → drive Focus navigation.

## Problem Statement / Motivation

The current Library (`apps/desktop/src/renderer/src/features/library/Library.tsx`):

1. **The Grid / Reel segmented control does nothing.** Both views
   render simultaneously — a horizontal reel up top (`.psl__reel-wrap`)
   and a day-grouped grid below (`.psl__grid-wrap`). The toggle just
   flips a `view: "reel" | "grid"` state that no layout actually
   reads.
2. **No Focus overlay.** Clicking a cell opens the Editor in a
   shrunken `.psl__edit-pane` inline, with the right rail's tiny
   16:10 thumbnail still rendering — exactly the "sidebar image too
   small to edit" pattern the design explicitly calls out as broken.
3. **No L/M/H copy row in detail rail.** The right rail has a single
   "Copy" button that dispatches `clipboard:copy` at preset `med`
   blindly. Users can't see the resulting dimensions / bytes per
   preset before pasting (the FloatOver toast already solved this
   correctly with the shared `<CopyButton>` component shipped in
   commit `e1f6d26`; we just need to place it in the rail).
4. **Right rail uses PwrAgnt pin/auto-hide pattern in all states.**
   The design specifies the right rail is **hidden in Grid mode**
   and **always visible in Focus + Reel** — no pin/unpin user-facing
   complexity. Our PwrAgnt-pattern hover-reveal (shipped in commit
   `b9296ea`) was the right answer for the WRONG question; this plan
   removes it because the design no longer needs it.
5. **Left rail shows every app icon regardless of capture presence.**
   The design source uses fixture data with all apps populated; the
   real implementation should only list apps that have ≥1 capture.
6. **No keyboard nav across captures.** ← / → in Focus, Esc to
   close Focus, optional ⌘[ / ⌘] to scrub Reel — none of which are
   wired today.

The design notes are unambiguous about the target — quoting screenshot 3:

> Reworked from a mashed-together reel+grid into **three discrete
> view-states** sharing the same selection + filter model. The
> Reel/Grid toggle now actually does something.

## Proposed Solution

Refactor `Library.tsx` around an explicit `mode` state machine and
build out the three view-states one phase at a time. Each phase ends
shippable on its own — the Grid / Reel toggle starts working in
Phase A, the Focus overlay lands in Phase C, and Reel mode lands in
Phase D. The detail rail (built once in Phase C) is reused in Phase D
unchanged.

The existing `<Editor captureId={x} embedded />` is reused for the
canvas portion in both Focus and Reel (it already does drag-to-draw,
overlay rendering, tool selection, V/A/R/H/B/T hotkeys, undo) — we
just wrap it in different chrome per mode and override its toolbar
positioning via CSS.

The shared `<CopyButton>` (commit `e1f6d26`) is reused as-is for the
L/M/H row — explicit user requirement: *"Our Low / Medium / High
buttons are in good shape. We have these as a reusable control so
just use that on the new placements."*

## Technical Approach

### Architecture

**Discriminated-union state in a `useReducer`, not 4 `useState`s.**

The original plan's separate-`useState` shape (`mode` + `selectedId` + `gridScrollRef` + `activeApp`) allowed illegal states like `kind: "focus"` with `selectedId: null` and required scattered defensive guards in every render path. The deepened plan uses a discriminated union where each `kind` carries exactly the fields it needs.

```ts
// apps/desktop/src/renderer/src/features/library/library-view.ts (new)

export type GridReturnAnchor = {
  readonly scrollTop: number;
  readonly cellId: string;
};

export type LibraryView =
  | { readonly kind: "grid"; readonly selectedRecordId: string | null }
  | {
      readonly kind: "focus";
      readonly selectedRecordId: string;            // non-nullable — compile-time guarantee
      readonly returnAnchor: GridReturnAnchor;      // captured on Grid → Focus, restored on Focus → Grid
    }
  | { readonly kind: "reel"; readonly selectedRecordId: string };

export type LibraryAction =
  | { type: "OPEN_FOCUS"; recordId: string; returnAnchor: GridReturnAnchor }
  | { type: "CLOSE_FOCUS" }
  | { type: "TOGGLE_VIEW"; to: "grid" | "reel"; fallbackId: string | null }
  | { type: "NAVIGATE"; recordId: string }      // ← / → in Focus or Reel
  | { type: "SELECT_IN_GRID"; recordId: string }  // cell click WITHOUT opening Focus (future use)
  | { type: "FILTER_CHANGED"; visibleIds: ReadonlyArray<string> };

export function libraryReducer(s: LibraryView, e: LibraryAction): LibraryView {
  switch (e.type) {
    case "OPEN_FOCUS":
      return { kind: "focus", selectedRecordId: e.recordId, returnAnchor: e.returnAnchor };
    case "CLOSE_FOCUS":
      if (s.kind !== "focus") return s;
      return { kind: "grid", selectedRecordId: s.selectedRecordId };
    case "TOGGLE_VIEW": {
      const id = s.selectedRecordId ?? e.fallbackId;
      if (e.to === "grid") return { kind: "grid", selectedRecordId: id };
      if (id === null) return { kind: "grid", selectedRecordId: null };  // can't enter Reel without selection
      return { kind: "reel", selectedRecordId: id };
    }
    case "NAVIGATE":
      if (s.kind === "focus") return { ...s, selectedRecordId: e.recordId };
      if (s.kind === "reel") return { ...s, selectedRecordId: e.recordId };
      return s;
    case "SELECT_IN_GRID":
      if (s.kind !== "grid") return s;
      return { ...s, selectedRecordId: e.recordId };
    case "FILTER_CHANGED": {
      // The deferred-implementation question is now resolved: bail to Grid when filter
      // makes the current capture invisible. Filter is a query; query changed; show
      // the new result set in Grid form.
      const stillVisible = s.selectedRecordId !== null && e.visibleIds.includes(s.selectedRecordId);
      if (s.kind !== "grid" && !stillVisible) {
        return { kind: "grid", selectedRecordId: null };
      }
      return s;
    }
  }
}

export const initialLibraryView: LibraryView = { kind: "grid", selectedRecordId: null };
```

In `Library.tsx`:

```ts
const [view, dispatch] = useReducer(libraryReducer, initialLibraryView);
const [activeApp, setActiveApp] = useState<string>("all");  // app filter stays separate; orthogonal axis
```

`activeApp` stays as plain `useState` because it's a non-coupled axis — changing the filter doesn't atomically change view state, but it does *trigger* a `FILTER_CHANGED` dispatch via an effect.

**Naming continuity:** `selectedRecordId` (not `selectedId`) matches the existing variable in current `Library.tsx`. `kind` is the discriminant tag, not `mode` — JS-idiomatic discriminated-union convention.

Transitions:

| From | Trigger | To | Action dispatched |
|---|---|---|---|
| Grid | click cell | Focus | `OPEN_FOCUS({ recordId, returnAnchor })` (returnAnchor captured at click time) |
| Grid | Reel toggle | Reel | `TOGGLE_VIEW({ to: "reel", fallbackId: visible[0]?.id ?? null })` |
| Focus | Esc / × | Grid | `CLOSE_FOCUS` (scroll restoration handled by `display:none` + native scrollTop preservation; no manual restore needed) |
| Focus | Reel toggle | Reel | `TOGGLE_VIEW({ to: "reel", fallbackId: null })` (selection persists since `view.selectedRecordId` is non-null in focus) |
| Focus | Grid toggle | Grid | `TOGGLE_VIEW({ to: "grid", fallbackId: null })` |
| Focus | ← / → | Focus | `NAVIGATE({ recordId: neighborInVisibleSet(±1) })` |
| Reel | Grid toggle | Grid | `TOGGLE_VIEW({ to: "grid", fallbackId: null })` |
| Reel | filmstrip click | Reel | `NAVIGATE({ recordId })` |
| Reel | ← / → | Reel | `NAVIGATE({ recordId: neighborInVisibleSet(±1) })` |
| Any | filter changed | Maybe Grid | `FILTER_CHANGED({ visibleIds })` — bails to Grid if current capture no longer visible |

**Cmd-[ / Cmd-]** — REMOVED from this plan. Decision (was Deferred F.4): hide the scrubhead, drop the keys. The original justification was "alias to ← / → with a moving playhead." Code-simplicity-reviewer flagged: doesn't earn its CSS complexity. ←/→ already does the work. The "scrub ⌘[ / ⌘]" hint in the design source becomes dead text; it's getting deleted from `library.css` during Phase D.

### Architecture · Mode-conditional rendering — keep Grid mounted

**Major performance + correctness change vs. the original plan.** Performance-oracle and julik-frontend-races-reviewer independently flagged: unmounting Grid on every Focus open/close has compounding costs:

1. **Async-thumbnail height drift breaks scroll restoration.** Grid mounts → cells render with `aspect-ratio: 16/10` placeholders → `<img src="pwrsnap-cache://...">` resolves async → cells reflow as images decode. If `scrollTop = saved` runs in `useLayoutEffect` (before image decode), the scroll container's `scrollHeight` is short and the call gets clamped. By the time images load, scrollTop is wrong.
2. **Thumbnail re-fetch storm.** Every Esc remounts every visible `<img>`, which re-triggers the custom protocol handler. Even if cached at the handler level, that's 100-500 IPCs in a burst.
3. **Manual scroll capture/restore is unnecessary.** The browser already preserves `scrollTop` on a `display:none` element across show/hide cycles natively.

**Decision: keep Grid mounted across all mode transitions, hide via `display:none` (or the `hidden` attribute, which Chromium/React treat identically). Focus and Reel mount on demand.**

```tsx
return (
  <div className="psl" data-mode={view.kind}>
    {/* Grid is always mounted; visibility driven by data-mode in CSS */}
    <main className="psl__main" data-active={view.kind === "grid"}>
      <GridContent records={records} activeApp={activeApp} selectedRecordId={view.selectedRecordId} ... />
    </main>

    {/* Focus and Reel are conditional — they own expensive state (Editor, overlay subscriptions) */}
    {view.kind === "focus" && <Stage view={view} dismissible records={records} dispatch={dispatch} />}
    {view.kind === "reel" && <Stage view={view} records={records} dispatch={dispatch} />}

    {/* DetailRail returns null in Grid mode — internal mode awareness, NOT JSX-tree conditional */}
    <DetailRail view={view} record={selectedRecord} />
  </div>
);
```

CSS:

```css
.psl[data-mode="focus"] .psl__main,
.psl[data-mode="reel"] .psl__main {
  display: none;
}
```

`scrollTop` survives `display:none` toggles in Chromium (verified across the active Chromium versions Electron ships). The `gridScrollRef` capture/restore mechanism the original plan specified can be DELETED — `returnAnchor` in the discriminated union now exists ONLY for the cell-pulse animation (we still need to know which cell to pulse on Focus → Grid return).

The trade-off: Grid stays in memory while in Focus or Reel. With ~1000 cells and `loading="lazy"` + `content-visibility: auto` (see Phase B research insights), the memory cost is minimal — offscreen cells aren't decoded.

Editor inside Focus/Reel still mounts on Stage mount and unmounts on close — that's the right call (Editor owns expensive overlay state via `overlays:listForCapture` IPC + drag-to-draw refs; keeping it warm across modes leaks subscriptions).

**Right rail lifecycle.**

- Grid mode → rail returns `null` from inside `<DetailRail>` (mode awareness internal to the component, NOT a JSX-tree conditional in `Library.tsx`). Future surfaces that want a rail in Grid (e.g., bulk-select actions for Phase 2.x) change one component, not the whole layout.
- Focus mode → rail always rendered, fixed 360px wide.
- Reel mode → same rail as Focus (single component, reused).

**Pin/auto-hide pattern extraction.** Architecture-strategist's recommendation: extract the existing pin/unpin pattern (commit `b9296ea`) into `features/shared/HoverRevealPanel.tsx` BEFORE deleting its Library usage. It's PwrAgnt house style; we'll need it again (sizzle composer, future inspector). 30-minute extraction, sits unused but available. Phase B is amended accordingly.

**Editor reuse strategy.**

`<Editor captureId={x} embedded />` already handles the canvas + tool state + drag-to-draw + V/A/R/H/B/T hotkeys. The deepened plan replaces the original `chromeless?: boolean` proposal with a typesafe discriminated `chrome` prop:

```ts
// apps/desktop/src/renderer/src/features/editor/Editor.tsx

export type Tool = "pointer" | "arrow" | "rect" | "highlight" | "blur" | "text";

export type EditorChrome =
  | "full"        // standalone editor window — titlebar + toolbar
  | "embedded"    // current Library inline mode — toolbar, no titlebar (transitional, dropped in Phase B)
  | "chromeless"; // Focus/Reel — canvas + draft input only

export type EditorProps = {
  readonly captureId: string;
  readonly chrome?: EditorChrome;       // defaults to "full"

  // Controlled-or-uncontrolled tool state. If both are passed, Editor is controlled
  // (Library owns the state, drives the floating toolbar). If neither, Editor falls
  // back to internal `useState`. Standalone-window path uses internal state — no
  // refactor needed for that call site.
  readonly tool?: Tool;
  readonly onToolChange?: (tool: Tool) => void;
};
```

Migration: every existing `<Editor embedded />` becomes `<Editor chrome="embedded" />` (single call site, mechanical). All code paths surveyed — see repo-research-analyst findings; only `Library.tsx:441` references it.

**`exactOptionalPropertyTypes` workaround for conditional optional props** — TypeScript reviewer's note. Don't pass `tool={cond ? value : undefined}` (under `exactOptionalPropertyTypes`, `undefined` is not the same as absent). Use a conditionally-built spread:

```tsx
const toolProps = view.kind === "focus" || view.kind === "reel"
  ? ({ tool, onToolChange: setTool } satisfies Pick<EditorProps, "tool" | "onToolChange">)
  : ({} as const);

<Editor captureId={view.selectedRecordId} chrome="chromeless" {...toolProps} />
```

This is the canonical workaround — prop is absent when not in focus/reel, present when it is. `satisfies` keeps inference tight.

### Implementation Phases

#### Phase A: View-state model refactor — Grid / Reel toggle works

**Goal:** the Grid / Reel button flips the layout for real. No new visual surfaces yet; turn the dead toggle into a working one AND lay the discriminated-union foundation that Phases C/D depend on.

Implementation Units:

| Unit | Goal | Files |
|---|---|---|
| A.1 | Create `library-view.ts` with `LibraryView` discriminated union, `LibraryAction`, `libraryReducer` per the Architecture section. Includes `OPEN_FOCUS`, `CLOSE_FOCUS`, `TOGGLE_VIEW`, `NAVIGATE`, `SELECT_IN_GRID`, `FILTER_CHANGED` actions. | `features/library/library-view.ts` (new) |
| A.2 | Replace `[view, setView]` + `[selectedRecordId, setSelectedRecordId]` + `[pinned, setPinned]` + `[revealed, setRevealed]` with `useReducer(libraryReducer, initialLibraryView)`. Add `data-mode={view.kind}` on `.psl`. | `Library.tsx` |
| A.3 | Wire the segmented control to dispatch `TOGGLE_VIEW`. Computes `fallbackId` from current `visible[0]?.id` for the Reel branch. | `Library.tsx` |
| A.4 | CSS-driven hide: `.psl[data-mode="focus"] .psl__main, .psl[data-mode="reel"] .psl__main { display: none; }`. The `.psl__reel-wrap` gets a similar gate (visible only when `data-mode="reel"`). | `library.css` |
| A.5 | Default initial state is `{ kind: "grid", selectedRecordId: null }`. | `library-view.ts`, `Library.tsx` |
| A.6 | Selection persistence is automatic via the discriminated union (the `selectedRecordId` field is preserved in `TOGGLE_VIEW` transitions). Verify with manual click → toggle round-trip. | `Library.tsx` |
| A.7 | **Pre-flight: audit `Editor.tsx` for IPC cancel-safety** before Phase C exposes a fast Focus open/close cycle. Every `dispatch(...).then(...)` that calls `setState` post-resolve needs a `let cancelled = false` guard in its `useEffect`. Specifically check `library:byId`, `overlays:listForCapture`. | `features/editor/Editor.tsx` |

**Patterns to follow:**
- Existing `data-mode` attribute pattern (RegionSelector.tsx uses `document.body.dataset` for variant CSS). Mirror with `data-mode` on `.psl` (already in current code; just gets new values).
- Stale-closure-safe keydown listener: use a `viewRef` mirror updated in `useEffect`, read `viewRef.current` inside the keydown handler. Prevents the "first ESC works, then silently breaks" bug julik flagged.

**Verification:**
- Click Grid → only the day-grouped grid is visible; no reel above. The `.psl__main` element still exists in DOM with `display: none` when in Reel/Focus (verify in DevTools Elements; `scrollTop` survives across toggles).
- Click Reel → grid is hidden via display:none; reel-wrap is visible (still placeholder shape — the always-open stage lands in Phase D).
- Selection in one mode persists when toggling to the other.
- The discriminated union prevents `TS2339` errors when accessing `view.returnAnchor` outside `kind === "focus"`. Verify by trying to write that bug; the compiler should catch it.
- A.7: grep `Editor.tsx` for `.then(`; every match should have a `cancelled` flag check before any setState. Add the pattern where missing.
- Typecheck + electron-vite build clean.

**Execution note (test-first for the reducer):** `library-view.ts` is pure logic with no React or DOM. Write the reducer tests first — `libraryReducer(state, action)` is a pure function, every transition in the table can be a one-line assert. This is the cheapest place in the entire plan to get test coverage.

```ts
// library-view.test.ts
test("OPEN_FOCUS from grid captures returnAnchor", () => {
  const next = libraryReducer(
    { kind: "grid", selectedRecordId: null },
    { type: "OPEN_FOCUS", recordId: "abc", returnAnchor: { scrollTop: 1200, cellId: "abc" } }
  );
  expect(next).toEqual({ kind: "focus", selectedRecordId: "abc", returnAnchor: { scrollTop: 1200, cellId: "abc" } });
});

test("FILTER_CHANGED in focus bails to grid when selection no longer visible", () => {
  const next = libraryReducer(
    { kind: "focus", selectedRecordId: "abc", returnAnchor: { scrollTop: 0, cellId: "abc" } },
    { type: "FILTER_CHANGED", visibleIds: ["xyz"] }
  );
  expect(next).toEqual({ kind: "grid", selectedRecordId: null });
});
```

#### Phase B: Grid mode as pure landing — extract pin/unpin, drop right rail in Grid, drop reel-mash, data-driven left rail, perf hygiene

**Goal:** Grid mode matches screenshot 2 — day-grouped cells fill the main area, no reel above, no right rail. Phase E (data-driven left rail) folds in here. Phase E was redundantly its own phase in the original plan.

Implementation Units:

| Unit | Goal | Files |
|---|---|---|
| B.1 | **Extract pin/unpin pattern to a reusable component BEFORE deleting its Library usage.** Move `pinned`/`revealed`/`hideTimerRef`/`revealRail`/`hideRail` state + the spine markup + the `.psl__right-spine` / `.psl__right-menu-button` / `.psl__right-pin-button` CSS into `features/shared/HoverRevealPanel.tsx`. Component sits unused but available for future surfaces (sizzle composer, Phase 4 status panel, etc.). | `features/shared/HoverRevealPanel.tsx` (new), `features/shared/HoverRevealPanel.css` (new) |
| B.2 | DetailRail returns `null` when `view.kind === "grid"`. The mode-conditional lives INSIDE the rail component, not in `Library.tsx`'s JSX tree. Future surfaces that want a rail in Grid (bulk-select, etc.) only change one component. | `features/library/DetailRail.tsx` (new — see Phase C.5 for full content; in B we just create the shell that returns null in grid) |
| B.3 | Update `.psl` grid template: stays `220px 1fr 360px` always, but `<DetailRail>` returns null in Grid so the third column visually collapses to its empty content. Or — equivalently — `.psl[data-mode="grid"] { grid-template-columns: 220px 1fr; }`. Pick the latter for honest layout. | `library.css` |
| B.4 | Delete original Library.tsx pin/unpin code (now lives in `HoverRevealPanel.tsx`). Specifically lines 91-114 (state + callbacks), 446-465 (rail wrapper props), 467-525 (spine + actions JSX). | `Library.tsx` |
| B.5 | Cell click in Grid: dispatch `OPEN_FOCUS` directly (skip the "select then open" middleman). The cell's onClick captures `mainPaneRef.current.scrollTop` synchronously and includes it in the action. The original plan's "select-only" intermediate state is removed — there's no point in selecting without opening. (`SELECT_IN_GRID` action is reserved for future bulk-select / cmd-click multiple.) | `Library.tsx` |
| B.6 | Drop `.psl__edit-pane` inline rendering. Editor is now Focus-only (Phase C). | `Library.tsx`, `library.css` |
| B.7 | Drop the unused sizzle strip + sizzle props (sizzle is Phase 6 territory). | `Library.tsx` |
| B.8 | **(folded from old Phase E)** Filter the left-rail Source App list to only apps with ≥1 capture. Memoize with `useMemo(() => Object.entries(APP_INFO).filter(([app]) => fixtureCaptures.some(c => c.app === app)), [fixtureCaptures])` so the per-render `.filter().length` cost (8 apps × 500 captures = 4000 ops/render) doesn't accumulate. The currently-active filter sticks around even at count 0 so the user doesn't get teleported when their last capture in a filter gets deleted. | `Library.tsx` |
| B.9 | **Perf hygiene (cheap wins).** Add `loading="lazy"` and `decoding="async"` to the `<img>` in `<CellThumb>`. Add `content-visibility: auto; contain-intrinsic-size: <cell-w> <cell-h>;` to `.psl__cell` (replaces virtualization through ~1000 captures). Add `contain: layout paint` to `.psl__cell` so the cell-pulse animation in Phase F doesn't invalidate parent paint regions. | `features/library/Library.tsx` (CellThumb), `library.css` |
| B.10 | Remove the `grouped.slice(0, 2)` band-aid in current `Library.tsx:387` so all day-groups render. With B.9 perf hygiene applied, this is safe through ~1000 captures. | `Library.tsx` |
| B.11 | **Migration check.** Confirm no persisted state in main-process settings references the deleted rail-visibility keys: `grep -r "pinned\|revealed" apps/desktop/src/main/settings/` should return zero hits. If non-zero, add a settings migration drop. | `apps/desktop/src/main/settings/` (audit only) |

**Patterns to follow:**
- BEM naming for the new HoverRevealPanel: `.hover-reveal-panel`, `.hover-reveal-panel__spine`, `.hover-reveal-panel__menu-button`, etc. — neutral prefix since it's now shared.
- `data-mode` attribute on `.psl` already gates other styles; use it for the grid-template-columns swap.

**Verification:**
- Open Library — lands in Grid mode by default with NO right rail visible. Day-grouped cells fill the main area between the left filter rail and the right edge of the window. The `.psl__right` element still mounts but `<DetailRail>` returns `null` in `grid` mode.
- Click a cell — Focus opens directly (no intermediate "selected but not focused" state).
- Reel toggle still works (renders the placeholder reel from Phase A).
- Pin/unpin code in Library.tsx is gone. New `HoverRevealPanel.tsx` exists at `features/shared/`, `pnpm typecheck` + build clean (no consumers yet, but the component compiles).
- Left rail Source App list: with 8 apps in fixtures but only 5 having captures, only those 5 render. Toggling filter to one of them and deleting all its captures keeps it visible until the user navigates away.
- Lighthouse-style perf check: open Library with 500 fixture captures, verify FPS ≥ 55 during scroll. Initial paint < 600ms. (Manual eyeball with DevTools Performance tab is fine; no need for a formal benchmark suite yet.)
- B.11 audit confirms zero hits.

**Execution note:** mostly rip-out + a couple of additive perf changes. The HoverRevealPanel extraction (B.1) is the only "build" work — it's mechanical (copy-paste from Library.tsx → new file, rename CSS classes from `.psl__right-*` to `.hover-reveal-panel__*`).

#### Phase C: Stage component (Focus + Reel use it) + DetailRail + Editor `chrome` discriminator

**Goal:** clicking a Grid cell opens the Focus overlay (screenshot 4). Big stage + floating × + bottom-center edit toolbar + always-visible detail rail with L/M/H copy. Phase D's Reel stage will reuse the same `<Stage>` component with `dismissible={false}`.

**Component decomposition revised** (from code-simplicity-reviewer + architecture-strategist consensus): the original plan's `FocusOverlay` and `ReelStage` were 80% identical. Merge into one `<Stage>` component that takes `dismissible: boolean` (controls × button + Esc behavior) and an optional `aboveStageSlot` (Reel mode passes the filmstrip; Focus passes nothing). Net: 4 new components down from the original plan's 5: `Stage.tsx`, `DetailRail.tsx`, `EditToolbar.tsx`, `library-view.ts` (already in Phase A.1). Filmstrip is inlined into the Reel branch in Phase D.

Implementation Units:

| Unit | Goal | Files |
|---|---|---|
| C.1 | New component `<Stage view={LibraryView} dismissible={boolean} record={CaptureRecord} dispatch={(LibraryAction)=>void} aboveStageSlot?={ReactNode} />` in `features/library/Stage.tsx`. Renders top breadcrumb (app tag + name + date + dims), prev/next nav buttons on canvas edges, embeds `<Editor chrome="chromeless" tool onToolChange />` for the canvas, embeds `<EditToolbar>`, optionally renders the slot above the stage (Reel filmstrip), conditionally renders × button when `dismissible`. Uses native HTML `<dialog>` element with `showModal()` per the framework-docs research (Electron 41 has Chromium 146; full support including `closedby="any"`). | `features/library/Stage.tsx` (new) |
| C.2 | Replace Editor's `embedded?: boolean` with the discriminated `chrome: "full" \| "embedded" \| "chromeless"` prop. Migrate the one existing call site (`Library.tsx:441` Phase B already removed it; only standalone-window path remains, which uses default `chrome: "full"`). Add controlled-or-uncontrolled `tool` + `onToolChange` (both optional; falls back to internal `useState` when neither passed — preserves standalone-window invariant). Rename Editor's internal `function Toolbar` → `function EditorToolbar` to avoid name collision with the new `<EditToolbar>` component. | `features/editor/Editor.tsx`, `library.css`/`editor.css` |
| C.3 | New component `<EditToolbar tool={Tool} onChange={(Tool)=>void} />` in `features/library/EditToolbar.tsx`. Horizontal layout: Select V / Arrow A / Rect R / Highlight H / Text T / Blur B + (placeholder) magic wand + (placeholder) undo. **Crop slot reserved but not rendered** in this phase — see Scope Boundaries. **Magic wand + Undo + color swatches NOT rendered** in this phase (don't port their CSS either; reserved-but-empty slots are dead code). `onMouseDown={(e) => e.stopPropagation()}` on the toolbar root to prevent toolbar clicks bubbling to the canvas as drag-starts (the rect-tool-mid-click bug class). | `features/library/EditToolbar.tsx` (new) |
| C.4 | Editor accepts the controlled-or-uncontrolled `tool` / `onToolChange` props per the Architecture section's pattern. Editor's existing window-level keydown handler keeps working — when controlled, it calls `onToolChange(t)` instead of local `setTool(t)`. **Tool resets to `"pointer"` on every mode change** (Library effect: `useEffect(() => setTool("pointer"), [view.kind])`). Predictable beats clever — resolves julik's "rect tool persisting into filmstrip click" surprise. | `features/editor/Editor.tsx`, `Library.tsx` |
| C.5 | New component `<DetailRail view={LibraryView} record={CaptureRecord} />` in `features/library/DetailRail.tsx`. Returns `null` when `view.kind === "grid"`. When focus/reel: renders tab strip (Detail / History / OCR — only Detail tab has content this phase), metadata block, Codex caption stub, three `<CopyButton>` instances (preset low/med/high) inside a `.psl__copy-row` wrapper using `presetMetrics()`-derived dim + bytes, action row (Share / Editor / trash). The `record` prop is non-nullable — caller (`Library.tsx`) guards with `{selectedRecord && <DetailRail ... record={selectedRecord} />}`. **Move `presetMetrics()` from `TrayMenu.tsx:50-62` into `features/shared/CopyButton.tsx`** (next to the consumer) so both the tray and the new DetailRail import the same function. | `features/library/DetailRail.tsx` (new), `features/shared/CopyButton.tsx` (export `presetMetrics`), `features/tray/TrayMenu.tsx` (import from new location) |
| C.6 | Cell-click handler in Grid: dispatch `OPEN_FOCUS({ recordId, returnAnchor: { scrollTop: mainPaneRef.current.scrollTop, cellId: recordId } })`. The returnAnchor exists ONLY for the cell-pulse animation (scroll restoration is now handled by `display:none` preserving native `scrollTop`). | `Library.tsx` |
| C.7 | Cell-pulse animation. CSS `@keyframes psl-cell-return-pulse` (port from `design/src/library.css:1168-1171`, the `cell-pulse` keyframes). Applied via `.psl__cell.is-was-open { animation: psl-cell-return-pulse 600ms var(--ease-out); }`. **Pure-CSS approach (no rAF)**: when `view.kind` flips from `"focus"` to `"grid"`, a `useLayoutEffect([view.kind])` adds `.is-was-open` to the cell at `view.returnAnchor.cellId` (already in DOM since Grid stays mounted). `animationend` listener `{ once: true }` removes the class. Force-reflow trick (`void el.offsetWidth`) when re-applying the class so a rapid open-close-open chain restarts the animation instead of no-oping. | `Library.tsx`, `library.css` |
| C.8 | Window keydown listener for Esc / ← / → / Tab. **Use `viewRef` + ref-mirror pattern** (not closure on `view`) to avoid the stale-closure bug julik flagged. Skip when target is `<input>` / `<textarea>` / `[contenteditable]`. Esc dispatches `CLOSE_FOCUS`. ← / → dispatches `NAVIGATE` with neighbor in `visible[]`. Single listener, registered once at Library mount, reads current state from ref. | `Library.tsx` |
| C.9 | Port focus + edit-toolbar CSS from `design/src/library.css` to `library.css`. Classes ported: `.psl__focus`, `.psl__focus-stage`, `.psl__focus-close`, `.psl__focus-close-hint`, `.psl__edit-toolbar`, `.psl__et-btn`, `.psl__et-sep`, `.psl__et-btn-key`, `.psl__stage`, `.psl__stage-meta`, `.psl__stage-pos`, `.psl__stage-nav`, `.psl__stage-img`, `.psl__copy-row`. **`.psl__focus-rail` is unified onto existing `.psl__right` with `data-mode` modifiers** — no parallel rail container. **NOT ported (out of scope features)**: `.psl__et-swatch` (color swatches), magic-wand styles, `.psl__et-stroke` (color swatch underlay). | `library.css` |
| C.10 | **Backdrop dismiss uses `mousedown`, not `click`.** `<dialog>` element gets `onMouseDown={(e) => { if (e.target === e.currentTarget) dialogRef.current?.close(); }}`. Prevents the rect-tool-drag-off-canvas-onto-backdrop accidental dismiss (julik race #10). | `features/library/Stage.tsx` |
| C.11 | **Focus management.** Native `<dialog>` + `showModal()` handles this for free: focus moves into dialog on open, returns to trigger on close, page outside is `inert`. Add `tabIndex={-1}` on the stage container so it can receive programmatic focus. The × button is the natural first-focus target (autofocus or `:focus-within`). | `features/library/Stage.tsx` |
| C.12 | **Image preload on cell `onMouseEnter` / `onPointerDown`.** Before Focus opens, kick off a `new Image()` against `cacheUrl(id, "full")` so the high-res image is decoded by the time the user releases the mouse button. Eliminates the 50-200ms blank-stage flash on Focus open. Cheap: ~5 lines. | `Library.tsx` (Grid cell handler) |

**Patterns to follow:**
- `<CopyButton>` reuse — see `features/shared/CopyButton.tsx` (no changes; 3 instances render in DetailRail)
- `<Editor>` chrome discriminator — replace existing `embedded?: boolean` per Architecture · Editor reuse strategy
- Native `<dialog>` element — see framework-docs research; handles inert + focus trap + Esc + close events for free
- `data-mode` CSS targeting — use `.psl[data-mode="focus"]` for focus-specific layout
- Stale-closure-safe keydown via `viewRef` mirror — see julik concern 4a

**Verification:**
- In Grid, click any cell → Focus overlay opens with that capture's image at usable size. The `<dialog>` element's backdrop dims the page (`::backdrop` styling). Top breadcrumb showing "VS Code · auth flow — token refresh · Today 11:23 · 2880×1800". × button top-right. Edit toolbar centered at bottom of canvas with V/A/R/H/T/B keys visible. Prev/next chevrons on left/right edges of canvas. **Tab cycles within the dialog only** (page outside is `inert` — Tab can't escape).
- Right rail visible with 360px width: tab strip (Detail tab active; History/OCR placeholder), metadata block, Codex caption card, `.psl__copy-row` with three `<CopyButton>` instances showing scaled dims + bytes, Share + Editor + delete action row.
- ⌘1 / ⌘2 / ⌘3 (or clicking the buttons) → fires `clipboard:copy` with the right preset; CopyButton's "Copied" overlay confirms.
- Press R → toolbar updates active state + Editor canvas's `data-tool` changes; drag on canvas creates a rect overlay.
- Press Esc → dialog closes, returns to Grid. The cell that was open briefly pulses with the `cell-pulse` keyframes animation (600ms accent-ring). **Scroll position is preserved natively** because Grid was never unmounted.
- Press ← / → → cycles through filtered `visible[]` with wrap-around. DetailRail metadata + canvas image update.
- × button → same as Esc. Click on the dim backdrop region (NOT inside the stage) → same as Esc. Mid-rect-drag (mousedown inside stage, drag past edge, release on backdrop) → does NOT dismiss (mousedown-target check, not click).
- Click Reel toggle → switches to Reel mode with the same selection.
- **Tool reset on mode change**: in Focus pressing R (rect tool active), then Esc → in Grid the next time a Focus opens, tool is back to "pointer" (Library's effect resets it on `view.kind` change).
- **Stale-closure regression test**: open Focus, press Esc → close. Re-open Focus, press Esc → must close (closure pattern would silently break here without the viewRef pattern).
- Visual: matches screenshot 4 within reasonable tolerance for capture-aspect differences (the design's mock is 2880×1800; real captures vary).

**Execution note (test-first checkpoints):** biggest phase. Recommend checkpointing after C.2 (Editor chrome discriminator + standalone-window unbroken), C.5 (DetailRail rendering with three CopyButtons), C.7 (cell pulse working visually), C.10 (backdrop dismiss on mousedown only). Each is a manual smoke that takes <1 minute to verify and catches the regression class for that unit.

#### Phase D: Reel mode — `<Stage dismissible={false}>` + inline filmstrip

**Goal:** the Reel toggle yields screenshot 5 — filmstrip on top, big always-open stage below, same edit toolbar + detail rail as Focus.

**Decomposition note:** `<Stage>` from Phase C is reused with `dismissible={false}` and an `aboveStageSlot` prop for the filmstrip. Filmstrip is **inlined into the Reel render path** in Library.tsx — it's used in exactly one place, extraction is premature per code-simplicity-reviewer.

Implementation Units:

| Unit | Goal | Files |
|---|---|---|
| D.1 | In `Library.tsx`, `view.kind === "reel"` branch renders `<Stage view={view} dismissible={false} record={selectedRecord} dispatch={dispatch} aboveStageSlot={<FilmstripJSX />} />`. The FilmstripJSX is inline JSX (~30 lines), not a separate component. | `Library.tsx` |
| D.2 | Filmstrip horizontal scroll position preservation across mode flips. `useRef<number>(0)` for scroll-left; `useLayoutEffect` restores on Reel mount; `scroll` event listener captures changes (passive, debounced). Same pattern as the gridScrollRef but on a filmstrip-internal ref. | `Library.tsx` |
| D.3 | Filmstrip uses `content-visibility: auto; contain-intrinsic-size: <frame-w> <frame-h>;` on `.psl__frame` per perf-oracle's filmstrip recommendation. Through ~1000 captures this avoids horizontal-strip-paint-cliff without a virtualization library. | `library.css` |
| D.4 | Filmstrip frame click dispatches `NAVIGATE({ recordId })`. When `selectedRecordId` changes via ←/→, `scrollIntoView({ block: "nearest", inline: "center" })` on the new frame so it doesn't scroll out of view. | `Library.tsx` |
| D.5 | TOGGLE_VIEW("reel") with no selection: the reducer falls back to `visibleIds[0]` if available. If `visible` is empty, it stays in Grid (per the reducer logic — can't enter Reel without a selection). Renders an empty-state in the Reel branch when somehow reached: centered "No captures match this filter" message. | `Library.tsx`, `library.css` |
| D.6 | ← / → in Reel: already wired from C.8 (the keydown listener checks `view.kind` from viewRef and dispatches NAVIGATE for both `focus` and `reel`). | (no new code; verification only) |
| D.7 | Position counter "N / total" in top-right of `<Stage>` — already part of Stage in Phase C, no new work. | (no new code; verification only) |
| D.8 | Port reel-mode CSS (`.psl__reel-mode`, `.psl__reel-wrap`, `.psl__reel-hdr`, `.psl__reel`, `.psl__reel-day`, `.psl__frame`) from `design/src/library.css`. **Don't port `.psl__playhead`** — F.4 decision is "hide scrubhead". Don't port the "scrub ⌘[ / ⌘]" hint either. Stage classes are already in place from C.9. | `library.css` |

**Verification:**
- Toggle Reel from Grid → filmstrip on top, `<Stage dismissible={false}>` below (no × button visible), right rail visible.
- Click a frame → Stage image + DetailRail update.
- ← / → cycle. Holding the key auto-repeats; selected frame stays in view (`scrollIntoView` on every change).
- Toggle Grid → Reel → Grid → Reel: filmstrip's horizontal scroll-left is preserved (D.2 ref pattern).
- Empty-filter case: change activeApp filter to one with zero captures while in Reel. Reducer's `FILTER_CHANGED` action bails to Grid (selection no longer in `visibleIds`). User sees Grid empty state, not a half-rendered Reel.
- Visual: matches screenshot 5.

**Execution note:** mostly a scoped reuse of Phase C primitives. Net new code: filmstrip JSX (inline) + scroll-position ref + a few CSS classes. If Stage's `aboveStageSlot` prop turns out clunky in practice, fall back to an inline JSX block in the Reel branch and skip the slot — it's an internal API, no consumers outside Library.

#### ~~Phase E: Left-rail data-driven app filter~~ — FOLDED INTO PHASE B (B.8)

The original plan separated this as its own phase but acknowledged it was "trivially small" and recommended landing it alongside Phase B. Code-simplicity-reviewer agreed; it's now Phase B.8. No phase-level coordination needed.

#### Phase F: Polish — visual matching pass

**Goal:** the small things that make the surface feel finished.

**Most original Phase F units have moved or been resolved:**

- **F.1 (scroll restoration)** — moved to Phase B (the `display:none` decision means scroll is preserved natively; nothing extra to verify in Phase F).
- **F.2 (cell pulse)** — moved to Phase C.7 (it's part of the Focus close UX, not standalone polish).
- **F.3 (⌘L / ⌘⇧P shortcuts)** — DROPPED. ⌘L focusing an inert search input is anti-feature (search wiring is Phase 2.x). ⌘⇧P is already wired via main-process globalShortcut and is unrelated to this plan. No-op for this plan.
- **F.4 (scrubhead)** — DECIDED: hide it. Scrubhead playhead element is dropped from the design CSS port (Phase D.8). No keyboard binding for ⌘[ / ⌘]. Status-bar hint also dropped.
- **F.5 (status bar mode hints)** — DROPPED. Code-simplicity-reviewer was right: keyboard-shortcut chrome in the bottom-right of a window users already know how to use is fluff. The static `⌘⇧P new · ⌘L library · ⌘K search` text stays as it currently is.

What remains in Phase F:

| Unit | Goal | Files |
|---|---|---|
| F.6 | **Visual matching pass.** Compare each mode against its design screenshot. Fix obvious deltas: spacing (the design's mode-row gap might differ from ours by 2-4px), font weights (Geist 600 vs 700 distinction), hover states (the `.psl__cell:hover` outline color), preview thumbnail aspect-ratio rendering. Use the same forced-height-diagnostic technique that worked for the tray (temporarily hardcode dimensions to known design values to verify our rendering against the mock at 1:1). | `library.css` |
| F.7 | **Editor mid-drag overlay leak guard.** Editor's draft-cleanup useEffect must commit-or-cancel a pending `text` draft and discard a pending `rect-drag` draft on unmount. Verify by manual repro: open Focus → press T → start typing in text overlay → press Esc → reopen Focus on same capture → expect no ghost text overlay. If repro succeeds, add explicit cleanup. | `features/editor/Editor.tsx` |
| F.8 | **End-to-end manual smoke** of all transitions in the table. Each transition exercised once with a real capture record (not just fixtures). | (no new code) |

**Verification:**
- Open Library, scroll grid down 800px, click cell, Esc back — scroll position is preserved (Phase B's `display:none` ensures this; F is just confirming).
- Cell pulses on return (Phase C.7).
- F.7 mid-draft repro: no ghost overlays after Esc-during-text-draft.
- All transitions in the table work; modes switch cleanly; selection persists across them.

**Execution note:** small. Mostly verification + visual polish. The mid-drag guard (F.7) is the only one that might surface a real bug.

## Alternative Approaches Considered

- **Keep the current pin/unpin right-rail (PwrAgnt pattern) and just
  build out Focus / Reel on top.** Rejected — the design notes
  explicitly call out grid as "no shrunken sidebar preview
  competing." The pin/unpin model was the right answer to "the rail
  is too aggressive in browse mode" but the design's actual answer
  is "no rail at all in browse mode, always-visible rail in
  focus/reel". Simpler, fewer states for the user.
- **Build Focus / Reel without lifting `tool` state out of Editor.**
  Rejected — Option A in the architecture section explains the
  reasoning. Lifting `tool` state out lets the floating bottom
  toolbar (Library-owned) and the canvas (Editor-owned) share a
  single source of truth without a roundtrip.
- **Keep both the design's reel filmstrip AND the existing reel
  layout simultaneously.** Rejected — the design's whole point is
  three discrete states. Rendering the filmstrip in grid mode
  defeats the simplification.
- **Implement Crop tool as part of this plan.** Rejected — Crop
  needs an overlay schema entry, render-bake support, drag-to-crop
  UX, and "save as new capture vs. apply to existing" decisions.
  That's its own plan. Toolbar shows Select/Arrow/Rect/Highlight/
  Text/Blur in this iteration; Crop slot reserved for the next plan.
  See Scope Boundaries.

## System-Wide Impact

### Interaction Graph

- Grid cell click → `setMode("focus")` → re-render with `<FocusOverlay>` mounted.
  - Focus overlay mounts → `<Editor chromeless captureId={x} />` mounts → fetches capture record + overlays via `dispatch("library:byId")` and `dispatch("overlays:listForCapture")` (existing IPC).
  - Detail rail mounts → renders three `<CopyButton>` with `presetMetrics()`-derived strings (no IPC; pure compute).
  - User clicks ⌘1 → `<CopyButton>` fires `onCopy("low")` → calls `dispatch("clipboard:copy", { captureId, preset: "low" })` → main writes scaled PNG to clipboard.
- Focus → Esc / × → `setMode("grid")` → unmount FocusOverlay → restore `gridScrollRef.current.scrollY` via window.scrollTo / pane scrollTop.
- Reel mode → ← / → arrow → `setSelectedId(±1 in visible)` → `<ReelStage>` updates → `<Editor>` receives new captureId → re-loads via existing Editor's useEffect chain.

### Error & Failure Propagation

- Selected captureId not in `records` (race with delete) → existing
  stale-selection fallback in `Library.tsx` (currently clears
  `selectedRecordId`) needs to be updated to clear `selectedId` and
  pop the user back to Grid mode (don't leave them in a Focus on a
  ghost capture).
- Capture image fails to load → Editor's existing error state
  ("Couldn't load capture: …") renders inside the canvas slot. No
  change needed.
- ResizeObserver / measurement bugs from the tray plan → not
  applicable here; Library is a fixed-frame window, no auto-size.

### State Lifecycle Risks

- **Mid-mode-flip user actions** — what if a clipboard:copy is
  in-flight when the user toggles Grid → Reel? The dispatch is
  fire-and-forget; the result toast is on the float-over surface
  not the Library, so nothing in Library cares about the response.
  Safe.
- **Unmounting Editor with unsaved draft** — Editor.tsx already
  handles draft cleanup on unmount (text-input commit, rect-drag
  cancel via Esc). Verify that Focus close while in mid-drag
  doesn't leave a dangling overlay; if so, cancel draft on close.

### API Surface Parity

- The `clipboard:copy` command is unchanged; we just add three more
  call sites (one per CopyButton in DetailRail).
- `library:list`, `library:byId`, `overlays:listForCapture` are all
  existing IPCs — no schema or contract changes.

### Integration Test Scenarios

5 cross-layer scenarios that unit tests with mocks would miss:

1. **Grid → Focus → ⌘1 copy → Esc → Grid scroll restored.** End-to-
   end: window scroll preserved across mode flip, clipboard contains
   a valid PNG of the right scale, cell briefly pulses on return.
2. **Focus → ← arrow at index 0 → wraps to last visible capture.**
   Verifies the modular-arithmetic wrap-around in `navInFocus`.
3. **Focus → app filter changes (e.g., Telegram → VS Code).** Should
   close Focus (filtering out the currently-focused capture is a
   user choice — bail to Grid in the new filter rather than try to
   resolve to a different capture). Verify selection state is sane.
4. **Reel → drag-to-draw rect on canvas → toggle to Grid → toggle
   back to Reel.** Drawn overlay should still be there (persistence
   via `overlays:upsert` is unchanged; Editor reloads its overlays
   on mount).
5. **Cold start with zero captures.** Library opens in Grid with
   "No captures yet" empty state (existing copy in current Library);
   left rail Source App section is empty (Phase E); Reel toggle
   should still be functional but show an empty-state message in
   the stage.

## Acceptance Criteria

### Functional Requirements

- [ ] Grid / Reel segmented control toggles between Grid and Reel
      view-states; both states render distinctly (Grid: cells fill
      pane; Reel: filmstrip + stage + rail).
- [ ] Default landing on Library open is Grid mode.
- [ ] In Grid: clicking any cell opens the Focus overlay.
- [ ] In Focus: × button + Esc both return to Grid; cell pulses
      briefly on return; window scroll position is restored.
- [ ] In Focus: ← / → cycle through filtered visible set with wrap-around.
- [ ] In Focus: edit toolbar floats bottom-center over canvas with
      Select / Arrow / Rect / Highlight / Text / Blur tools and
      single-letter hotkeys (V / A / R / H / T / B). Drawing on the
      canvas creates overlays (existing Editor behavior).
- [ ] In Focus + Reel: detail rail visible on right, 360px wide,
      always-on (no pin / unpin user toggle). Shows metadata block,
      Codex caption stub, three `<CopyButton>` instances (Low/Med/High
      via shared component), Share/Editor/trash action row.
- [ ] Right rail is hidden entirely in Grid mode (no spine, no
      panel, no toggle).
- [ ] Selection persists across all mode transitions.
- [ ] Reel mode shows filmstrip across top, always-open stage below,
      same toolbar + rail as Focus, NO × button.
- [ ] Left rail Source App section only lists apps that have ≥1
      capture (data-driven, not literal-from-design).
- [ ] PwrAgnt pin/auto-hide right-rail code is fully removed.

### Non-Functional Requirements

- [ ] Typecheck (`pnpm --filter desktop typecheck`) clean.
- [ ] Build (`pnpm --filter desktop exec electron-vite build`) clean.
- [ ] Visual matches each design screenshot within reasonable
      tolerance (spacing, fonts, colors). Capture aspect ratios
      may vary from the mock since real captures aren't fixed
      2880×1800.

### Quality Gates

- [ ] Each phase ships independently shippable — A is a working
      toggle without new visuals; B is a Grid cleanup without
      Focus; etc. No phase leaves the app in a broken state.
- [ ] Phase B explicitly deletes the pin/unpin code from `b9296ea`;
      that change is called out in its commit message so future-us
      doesn't get confused.
- [ ] All new CSS classes ported from `design/src/library.css` —
      avoid hand-redoing the visual treatment.

## Success Metrics

- The Grid / Reel toggle does what its label promises.
- Users can edit a capture without their cursor falling off a
  shrunken thumbnail.
- L/M/H copy buttons consistent across float-over toast (already
  shipped) and library detail rail (this plan).
- No more PwrAgnt-pattern explainer needed in the UI — the right
  rail is either visible or not based on what mode you're in,
  no pin/unpin to learn.

## Dependencies & Prerequisites

- Shared `<CopyButton>` component (already shipped in `e1f6d26`).
- Existing `<Editor embedded>` (already in repo) — needs minor
  extension to accept `chromeless?: boolean` prop (Phase C.2).
- Existing `useLibrary()` hook (already in repo) — no changes.
- Existing `clipboard:copy`, `library:list`, `library:byId`,
  `overlays:listForCapture` IPCs (already in repo).
- Design CSS source: `design/src/library.css` (refreshed in commit
  `da8ed89` — current).

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Phase B's deletion of pin/unpin breaks something subtle that depended on the rail's render lifecycle | Low | Low | Pin/unpin code is fully extracted to `HoverRevealPanel.tsx` (B.1) before deletion. No external dependencies (audited by repo-research-analyst). |
| `<Editor>` `chrome` discriminator breaks the standalone editor window | Low | High | Controlled-or-uncontrolled `tool`/`onToolChange` (both optional) preserves the standalone path's internal-state fallback. Only one existing call site to migrate (`Library.tsx:441`, removed in Phase B). Verify by opening editor from float-over's Edit button after Phases A/B/C. |
| **Stale closure in keydown listener** (julik #4a) — `useEffect(..., [])` captures initial `view`, breaks after first mode flip | High if missed | High | Use `viewRef` mirror pattern: `useRef`, updated in `useEffect([view])`, read inside the `window.addEventListener("keydown")` callback. Single listener for the lifetime of Library mount. |
| **Editor IPC race during rapid mode flips** (julik #6) — `library:byId` for capture A resolves AFTER capture B has been selected | Medium | High | Phase A.7 audits `Editor.tsx` for cancel-safety. Every IPC `.then(...)` calling setState must have a `let cancelled = false` flag in its `useEffect` cleanup. Pre-Phase-C work — gates Phase C exposure of the race surface. |
| **Stage backdrop dismiss on rect-drag mouseup** (julik #10) — user drags rect past canvas edge, releases on backdrop, `click` fires, dialog closes mid-stroke | Medium | Medium | Phase C.10: backdrop dismiss listens for `mousedown` with `e.target === e.currentTarget`, NOT `click`. Drag-from-stage doesn't accidentally dismiss. |
| **Tool state persists across mode changes** (julik #3) — user has rect tool active in Focus, Esc out, next click in filmstrip starts drawing rect | Low (after fix) | Medium | Phase C.4: `useEffect(() => setTool("pointer"), [view.kind])`. Resets on every mode change. |
| **Cell pulse fires on detached node** (julik #2) — pulse setTimeout runs after Grid has been remounted or the cell has been unselected | Low | Low | Phase C.7: use `animationend` listener with `{ once: true }` instead of setTimeout. Self-cleaning. Force-reflow before re-applying class so rapid open/close/open restarts the animation. |
| **`exactOptionalPropertyTypes` strict-mode bites on conditional optional props** (TS reviewer §7) | Medium if missed | Low | Documented in Architecture section: spread a conditionally-built object instead of passing `prop={cond ? value : undefined}`. Implementing agent must follow the pattern. |
| **Filter change while Focus is open puts FocusOverlay on a non-visible capture** (julik #5) | Medium | Medium | Resolved in reducer: `FILTER_CHANGED` action bails to Grid if current selection no longer in `visibleIds`. Test in Phase A reducer test suite (no need to wait for full integration). |
| **`<dialog>` element interactions with React's commit timing** | Low | Medium | Open/close via imperative ref calls (`dialogRef.current.showModal()` in `useEffect`, `dialogRef.current.close()` on Esc/×). `close` event fires onCloseEvent → dispatches `CLOSE_FOCUS`. Verify state stays consistent during rapid open-close cycles. |
| **`presetMetrics()` move from TrayMenu to shared breaks tray** (repo-research-analyst note) | Low | Low | Single import-site update (`TrayMenu.tsx`) when the function moves. Both consumers (tray + DetailRail) typecheck before merge. |
| **Grid scroll position lost despite display:none** | Low | Medium | Verified-via-Chromium-spec that `scrollTop` survives `display:none` toggles **on the same DOM element**. Risk only manifests if React reconciliation creates a new element instance somehow. Add `key` stability test: open Focus, scroll Grid before close, verify scrollTop persists. |

## Future Considerations

- **Crop tool** (deferred from this plan) lands as its own feature.
  **Important schema-level note from architecture-strategist's review:**
  Crop is a `CaptureMutation`, NOT an entry in the overlay union.
  Annotations are *additive* (composite onto source); crop is
  *substitutive* (changes the canonical viewport). Schema design
  should be:
  ```ts
  type CaptureRecord = {
    id: string;
    sourceImagePath: string;
    crop?: { x: number; y: number; w: number; h: number };  // capture-level
    overlays: Overlay[];                                       // annotations
  };
  ```
  Bake pipeline: crop runs first to produce post-crop image, then
  overlays composite onto that. Don't extend the existing overlay
  `kind` union with `"crop"` — it'll force every overlay-handling
  path to special-case it.
- **Color swatches** — Editor currently uses a fixed accent color
  for all overlays. Add a color field to the overlay schema, plus
  the swatch UI in `<EditToolbar>`. Probably alongside Crop.
- **Magic wand / Codex auto-annotate** — Phase 4 of the buildout
  plan. Toolbar slot is reserved.
- **Search bar wiring** — currently visual; Phase 2.x in the
  buildout plan.
- **OCR / History tabs** — placeholder buttons; content lands when
  OCR pipeline exists.
- **Tag editing in detail rail** — currently read-only; full tag
  CRUD is a separate plan.
- **CopyButton CSS prefix rename** — `.fo__copy-btn*` is now
  cross-feature (float-over, tray, library). The `fo__` prefix is
  misleading. Future cleanup: rename to a context-neutral
  `.ps-copy-btn*` and update all three feature stylesheets in one
  pass. Tracked as tech debt; not load-bearing for this plan.
- **Grid virtualization** — current plan ships with `loading="lazy"`
  + `content-visibility: auto` which carries through ~1000 captures.
  When telemetry shows otherwise, virtualize via react-window or
  react-virtuoso. Day-grouped layouts are awkward to virtualize
  (sticky group headers, variable group heights), so this is its
  own future plan.
- **Filmstrip virtualization** — uniform-width frames make this
  much simpler than the grid. A horizontal `react-window`
  `FixedSizeList` is straightforward when needed.
- **Multi-select in Grid** — `SELECT_IN_GRID` action is reserved
  in the reducer for future use. Bulk actions, ⌘-click multiple
  cells, etc. Right rail's mode-conditional pattern (DetailRail
  returns null in Grid TODAY but could render a "3 selected" panel
  TOMORROW) is built for this extension.
- **Standalone editor window deprecation** — once the in-Library
  Focus + Reel modes have parity with the standalone window, the
  separate window goes away. The Editor `chrome: "full"` mode
  becomes unused; can be removed as cleanup. Phase 6+ work.

## Scope Boundaries

**Explicitly NOT in this plan:**

- Crop tool implementation (toolbar slot reserved-but-not-rendered; CSS classes for it NOT ported).
- Color swatches in toolbar (single-color rendering remains; `.psl__et-swatch` CSS NOT ported).
- Magic wand / Codex auto-annotate button (slot reserved-but-not-rendered; no CSS port).
- Undo button beyond what Editor already has (its existing "Undo last" stays).
- Search bar functionality (visual only; no query parsing).
- Smart filter wiring (Pinned / Bug repros / Has annotations are visual-only chips with stub counts).
- History / OCR tab content in DetailRail (tabs render, only Detail tab has content).
- Tag editing in DetailRail (read-only display).
- Sizzle reel composer (Phase 6 of the buildout plan).
- Drag-out from cells (Phase 2.x deferred per the buildout plan).
- Multiple-selection in Grid (single-selection only; `SELECT_IN_GRID` reducer action reserved for future use).
- **Grid virtualization** — `loading="lazy"` + `content-visibility: auto` carries through ~1000 captures. Virtualization is a future plan gated on telemetry.
- **Filmstrip virtualization** — same as above; through ~1000 captures the `content-visibility: auto` approach is sufficient.
- **Cmd-[ / Cmd-] keyboard shortcuts** — decided NOT to ship (was Deferred F.4). ←/→ does the work.
- **Status bar dynamic mode hints** — decided NOT to ship (was Phase F.5).
- **⌘L / ⌘⇧P shortcuts in Library** — decided NOT to ship in this plan (was Phase F.3); ⌘⇧P is wired globally already; ⌘L would focus an inert search.

## Resolved Decisions (formerly Deferred)

The deepening pass resolved 4 of the original 5 deferred items. Captured here for traceability:

1. ~~**Reel scrubhead** — hide it.~~ Drop the playhead, drop the "scrub ⌘[ / ⌘]" hint, no keyboard binding. Code-simplicity-reviewer + architecture-strategist agreed: aliasing to ←/→ doesn't earn its CSS. Phase D.8 deletes the playhead from the design CSS port.

2. ~~**Filter change while in Focus** — bail to Grid.~~ Encoded in `libraryReducer`'s `FILTER_CHANGED` handler. Filter is a query, query changed, show new result set.

3. ~~**Empty-state for Reel** — centered "No captures match this filter" message.~~ Phase D.5 implementation note.

4. ~~**Cell pulse duration** — 600ms (not 250ms).~~ Per the design source's `cell-pulse` keyframes (1.2s) and best-practices research (250ms feels glitchy; 600ms reads as deliberate). Pure CSS animation, no rAF needed since the cell is in the DOM (Grid stays mounted).

5. **Empty Source App left-rail section** — STILL DEFERRED. Implementer's discretion: render the section header with a "No source apps yet" placeholder vs. hide the whole section. Genuinely doesn't matter; pick whichever looks cleaner during Phase B.8.

## Deferred to Implementation

The remaining items where the implementing agent's eye matters more than upfront commitment:

1. **CSS naming conflict resolution.** Plan ports `psl__et-*` (abbreviated) classes from the design source while the codebase otherwise prefers full-word forms (`psl__nav-icon`, `psl__cell-thumb`, etc.). Two paths: (a) keep `psl__et-*` for design-source fidelity; (b) rename to `psl__edit-toolbar-*` for codebase consistency. Pick during Phase C.9 based on how the diff looks. Either is defensible; what's NOT defensible is shipping both forms in the same file.

2. **Stage `aboveStageSlot` API.** Phase C designs `<Stage>` to accept an `aboveStageSlot` prop for the Reel filmstrip. If during implementation this slot turns out clunky (prop drilling, awkward typing), fall back to inline JSX in the Reel branch with no Stage prop change — Stage stays Focus-only, ReelStage gets reborn as a ~50-line component that imports Stage and adds the filmstrip above it. Keep that escape hatch open.

3. **Whether to use native `<dialog>` element or a styled `<div>`.** Framework-docs research strongly recommends `<dialog>` (free focus management, inert behind, Esc handling, `closedby="any"`). But: `<dialog>` defaults to centered + sized-to-content, requires `dialog.psl__focus { inset: 0; max-width: none; ... }` overrides, and React + `<dialog>` interactions are known-quirky in some React versions. If the dialog approach hits weird bugs, fall back to a portal'd `<div role="dialog" aria-modal="true">` with a manually-applied `inert` attribute on the Library shell. Both approaches are documented in the research; the dialog path is preferred but not load-bearing.

4. **Tool state isolation in standalone-window editor path.** Editor's controlled-or-uncontrolled `tool` prop falls back to internal `useState` when neither `tool` nor `onToolChange` is passed. Verify the standalone-window path (opened from float-over's Edit button) still has tool hotkeys working after Phase C.4. If it broke, the fallback isn't being reached — debug the prop type narrowing.

## Documentation Plan

- `AGENTS.md` updates: not required — this plan is implementation-
  facing, not future-agent-blocking. The existing tray-sizing and
  setMinimumSize sections are the load-bearing docs from this
  session.
- Buildout plan (`docs/plans/2026-05-03-001-feat-pwrsnap-feature-
  buildout-plan.md`): mark relevant Phase 2 items as updated per
  this plan once it ships. Specifically the "always-edit, no
  modes" line should be reframed — we now have explicit modes
  (Grid / Focus / Reel), but the model has matured.
- No new top-level docs.

## Sources & References

### Design Source

- [`design/PwrSnap Library.html`](../../design/PwrSnap Library.html) —
  imports `design/src/Library.jsx` which has the full interactive
  React component the plan ports. Reads as canonical for the
  three-state model + transitions.
- [`design/src/Library.jsx`](../../design/src/Library.jsx) —
  reference for `FocusStage`, `ReelBody`, `DetailRail`, `EditToolbar`,
  `CopyRow` component shapes. Plan's components mirror these but
  use real records + IPC instead of fixture data.
- [`design/src/library.css`](../../design/src/library.css) — source
  of truth for `.psl__focus*`, `.psl__stage*`, `.psl__edit-toolbar`,
  `.psl__et-*`, `.psl__reel-mode`, `.psl__filmstrip` styles.

### Internal References

- `apps/desktop/src/renderer/src/features/library/Library.tsx` —
  current implementation, state to refactor.
- `apps/desktop/src/renderer/src/features/editor/Editor.tsx` —
  reuse target (with new `chromeless` prop, see Phase C.2).
- `apps/desktop/src/renderer/src/features/shared/CopyButton.tsx` —
  ship-as-is; no changes needed.
- `apps/desktop/src/renderer/src/styles/library.css` — destination
  for ported design CSS.
- `apps/desktop/src/renderer/src/lib/useLibrary.ts` — reads `records`,
  unchanged.

### Related Work

- Commit `e1f6d26` — shared `CopyButton` component (Phase C reuse).
- Commit `b9296ea` — PwrAgnt-pattern pin/unpin right-rail (Phase B
  deletes this).
- Commit `da8ed89` — refreshed `design/` bundle this plan reads from.
- `docs/plans/2026-05-03-001-feat-pwrsnap-feature-buildout-plan.md`
  — overall Phase 2 / Phase 4 context this plan slots into.

### User-Provided Context

User screenshots referenced throughout (provided in plan request):

1. Current Library screen — sets baseline for the gap.
2. Grid mode (sidebar closed, nothing selected) — target for Phase B.
3. Library design notes ("three states, one model") — canonical
   text source for Phases A–D + state transitions.
4. Focus overlay (single-image edit from Grid) — target for Phase C.
5. Reel mode (always-open stage + filmstrip) — target for Phase D.

User-stated constraints incorporated:

- L/M/H copy buttons reused as-is via shared `<CopyButton>` (no
  redesign).
- Reel scrubhead either hidden or wired to ⌘[ / ⌘] (Deferred F.4).
- Left rail visual unchanged; only filter logic changes (Phase E).
