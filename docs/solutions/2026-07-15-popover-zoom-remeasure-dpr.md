# Popover zoom remeasure — `zoom-changed` never fires; use devicePixelRatio

**Status**: Fix for the intermittent Windows E2E failure in
`tray-sizing.spec.ts` › "sizes correctly under non-1.0 zoom"
(“tray contentSize never grew after zoom — remeasure round-trip didn't
land”, e.g. PR #317 run 29465287755). Prior hardening was PR #252.
Two parts: the dead-trigger root cause (below) and a throttling
hardening (`backgroundThrottling: false`, see "Residual flake" at the
end) after the first CI run with the DPR listener alone still flaked
once on the starved VS2026 runner.

**TL;DR** — Electron's `webContents.on("zoom-changed")` fires **only**
for a user mouse-wheel zoom *request*. It does **not** fire for
`setZoomFactor`, the `zoomLevel` setter (which is what the View-menu
`zoomIn` / `zoomOut` roles call), or Chromium HostZoomMap same-origin
propagation to sibling windows. So the old main-side
`zoom-changed → events:popover:remeasure` kick was dead code in every
real zoom path — production ⌘+ in the library included. The popovers
now detect effective-zoom changes themselves in the renderer via a
re-arming `matchMedia("(resolution: <dpr>dppx)")` change listener and
force a re-post through the resize channel.

---

## Why the popovers need a zoom trigger at all

The tray + float-over popovers post their measured **CSS-pixel** height
over IPC; main converts to **DIP** via `webContents.zoomFactor` before
`setContentSize` (see the "Tray + float-over popover sizing" section of
CLAUDE.md). When the session zoom changes (shared per-origin via
HostZoomMap — the user ⌘+'s in the library and the popovers inherit
it), main must re-run that conversion with the new factor **even when
the renderer's CSS-pixel measurement is unchanged**. Something has to
trigger the re-post.

## What we (wrongly) relied on, and why each fails

| Trigger | Why it fails |
|---|---|
| `webContents.on("zoom-changed")` in main | Mouse-wheel-only, per Electron docs ("Emitted when the user is requesting to change the zoom level using the mouse wheel") **and verified empirically on Electron 41**: never fires for `setZoomFactor`, `zoomLevel = x` (menu roles), or HostZoomMap propagation to a same-origin sibling. |
| Renderer `ResizeObserver` on the measure wrapper | Only fires when the wrapper's CSS-pixel box changes. `.ps-tray` / `.fo` have **fixed CSS widths**, so zoom doesn't reflow the content — the CSS height usually lands on the same value, modulo device-pixel quantization fractions. Whether a fraction survives `Math.ceil` decided pass/fail → the VM-speed-and-font-timing-sensitive flake. |

## The fix — renderer-side devicePixelRatio detection

Chromium exposes effective zoom to the page as
`window.devicePixelRatio` (= displayScaleFactor × pageZoomFactor). A
resolution media query fires `change` whenever it moves — for **any**
zoom source, in **every** same-origin window (verified empirically:
both `setZoomFactor` and `zoomLevel +=` fired the listener in both
windows). The query is pinned to the value it was created with, so
re-arm after every fire:

```ts
let dprQuery: MediaQueryList | null = null;
const onDprChange = (): void => {
  armDprQuery();
  post(true); // bypass the posted-height cache; main re-converts CSS→DIP
};
const armDprQuery = (): void => {
  dprQuery?.removeEventListener("change", onDprChange);
  dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  dprQuery.addEventListener("change", onDprChange);
};
armDprQuery();
```

Lives in the same `useLayoutEffect` as the measure/post machinery, in
**both** popovers (they must stay symmetrical):

- `apps/desktop/src/renderer/src/features/tray/TrayMenu.tsx`
- `apps/desktop/src/renderer/src/features/float-over/FloatOverHost.tsx`

Display-scale changes (window dragged to a monitor with a different
scale factor) also fire the listener; the forced re-post is a no-op in
main when the computed DIP height is unchanged, so that's harmless.

Removed as part of this fix: the `zoom-changed` handlers in
`main/tray.ts` + `main/float-over.ts` and the now-orphaned
`events:popover:remeasure` channel (`EVENT_CHANNELS.popoverRemeasure`).
Don't reintroduce a main-side zoom hook without checking what actually
emits it.

## How to verify (the empirical probe)

Two hidden same-origin BrowserWindows, `zoom-changed` listeners in
main, a dpr media-query listener + ResizeObserver in the page. Call
`setZoomFactor(1.5)` on window A, then `zoomLevel += 0.5`. Observed on
Electron 41.7.1 (macOS; the emission logic is platform-independent
Chromium/Electron code):

- `zoom-changed`: **never fired** (either window, either API)
- dpr media-query `change`: fired in **both** windows for **both** APIs
- ResizeObserver: reported an **unchanged** height for a fixed-size box

## E2E guard

`apps/desktop/e2e/tray-sizing.spec.ts` › "sizes correctly under non-1.0
zoom" drives `setZoomFactor` on the tray webContents (same programmatic
path as the menu roles — deliberately NOT hand-delivering a remeasure
event) and polls for the contentSize to actually grow before asserting
`ceil(cssHeight × zoomFactor)`. If the renderer trigger regresses, the
poll times out with "tray contentSize never grew after zoom" and dumps
the full inspect snapshot (`zoomFactor` still 1 → setZoomFactor never
applied; 1.5 with an unchanged height → the dpr → re-post →
setContentSize chain broke).

## Residual flake → `backgroundThrottling: false`

The first CI run with only the DPR listener (PR #318 run 29466571400)
still flaked once on windows-latest: attempt 1 timed out the 8s growth
poll, retry passed in 2.6s — and in the same job, `tray-first-paint`'s
"cold | 1 seeded capture" timed out its bridge window twice on
ordinary, zoom-free resize posts. So the runner starves renderers for
multi-second stretches, and there's a specific mechanism that makes the
DPR trigger vulnerable to it: **MediaQueryList `change` events are
delivered during Chromium's rendering-update steps**, which are
throttled or paused for backgrounded/occluded renderers. (Forcing
layout from outside via `executeJavaScript` + `getBoundingClientRect`
does NOT run the evaluate-media-queries step — the E2E's polling can't
un-stick it.)

This also matters in production: the tray is prewarmed and hidden for
most of its life, and the float-over parks pseudo-hidden. A ⌘+ in the
library while a popover is hidden could defer the dpr-change event
until (or past) the next show, leaving the first paint at a stale size.

Hardening: both popover BrowserWindows now set
`backgroundThrottling: false` in their webPreferences
(`createTrayWindow` / `createFloatOverWindow` in `main/window.ts`).
Note `themedWebPreferences()` already does this in split mode for
different reasons; the popovers need it unconditionally. The E2E
growth poll was also widened 8s → 20s with snapshot diagnostics —
the gate exists to catch "never lands", not "lands slowly".
