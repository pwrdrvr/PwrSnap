# E2E teardown hang: login-shell resolver blocks `app.exit(0)` (+6s/spec cliff on persistent runner VMs)

**Date:** 2026-08-03
**Symptom:** macOS Desktop E2E jobs on the persistent Tart runner VMs
jump from ~3–4 min to a flat ~17 min after roughly a dozen jobs, with
NO failed or retried specs — every spec pays a uniform ~+6.0s. A guest
reboot fully resets it. The onset is a cliff, not a drift: one job runs
~11 min (transition mid-run), every job after pins at the ceiling.

## Anatomy of the +6s

Per-spec Playwright step timings showed launch (~0.3s) and the test
body (ms) healthy, with the missing ~6s after the last step. That is
exactly the fixture's forced-teardown budget in
`apps/desktop/e2e/fixtures/electron-app.ts`:
`ELECTRON_CLOSE_TIMEOUT_MS` (5s) + `waitForProcessExit` (1s) → SIGKILL.
The graceful path — `app.evaluate(exit(0))` — was *delivered and
evaluated* (probes confirmed), but the process did not exit.

## Root cause chain (captured live via targeted `spindump` as root)

1. `login-shell-path.ts` `prewarm()`s at boot: a `worker_threads`
   Worker (`shell-env-refresh-worker.ts`) resolves the user's
   interactive login-shell PATH via **`execFileSync` of the login
   shell** (through `@pwrdrvr/agent-transport`).
2. The spawned shell runs the full rc fan-out (nvm init alone spawns
   dozens of subshells; brew, xcode-select, etc.) — `wait4` chains of
   zsh/bash grandchildren.
3. `app.exit(0)` → Node teardown must stop the worker → **a worker
   pinned inside a sync spawn cannot be terminated** → the main thread
   blocks on a turnstile waiting for the worker (spindump:
   `blocked by turnstile waiting for Electron [pid] thread <worker>`;
   worker leaf: `node::SyncProcessRunner::Spawn → uv_run → kevent`).
4. The fixture SIGKILLs at ~6.2s. Pre-fix, `killProcessTree` only
   tree-killed on Windows — on macOS the SIGKILL hit the root PID only,
   orphaning Electron helpers AND the in-flight shell tree into the
   session.

Why a cliff: every E2E app instance has the shell resolve in flight
during its first ~1s — exactly when short specs tear down. On a fresh
guest the shell finishes in ~0.3s, before most closes. As session load
grows, shell resolves stretch; once they outlive the window between
launch and close, EVERY teardown blocks → SIGKILL → orphaned shell
trees add load → the state is self-sustaining until reboot. Two suites
running concurrently in one VM reproduce the signature immediately
(observed by accident); `worker.unref()` (added for an earlier hang in
this area) cannot help because unref does not make a sync-pinned worker
terminable.

## Fixes (fix/e2e-teardown-clean-exit)

- `login-shell-path.ts`: `value()` short-circuits under
  `PWRSNAP_E2E=1` (same arm as win32) — E2E never spawns the login
  shell. Determinism bonus: specs no longer touch host dotfiles.
- `electron-app.ts` `killProcessTree`: POSIX now snapshots the
  descendant tree (`ps -axo pid=,ppid=`) before killing and SIGKILLs
  every descendant — no more orphaned helpers/shells on forced
  teardown, on any platform.
- `electron-app.ts` `closeElectronApp`: logs
  `[e2e-teardown] graceful close failed …` whenever the forced path
  fires — if most specs of a run print it, the guest is degraded
  (reboot it; see the macos-vm-e2e-lab troubleshooting doc).

## Diagnosis recipe (for the next hang of this shape)

- Uniform +N s/spec with clean step timings → teardown budget; grep the
  fixture for the matching timeout sum.
- Live: `ps ax -o pid,stat,etime,comm` in the guest — app roots idling
  ~6s then dying is the signature.
- `sample` is useless on stripped Electron (bogus symbol names);
  targeted **`sudo spindump <pid>`** annotates blockers
  (`blocked by turnstile waiting for …`, `blocked by wait4 …`).
- A probe that launches the app, evaluates `app.exit(0)`, and checks
  aliveness 1.5s later separates "exit not delivered" from "exit
  blocked".

## Follow-ups (not in this change)

- Real users can still hit a slow quit if they quit within ~1s of
  launch while their dotfiles are slow — the worker's sync resolve is
  unkillable by design of `execFileSync`. If that ever matters, move
  the worker to an async spawn with kill-on-timeout.
- The persistent runner VMs should still be rebooted on a cadence
  (or per-job) as defense in depth — with these fixes the degradation
  driver is gone in E2E, but the lab doc keeps the reboot recipe.

