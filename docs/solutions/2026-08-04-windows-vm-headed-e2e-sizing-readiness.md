# Windows VM headed E2E: native size readbacks are not renderer readiness

**Date:** 2026-08-04  
**Environment:** VMware Fusion, Windows 11, 2560×1600 guest display at 200% scale  
**Affected specs:** `library-day-header-overlap.spec.ts`,
`tray-first-paint.spec.ts`, `float-over-visibility.spec.ts`, and
`target-windows.spec.ts`

## Baseline

The copied full-suite run
`pwrsnap-full-e2e-20260804-160104` (commit `d4bab6e`) finished with
87 passed, 8 failed, 2 flaky, and 40 skipped:

- Seven library layout tests requested a 1440×900 renderer viewport but
  repeatedly observed 1439×901.
- The prewarmed empty tray path reported the 440 px constructor height after
  renderer resize IPC.
- Float-over visibility returned no matching window on its first attempt.
- `target-windows.spec.ts` timed out once and passed on retry.

The process and controller logs were otherwise healthy, with no leaked
Electron, Node, or PwrSnap process. Full artifacts:

`/Users/huntharo/.pwragent/profiles/default/projects/2026-08-03-18f0d1/artifacts/pwrsnap-full-e2e-20260804-160104`

## Root causes and fixes

### 1. VMware/Windows native sizing rounds frame and content differently

On the scaled VMware display, Electron could accept
`setContentSize(1440, 900)` and expose a 1439×901 Chromium viewport. This is
not harmless for the layout suite: those tests need an exact renderer size so
day-header collision coverage stays deterministic.

The launch fixture still requires exact 1440×900. When the renderer is within
two pixels, it now feeds the measured error back into the next native request
(for example, observed 1439×901 becomes request 1441×899). Repeated native
requests also receive a one-pixel nudge so Electron cannot coalesce them while
the renderer surface is stale. This compensates the input; it does **not** add
a tolerance to the asserted renderer viewport.

### 2. `BrowserWindow.getContentSize()` is neither paint truth nor readiness

Two opposite readback failures were captured:

- Main could still report 440 while the empty tray renderer and screenshot
  were already 302 px tall.
- Main could report the requested 688 while the seeded tray renderer was
  still at its previous 302 px viewport.

The tray resize channel now records the latest renderer request separately
from Electron's native readback. The E2E bridge reports all three values:
renderer `innerHeight`, requested height, and main readback. Its readiness
contract is now stronger: after the expected request arrives, the bridge waits
for renderer `innerHeight` to acknowledge the original CSS-height request
within the existing deadline. The strict 302/688 layout bands and explicit
440-constructor-frame regression assertion remain unchanged.

This was an observable asynchronous Windows resize, not a reason to increase a
timeout. In run `pwrsnap-e2e-20260804-182805-1e1f387a`, the nine launches that
resized after show needed another 44–188 ms after the first resize IPC before
Chromium applied the viewport. The old bridge sampled inside that interval.

### 3. A cold float-over window cannot be identified by URL

The float-over exists and can already be natively visible before its renderer
navigation commits, so an empty `webContents.getURL()` made the URL-hash lookup
return “no window.” Main now exposes the singleton BrowserWindow id through the
E2E-only bridge, with unit coverage for create/dispose/recreate identity.

The next diagnostic trace found a second false negative: the opacity poll
located the native window but then awaited renderer `executeJavaScript()` for
DOM telemetry. On a cold Windows renderer that single call took about one
second, starving the strict 800 ms opacity poll of every sample. Native
lifecycle inspection (exists, visible, opacity, bounds) is now separate from
opt-in renderer layout telemetry. The 800 ms assertion was not raised.

### 4. The target-window flake was from an older commit

The original full run used `d4bab6e`, before the transient-window quit fix in
`0b366b8` (#370). Current `origin/main` already schedules quit before
Playwright context cleanup and destroys transient windows during quit. The
target close test passed 5/5 in the focused run and both target tests passed in
each subsequent full suite, so no additional target-window change was needed.

## Windows validation record

All VM commands used committed, clean HEADs through the unattended lab. No
guest checkout, controller, VM setting, or lab script was modified manually.

| Run | Commit | Scope and result |
|---|---|---|
| `pwrsnap-e2e-20260804-174659-42b5a7f5` | `42b5a7f` | Focused origin/main baseline, retries off: 5 passed, 3 failed. Library failed 2/2 at width 1439; tray reproduced the constructor/readiness symptom. |
| `pwrsnap-e2e-20260804-175437-7d35b914` | `7d35b91` | Four affected paths ×5, retries off: 19 passed, 1 failed. Library 5/5, target 5/5, and 25/25 tray launches passed; one float opacity poll received no sample. |
| `pwrsnap-e2e-20260804-180546-1ed8c4e5` | `1ed8c4e` | Float visibility ×10, retries off: 10/10 passed, no teardown warning. |
| `pwrsnap-e2e-20260804-181427-1ed8c4e5` | `1ed8c4e` | Full suite: 96 passed, 1 failed, 40 skipped. The sole prewarmed seeded tray failure reproduced on retry with renderer/request/readback `302/688/688`, proving the optimistic-readback race. |
| `pwrsnap-e2e-20260804-182805-1e1f387a` | `1e1f387` | Prewarmed seeded tray ×3 specs ×5 launches, retries off: 3/3 specs and 15/15 launches passed; every row was `688/688/688`, zero timeouts. |
| `pwrsnap-e2e-20260804-183127-1e1f387a` | `1e1f387` | Final full suite: **97 passed, 0 failed, 0 flaky, 40 skipped**, zero retries, 7.2 min Playwright time. |

The final full run passed all seven library day-header specs, all four
float-over visibility specs, both target-window specs, and every tray scenario.
Tray `resizeApplied` summaries were:

| Scenario | min / p50 / mean / max | Applied height |
|---|---:|---:|
| cold, empty | 449 / 494 / 516 / 624 ms | 302 |
| cold, seeded | 569 / 671 / 713 / 991 ms | 688 |
| prewarmed, empty | 13 / 18 / 26 / 64 ms | 302 |
| prewarmed, seeded | 13 / 14 / 25 / 66 ms | 688 |

Final artifacts:

`/Users/huntharo/.pwragent/profiles/default/projects/2026-08-03-18f0d1/artifacts/pwrsnap-e2e-20260804-183127-1e1f387a`

Local validation also passed repository lint/typecheck/license policy/color
checks, a production Electron build, and the full unit suite (300 files;
3,479 passed, 5 skipped).

## Remaining observations

There are no remaining Playwright failures or flaky retries in the final run.
Two app launches exceeded the graceful-close budget and exercised the existing
force-kill fallback (PIDs 6140 and 4100). The controller completed with exit 0,
released its lock, and left no process leak. These warnings remain useful
teardown telemetry but are not the earlier leaked-worker failure mode.

The lab controller currently expands an empty `PLAYWRIGHT_ARGS` array under
`set -u`; invoking it with no Playwright arguments exits before allocating a
run id. Full-suite runs used the non-semantic `--trace retain-on-failure`
argument to keep the array nonempty without changing test selection or
assertions. The lab controller was intentionally left out of scope and
unchanged.
