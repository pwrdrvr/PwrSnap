---
title: Capture selector — Escape, interior-discard, crosshair, and pre-warmed state
type: solution
date: 2026-06-07
area: desktop
tags: [region-selector, capture, escape, globalShortcut, pre-warmed-windows, crosshair, snap-target, e2e, playwright]
---

# Capture selector — interaction + state gotchas

The region/window capture selector (`RegionSelector.tsx` + `region.css`,
driven by `region-selector.ts` in main) is one of the densest,
most-revisited surfaces in the app, and until now had no solution note
despite repeated incidents. Captured after
[PR #217](https://github.com/pwrdrvr/PwrSnap/pull/217) (crosshair +
multi-step Escape + interior-drag-redraw) so the next person touching the
overlay doesn't re-derive these — they're non-obvious and each one bit us.

Background on the window choreography this builds on:
[docs/plans/2026-05-04-001-fix-capture-flow-window-choreography-plan.md](../plans/2026-05-04-001-fix-capture-flow-window-choreography-plan.md).

Key files:

- `apps/desktop/src/renderer/src/features/region/RegionSelector.tsx` — the
  state machine (`snap → pending → drawing → adjusting → moving/resizing`).
- `apps/desktop/src/renderer/src/styles/region.css` — cursor map, dim mask,
  the transparent-pixel hit-test floor, crosshair.
- `apps/desktop/src/main/capture/region-selector.ts` — selector window,
  `globalShortcut` Esc/Enter forwarding.
- `apps/desktop/src/main/handlers/capture-handlers.ts` — the cancel/commit
  teardown choreography that `submitRegion` triggers.
- `apps/desktop/e2e/region-selector-{ui,snap}.spec.ts` — DOM-level specs.

---

## 1. Escape (and Enter) arrive on TWO paths — single-source them

A single physical Escape can reach the renderer **twice**:

1. The focused-renderer `keydown` listener (`onKeyDown`).
2. A `globalShortcut`-forwarded IPC (`region-selector:key` → `onSelectorKey`).
   Main arms this because **macOS withholds keyboard events from a
   freshly-shown panel** until the user clicks to "engage" it — so the
   forwarded path is often the *only* live one. Same for Enter.

Rules that fall out of this:

- **Both paths MUST call one handler.** `onKeyDown` and `onSelectorKey`
  both route Escape through a single `handleEscape()` (and Enter through
  `commit()`). If you add per-path logic, the two paths drift and the
  forwarded path — the production-critical one — silently diverges.
- **A step-back must NOT call `submitRegion`.** `submitRegion({ ok: false })`
  is the *real exit* and triggers the main-side teardown choreography:
  float-over cancel → ~50 ms compositor flush → `hideSelector()` →
  `activateApp(previousAppPid)` (see `capture-handlers.ts`). The multi-step
  Escape's "step back to snap" is purely client-side (`resetToSnap()`, no
  IPC). Only the snap-state Escape exits.
- **State-dependent Escape needs a de-dupe guard.** The old `cancel()` was
  state-independent, so a double-delivered single Escape was harmless (the
  second call was an idempotent no-op). `handleEscape()` is state-dependent
  (`interaction !== "snap"` → step back; `"snap"` → exit), which removed
  that safety: without a guard, one physical press could step back *and*
  then cancel. A short timer-only guard (`ESCAPE_DEDUPE_MS`, ~50 ms)
  swallows the duplicate. In practice `globalShortcut` usually *consumes*
  Escape so double-delivery is near-theoretical, but the guard makes it
  correct regardless.
- **Do NOT re-arm the de-dupe guard on `mousemove`.** An earlier version
  re-armed it on cursor movement for "snappier" deliberate repeats — but a
  stray cursor move landing between the two deliveries of one press would
  re-open the guard and let the duplicate through. Timer-only is the
  correct shape; clear the timer on unmount. A deliberate second Escape is
  always >50 ms later, so "Esc, Esc to exit" still works.

Do not try to "fix" focus problems by changing the selector window flags
(`type: 'panel'`, `setVisibleOnAllWorkspaces` ordering, `screen-saver`
level, `setSimpleFullScreen` before `show()`) — those are pinned by
`region-selector-window-flags.test.ts` and the `globalShortcut` forwarding
is the sanctioned answer to focus-withholding.

---

## 2. Selector windows are PRE-WARMED and reused — scrub transient state

The selector `BrowserWindow`s are created once at boot (`preWarmRegionSelector`)
and re-shown for each capture; the renderer is **not** remounted between
captures. So any transient flag set mid-interaction will **survive into the
next capture session** unless explicitly cleared.

