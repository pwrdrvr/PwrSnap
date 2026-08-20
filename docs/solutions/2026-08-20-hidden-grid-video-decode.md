# Hidden-grid video tiles: what actually burns, and what doesn't

**Date:** 2026-08-20
**Area:** Library grid video previews (`PreviewVideoThumb` in
`apps/desktop/src/renderer/src/features/library/Library.tsx`) while
Focus / Reel mode hides the grid pane under `display: none`.

## Context

Out of the 2026-08 CPU-burn investigation (2h looping video in the
detail view; renderer + GPU each ~50%), the grid tiles were a
secondary suspect: every visible video tile keeps a live
`<video src="pwrsnap-capture://…" preload="metadata">` element, and
the whole virtualized grid stays mounted under `display: none` while
Focus mode is open (deliberate — scroll position, TanStack
virtualizer state; see the zero-poison notes in the virtualizer's
`measureElement` and PR #326).

Question: do those hidden tiles hold media pipelines / decoders, and
should we detach `src` while the grid is hidden?

## Measurements

Probe: hidden Electron BrowserWindow (same Electron as the app,
`backgroundThrottling: false` — which per Electron docs also pins
`document.visibilityState` to `"visible"`, exactly like the real
library window), page with N `<video preload="metadata">` under a
`display: none` ancestor, 6s 640x360 H.264 file, sampled via
`app.getAppMetrics()` and `getVideoPlaybackQuality()`. No model
window interaction, no PwrSnap state touched.

Results (Electron 2026-08, macOS arm64):

1. **40 idle `preload="metadata"` videos under `display:none`: no
   measurable cost.** CPU 0.0% across Browser/GPU/Tab/Network
   processes; working set indistinguishable from the 0-video baseline
   (±20MB run-to-run noise, no monotonic growth), unchanged after
   +20s idle.
2. **`src`-detach (`removeAttribute("src") + load()`) reclaimed
   nothing measurable** relative to (1), and re-attach of all 40 took
   ~20ms (local protocol, small file).
3. **A PLAYING muted looping video under `display:none` keeps
   decoding at full frame rate**: `totalVideoFrames` advanced 121
   frames / 4s (= 30fps) with the wrap `display: none`, in both a
   hidden and a visible window. Element visibility is not part of
   Chromium's media suspension logic — only page visibility is, and
   this app disables background throttling app-wide
   (`apps/desktop/src/main/window.ts`).

## Conclusions

- `preload="metadata"` alone is NOT holding decoders. Idle paused
  tiles are effectively free; eagerly detaching `src` on Focus open
  (the invasive option) buys nothing measurable and would re-fetch
  metadata for every visible tile on every Focus close — a very
  common action — risking thumbnail flash on large real captures.
  **Not shipped.**
- The real leak is a **hover preview left playing when the grid
  hides**. Enter / double-click on a hovered tile opens Focus without
  any mousemove, and Chromium does not recompute `:hover` (or fire
  `mouseleave` on the now-hidden cell) until the next mousemove — so
  the preview keeps decoding, silently (muted + invisible), for as
  long as the user sits in the detail view. For Retina screen
  recordings that is real decode work, unbounded in time.
- No tile-tied rAF/interval loops exist: hover previews are
  event-driven, the grid scroll probe rAF loop only runs on an
  explicit `perf:scrollProbe` request, and `VideoStage`'s rAF loop is
  gated on `playing` and belongs to the detail surface the user is
  actually watching.

## The fix (shipped with this doc)

`SurfaceVisibleContext` in `Library.tsx`: a context (default `true`)
whose provider wraps the grid's `VirtualizedGrid` with
`view.kind === "grid"`. `PreviewVideoThumb` consumes it and

- pauses the video whenever the surface is hidden (the hover-play
  effect keys on `hovering && surfaceVisible`),
- drops the `hovering` latch on hide so returning to grid doesn't
  auto-resume under a pointer that has long moved elsewhere,
- refuses to start playback while hidden.

Scoped as a context rather than derived state because `CellThumb`
renders in TWO places: the grid pane (hidden in focus/reel) and the
Reel filmstrip (VISIBLE in reel mode, rendered inside Stage's
`aboveStageSlot`). Only the grid subtree gets a provider; the
filmstrip inherits the default and keeps its hover previews.

Pinned by
`apps/desktop/src/renderer/src/features/library/__tests__/Library.grid-video-preview.test.tsx`
(3 of its 4 tests fail without the gate).

## If this needs revisiting

- If a future capture pipeline makes idle tiles expensive (e.g.
  tiles switch to `preload="auto"`, or per-tile poster generation
  moves into the element), re-run the probe before reaching for
  `src`-detach; the probe harness shape is described above and takes
  minutes to rebuild.
- The primary burn from the original investigation (looping video in
  the detail view) is the detail surface itself, not the tiles —
  `VideoStage`'s per-frame `setCurrentTime` re-render while playing
  is the next thing to look at there.
