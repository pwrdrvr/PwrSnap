# E2E: a hung test leaks the Electron app → worker-teardown timeout fails the job

**Date:** 2026-08-02
**Spec:** `dock-lifecycle.spec.ts` ("forceReclaimDockIcon is a no-op when
the Library doesn't exist"), macOS VM lane
**Seen live:** PR #353 first attempt —
<https://github.com/pwrdrvr/PwrSnap/actions/runs/30775613634/job/91570487559>

## Symptom

The spec intermittently hangs to the 30s test timeout on the
"macOS Desktop E2E (self-hosted VM)" lane. The retry passes in ~1.5s, so
Playwright marks it flaky — but the run STILL exits 1 with:

```text
Worker teardown timeout of 30000ms exceeded.
…
1 flaky
127 passed
1 error was not a part of any test, see above for details
```

That last line is what fails the job: `pnpm test:e2e` exits 1 even
though zero tests failed.

## The causal chain (three links, each necessary)

1. **A test-body await hangs.** The failing attempt left no trace
   (trace is `on-first-retry`), but the suspect step is unique to this
   test: it closed windows matched by the NEGATIVE filter
   `!url.includes("stage=")` and awaited each one's `closed` event.
   That filter matches more than the Library: the focus-sink loads
   `data:text/html,` (no `stage=`), and any pre-warm window still
   mid-load reports an EMPTY url until its navigation commits — the
   same trap already documented in the fixture's `windowSize` comment.
   So the test was closing windows it didn't own and parking on
   `closed` events for close behavior it doesn't control, with no
   bound. (`win.close()` also round-trips the renderer's unload
   handling, which a loaded VM can stall; `win.destroy()` doesn't.)

2. **Test timeout ABANDONS the body — `finally` never runs.** When
   Playwright times a test out, it stops awaiting the test function;
   the async body stays parked on the hung await forever. The
   `try { … } finally { await app.close() }` pattern inside the test
   body provides NO cleanup guarantee on timeout. The Electron app
   leaks.

3. **The leaked app never exits, so worker teardown hangs.** PwrSnap
   deliberately stays resident after its windows close (tray /
   menubar-app lifecycle — `window-all-closed` does not quit). At
   worker teardown Playwright gracefully closes leftover apps and
   waits for process exit… which never comes. 30s later:
   "Worker teardown timeout" + "1 error was not a part of any test" →
   job-level failure. Note this link needs no wedged main process — a
   perfectly healthy leaked PwrSnap app hangs the graceful close,
   because staying alive is its designed behavior.

## Fixes (all three links)

- **Spec** (`dock-lifecycle.spec.ts`): close ONLY the Library via the
  positive match `url.includes("/renderer/index.html") &&
  !url.includes("stage=")` (the same discrimination
  `waitForLibraryWindow` uses); bound the `closed` wait with a 3s
  `destroy()` fallback and a 15s outer bound; bound every
  main-process evaluate (10s) so a wedge fails the test fast enough
  for its `finally` to still run.

- **Fixture** (`e2e/fixtures/electron-app.ts`): every launched app is
  tracked in a module-level registry until its `close()` runs, and the
  fixture exports an **extended `test`** whose auto fixture teardown —
  which Playwright runs even after a test timeout, unlike the abandoned
  test body — force-closes anything still registered (graceful-exit
  evaluate → close → SIGKILL ladder, ~11s worst case). POSIX force-kill
  nukes the whole process group (Playwright spawns Electron detached).

- **Rule: specs import `test`/`expect` from
  `./fixtures/electron-app`, never from `@playwright/test`.** A spec
  on the base `test` silently opts out of the guard. Enforced by
  `src/main/__tests__/e2e-spec-test-imports.test.ts` (type-only
  imports of `Page`/`Locator`/etc. remain fine; namespace and default
  runtime imports of the module are rejected too, since `pw.test`
  would smuggle the base object past a named-import check).

Known trade-off: the guard tears down before Playwright's built-in
artifact fixtures, so a reaped app's screenshot/video for that failing
test may be lost. For a wedged app those captures would have hung
anyway — losing them is the cheap half of the trade.

## Reusable diagnosis notes

- "N passed / 1 flaky, yet exit 1" + "error was not a part of any
  test" ⇒ look for worker-teardown noise, not a failing test.
- In the CI log, the worker-teardown timeout line lands ~30s AFTER the
  flaky test's own 30s timeout line — two stacked 30s waits are the
  signature of this leak chain.
- `trace: "on-first-retry"` means the hung FIRST attempt has no trace;
  the report's trace zip is the passing retry. Don't burn time looking
  for the hang in it.
- General lesson: in Playwright, cleanup that must survive a test
  timeout belongs in a fixture teardown (or the harness), never in a
  `finally` inside the test body.
