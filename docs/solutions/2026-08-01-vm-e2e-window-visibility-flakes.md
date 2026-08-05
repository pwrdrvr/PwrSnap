# macOS VM E2E flakes: `visible === false` on freshly-shown windows

**Date:** 2026-08-01
**Specs:** `dock-lifecycle.spec.ts` (tests 1–2), `tray-sizing.spec.ts:196`
**Fixed in:** the commit carrying this doc (spec-side preconditions; no
product change was needed).

## Symptom

Running the full desktop E2E suite inside an operator-provided macOS VM,
`dock-lifecycle.spec.ts` failed with
`afterStrip.visible === false` — i.e. after `app.dock.hide()` the
Library window reported not-visible to the OS. The same suite passed
when the spec ran alone or in small pairings. `tray-sizing.spec.ts`
("sizes to natural content height") also flaked with
`info.visible === false`.

Failures clustered on **cold** VM states (fresh provision, first runs
after boot, first runs after unrelated churn) and vanished as the VM
warmed — by the end of the investigation the failure was no longer
reproducible even on a cold-booted VM with the exact original recipe.
Treat "passes now" as survivorship, not proof: the mechanism below is
real and was directly observed.

## Root cause 1 — dock-lifecycle: asserting a visibility that was never established

The Library is created `show: false` and shown by
`showWindowWhenReady` (`ready-to-show`, with a 1000ms hard fallback).
The Playwright fixture's launch wait only covers the renderer's
`domcontentloaded` — **not** the window's first `show()`. Instrumented
runs in the VM (main-process event recorder + 25ms visibility sampler)
showed the first show routinely lands 30–100ms *after* the fixture
returns even on a warm VM; on a cold one it can lag past every
round-trip the spec makes before reading `visible`.

The spec asserted `visible === true` after `dock.hide()` without ever
establishing visibility beforehand (`beforeStrip` only checked
`exists`). On a slow launch the read simply preceded the first show:
`{exists: true, visible: false}` — exactly the recorded failure shape.

Two things the instrumentation ruled out:

- **No shown→hidden transition, ever** (≈60 instrumented runs,
  including cold boots and CPU-load runs). The window was never
  ordered out by the strip; it just hadn't been shown yet.
- **`dock.hide()` does not eat a pending show.** Electron's `DockHide`
  sets `setCanHide:NO` on every window in its window list before
  `TransformProcessType(kProcessTransformToUIElementApplication)`, and
  a pending `orderFront` still lands after the policy flip. Probes
  that deliberately hid the dock *before* the initial show passed
  8/8 under CPU load.

Also relevant context: with `PWRSNAP_E2E=1`, main hides the dock at
`whenReady` (index.ts), so the spec's `dockHide()` is a near-no-op
policy transform and `expectDockVisible(false)` passes instantly —
which *shrinks* the elapsed time before the `visible` read and widens
this race, compared to what the timings suggest on a dev machine.

**Fix:** `expectLibraryVisible()` — poll `getLibraryState().visible`
(10s ceiling; converges ≤1s via the `showWindowWhenReady` hard
fallback) as an explicit precondition before stripping the dock, in
both tests that later assert `visible`. The post-strip assertions stay
single-read on purpose: once visible, the Library must REMAIN visible
through strip/reclaim — polling those would weaken the contract. A new
test additionally pins the racy ordering itself (hide issued before
the initial show; the show must still land).

## Root cause 2 — tray-sizing: blur-dismiss vs ambient activation churn

The tray popover auto-hides on `blur` after a 120ms debounce
(`wireBlurDismiss` in tray.ts) — production behavior (click-outside
dismiss). In the VM, teardown of the *previous* spec's Electron app
produces ambient key-window/activation churn (the recorder captured
`did-resign-active` / `did-become-active` pairs mid-test with no test
action); a churn-blur landing right after `showInactive()` +
`focus()` dismisses the popover before the spec reads it.

**Fix:** the spec's `showTray()` helper re-shows (max 4 attempts),
waiting out the debounce each time, until visibility sticks. Dismissal
is not the spec's subject — sizing is.

## Diagnosis technique (reusable)

Main-process event recorder installed via `electronApp.evaluate`:
wire `hide/show/blur/focus` on every `BrowserWindow` plus
`did-resign-active`/`did-become-active`/`browser-window-*` on `app`,
and a 25ms sampler that logs *state transitions* of
`{perWindow isVisible/isFocused, dock.isVisible}`. Dump the event list
just before the failing assertion. This is what discriminated
"never shown yet" from "shown then hidden" — the single distinction
that decides spec-fix vs product-fix here. Pattern lives in the git
history of this branch (`test(desktop): TEMP instrument dock-lifecycle
with main-process event recorder`).

Repro notes for the future: the trigger is a *cold* system (first
Electron launches after VM provision/boot — cold FS caches, cold
WindowServer session), not CPU load per se — 8×`yes` hogs alone did
not reproduce; neither did display idle, nor pasteboard contents left
by clipboard-copy. Tight same-pair rerun loops "warm" the VM within
1–2 iterations and stop failing, so hunt flakes on freshly rebooted or
freshly cloned VMs, and expect the first run after `provision-dev.sh`
to be the most fertile.