Concretely, the interior-discard feature uses `discardingRef` +
`body[data-discarding]` (a 40%-opacity dim signalling "this pick is staged
for discard"). Two leaks bit us in review:

- It must be cleared in **`resetToSnap()` AND `commit()`** — an Escape or
  Enter out of a staged-discard `pending` state would otherwise leave the
  flag set, dimming the next session's rect to 40% and poisoning the keep
  logic.
- The `onMouseUp` dim-clear must run **before** the `snap`/`adjusting`
  early-return, or a mouseup that arrives after Escape already stepped the
  interaction back will skip the clear.

General rule for this component: **any flag/attribute you set during an
interaction needs a clear path in every reset (`resetToSnap`, `commit`,
`cancel`) and a default-on-entry**, because the window outlives the
interaction.

---

## 3. Per-frame overlay visuals: direct DOM writes + CSS attribute gating

The cursor-tracking crosshair is positioned by **direct DOM writes from a
ref** inside `onMouseMove` (`positionCrosshair()` writing
`hLineRef`/`vLineRef` `style.left`/`top`), **never via React state**.
Reasons:

- `onMouseMove` early-returns in `adjusting`, so driving position through
  state would force needless re-renders in a hot per-frame path.
- The line elements stay **mounted in every state** — if they were
  conditionally unmounted, the direct writes would target detached nodes.

Visibility is gated **declaratively in CSS** off the existing state-surface
attributes — `body[data-interaction]` (hidden during `moving`/`resizing`)
and `body[data-mode]` (hidden entirely in the instant `window` picker,
where a crosshair would imply a draw gesture that mode can't honor). Reuse
those attributes (the component already stamps them for cursor switching);
don't invent a parallel visibility channel.

Also: never give the overlay a fully-transparent background. `region.css`
paints `rgba(0,0,0,0.004)` on purpose — pure transparency makes macOS
click-through every transparent pixel and the window loses all mouse
events. Keep new overlay elements `pointer-events: none` so the
window-level listeners keep seeing every event.

---

## 4. `SnapTarget` "display" is overloaded — don't re-derive a kept rect

`SnapTarget` has two kinds, `window` and `display`. A **free-drawn region**
is stored as `{ kind: "display" }` ("semantically no window"), but
`rectForSnap({ kind: "display" })` returns the **whole display**. So you
cannot reconstruct a free-drawn rect from its snap target.

This bit the interior-discard "keep" path. The fix that matters: the
interior-discard branch leaves `rect` and `snapTarget` **untouched** while
`pending`, so a no-drag "keep" click has **nothing to restore** — it just
stays put. Re-deriving via `rectForSnap` on keep would silently re-expand a
free-drawn region to the entire screen. (A boolean `discardingRef` records
"a discard is staged"; there is no rect/snap stash because nothing changed.)

If you ever need a free-drawn rect to round-trip through a snap target, add
a third `SnapTarget` variant that carries its own rect rather than
overloading `display`. (The dims chip labelling any free region
"Display · W×H" is a symptom of the same overload — pre-existing, low
priority.)

---

## 5. E2E: real fullscreen overlay + a physical cursor = flaky snap specs

`region-selector-{ui,snap}.spec.ts` show a **real, fullscreen, top-level**
`BrowserWindow`. On a machine with a **physical cursor** (local dev), the OS
delivers a native `mousemove` at the cursor's location when the overlay
appears. If that point is outside the synthetic test window, the renderer
**correctly** re-snaps to `display` right after the test's single Playwright
`mouse.move`, leaving `data-snap` stuck on `display`. Headless CI has no
physical cursor, so it never sees this — the specs are green in CI and flaky
only locally under repeat.

Fix pattern (`lockWindowSnap` in `region-selector-snap.spec.ts`): re-dispatch
the move (or re-send the cursor-bearing window-list snapshot) **inside an
`expect.poll`** until the snap locks. This makes the test's move the last
event each iteration and self-heals the race **without weakening any
assertion** (it still requires a real `data-snap === "window"`).

```ts
async function lockWindowSnap(selector: Page, x: number, y: number) {
  await expect
    .poll(async () => {
      await selector.mouse.move(x, y);
      return selector.locator("body").getAttribute("data-snap");
    }, { timeout: 5000, intervals: [50, 100, 150, 250] })
    .toBe("window");
}
```

Route every "move, then assert window snap" through it; for cursor-init
tests (no test-driven move), re-send the cursor-bearing snapshot in the poll
instead. After this, the snap+ui suite passes 39/39 under `--repeat-each 3`
locally. The renderer is not buggy here — re-snapping when the real cursor
moves is correct; the tests just have to control for the environmental
mousemove.
