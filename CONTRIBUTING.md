# Contributing to PwrSnap

Thanks for taking the time to improve PwrSnap. The project is MIT-licensed
(see [LICENSE](LICENSE)) and currently in alpha — actively developed, but
designed to be non-destructive between releases. The settings substrate and
capture/overlay schemas migrate forward without invalidating older installs;
keep that contract in mind when proposing changes to either.

This document covers the development setup, repository conventions, testing
workflow, and diagnostic tooling needed to ship a change confidently. For the
load-bearing project rules (brand, command bus, sandboxed renderers,
settings substrate, popover sizing gotchas, native binding repair), read
**[AGENTS.md](AGENTS.md)** first. For the user-facing pitch, see
**[README.md](README.md)**.

## Development Setup

PwrSnap is a pnpm workspace (`apps/desktop` + `packages/*`). It needs the
Node.js version in `.nvmrc` (currently `v24.14.1`), selected through nvm, and
the pnpm version pinned in the root `package.json`:

```bash
git clone https://github.com/pwrdrvr/PwrSnap.git
cd PwrSnap
source ~/.nvm/nvm.sh
nvm use
pnpm install
pnpm dev
```

The root `preinstall` script refuses an install under the wrong Node. Do not
bypass it: native modules compiled against the wrong ABI fail later, at test
or launch time (see [better-sqlite3 Native Binding
Repair](#better-sqlite3-native-binding-repair)).

Keep a separate `pnpm install` in each worktree. Sharing root `node_modules`
does not supply all package-local dependency links, and sharing package
`node_modules` can bind workspace imports to the donor checkout's source and
make native staging mutate shared dependencies.

### Linux: Electron's sandbox helper

On Linux, install and desktop dev/preview warn when Electron's setuid sandbox
helper lacks root ownership or mode `4755`. If Electron reports the SUID
sandbox error, run these commands from the repository root:

```bash
pnpm fix:linux-sandbox
pnpm dev
```

The fixer resolves this checkout's installed Electron helper, runs `sudo chown
root:root` followed by `sudo chmod 4755`, and verifies the result. It is safe to
repeat; run PwrSnap as your normal user. Reinstallation or Electron replacement
may require repeating the repair. `pnpm check:linux-sandbox` repeats the
read-only advisory check. User namespaces may permit launch without the setuid
helper; mount policy (such as `nosuid`) and other security restrictions can
still prevent startup after repair. Install and launch never request sudo
automatically or disable sandboxing. Both commands do nothing on other
platforms. Linux is a development and CI platform for PwrSnap; no Linux
package is distributed.

Useful checks (all run from the repo root):

- `pnpm typecheck` — workspace-wide native TypeScript 7 check
- `pnpm typecheck:legacy` — the same projects with TypeScript 6
- `pnpm check:changed` — full lint plus tests related to committed and working
  changes since the `origin/main` merge base, including untracked files. Tests
  importing the filesystem also run, since source-reading contract tests have
  no discoverable import edge to the files they guard. Tooling
  changes and deletions run the full unit suite. Only one such check can run
  across this repository's local worktrees at a time. Run expensive checks
  sequentially; direct `lint`/`test` invocations do not acquire this lock.
- `pnpm check:benchmark` — compare compiler file inventories, probe type and
  unused-binding errors, then measure three sequential pairs on this machine;
  results are written to `.local/check-performance/paired.json`. Set
  `CHECK_BENCH_ITERATIONS` (1–20) or `CHECK_BENCH_OUTPUT` to customize a run.
- `pnpm test` — Vitest unit + integration suite
- `pnpm test:desktop-e2e` — Playwright + Electron end-to-end suite
- `pnpm test:desktop-e2e:docker` — the Linux/xvfb E2E subset on Docker, used
  to reproduce GitHub Actions failures locally
- `pnpm lint` — TypeScript, dependency/metadata/fuse/license/settings/color
  policy gates and native correctness/receiver checks
- `pnpm lint:syntax` — Oxlint correctness rules across TypeScript and JavaScript,
  including scripts and unit/E2E tests
- `pnpm lint:typed` — production TypeScript receiver checks; inline suppression
  is rejected, and callback contracts may declare `this: void`
- `pnpm licenses:check` — verifies `THIRD_PARTY_LICENSES` matches a
  deterministic regeneration; run `pnpm licenses:generate` after dependency
  changes
- `pnpm release:check` — release metadata gate (tag / version / changelog)

When focusing root Vitest runs through `pnpm test`, pass file paths or
filters directly, for example
`pnpm test apps/desktop/src/main/__tests__/development-dock-icon.test.ts`. Do
not insert a standalone `--` before the focus args; `pnpm test -- apps/...`
makes Vitest run the full workspace suite.

## Workspace Map

- `apps/desktop` — Electron app shell (main, preload, renderer, IPC).
- `packages/shared` — cross-process command-bus contracts, IPC channel
  constants, Result envelopes, overlay schemas.
- Codex App Server protocol types are consumed from
  `@pwrdrvr/codex-app-server-protocol`, pinned in
  `apps/desktop/package.json`. They are generator output maintained outside
  this repo; do not vendor them back in.

### How it's built

| Layer                | Stack                                                    | Where it lives                                  |
| -------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| Desktop shell        | Electron + TypeScript + React 19 + electron-vite         | `apps/desktop/`                                 |
| Capture pipeline     | Electron/OS capture + `sharp`; Swift/C++ window helpers  | `apps/desktop/src/main/capture/`                |
| Render pipeline      | `sharp` for resize + crop + thumbnail caching            | `apps/desktop/src/main/render/`                 |
| Persistence          | `better-sqlite3` (WAL) + durable `.pwrsnap` bundles      | `apps/desktop/src/main/persistence/`            |
| AI                   | Codex App Server and ACP clients; direct API adapters    | `apps/desktop/src/main/ai/`                     |
| Shared types         | Cross-process commands + IPC channels + result envelopes | `packages/shared/`                              |
| Settings + secrets   | Single substrate (JSON + Electron `safeStorage`)         | `apps/desktop/src/main/settings/`               |

## Pull Requests

- Keep PRs focused on one change.
- Follow Conventional-Commit-style PR titles: `type(scope): description`.
  Prefer scopes that match the project area being changed:
  - `desktop` — the Electron app itself (main, preload, renderer).
  - `protocol` — the Codex App Server protocol package dependency.
  - `design` — UI work tied to the design system.
  - `release` — packaging, signing, notarization, distribution, auto-update.
  - `docs` — documentation only.
  - `tests` — test coverage, fixtures, infrastructure.
- Include tests or explain why the change is documentation-only.
- Run the relevant checks before requesting review.
- Update `THIRD_PARTY_LICENSES` with `pnpm licenses:generate` when dependency
  changes affect bundled notices.

## AI backends

AI is optional and off until the user turns it on. Built-in Codex and ACP
paths are agent clients: PwrSnap talks to the user's installed Codex CLI or
Codex Desktop over Codex App Server (stdio JSON-RPC), or to an installed ACP
agent. User-configured direct API connections call OpenAI Responses,
OpenAI-compatible Chat Completions, or Anthropic Messages from main, with no
agent or proxy in between; that code lives under
`apps/desktop/src/main/ai/direct-api/`. Never route a custom model through
Codex/ACP as a fallback. [AGENTS.md](AGENTS.md) and
[docs/architecture.md](docs/architecture.md) hold the credential, capability,
and sandbox rules, including the capture-enrichment jail.

Codex protocol types are consumed from the published
`@pwrdrvr/codex-app-server-protocol` package. To move to a newer Codex
protocol surface, publish a new package version from
`github.com/pwrdrvr/codex-app-server-protocol`, then bump the exact pin in
`apps/desktop/package.json`.

PwrSnap is an App Server **client only** — never an App Server
*implementation*.

## Repository Conventions

- **pnpm workspaces.** Apps in `apps/*`, packages in `packages/*`. Always run
  `pnpm install` from the repo root.
- **Channel naming.** IPC channels use bare `<domain>:<verb>`
  (`capture:region`, `library:list`, `overlays:upsert`). No `pwrsnap:`
  prefix; matches PwrAgnt convention.
- **Single command bus.** All commands route through
  [`apps/desktop/src/main/command-bus.ts`](apps/desktop/src/main/command-bus.ts).
  ipcMain (Phase 1), HTTP RPC (Phase 7), and a future MCP transport all
  dispatch through it. Exactly one place to register a command and exactly
  one place to enforce auth + capability checks.
- **TypeScript strict.** `tsconfig.base.json` has `strict`,
  `verbatimModuleSyntax`, `isolatedModules`, and (per the deepening plan)
  `exactOptionalPropertyTypes`.
- **Renderers stay sandboxed.** Every `BrowserWindow` is created with
  `contextIsolation: true, sandbox: true, nodeIntegration: false`. Lifecycle
  tests enforce.
- **Result-pattern for cross-process errors.** Electron `invoke` strips
  `instanceof`. All command handlers return `Result<Res, PwrSnapError>` —
  `{ ok: false, error: { kind, code, message, cause? } }`.

The full and authoritative list of conventions, gotchas, and load-bearing
patterns (popover sizing, `setMinimumSize(0, 0)`, settings substrate,
better-sqlite3 native binding repair) lives in
**[AGENTS.md](AGENTS.md)** — read it before touching window code,
settings, or the native sidecar.

## Testing

For the desktop end-to-end suite, prefer `pnpm test:desktop-e2e` from the
repo root. The package-level
`pnpm --filter @pwrsnap/desktop test:e2e` path is also safe — it builds
`apps/desktop/out/` before launching Playwright.

To reproduce the Linux GitHub Actions Desktop E2E job locally, use
`pnpm test:desktop-e2e:docker` (or pass `--test '<pattern>' --iterations 30`
for flake hunting). This runs the Linux/xvfb subset on Docker's native Linux
platform; macOS-only clipboard, tray, menu-bar, screen-capture, and AppKit
windowing specs are expected to be skipped. Add `--platform linux/amd64`
only when investigating architecture-specific GHA parity.

### Headed macOS E2E

The macOS suite is headed: it opens windows, takes focus, and drives the
region selector and global hotkeys. Running it on your own desktop interrupts
whatever you are doing, and your real windows can end up inside a capture
under test. Prefer an off-desktop VM.

Prefer **PwrSuiteLab Control MCP**. Agents must discover its live tool schemas
and read the served `skill://manage-pwrlab-e2e/SKILL.md`; the product routing
and safety rules are in
[`.agents/skills/macos-vm-e2e-lab/SKILL.md`](.agents/skills/macos-vm-e2e-lab/SKILL.md).
An Operate grant authorizes exposed actions for the requested work without
per-operation native confirmation. Use the exact dedicated E2E target from
`lab_status`, never a GitHub Actions runner or the physical desktop.

Submit the exact clean, committed PwrSnap worktree in `job.repository`.
Untracked files count as dirty; explicitly stage new specs before committing.
Only committed HEAD and locally available submodule/LFS content are staged;
fetch required golden LFS objects before submission. No GitHub push is needed.
Pass the narrowest useful test filter: Playwright filters are regexes against
the full test path, so `e2e/editor` selects every `editor-*.spec.ts`.

Example `lab_e2e_run` arguments, assuming the guest has nvm and Corepack:

```json
{
  "target": "<exact E2E target from lab_status>",
  "agent_name": "PwrAgent",
  "project_name": "PwrSnap",
  "thread_name": "Verify region selector UI",
  "job": {
    "repository": "/absolute/path/to/clean/PwrSnap/worktree",
    "setup": [
      ["bash", "-c", "source \"${NVM_DIR:-$HOME/.nvm}/nvm.sh\" && nvm install && corepack pnpm install --frozen-lockfile"]
    ],
    "command": ["bash", "-c", "source \"${NVM_DIR:-$HOME/.nvm}/nvm.sh\" && nvm use && CI=1 PWRSNAP_E2E_DISABLE_GPU=1 corepack pnpm --filter @pwrsnap/desktop test:e2e e2e/region-selector-ui.spec.ts"],
    "artifacts": ["apps/desktop/test-results", "apps/desktop/playwright-report"],
    "timeout_seconds": 3600
  }
}
```

Replace target, path, caller, and task with actual values. Add top-level
`pr_number` as a decimal string only when applicable and known. Both
`lab_e2e_run` and `lab_e2e_acquire` require top-level `agent_name`,
`project_name`, and `thread_name`; putting them inside `job` is invalid.
`setup` is an array of argv arrays and `command` is an argv array, not a shell
string. The explicit `bash -c` commands above run only in the guest: nvm reads
`.nvmrc`, Corepack uses `package.json`'s package-manager pin, installation runs
PwrSnap's postinstall, and `test:e2e` runs its native rebuild/build pretest.
If a required runtime manager is missing, follow the served skill's guest-only
setup contract; never install host tools or copy credentials as a workaround.

`PWRSNAP_E2E_DISABLE_GPU=1` matches macOS CI rendering. `CI=1` enables the
configured HTML report, failure screenshots/video, and one retry with a trace;
omit `CI` only deliberately when diagnosing behavior without retries.
Artifacts must be bounded paths relative to checkout; `e2e.log` is collected
automatically. The timeout covers staging, setup, and tests.

Save the returned request ID and `run_id`. Poll `lab_request_status` using the
request ID; a completed launch request is not a completed test run. Collect
progress and artifacts with `lab_e2e_collect` using the exact target and saved
`run_id`. Inspect the returned artifact directory, exit code, and completeness.
On `Invalid tool or arguments`, compare the call with the current schema,
especially required attribution; do not assume the Operate grant was lost.
If transport fails after launch, inspect the run before submitting it again.

No initial acquire is needed: run acquires the display or consumes this
connection's reservation. **Release reservation** releases only the caller's
reservation, not a workload lock after handoff. Use guarded `lab_e2e_recover`
for an orphan, never manual lock deletion. `lock_started_at` is UTC and
`lock_age_seconds` is the full guest-measured age, independent of chart window;
age alone does not establish that recovery is safe.

#### Managed script fallback

Only when Control MCP is unavailable, discover an existing PwrSuiteLab checkout
and follow its current instructions and `macos-tart` runbook. Agents need
explicit approval naming the target and intended test for this script path;
already-given approval for that run suffices. Do not fall back to scripts to
bypass an MCP validation or permission refusal. Host, guest, configuration,
and access details stay in PwrSuiteLab.

Run this from your PwrSnap worktree, not from the lab checkout:

```bash
suite_lab_root="$HOME/path/to/PwrSuiteLab"
"$suite_lab_root/macos-tart/run-e2e.sh" --confirm-live-run \
  --workload pwrsnap --local "$(git rev-parse --show-toplevel)" \
  e2e/region-selector-ui.spec.ts
```

That flag order is required — the controller reads its arguments positionally,
and everything after `--local <path>` is passed to Playwright untouched.
The same clean committed HEAD and local LFS requirements apply. The script
adapter does not set `CI`, so it does not enable HTML reporting or retries.
Redirect output with `> run.log 2>&1`, not a pipe through `tail`; use the lab's
collection helper after a controller interruption instead of starting another
run. Retain strict host-key checking and the configured identity; never bypass
the controller with bare Tart, raw SSH, or manual lock removal.

Without a lab you can run the suite headed on your own machine, accepting the
interruption — but an agent must get explicit approval before taking your screen.

### Visual-regression goldens

The focused Playwright visual-regression suite uses lossless WebP references
stored in Git LFS under `apps/desktop/e2e/*.spec.ts-snapshots/`. Screenshot
rendering varies across operating systems, so Linux and macOS/arm64 use
separate reviewed baseline environments. The self-hosted macOS VM is the
active visual CI lane while Linux visual coverage is temporarily excluded until
its worker teardown is stabilized; Windows continues to run behavioral E2E
coverage.

To update a Linux-focused baseline, use the Docker runner on your host's
native architecture. The Linux goldens do not depend on CPU architecture: on
2026-10-02 a native linux/arm64 run on Apple Silicon matched the
linux/amd64-generated `library-grid-linux.webp` at the suite's default
comparison, with no pixel allowance. Emulating amd64 on an Apple Silicon host
works too, but it is many times slower and buys nothing here.
`--update-snapshots` requires `--test` and safely copies only generated
baseline directories back to the source worktree. Run it from the repository
root, and pass the flags straight through — an inserted `--` reaches
`run-docker.sh` as an argument and it exits 2 with `unknown arg: --`:

```bash
pnpm test:desktop-e2e:docker --test 'visual regression' --update-snapshots
```

A failed run copies nothing back, so it has to be repeated — but read the
reported failure first rather than re-running blind. The Linux suite has a
known worker-teardown flake that a re-run clears; an Electron launch or
`evaluate` crash (GLib assertions, `Target page … closed`) is a real failure
that will not. `--keep-stage` leaves the generated baselines in the stage
directory either way, so a teardown failure after a good render does not have
to be re-rendered.

For macOS, review the `*-actual.webp` files emitted by the self-hosted VM's
`desktop-e2e-macos-artifacts` artifact, then deliberately promote approved
files to their `*-darwin.webp` baselines. For an authorized MCP golden-update
job, explicitly add only the relevant `apps/desktop/e2e/<spec>-snapshots`
directories to `job.artifacts`, collect them using the saved run ID, then review
and copy the intended files into the local worktree. A guest rewrite alone does
not update local goldens. The fallback script collects only test results and
reports; do not use its `--update-snapshots` because it does not retrieve the
rewritten baselines. Both Linux and macOS Desktop E2E
checkouts fetch these LFS objects; regular build, lint, unit-test, and Windows
E2E jobs do not download them.

## better-sqlite3 Native Binding Repair

PwrSnap uses `better-sqlite3`, which ships a native `.node` binary. The
system Node ABI and Electron ABI can diverge — especially after switching
worktrees, updating Electron, or running `pnpm install` under a different
Node version. The usual symptom during `pnpm dev` is:

```text
better_sqlite3.node was compiled against a different Node.js version
NODE_MODULE_VERSION <old>. This version of Node.js requires NODE_MODULE_VERSION <new>.
```

Do not chase this as a database bug. Repair the native sidecar from the repo
root:

```bash
source ~/.nvm/nvm.sh
nvm use
pnpm install
pnpm rebuild:electron-native
```

The script keeps two binaries on purpose:

- `better-sqlite3/build/Release/better_sqlite3.node` stays compiled for
  system Node so unit tests and scripts can `require("better-sqlite3")`.
- `better-sqlite3/electron-native/better_sqlite3.node` is compiled or
  downloaded for Electron and is what the app loads at runtime.

For release/package work, the Electron sidecar must be built for the target
architecture, not necessarily the host. The script honors `npm_config_arch`
/ `npm_config_target_arch` (including `"universal"`, which lipos arm64 +
x64 prebuilds into a fat binary), and
`apps/desktop/src/main/persistence/native-binding.ts` ignores the sidecar
unless its metadata matches the running Electron version, `better-sqlite3`
version, and `process.arch`.

## Release Pipeline

Every tagged desktop release is published only after the macOS
sign/notarization job, the Windows signing job, and the Linux build gate all
succeed. Release installers include the controlled FFmpeg sidecar used for
video processing. The pipeline (Apple Silicon and universal DMGs, Windows x64
installer, signing, notarization, updater metadata, stable-name aliases) is
documented in [docs/desktop-release-runbook.md](docs/desktop-release-runbook.md);
Homebrew and Winget follow-up is in
[docs/package-manager-release-runbook.md](docs/package-manager-release-runbook.md).

Pull-request preview artifacts are not production-signed and expire after 14
days; the Windows preview is unsigned and the macOS preview is not notarized.
They are for development testing, not normal installation. Windows build and
source notes are in [docs/windows/README.md](docs/windows/README.md).

## Design Documents

- [docs/architecture.md](docs/architecture.md) is the canonical description
  of what PwrSnap is and why it is shaped this way. Read it before changing
  scope, schema, or IPC contracts.
- [AGENTS.md](AGENTS.md) holds the enforcement rules — the invariants a
  change can violate.
- Solution learnings (post-incident notes, gotchas) live in
  `docs/solutions/`. **These are never deleted.**
- `docs/plans/` and `docs/brainstorms/` no longer exist. Do not recreate
  them — open an issue, or amend `docs/architecture.md` when the change is
  architectural. See AGENTS.md §Workflow for the full retention policy.

## Conduct

This project follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security

Do not report vulnerabilities in public issues. Follow
[SECURITY.md](SECURITY.md).
