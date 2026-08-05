# Windows headed E2E: native size readbacks are not renderer readiness

**Date:** 2026-08-04
**Affected specs:** `library-day-header-overlap.spec.ts`,
`tray-first-paint.spec.ts`, `float-over-visibility.spec.ts`, and
`target-windows.spec.ts`

## Symptoms

A headed Windows E2E run exposed four recurring failure shapes:

- Seven library layout tests requested a 1440×900 renderer viewport but
  repeatedly observed 1439×901.
- A prewarmed empty tray path reported the 440 px constructor height after
  renderer resize IPC.
- Float-over visibility returned no matching window on its first attempt.
- `target-windows.spec.ts` timed out once and passed on retry.

The controller and process teardown were otherwise healthy, with no leaked
Electron, Node, or PwrSnap process.

## Root causes and fixes

### 1. Windows native sizing can round frame and content differently

Under some scaled Windows display configurations, Electron can accept
`setContentSize(1440, 900)` and expose a 1439×901 Chromium viewport. This is
not harmless for the layout suite: those tests need an exact renderer size so
day-header collision coverage stays deterministic.

The launch fixture still requires exact 1440×900. When the renderer is within
two pixels, it feeds the measured error back into the next native request
(for example, observed 1439×901 becomes request 1441×899). Repeated native
requests also receive a one-pixel nudge so Electron cannot coalesce them while
the renderer surface is stale. This compensates the input; it does **not** add
a tolerance to the asserted renderer viewport.

### 2. `BrowserWindow.getContentSize()` is neither paint truth nor readiness

Two opposite readback failures were captured:

- Main could still report 440 while the empty tray renderer was already
  302 px tall.
- Main could report the requested 688 while the seeded tray renderer was
  still at its previous 302 px viewport.

The tray resize channel records the latest renderer request separately from
Electron's native readback. The E2E bridge reports all three values: renderer
`innerHeight`, requested height, and main readback. Its readiness contract is
stronger: after the expected request arrives, the bridge waits for renderer
`innerHeight` to acknowledge the original CSS-height request within the
existing deadline. The strict 302/688 layout bands and explicit
440-constructor-frame regression assertion remain unchanged.

This was an observable asynchronous Windows resize, not a reason to increase a
timeout. In repeated focused coverage, launches that resized after show needed
another 44–188 ms after the first resize IPC before Chromium applied the
viewport. The old bridge sampled inside that interval.

### 3. A cold float-over window cannot be identified by URL

The float-over exists and can already be natively visible before its renderer
navigation commits, so an empty `webContents.getURL()` made the URL-hash lookup
return “no window.” Main exposes the singleton BrowserWindow id through the
E2E-only bridge, with unit coverage for create/dispose/recreate identity.

A subsequent trace found a second false negative: the opacity poll located the
native window but then awaited renderer `executeJavaScript()` for DOM
telemetry. On a cold renderer that call took about one second, starving the
strict 800 ms opacity poll of every sample. Native lifecycle inspection
(exists, visible, opacity, bounds) is separate from opt-in renderer layout
telemetry. The 800 ms assertion was not raised.

### 4. The target-window flake was already fixed on current main

The original failing run predated the transient-window quit fix in `0b366b8`
(#370). Current main schedules quit before Playwright context cleanup and
destroys transient windows during quit. Repeated focused coverage and the
subsequent full suite passed, so no additional target-window change was
needed.

## Validation

All test runs used clean, committed revisions through an operator-provided
off-desktop Windows environment. Repository documentation intentionally does
not encode that environment's paths or configuration.

- Focused current-main baseline, retries off: 5 passed and 3 failed. Library
  failed 2/2 at width 1439 and tray reproduced the readiness symptom.
- Four affected paths repeated five times, retries off: 19 passed and 1
  failed. Library 5/5, target 5/5, and 25/25 tray launches passed; one float
  opacity poll received no sample.
- Float visibility repeated ten times, retries off: 10/10 passed.
- Prewarmed seeded tray repeated across 15 launches, retries off: 15/15
  passed; every renderer/request/readback row was 688/688/688 with zero
  timeouts.
- Final full headed Windows suite: **97 passed, 0 failed, 0 flaky, 40
  skipped**, with zero retries.

Local validation also passed repository lint/typecheck/license policy/color
checks, a production Electron build, and the full unit suite (300 files;
3,479 passed, 5 skipped).

## Remaining observation

Two app launches in the final full suite exceeded the graceful-close budget
and exercised the existing force-kill fallback. The runner completed
successfully and left no process leak. These warnings remain useful teardown
telemetry but are not the earlier leaked-worker failure mode.
