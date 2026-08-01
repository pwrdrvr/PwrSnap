---
name: macos-vm-e2e-lab
description: >-
  Set up and operate the PwrSnap macOS VM lab: Tart-based macOS VMs on
  Apple Silicon for running the desktop Playwright E2E suite off-desktop
  (no window flashing / focus stealing on the host), plus ephemeral,
  network-isolated self-hosted GitHub Actions runners that serve the
  "macOS Desktop E2E (self-hosted VM)" CI lane. Use this skill whenever
  the user wants to: set up this lab on a new Mac, run E2E tests in a VM,
  fix a broken VM/runner, register or serve GHA runner jobs, understand
  softnet network isolation, or debug VM display/SSH/provisioning issues.
  Also trigger on mentions of Tart, softnet, self-hosted mac runners,
  "tests in a VM", or E2E runs stealing focus — even if the user doesn't
  name this skill.
compatibility: >-
  Apple Silicon Mac host with Homebrew and an authenticated `gh` CLI.
  Needs ~80GB free disk. Two steps require the human (sudo password +
  a GitHub repo setting) — everything else is agent-drivable over SSH.
---

# PwrSnap macOS VM E2E lab (Tart)

## What this builds and why

Two capabilities on one Mac host:

1. **Off-desktop E2E runs** — the desktop Playwright suite runs inside a
   macOS VM whose windows render on the VM's own virtual display. The
   host desktop is never touched. Runs live in a tmux session inside the
   VM, driven over SSH.
2. **A self-hosted GitHub Actions lane** — ephemeral runner VMs serve the
   `desktop-e2e-macos` job in `.github/workflows/ci.yml` (labels
   `[self-hosted, macOS, ARM64, pwrsnap-mac-vm]`). This is the only CI
   lane that exercises the macOS-only specs (clipboard, tray, menu-bar,
   dock lifecycle, AppKit windowing); GH-hosted macOS runners are
   cost-prohibitive.

