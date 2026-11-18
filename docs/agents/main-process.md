# Agent rules: Main-process navigation, quit and renderer intents

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## No webContents opens a window, and none navigates away

**Every webContents PwrSnap creates is covered by a `setWindowOpenHandler`
that denies, and a `will-navigate` handler that refuses any target which is
not PwrSnap's own content. A URL leaves the app only by clearing
`isAllowedExternalUrl`, and only into the user's browser. The sole configurable
exception is an OAuth authorization URL generated in main from a saved custom
model's validated metadata; it goes directly to the system browser, never to a
PwrSnap webContents. Do not broaden the generic allowlist for OAuth.** Owner:
[navigation-guard.ts](../../apps/desktop/src/main/navigation-guard.ts), armed from
`app.whenReady()` in [index.ts](../../apps/desktop/src/main/index.ts) beside
`installMediaPermissionPolicy()`. Pinned by
[navigation-guard.test.ts](../../apps/desktop/src/main/__tests__/navigation-guard.test.ts).

Electron's default for both hooks is "yes", and the default `window.open`
creates a new `BrowserWindow` carrying the SAME webPreferences — our preload
and its IPC bridge — pointed at content we did not choose. `contextIsolation`
+ `sandbox` + `nodeIntegration: false` do not help here: they harden the
renderer that lands, they do not decide what lands.

**The reachable path was a modifier key.** Settings → About renders three real
`<a href="https://…">` rows. Each `onClick` calls `preventDefault()` and routes
through `app:openExternal`, which is correct for a plain left-click and **is
not consulted for a middle-click or a cmd/ctrl-click** — Chromium turns those
into a window-open. So the one surface that deliberately routes links through
an allowlist could be made to bypass it without exploiting anything.

Five things that bite:

- **`URL.origin` is the STRING `"null"` for every opaque scheme** — `file:`,
  `data:`, and anything non-special all report it, so two unrelated opaque
  URLs compare EQUAL. That is why `file:` is decided in its own branch and
  returns there unconditionally (a `file://host/…` whose `fileURLToPath`
  throws must be refused, not handed to an origin test), and why the
  dev-server branch requires an http/https target before comparing. Before
  that, an `ELECTRON_RENDERER_URL` with an opaque origin would have made
  every `data:` URL a permitted navigation target.
- **The allowlist lives in exactly one module.**
  [external-url-allowlist.ts](../../apps/desktop/src/main/external-url-allowlist.ts)
  holds `isAllowedExternalUrl`; `app:openExternal` and the guard both import
  it. It is not an export of `app-handlers.ts` because the guard would then
  pull the command bus, the window factory and electron-updater into a file
  whose job is one string predicate — and into every test of it. Two copies of
  a security predicate drift; that is the whole point of the module.
- **The navigation predicate is deliberately stricter than
  `isTrustedRendererUrl`** in `media-permissions.ts`, which answers a different
  question ("did this request come from a page we loaded?") and accepts ANY
  `file:` URL and ANY loopback port. Those are fine for classifying a request
  already made and too loose for a navigation TARGET, where any `file:` would
  let a renderer pull an arbitrary local HTML file — a downloaded one — into a
  window that still has our preload. Do not unify them; it can only loosen
  this one.
- **The dev-server origin must stay allowed or `pnpm dev` breaks.** The
  renderer is served from `http://localhost:<port>` there, not `file://`, and
  Vite's HMR full-reload is a renderer-initiated navigation. It is
  origin-compared against `ELECTRON_RENDERER_URL` and gated on
  `!app.isPackaged`, so a stray env var cannot open a path in a shipped build.
  A self-navigation (reload) of the page already loaded is allowed for the same
  class of reason: the renderer error boundary's Reload button is the recovery
  path when everything else has failed.
- **`will-frame-navigate` takes subframes ONLY.** It is a superset of
  `will-navigate` — both fire for the main frame — so acting on both would hand
  an allowlisted URL to the browser twice. PwrSnap renders no iframes today,
  which is exactly why the arm exists: one that appears later inherits the
  policy instead of silently escaping it.

Two smaller rules, both learned the hard way. **`installNavigationGuard` is
idempotent** because it APPENDS an emitter listener rather than replacing a
session handler the way `installMediaPermissionPolicy` does — installing twice
would give every webContents two `will-navigate` listeners, and one click on
an allowlisted link would open two browser tabs. And **a refused URL is logged
as origin + path only**: it is renderer-supplied, can carry a secret in its
query, and the main log goes to disk and rides along in bug reports.

**Tests here must build file URLs with `pathToFileURL`, never by
concatenating `file://` onto a POSIX path.** `file:///Applications/…` is not a
valid file URL on Windows — `fileURLToPath` throws with no drive letter — so a
hardcoded POSIX fixture passes on macOS and Linux and fails the whole Windows
lane.

An `<a href>` is safe again now that the guard exists, and it is what About
uses: a real, copyable URL, with `onClick` → `app:openExternal` kept in front
of it because that path reports a failure inline (the "Link status" row) where
the guard can only log. Keep that pairing — the guard is the backstop, not the
mechanism.

