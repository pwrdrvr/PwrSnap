# Tray popover faded into captures — NSPanel `orderOut:` animation

*2026-09-02 — [#542](https://github.com/pwrdrvr/PwrSnap/pull/542)*

## Symptom

Captures started from a **button in the tray popover** came out with a
half-dissolved PwrSnap popover alpha-blended into the image. The exact
same capture taken with the global hotkey was clean.

Everything on the main-process side looked correct: the popover was
dismissed before the capture, `isVisible()` read `false`, and the
renderer was doing nothing unusual. That is what made it read as a
compositor or screencapture problem rather than a window animation.

## Cause

The tray popover is a macOS `NSPanel` — `type: 'panel'` in
`createTrayWindow`, which is what keeps `show()` from activating PwrSnap
(see the long comment there). AppKit resolves a panel's default
`NSWindowAnimationBehaviorDefault` to
`NSWindowAnimationBehaviorUtilityWindow`, so `[NSWindow orderOut:]` —
which is what `BrowserWindow.hide()` calls — plays a **~0.2s fade-out**
instead of clearing the window on the next frame.

Three facts have to line up for this to reach a saved file:

1. Every capture started from a tray button dismisses the popover and
   then waits a **50ms** compositor flush before freezing the screen
   (`hidePwrSnapChromeAndSettle` in `capture-handlers.ts`; the
   pre-snapshot hide in `region-selector.ts`). 50ms into a 200ms fade
   the popover is still roughly 70% opaque.
2. The region/auto path does **not** re-shoot the screen after the user
   commits — it crops the frozen snapshot (COMMIT branch of
   `capture:interactive`). Whatever was painting at freeze time is in
   the file permanently.
3. `isVisible()` cannot detect this. AppKit orders the window out when
   the fade **starts**, so the window reads hidden for the entire time
   it is still on screen.

Fact 3 is why the guard in `hideTrayPopoverIfVisible` could not have
saved us, and why every diagnostic pointed away from the window.

### Why only the tray

Every other PwrSnap panel already avoided it, for unrelated reasons:

| Surface | Dismissal | Fade? |
|---|---|---|
| Tray popover | `hide()`, window kept warm | **yes** |
| Float-over toast | `parkOffScreen()` — opacity 0 + move, never `hide()` | no |
| Region selector | `hide()` **+ `destroy()`** (`swapFreshSelectorForDisplay`) | no — destroy kills the animation |
| Recording HUD | `hide()` **+ `destroy()`** | no |

The tray is the one panel we deliberately keep resident (pre-warmed at
boot for first-click latency), so it is the one panel that is hidden
rather than destroyed.

## Fix

Electron exposes no `animationBehavior` setter, so take the window to
alpha 0 *before* ordering it out. `-[NSWindow setAlphaValue:]` applies
immediately — there is no implicit animation outside an
`NSAnimationContext` — so the fade then runs 0 → 0 and paints nothing.

`hideTrayWindowNow` / `showTrayWindowNow` in
[tray.ts](../../apps/desktop/src/main/tray.ts) are the pair. All five
dismiss paths and all three show paths route through them.

Two things about the shape of the fix:

- **All dismiss paths, not just the capture one.** A fade started by
  blur-dismiss, the tray-icon toggle or right-click is just as
  capturable — and per fact 3 above, the capture path's own
  `isVisible()` guard would skip it and let the fade paint itself in.
- **Windows is excluded.** There the tray window is `transparent: true`,
  and `setOpacity` drives whole-window layered alpha
  (`SetLayeredWindowAttributes`), mutually exclusive with the per-pixel
  alpha (`UpdateLayeredWindow`) a transparent window composites through
  — the trap already documented on `parkOffScreen` in `float-over.ts`,
  where an opacity round-trip left the toast blank. Windows has no
  NSPanel fade to fix.

## The new footgun this creates

`hideTrayWindowNow` leaves the panel at alphaValue 0. **A show path that
does not call `showTrayWindowNow` brings the popover back invisible** —
ordered in, key, hit-testing, painting nothing. That is worse than the
original bug and much harder to diagnose.

Behavioral tests cannot catch it (it only fires on a show path that does
not exist yet), so `tray-instant-hide.test.ts` grep-asserts `tray.ts`
for stray `.show()` / `.showInactive()` calls outside the helper.

## Known limitation

The same animation fades the popover **in**, and we cannot suppress that
without hiding what we are trying to show. It only matters for `timed`
mode, which snapshots with `keepPwrSnapChrome` (no hide, no compositor
flush) — a tray re-opened in the last ~200ms of the countdown is frozen
mid-fade-in. Fixing it means holding the snapshot until the fade
settles, which trades a rare artifact for latency on every timed
capture. Not worth it until someone hits it.

## Pinned by

- [tray-instant-hide.test.ts](../../apps/desktop/src/main/__tests__/tray-instant-hide.test.ts)
  — every dismiss path, both platforms, plus the source grep above.
- [tray-instant-dismiss.spec.ts](../../apps/desktop/e2e/tray-instant-dismiss.spec.ts)
  — reads `getOpacity()` off the live AppKit panel; the only observable
  that separates "gone" from "still fading".
- [region-selector-window-flags.test.ts](../../apps/desktop/src/main/__tests__/region-selector-window-flags.test.ts)
  — the other half: chrome leaves the frame, with a measured flush,
  before `captureAndRegister` freezes the screen.