Why Tart and not VMware/Parallels/UTM: macOS guests on Apple Silicon are
only possible through Apple's Virtualization.framework — VMware Fusion
will never support them on arm64. Tart drives that framework from a CLI,
has prebuilt CI-ready macOS images (SSH + GUI auto-login already
enabled), and pairs with `softnet` for the network isolation the runner
security model needs. License note: Tart is Fair Source (free on
personal workstations) — accepted for use as an external tool only;
never add it as a dependency and never read its source (see the
repo-root agent instructions' licensing policy).

## Security model (why each piece exists)

The repo is **public**, so a self-hosted runner is only acceptable with
all three layers:

1. **Ephemeral VMs** — each runner registers with `--ephemeral`, serves
   exactly one job, then the VM is deleted. Nothing persists between
   jobs.
2. **softnet isolation** — runner VMs boot with `--net-softnet`: internet
   works, all RFC1918 private address space (the host LAN) is blocked.
   `run-ephemeral-runner.sh` probes this from inside the VM before
   registering and aborts if private space is reachable. Never register
   a runner from a VM that failed this probe.
3. **GitHub settings** — the CI job carries an `if:` guard that skips it
   for PRs from fork head-repos, and the repo must have Settings →
   Actions → General → "Require approval for all external contributors"
   enabled (human does this in the GitHub UI).

The dev VM (`pwrsnap-dev`) runs on ordinary NAT — it's trusted, it only
runs code the user checked out. Only runner VMs need softnet.

## Host setup (one time per Mac)

Copy the bundled scripts to the conventional location first — they
expect to live there (logs, artifacts, SSH key all land in that dir):

```bash
mkdir -p ~/pwrsnap-mac-vm
cp -R <this-skill-dir>/scripts/ ~/pwrsnap-mac-vm/
chmod +x ~/pwrsnap-mac-vm/*.sh ~/pwrsnap-mac-vm/runner/*.sh
```

Then:

```bash
brew install cirruslabs/cli/tart cirruslabs/cli/softnet
tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest pwrsnap-sequoia-base
```

The image pull is ~35GB — run it in the background and expect 15–60
minutes. Sequoia (macOS 15) is deliberate: it matches CI's `macos-15`
GH-hosted runners. Keep `pwrsnap-sequoia-base` pristine — never boot it;
everything else clones from it.

**Apple limit: max 2 macOS VMs running concurrently per host.** Dev VM +
one runner VM is the ceiling. Plan sequencing around it (e.g. stop
`pwrsnap-dev` before building the runner base image).

## Dev VM: provision and run E2E

```bash
cd ~/pwrsnap-mac-vm
./provision-dev.sh          # idempotent; safe to re-run after failures
./run-e2e.sh main                        # full suite on an origin branch
./run-e2e.sh my-branch --grep clipboard  # subset
./run-e2e.sh --local <repo-path> [args]  # test UNPUSHED local commits
```

`--local` pushes the repo's current HEAD straight into the VM over SSH
(branch `e2e-local`, detached checkout) — use it for work-in-progress
that isn't on origin yet. The repo is public; never push WIP branches
to origin just to get them into the VM. Only committed state travels —
commit (or `git commit -m wip`) before running.

`provision-dev.sh` clones the base → `pwrsnap-dev` (8 CPU / 16GB /
1920x1080), installs a dedicated SSH key (cirrus images ship user
`admin`, password `admin`; the script switches to key auth), then inside
the VM: tmux, nvm + the `.nvmrc` node, corepack pnpm, a clone of the
repo at `~/PwrSnap`, and the display-resolution agent (see gotchas).

`run-e2e.sh <branch> [playwright args]`:
- runs checkout → `pnpm install` → `pnpm rebuild:electron-native` →
  build → `playwright test` inside tmux session `e2e` in the VM,
- tails the log to your terminal; Ctrl-C detaches without killing the
  run (`tmux attach -t e2e` in the VM to reattach),
- on failure, scp's `test-results/` back to
  `~/pwrsnap-mac-vm/artifacts/<timestamp>/`.

To watch the VM's screen: `./vnc.sh [vm-name]`. It opens Screen
Sharing against the guest's built-in service (port 5900, admin/admin)
at the VM's DHCP address, which is stable across restarts because tart
pins the VM's MAC — so Screen Sharing's reconnect finds a recycled VM
again. The `vnc://…@127.0.0.1:<port>` URL in the run log is tart's own
per-boot server (random port + password every boot) — only useful for
recovery-mode / pre-login screens, never for everyday viewing.

Expected healthy result: full suite ≈3 minutes, everything passing
except the Linux-only skips (7) and any known-flaky specs tracked in
the repo's issues/PRs.

## Runner: golden image and serving jobs

One-time human step (needs their password — agents must not do this):

```bash
echo "$USER ALL=(ALL) NOPASSWD: $(brew --prefix)/bin/softnet" | sudo tee /etc/sudoers.d/softnet
```

Verify with `sudo -n $(brew --prefix)/bin/softnet --help`. softnet runs
on the HOST (tart invokes it to build the isolated network); the VM
never sees it.

Then:

```bash
cd ~/pwrsnap-mac-vm
./runner/provision-runner-base.sh    # clone pwrsnap-dev -> pwrsnap-runner-base,
                                     # stage (not register) actions-runner
./runner/run-persistent-runner.sh    # DEFAULT: one long-lived runner VM
```

**Persistent mode (default).** One `pwrsnap-runner` VM, cloned from the
base once, registered non-ephemeral under a stable name, serving jobs
until stopped. Why it's the default: the actions-runner `_work` dir,
pnpm store, and node toolchain stay warm between jobs (no re-clone /
re-install tax), and it occupies exactly ONE of the host's two
macOS-VM slots — the other stays free for `pwrsnap-dev` local runs. A
single runner process serves one job at a time by construction. It
still boots with softnet and still verifies isolation before serving.
Re-baseline to a clean slate whenever wanted:

```bash
tart stop pwrsnap-runner && tart delete pwrsnap-runner
./runner/run-persistent-runner.sh   # re-clones + re-registers (--replace)
```

**Ephemeral mode (paranoid option).** `./runner/run-ephemeral-runner.sh
[--once]` — fresh VM per job, destroyed after: clone base → boot with
softnet → verify isolation → register `--ephemeral` → serve ONE job →
delete VM. Costs a full checkout + pnpm install every job and cycles
VM slots; use when you want zero state carryover (e.g. after loosening
the fork-PR policy, or for one-off suspicious jobs).

Both modes: registration tokens come from
`gh api -X POST repos/pwrdrvr/PwrSnap/actions/runners/registration-token`
and require repo admin on the authenticated `gh` — check
`gh auth status` if the token fetch 403s.

Operational note: the CI lane only functions while a runner is
listening. If none is, queued `desktop-e2e-macos` jobs sit up to 24h
and fail — keep the lane's workflow job non-required (or the runner
always-on via launchd) accordingly. A persistent runner that's offline
stays registered (shows offline in repo Settings → Actions → Runners);
jobs queue until it returns.

