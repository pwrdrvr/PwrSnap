---
name: macos-vm-e2e-lab
description: >-
  Set up and operate the PwrSnap macOS VM lab: Tart-based macOS VMs on
  Apple Silicon for running the desktop Playwright E2E suite off-desktop
  (no window flashing / focus stealing on the host), plus persistent or
  ephemeral, network-isolated self-hosted GitHub Actions runners that serve the
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
2. **A shared self-hosted GitHub Actions lane** — organization runners in the
   selected-repository `PwrDrvr macOS` group serve both PwrSnap and
   PwrAgent (labels `[self-hosted, macOS, ARM64, pwrdrvr-macos]`). This is
   the only CI lane that exercises the macOS-only specs (clipboard, tray,
   menu-bar, dock lifecycle, AppKit windowing); GH-hosted macOS runners are
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

The two allowed repositories are **public**, so a shared self-hosted runner is
only acceptable with all four safeguards:

1. **Runner lifecycle** — the persistent VM is the default and serves one
   trusted same-repository job at a time, so its work cache can persist. Use
   the ephemeral mode when a clean VM per job is required, and re-baseline the
   persistent VM whenever its retained state is no longer acceptable.
2. **softnet isolation** — runner VMs boot with `--net-softnet`: internet
   works, all RFC1918 private address space (the host LAN) is blocked.
   Both runner scripts probe this from inside the VM before registering and
   abort if private space is reachable. Never register a runner from a VM that
   failed this probe.
3. **Selected repository access** — the organization runner group is limited
   to `pwrdrvr/PwrSnap` and `pwrdrvr/PwrAgent`. Do not use an all-repositories
   group and do not register a second repo-scoped copy of this runner. The
   group must also have `allows_public_repositories=true` — both repos are
   public, and GitHub's default (`false`) makes the group silently refuse
   their jobs: runners sit online+idle while jobs queue forever.
   `configure-shared-runner-group.sh` sets the flag at creation and re-asserts
   it on repair; this is an intentional part of the model, not a loosening —
   the fork-PR `if:` guards and the "require approval for all external
   contributors" setting (item 4) are what keep untrusted code off the runner.
4. **GitHub settings** — each CI job carries an `if:` guard that skips it
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
cp -R <this-skill-dir>/scripts/. ~/pwrsnap-mac-vm/
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
./runner/configure-shared-runner-group.sh  # PwrSnap + PwrAgent only
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

Both modes register to `https://github.com/pwrdrvr` in the selected-repository
organization group. `configure-shared-runner-group.sh` permits only PwrSnap
and PwrAgent, then the runner scripts obtain organization registration tokens
from `orgs/pwrdrvr/actions/runners/registration-token`. A first registration
or re-baseline requires an org-admin token (or fine-grained Actions Runners +
Administration permission); refresh `gh` with `gh auth refresh -h github.com
-s admin:org` if it returns 403. An already registered persistent runner does
not call this API during ordinary launchd restarts.

**Migrating the existing runner.** A runner previously registered directly to
PwrSnap must be removed and reconfigured once, rather than cloned for
PwrAgent:

```bash
./runner/migrate-persistent-runner-to-org.sh
```

The migration stops the listener, deletes its old repo registration, clears
the local config, and starts the same Tart VM as the shared organization
runner. It does not delete the VM or runner base image.

**Always-on via launchd (recommended once the lane matters):**

```bash
./runner/install-launch-agent.sh
```

Installs + loads `com.pwrsnap.gha-runner` (user LaunchAgent):
RunAtLoad + KeepAlive, so the runner starts at login, boots the VM if
it's stopped, and the listener restarts after runner self-updates or
crashes. Logs to `~/pwrsnap-mac-vm/.runner-agent.log`. Stop with
`launchctl bootout gui/$UID/com.pwrsnap.gha-runner` (plus
`tart stop pwrsnap-runner` to drop the VM). Do NOT also run
`run-persistent-runner.sh` by hand while the agent is loaded — GitHub
allows one live session per registered runner, so the second listener
just errors.

Why not just background the script from a terminal: the VM's `tart
run` process lives in that shell's process group, so closing the
session (or a supervisor killing the task tree) takes the whole VM
down with it — launchd owning the tree is the fix, not `nohup`.

Operational note: the CI lane only functions while a runner is
listening. If none is, queued `desktop-e2e-macos` jobs sit up to 24h
and fail — keep the lane's workflow job non-required (or the runner
always-on via launchd) accordingly. A persistent runner that's offline
stays registered (shows offline in organization Settings → Actions → Runners);
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