## A deferred quit is retried from a macrotask, never from its own promise chain

**Any `before-quit` or `will-quit` listener that calls `preventDefault()` and
later asks again must do it through `retryQuitAfterDispatch`
([quit-retry.ts](../../apps/desktop/src/main/quit-retry.ts)), and nothing defers a
quit that has nothing to wait for.** Pinned by
[quit-reentry.test.ts](../../apps/desktop/src/main/__tests__/quit-reentry.test.ts),
against a model of Electron's quit state machine
([electron-quit-model.ts](../../apps/desktop/src/main/__tests__/electron-quit-model.ts))
that `pnpm --filter @pwrsnap/desktop probe:quit-reentry` checks against the
real runtime.

⌘Q hung intermittently from #659 on: two before-quit passes, every window
closed, `quit stalled: no will-quit` with zero BaseWindows and zero
webContents. Nothing was still closing. Electron had stopped quitting:

- **`Browser::Quit()` writes `is_quitting_ = HandleBeforeQuit()` AFTER the
  emit, and a native-started emit runs a microtask checkpoint before it
  returns.** ⌘Q (`terminate:`), Dock → Quit and a raw SIGTERM all start
  natively. The diagnostics flush settled in microtasks when no profiler was
  recording, so its `app.quit()` ran nested inside the pass it was retrying.
  The nested pass set the flag and closed the Library; the outer pass then
  wrote `false` over it. The Library finished closing, and Electron emitted
  `window-all-closed` in place of `will-quit`. With no window left, nothing
  ever asked again.
- **will-quit is worse: it is ALWAYS native-started** (the last window
  finishing its close), so a microtask retry from will-quit is lost even when
  the quit began in JS. The recording barrier's retry had this shape.
- **A tray-menu Quit is JS-started and never nested**, and neither is E2E
  teardown (`setImmediate(() => app.quit())`), which is why some quits with
  the identical double pass completed and why no spec caught it. A green E2E
  run proves nothing here.
- **A flush with no work does not defer.** `createDiagnosticsShutdown` takes
  `hasPendingWork`: a hot-CPU profiler is running, starting or stopping
  (`hasActiveHotCpuProfilers`), or the trace hook is armed. Not "a monitor
  slot exists": the main-process slot is installed at boot for every role, so
  that test is always true. Without either, `stop()` still runs to latch the
  targets' shutdown state, but quit is one pass. The #659 guarantee holds
  whenever a harness is on.
- **`installQuitStallRecovery`
  ([quit-stall-recovery.ts](../../apps/desktop/src/main/quit-stall-recovery.ts)) is
  a safety net, not the fix.** After a before-quit pass that nothing deferred,
  it re-asks once if Electron emits `window-all-closed` (the stall signature).
  It also exits if nothing has quit 20 s later and no window is left. Do not
  delete the root fix on the strength of it.

Full trail, probe output and the source lines:
[docs/solutions/2026-09-30-quit-stall-nested-before-quit.md](../../docs/solutions/2026-09-30-quit-stall-nested-before-quit.md).

## A one-shot intent sent to a renderer must not be droppable

**An event that carries a user's intent and exists nowhere else — today
`libraryOpenCapture`, which `editor:open` and `library:openInLibrary`
send — is sent ONCE, after `did-stop-loading`, on a channel the preload
latches. No `setTimeout` grace, no resend.** Owners:
`sendOpenCaptureWhenReady` in
[library-handlers.ts](../../apps/desktop/src/main/handlers/library-handlers.ts)
and [latched-events.ts](../../apps/desktop/src/preload/latched-events.ts).
Pinned by
[library-handlers-editor-open.test.ts](../../apps/desktop/src/main/handlers/__tests__/library-handlers-editor-open.test.ts)
and [latched-events.test.ts](../../apps/desktop/src/preload/__tests__/latched-events.test.ts).

- **`isLoading()` is still true inside `did-finish-load`** (231 of 231
  loads measured). It turns false at `did-stop-loading`, 0–7ms later. So
  "if loading, wait for `did-finish-load`" waits forever when the request
  lands between the two. Nothing is sent, and nothing times out. That was
  the `editor-v2-capture-open` flake, about 1 open in 40. Wait on the
  event that ends the state you checked.
- **React subscribes in a passive effect, after an IPC task can already
  have run.** Measured with one send per open: 59 of 120 opens were sent
  before the Library subscribed. The preload's listener exists before any
  page script, holds the latest payload while nothing is subscribed, and
  hands it to the first subscriber.
- **A latched channel wants exactly one subscriber.** Any subscriber
  receives events live, so an earlier one (a diagnostic listener, say)
  takes the intent before the Library mounts.
- **Add a channel to the latch only if a late subscriber cannot recover
  it.** A state broadcast is re-fetched on mount, so it has nothing to
  latch.

Failure timelines, the load-event measurements, and a probe that hides the
bug: [docs/solutions/2026-09-26-library-open-capture-lost-intent.md](../../docs/solutions/2026-09-26-library-open-capture-lost-intent.md).
