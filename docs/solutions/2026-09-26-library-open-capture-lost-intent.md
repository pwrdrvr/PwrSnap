# `editor:open` lost its intent: `isLoading()` outlives `did-finish-load`

**Symptom.** `apps/desktop/e2e/editor-v2-capture-open.spec.ts` failed its
first attempt about 1 run in 20 in the Linux Docker E2E harness, on
Electron 41 and 44 alike. Either test in the file could fail:
`locator.waitFor` timed out after 15s waiting for `.psl__focus`, right
after `editor:open` had returned `ok`. The retry passed in well under a
second. Every spec that opens the editor through `editor:open` straight
after launch was exposed, and so was a real user whose Edit click reached
the Library while it was still loading: the window came forward on the
grid and the capture never opened.

## The hypothesis that was real but was not the failure

`sendOpenCaptureWhenReady` (library-handlers.ts) sent the
`libraryOpenCapture` event, and the Library subscribes to it in a React
`useEffect`. The obvious suspect was an event that arrives before that
effect has run, and it does happen. With a raw listener installed at
module evaluation, instrumented runs showed the event reaching the
renderer at t=130ms while the Library subscribed at t=134ms. The React
subscriber never saw it. Main's second send, 100ms later, is what opened
Focus.

That resend covered this race in every sampled run. It was not what
failed.

## What actually happened

Three captured failures, times in renderer ms from `timeOrigin`:

| | failure 1 | failure 2 | failure 3 |
|---|---|---|---|
| test dispatches `editor:open` | 88 | 92 | 97 |
| main enters `sendOpenCaptureWhenReady` | 91 | 98 | 101 |
| `webContents.isLoading()` there | **true** | **true** | **true** |
| Library subscribes | 127 | 131 | 137 |
| main sends the event | **never** | **never** | **never** |

`isLoading()` was true, so main took the "still loading" branch and waited
on `once("did-finish-load")`. `isLoading()` does not turn false at
`did-finish-load`. It turns false at `did-stop-loading`, which comes
later. Measured with markers on the Library's webContents over 231 loads:

- `isLoading()` read inside the `did-finish-load` handler: **true, 231 of
  231**.
- `did-finish-load` → `did-stop-loading`: 0–7ms, median 0.

A request that lands in that window sees a window still loading and waits
for an event that has already fired. Nothing is sent, and no timeout
exists to notice. The spec dispatches right after `domcontentloaded`,
which is next to `load`, so it hit this window about once in 40 opens.
The fix run caught one in the act: `did-finish-load` at 196,
`editor:open` at 202 with `isLoading() === true`, `did-stop-loading` at
203. The old code would have waited forever there.

The rescue that covered the first race could not cover this one: the
100ms resend lived only on the "already loaded" branch.

## The fix

1. **Pair the state check with the event that ends that state.** Main
   now waits on `did-stop-loading` whenever `isLoading()` is true (and for
   a just-created window).
2. **Latch the intent in the preload.** The preload is the only renderer
   code guaranteed to run before the page. `createEventSubscriber`
   ([latched-events.ts](../../apps/desktop/src/preload/latched-events.ts))
   installs the `libraryOpenCapture` listener at preload evaluation. It
   holds the latest payload that arrives while nothing is subscribed, and
   hands it to the first subscriber when it subscribes.
3. **Send exactly once.** The 100ms grace after load and the 100ms resend
   were both guesses at React's mount time. With the latch they can only
   deliver the intent twice, so both are gone.

Removing the resend is what makes the latch load-bearing. In two
60-iteration runs of the fixed build, 59 and 51 of 120 opens were sent
before the Library had subscribed, and each arrived when it did.

## Results

All runs use `scripts/e2e/run-docker.sh --test 'editor-v2-capture-open'`,
retries off, 2 opens per iteration.

| build | iterations | result |
|---|---|---|
| origin/main | 20 | 19/20 |
| origin/main + probe | 60 | 57/60 — all 3 failures are the table above |
| fix + probe | 60 | 60/60 — 0 gap hits, 59/120 latched |
| fix + probe (load markers) | 60 | 60/60 — 1 gap hit, 51/120 latched |
| fix, no probe | 40 | 40/40 |

## A probe that hides the bug

The first probe read renderer state (navigation timing, a diagnostic
array) with `page.evaluate` BEFORE dispatching. It ran 30/30. The evaluate
queues behind the renderer's first render, so the test could no longer
dispatch before the Library was up. Anything that touches the renderer
before the dispatch changes the timing under test. Read renderer state
after the dispatch, and timestamp main-side events with `Date.now()`.
Align the two clocks with `performance.timeOrigin`.

## Checked and not affected

- `float-over.ts` checks `isLoadingMainFrame()` and waits on
  `did-finish-load`, but only in `getOrCreate()`, right after
  `loadFile` starts. A just-started load cannot be in the finish → stop
  window.
- `tray.ts` uses the same pairing for a perf mark in an E2E-only path.
  The mark can be late or missing, and nothing waits on it.
