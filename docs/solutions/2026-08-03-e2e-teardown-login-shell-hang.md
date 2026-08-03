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
