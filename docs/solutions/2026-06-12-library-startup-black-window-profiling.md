# Library startup profiling harness + startup-path cleanups

**Date:** 2026-06-12
**Reported symptom:** On launch, the Library window appeared as a
featureless black rectangle and "filled in" several seconds later (~5s
on a ~700-capture library).

> **⚠️ Root-cause correction (read this first).** The dramatic *~5s*
> black window was **NOT** caused by anything in this document. It was a
> **Chromium singleton-lock hang** introduced by the two-process split
> work: a second Electron process launched against the **same userData**
> dir and blocked on the userData `SingletonLock` until it timed out —
> so nothing painted at all. That is a separate bug in the split-process
> code, fixed there.
>
> What this investigation actually produced is still worth keeping: an
> env-gated **startup profiling harness** and two **genuine
> startup-path improvements** (login-shell PATH off the critical path;
> AI probes deferred). Those stand on their own merit — they were never
> the multi-second hang. An earlier iteration also added a boot
> *skeleton* to mask the (misattributed) black window; once the real
> cause was understood the skeleton was **removed** — it was papering
> over a phantom and looked worse than a brief flash. The
> compositor-starvation lesson it taught (§5 below) is kept because it's
> a real Chromium gotcha.

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

These are the real costs the profiler surfaced on a *normal
single-process* launch. NONE of them is multi-second — the ~5s the user
saw was the singleton-lock hang (see the correction at the top), which a
single-process profiling run does not reproduce. Renderer JS heap was
9.7MB and renderer CPU ~200ms total — pagination (100-row head page) and
virtualization; memory and renderer compute were non-issues. The
worthwhile findings:

1. **~1.0s: synchronous login-shell env hydration.**
   `hydrateProcessEnvFromLoginShell` (execFileSync of the interactive
   login shell) blocked the main thread at the very top of bootstrapApp,
   before the window could even be created. Real, and on the critical
   path for no reason: PwrSnap shells out by bare command name only for
   *AI helper* discovery (`codex`, ACP agent CLIs) and the rare
   ffmpeg-on-PATH fallback; the capture path uses absolute/bundled
   paths. None run during window bring-up. → moved off-thread (fix
   below).
2. **Spawn storms during the paint window.** The startup Codex readiness
   probe (~0.9s of `codex` process spawns) and ACP discovery/warm-up
   (~2s, kimi etc.) landed between window-show and first-thumbnail-paint,
   competing with renderer startup. → deferred (fix below).
3. The rest (DB open ~150–260ms, tray ~90ms, 30 × ~70ms parallel
   thumbnail-cache fetches + decode) was individually fine.
4. **The empty-shell paint.** `ready-to-show` fires on the bare
   `<div id="root">` (pure black) before React paints, so there's a
   brief black flash. On a single-process launch this is ~150–350ms and
   was never the complaint. The earlier boot-skeleton "fix" targeted
   this and was removed (see the top correction); the flash is
   acceptable and we show on `ready-to-show` as before.

## Fixes shipped

- **Login-shell PATH off the critical path entirely**
  ([login-shell-path.ts](../../apps/desktop/src/main/login-shell-path.ts)).
  The 2026-06 review (see below) rejected the first attempt — an
  encrypted `safeStorage` cache of the *whole* shell env — as treating
  the symptom. Final design: a singleton that resolves **only `PATH`**
  in a worker thread (execFileSync on main freezes compositing for
  every window), started fire-and-forget via `prewarm()` at boot so it
  NEVER blocks window bring-up. The only consumers (`codex`/ACP
  discovery, both deferred several seconds; the ffmpeg-on-PATH
  fallback, user-action-only) `await loginShellPath.value()` — instant
  once resolved, else awaits the in-flight resolve. On resolve it also
  unions the result into `process.env.PATH` so plain inherited-env
  spawns benefit without each call site awaiting. No on-disk cache
  (nothing blocks now, so there's nothing to pre-warm from disk), which
  also deletes the whole instance-key-poisoning failure class — we keep
  one non-secret string in memory and re-resolve once per launch.
  PATH-only is deliberate: we do NOT replay HOME/NVM_DIR/instance vars.
  No-op on win32.
- **Deferred probes**: startup Codex readiness probe +4s
  (`STARTUP_CODEX_PROBE_DELAY_MS`), ACP agent warm-up 2s→8s
  (`ACP_AGENT_WARMUP_BOOT_DELAY_MS`). Nothing on the boot path consumes
  either result; on-demand dispatches still trigger their own probes.
  E2E keeps baseline timing (codex inline, warm-up 2s) — see index.ts.
- **~~Boot skeleton~~ (reverted).** An interim fix injected static
  topbar/sidebar/tile-ghost markup into `#root` to mask the empty-shell
  flash. Removed once the ~5s was traced to the singleton-lock hang: it
  masked a phantom, looked worse than a brief flash on a fast machine,
  and its animated (loading-shimmer) variant starved the software
  compositor on GPU-less CI (§5). We show on `ready-to-show` as before.

Measured (profiled single-process launch, 700-capture library): DB open
lands ~+44ms after app-ready (was ~+1.1s behind the blocking shell
spawn); login-shell PATH now resolves in the background after the window
is up. These are real-but-small wins — again, the ~5s was the lock hang,
not this.

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
2. **The login shell echoes back the env it was spawned with.** The
   first (later-discarded) cached-hydration attempt persisted the whole
   resolved env, which replayed one launch's instance-specific vars
   (PWRSNAP_*, ELECTRON_*) into the NEXT launch — observed as a
   profiling run writing artifacts into the previous run's directory
   because the cached `PWRSNAP_STARTUP_PROFILE_DIR` overrode the live
   one. The final design ([login-shell-path.ts](../../apps/desktop/src/main/login-shell-path.ts))
   sidesteps the entire class: it keeps **only `PATH`** and persists
   **nothing**. If you ever reintroduce env caching, the rule stands —
   carry only the specific keys you need, never the whole shell env.
3. **`cp -Rpc` of a live userData clones the `Singleton*` symlinks.**
   A later launch against the clone can lose the single-instance lock to
   a stale/foreign socket and silently exit as a forwarding stub (two
   log lines, no window). Delete `Singleton*` from clones before use.
4. **pkill patterns**: the dev Electron binary lives under
   `<repo>/node_modules/.pnpm/electron@…/…/Electron.app`, NOT under
   `apps/desktop/node_modules`. Patterns that miss it leave orphan
   tray-app instances alive (no window ≠ quit) holding locks and
   hotkeys.
5. **No infinite CSS animations in boot-path chrome.** (The skeleton
   this came from was ultimately reverted — but the lesson is real and
   independent.) The skeleton's tiles originally pulsed (infinite
   opacity animation) from inject until React's first commit cleared
   them. On GPU-less machines (GHA
   Windows runners, some VMs) Chromium composites in software, and the
   animating library window starved the shared compositor enough that
   the TRAY renderer's ResizeObserver — which fires as part of the
   rendering steps — never ran: its resize IPC never posted and the
   popover stuck at the constructor frame / pre-data empty height.
   Four straight red Windows E2E rounds; a CI bisect (revert
   index.html → green) pinned it. Boot chrome must be static — zero
   ongoing compositor cost after the first frame. Related trap from
   the same debugging session: the seeded tray-spec macOS height
   ranges ([420, 560]) are machine-tuned and fail on other Macs even
   on pure main — no CI job runs those specs on macOS, so local macOS
   runs are NOT a proxy for the Windows job.
