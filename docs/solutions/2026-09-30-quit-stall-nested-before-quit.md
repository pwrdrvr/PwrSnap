# ⌘Q stalls after a nested before-quit pass

**Status:** fixed. AGENTS.md §"A deferred quit is retried from a macrotask, never
from its own promise chain" states the rule; this note records how it was found.

## Symptom

⌘Q hung intermittently. The app stayed alive with no windows until it was
force-quit. `installQuitDiagnostics` logged the same pattern every time:

```
(pwrsnap:quit) quit requested windows=[region selector, library, focus-sink "data:", tray]
(pwrsnap:quit) quit requested windows=[library]          <- ~10 ms later
(pwrsnap:window) main window close event id=3
(pwrsnap:window) main window closed id=3
(pwrsnap:quit) quit stalled: no will-quit since the last before-quit waitedMs=5000 baseWindows=[] webContents=[]
```

It came from the installed release and from two unrelated worktrees in one
evening, so it was on `main`. Some quits with the identical double pass
completed, with `will-quit` about 15 ms after the second pass.

## The wrong lead

The stall-report comment in `index.ts` assumed Electron "still counted"
something that had not finished closing. The report itself ruled that out.
Zero BaseWindows and zero webContents means the native window list was
empty, and Electron calls `NotifyAndShutdown` (→ `will-quit`) on an empty list
only when `is_quitting_` is true. So the question was what cleared
`is_quitting_`.

## Cause

Electron 41.10.7, `shell/browser/browser.cc`:

```cpp
void Browser::Quit() {
  if (is_quitting_) return;
  is_quitting_ = HandleBeforeQuit();      // emits before-quit
  ...
}
void Browser::OnWindowAllClosed() {
  if (is_exiting_) Shutdown();
  else if (is_quitting_) NotifyAndShutdown();
  else observers_.Notify(&BrowserObserver::OnWindowAllClosed);   // window-all-closed
}
void Browser::NotifyAndShutdown() {
  ... emits will-quit ...
  if (prevent_default) { is_quitting_ = false; return; }
  Shutdown();
}
```

`gin_helper::CallMethodWithArgs` wraps every emit in a `node::CallbackScope`.
When that is the outermost scope, meaning the emit started from a native task,
closing it runs a microtask checkpoint. That checkpoint is still inside
`HandleBeforeQuit()` and before the assignment.

#659's `createDiagnosticsShutdown` deferred every first quit and resumed with
`flush().then(() => app.quit())`. With no profiler or trace recording,
`stop()` does no I/O, so the whole chain settled in that checkpoint:

1. ⌘Q → `terminate:` → `Browser::Quit()` → before-quit #1, prevented.
2. The checkpoint runs the resume: a nested `app.quit()` → before-quit #2.
   Transient teardown runs, `is_quitting_ = true`, and the Library starts
   closing.
3. The outer `Browser::Quit()` resumes and writes `is_quitting_ = false`.
4. The Library finishes closing on a later task. The window list is empty
   and `is_quitting_` is false, so Electron emits `window-all-closed`. PwrSnap
   ignores that event in the combined role. Nothing is left to ask again.

The intermittency comes from how the quit starts. ⌘Q, Dock → Quit and SIGTERM
start natively. The tray menu's Quit and E2E teardown call `app.quit()` from
JS, and there the checkpoint waits for that JS to return.

A second instance had the same shape: the will-quit recording barrier's
`.finally(() => app.quit())`. `will-quit` is emitted when the last window
finishes closing, which is always a native task. A nested `Browser::Quit()`
there sees `is_quitting_` still true and returns, and then
`NotifyAndShutdown` clears it. That stall emits no event at all.

## Measured

`pnpm --filter @pwrsnap/desktop probe:quit-reentry`
([electron-quit-reentry-probe.mjs](../../apps/desktop/scripts/electron-quit-reentry-probe.mjs))
runs each case in a hidden-window, accessory-policy child. "Native" is a
SIGTERM, which Electron posts as `Browser::Quit`. On 41.10.7, macOS 26.6:

```
ok   before-quit retry=microtask      start=native model=stall electron=stall  [before-quit, before-quit, closed, window-all-closed]
ok   before-quit retry=microtask      start=js     model=quit  electron=quit  [before-quit, before-quit, closed, will-quit, quit]
ok   before-quit retry=after-dispatch start=native model=quit  electron=quit  [before-quit, before-quit, closed, will-quit, quit]
ok   before-quit retry=after-dispatch start=js     model=quit  electron=quit  [before-quit, before-quit, closed, will-quit, quit]
ok   will-quit   retry=microtask      start=native model=stall electron=stall  [before-quit, closed, will-quit]
ok   will-quit   retry=microtask      start=js     model=stall electron=stall  [before-quit, closed, will-quit]
ok   will-quit   retry=after-dispatch start=native model=quit  electron=quit  [before-quit, closed, will-quit, before-quit, will-quit, quit]
ok   will-quit   retry=after-dispatch start=js     model=quit  electron=quit  [before-quit, closed, will-quit, before-quit, will-quit, quit]
model matches Electron
```

The first row is the field log, event for event. A `beforeunload` listener
in the page, which the editor installs, made no difference.

## Fix

- `retryQuitAfterDispatch` ([quit-retry.ts](../../apps/desktop/src/main/quit-retry.ts))
  re-issues a deferred quit from `setImmediate`. A macrotask cannot run until
  the outer pass has returned. Both retries use it.
- `createDiagnosticsShutdown` takes `hasPendingWork`. With no hot-CPU
  monitor and no armed trace hook it does not defer, so the common quit is
  one pass. `stop()` still runs, to latch the targets' shutdown flags.
- `installQuitStallRecovery` ([quit-stall-recovery.ts](../../apps/desktop/src/main/quit-stall-recovery.ts))
  is armed by a before-quit pass that nothing deferred:
  - it re-asks once on `window-all-closed`;
  - it exits if no `quit` arrives within 20 s and no window remains.

  It is a backstop; the two fixes above are what make the quit complete.

## Testing it

`quit-reentry.test.ts` drives the real `createDiagnosticsShutdown` through
`ElectronQuitModel`, which reproduces the checkpoint timing. Against the
pre-fix module it fails with `window-all-closed` in place of `will-quit`. No
E2E can reach this: Playwright can only quit from JS, and the JS path never
nests. Re-run the probe after an Electron major bump; if a row reads `DIFF`,
update the model before trusting the unit test.