## Correction (2026-08-03, later the same day): the login-shell chain was NOT the driver

After #354/#355/#356 all merged, jobs on the persistent runners still
degraded to ~17 min with the fixture telemetry showing every close
forced (140 warnings/run) — on code where the login-shell resolver no
longer exists. A controlled loop on a fresh guest reproduced the cliff
at run 8 again, deterministically, with zero contamination. The
login-shell worker captured in the original spindump was a bystander
(it genuinely blocked THAT process's exit at THAT moment, but removing
it changed nothing systemic).

**Actual root cause: a vmapple kernel leak.** Every VideoToolbox
initialization in a Virtualization.framework guest creates an
`AppleVideoToolboxParavirtualizationUserClient` kernel object that the
paravirt driver never frees at process death — `ioclasscount` showed
**1126** live clients on a degraded guest, and a control run measured
**+143 per full suite** (8 runs × ~143 ≈ the cliff). Once the driver's
table jams, `IOService::newUserClient` blocks, every new Electron
helper hangs AT BIRTH inside the kernel (spindump: suspended+zombie,
unkillable until the syscall unwinds), and app exit blocks in `wait4`
on that helper — the uniform +6s/spec. Reboot resets the kernel table,
which is why a fresh guest was always fast.

`app.disableHardwareAcceleration()` / `--disable-gpu` (the earlier
paravirt-GPU mitigation) switch rendering to SwiftShader but do NOT
stop the GPU process from initializing hardware media codecs. The fix
(fix/e2e-videotoolbox-kernel-leak) adds
`--disable-accelerated-video-decode` / `--disable-accelerated-video-encode`
under the same `PWRSNAP_E2E_DISABLE_GPU=1` gate. Measured: control
suite +143 clients, fixed suite **+0**; endurance loop past the run-8
cliff clean.

**Lesson recorded for the next investigation:** the original fix was
only ever verified on a fresh guest — which was always fast. A fix for
a degradation must be verified against the degraded state (or through
the full onset window), not the healthy one.

## Postscript (2026-08): the resolver was removed entirely

Shortly after this fix landed, the login-shell PATH machinery was
deleted outright (`login-shell-path.ts`,
`shell-env-refresh-worker.ts` + client, and the `PWRSNAP_E2E=1` gate
above, which the removal made moot). Decision: PwrSnap never spawns
the user's login shell to guess at PATH. Binary discovery instead
checks explicit install locations (app bundles, Homebrew prefixes,
nvm node bin dirs — plain filesystem scans) plus the app's inherited
PATH, validates pinned paths before spawning, and surfaces
"not found" in Settings → AI where the user can pin a path. The
first follow-up above (slow quit for real users) is resolved by the
same removal. The fixture tree-kill and teardown telemetry remain —
they are still the right defense for any future teardown blocker.

## Independent follow-up: exercise the real quit lifecycle and isolate host discovery

PR #366 identified and fixed the persistent-runner degradation: the
Virtualization.framework VideoToolbox kernel-object leak described in the
correction above. A subsequent harness audit found two independent test-fidelity
and isolation problems. They were not the cause of the degradation cliff, and
the changes below are not an additional fix for that kernel leak:

- `closeElectronApp` called `app.exit(0)` before Playwright's
  `ElectronApplication.close()`. Electron's `app.exit()` explicitly skips
  `before-quit` and `will-quit`, so PwrSnap's worker/window/timer/process-pool
  cleanup never ran. The fixture now starts with Playwright's bounded `close()`
  path, which uses `app.quit()`, and retains the descendant-tree SIGKILL only
  as the deadline fallback.
- E2E boot dispatched the startup Codex discovery probe inline for every fresh
  app. That launched the host's real Codex `--version` and auth probes hundreds
  of times per suite, even though only the settings discovery spec needs them.
  E2E now skips the boot probe and the main settings handler returns an empty
  snapshot for non-forced renderer mount probes. The dedicated spec dispatches
  discovery with `force: true` and retains end-to-end coverage.

An A/B full-suite run after rebasing onto #366 measured the tradeoff on the
same guest and kernel state. `main` passed 129 tests in 3.0 minutes with two
bounded fallback closes; the lifecycle-isolation branch passed the same 129 in
3.4 minutes with one fallback. The VideoToolbox client count stayed 487 before
and after both runs, and neither left Electron or Codex processes alive. The
roughly 24-second suite cost is the price of exercising production cleanup on
every launch, not evidence of another degradation fix; one run is also too
small to claim that the fallback rate improved. Unit coverage separately
asserts the deterministic isolation property: an E2E non-forced discovery
request never invokes the discovery service, while a forced request does.
