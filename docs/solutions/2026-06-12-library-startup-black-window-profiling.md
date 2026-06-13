# Library startup: 5s black-window — profiling harness, root causes, fixes

**Date:** 2026-06-12
**Symptom:** On launch, the Library window appeared as a featureless black
rectangle and only "filled in" with content several seconds later (~5s
reported on a ~700-capture library; 1.4–3.4s reproduced warm/cold on an
M4 Mac mini).

## The startup profiling harness (kept wired, env-gated)

Launch with `PWRSNAP_STARTUP_PROFILE=1` to capture, into
`PWRSNAP_STARTUP_PROFILE_DIR` (default `<tmpdir>/pwrsnap-startup-profile-<pid>`):

- `main.cpuprofile` — main-process CPU profile sampled from the FIRST line
  of the main bundle (`startup-profile-boot.ts` is deliberately the first
  import in `index.ts`) for `PWRSNAP_STARTUP_PROFILE_DURATION_MS` (15s).
- `renderer-library.cpuprofile` — renderer CPU profile attached via
  `webContents.debugger` before `loadRenderer` (so script eval is covered).
- `main.heapsnapshot` / `renderer-library.heapsnapshot`.
- `startup-marks.json` — ms-relative milestones: boot phases, window-show
  source, page lifecycle events (firstPaint / firstContentfulPaint /
  firstImagePaint via CDP `Page.lifecycleEvent`), per-command bus timings,
  per-protocol-fetch timings.

Implementation: [startup-profiler.ts](../../apps/desktop/src/main/startup-profiler.ts).
Open `.cpuprofile` in Chrome DevTools (Performance → load) or speedscope;
`.heapsnapshot` in DevTools → Memory.

**Profiling runs are passive observers by design.** With the flag set, the
app SKIPS: global hotkey registration, boot GC, and asset filename
maintenance. See "Safety lessons" below for why this is load-bearing.

### Recommended way to profile against real-scale data

```bash
# APFS copy-on-write clone of the real userData — instant, isolated lock
cp -Rpc "$HOME/Library/Application Support/PwrSnap" /tmp/pwrsnap-profile-userdata
rm -f /tmp/pwrsnap-profile-userdata/Singleton*   # cloned singleton symlinks confuse the lock

cd apps/desktop && pnpm build
PWRSNAP_STARTUP_PROFILE=1 \
PWRSNAP_STARTUP_PROFILE_DIR=/tmp/pwrsnap-startup-profile \
PWRSNAP_USER_DATA=/tmp/pwrsnap-profile-userdata \
./node_modules/.bin/electron .
# artifacts appear ~17s after launch; kill the app afterwards
```

## What the profiles showed (700-capture library, built output)

Renderer JS heap was 9.7MB and renderer CPU ~200ms total — pagination
(100-row head page) and virtualization work; memory and renderer compute
were NON-issues. The ~5s was pure latency, in four parts:

1. **~1.0s: synchronous login-shell env hydration.**
   `hydrateProcessEnvFromLoginShell` (execFileSync of the interactive
   login shell) blocked the main thread at the very top of bootstrapApp,
   before the window could even be created. Single largest line item.
2. **`ready-to-show` fires on the EMPTY html shell.** For a SPA the event
   is meaningless: Chromium paints the bare `<div id="root">` page (pure
   black), main shows the window, and the user stares at a void while
   React mounts + `library:list` returns + thumbnails decode. The "black
   placeholder" was literally the window `backgroundColor`.
3. **Spawn storms during the paint window.** The startup Codex readiness
   probe (~0.9s of `codex` process spawns) and ACP discovery/warm-up
   (~2s, kimi etc.) landed exactly between window-show and
   first-thumbnail-paint, competing with renderer startup.
4. The rest (DB open ~150–260ms, tray ~90ms, 30 × ~70ms parallel
   thumbnail-cache fetches + decode) was individually fine.

## Fixes shipped

- **Cached login-shell hydration**
  ([shell-env-hydration.ts](../../apps/desktop/src/main/shell-env-hydration.ts)):
  encrypted (`safeStorage`) cache of the resolved shell env in userData;
  warm launches apply it in ~1ms inside `whenReady` and refresh it in a
  worker thread (+5s, off the main thread — execFileSync on main freezes
  compositing for every window). Cold/first launch blocks exactly as
  before, once. Merge semantics reuse the package's own
  `resolveShellEnv` injection point.
- **Boot skeleton in index.html**: static topbar/sidebar/tile-ghost
  markup injected into `#root` (library stage only — every other window
  carries `#stage=` in its hash). React's first commit replaces it. The
  shown window now paints app structure before React even mounts —
  verified by `firstPaint` landing BEFORE `window-show` in the marks.
- **Deferred probes**: startup Codex readiness probe +4s
  (`STARTUP_CODEX_PROBE_DELAY_MS`), ACP agent warm-up 2s→8s
  (`ACP_AGENT_WARMUP_BOOT_DELAY_MS`). Nothing on the boot path consumes
  either result; on-demand dispatches still trigger their own probes.

Measured warm-launch result (same machine, same library):
window visible 1977→393ms; first paint 2727→368ms (now pre-show);
thumbnails 3372→1187ms. The black phase is gone entirely.

## Safety lessons (hard-won, do not relearn)

1. **A profiling/dev instance must NEVER register global hotkeys.**
   Capture bundles live OUTSIDE userData (`~/Documents/PwrSnap`), so an
   instance running against a cloned userData that grabs ⌘⇧C steals the
   user's real capture: bundle file written to the real Documents dir,
   DB row written to the throwaway clone. This happened live during this
   work; the capture was recovered by hand-copying rows (captures,
   ai_runs, ai_run_media_inputs, ai_run_usage, capture_enrichments,
   enrichment_tag_suggestions, layers — FTS rows follow via the
   `captures_ai_fts` / `capture_enrichments_ai_fts` triggers) from the
   clone DB into the real DB with the real app closed. The
   `startupProfilingEnabled()` guard in index.ts now makes this
   structurally impossible. Same reasoning for boot GC and filename
   maintenance: both touch files outside userData.
2. **The login shell echoes back the env it was spawned with.** Caching
   its output verbatim replays one launch's instance-specific env
   (PWRSNAP_*, ELECTRON_*) into the NEXT launch — observed as a
   profiling run writing artifacts into the previous run's directory
   because the cached `PWRSNAP_STARTUP_PROFILE_DIR` overrode the live
   one. `shell-env-hydration.ts` filters those keys on write AND on
   apply; [shell-env-hydration.test.ts](../../apps/desktop/src/main/__tests__/shell-env-hydration.test.ts)
   locks the behavior.
3. **`cp -Rpc` of a live userData clones the `Singleton*` symlinks.**
   A later launch against the clone can lose the single-instance lock to
   a stale/foreign socket and silently exit as a forwarding stub (two
   log lines, no window). Delete `Singleton*` from clones before use.
4. **pkill patterns**: the dev Electron binary lives under
   `<repo>/node_modules/.pnpm/electron@…/…/Electron.app`, NOT under
   `apps/desktop/node_modules`. Patterns that miss it leave orphan
   tray-app instances alive (no window ≠ quit) holding locks and
   hotkeys.