## Gotchas (each of these cost real debugging time)

Read [references/troubleshooting.md](references/troubleshooting.md) for
the full write-ups. Headlines:

- **Headless VF guests boot at 1024x768 no matter what `tart set
  --display` says.** The configured resolution only applies when a
  viewer attaches. Fix is in-guest: `provision-dev.sh` compiles
  `~/bin/setres` (a CoreGraphics mode-setter) and installs a LaunchAgent
  that runs it at every GUI login; `run-e2e.sh` also calls it
  defensively. Symptom if missing: specs that drive 1440x900 windows
  fail with `innerHeight: 684`.
- **`system_profiler SPDisplaysDataType` is always empty in VF guests**
  — probe the real resolution with a `swift -e` CoreGraphics one-liner,
  not system_profiler.
- **Feeding scripts to `ssh host 'bash -s'` via heredoc:** any command
  inside that reads stdin (`brew install`, some curl-pipe patterns) eats
  the rest of your script silently. Append `</dev/null` to every
  stdin-hungry command. The bundled scripts already do this — keep the
  pattern when extending them.
- **tmux + `tee` swallows exit codes** — pipelines report the LAST
  command's status. The bundled `run-e2e.sh` wraps the job in
  `bash -c 'set -o pipefail; …'`; keep that if you touch it.
- **Non-interactive SSH shells don't have brew on PATH** — scripts must
  `eval "$(/opt/homebrew/bin/brew shellenv)"` first.
- **GUI apps over SSH work** because cirrus images auto-login `admin`
  into a console GUI session. If Electron can't connect to the window
  server, check that auto-login is still intact rather than blaming
  Playwright.
- **Real-screen-capture specs** need `PWRSNAP_E2E_REAL_CAPTURE=1` plus a
  one-time Screen Recording TCC grant via the VM's GUI; everything else
  uses the E2E fakes and needs no TCC.
- **The paravirt GPU is unstable under Electron E2E load.** The
  suite's GPU-process submissions trip kernel `gpuRestart` resets
  (AppleParavirtGPU; reports in the guest's
  `/Library/Logs/DiagnosticReports/` naming Electron Helper), each of
  which stalls WindowServer — this was the root cause of the
  dock-lifecycle / tray-sizing visibility flakes, and a reset storm
  once panicked the guest into a mid-suite reboot. `run-e2e.sh`
  exports `PWRSNAP_E2E_DISABLE_GPU=1` (SwiftShader software
  rendering) to avoid the paravirt GPU entirely. If a VM run dies
  with a vanished tmux session, compare `sysctl kern.boottime` to the
  log's mtime and check for gpuRestart reports before blaming the
  tests. Full write-up:
  `docs/solutions/2026-08-01-vm-e2e-window-visibility-flakes.md`.

## Updating pieces later

- New base image release: `tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest pwrsnap-sequoia-base-new`,
  re-run provisioning against a fresh dev clone, then delete the old
  VMs. Clones are APFS copy-on-write — cheap until they diverge.
- New actions-runner version: re-run `provision-runner-base.sh` (it
  fetches the latest release when no version argument is given) after
  deleting the old `pwrsnap-runner-base`.
- Resource sizing: `tart set <vm> --cpu N --memory MB --display WxH`
  while the VM is stopped.
