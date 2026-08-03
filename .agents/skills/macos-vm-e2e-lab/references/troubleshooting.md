# Troubleshooting the macOS VM E2E lab

Full write-ups of the failure modes hit while building this lab
(2026-08-01, first brought up on the M-series Mac Studio host). Each
section: symptom → root cause → fix.

## Display stuck at 1024x768 / specs fail with `innerHeight: 684`

**Symptom.** Layout-sensitive specs (`library-day-header-overlap`,
`library-focus-scroll`, `recording-flow`, …) fail with the fixture
unable to reach a 1440x900 window: `innerHeight` pins at 684 (= 768
minus menu bar). `tart get <vm>` shows `1920x1080` — looks configured,
isn't real.

**Root cause.** Virtualization.framework macOS guests auto-reconfigure
their display to whatever viewer attaches. Headless (`--no-graphics`,
or `--vnc-experimental` with no client connected) there is NO display
device at all, and the guest WindowServer falls back to a 1024x768
framebuffer. `tart set --display` is a hint for viewers, not a boot
resolution. AppKit clamps window HEIGHT to the visible screen frame
(width may overflow), which is why only innerHeight pins.

**Fix.** Switch the mode from inside the guest via CoreGraphics.
`provision-dev.sh` compiles this to `~/bin/setres` in the VM and
installs LaunchAgent `com.pwrsnap.setres` (RunAtLoad, Aqua session) so
every boot self-corrects; `run-e2e.sh` also calls it at job start.
The mode list of the virtual display includes 1920x1080 — verify with:

```bash
ssh <vm> 'swift -e "import CoreGraphics; print(CGDisplayBounds(CGMainDisplayID()))"'
```

Expect `(0.0, 0.0, 1920.0, 1080.0)`. If you need a different
resolution, edit the wanted mode in the setres source inside
`provision-dev.sh` and re-provision — pick from the guest's own
`CGDisplayCopyAllDisplayModes` list.

**Do not** probe with `system_profiler SPDisplaysDataType` — it returns
an empty array in VF guests in every mode, even with a window attached.

## Host can't reach any VM: ping 100% loss, SSH "No route to host"

**Symptom.** `tart ip` returns an address on 192.168.64.x and `arp -a`
shows the VM's MAC resolved on `bridge100`, but ping gets 100% packet
loss and `ssh`/`nc` report "No route to host" / connection refused.
`provision-dev.sh` dies at the key-install step with exactly this.

**Root cause.** macOS Local Network privacy (TCC) on Sequoia and later.
The VM NAT subnet counts as "local network", and the *responsible app*
for your shell (Terminal, iTerm, the Claude/Codex desktop app when an
agent runs the scripts) must hold the Local Network permission. ARP
works because the filter drops IP traffic only — which is what makes
this look like a guest/sshd problem when it isn't.

**Fix.** System Settings → Privacy & Security → Local Network → enable
the app that owns the shell. The failed connection attempts add the app
to that list; if it's already listed and ON, toggle it off/on, and if
the block persists restart the app (permission is read at process
start). Identify the responsible app by walking `ps -o ppid=,comm= -p`
ancestry from your shell upward.

## Provisioning "succeeds" but nvm/repo/tmux missing in the VM

**Symptom.** `provision-dev.sh` exits 0 but the VM has no `~/.nvm`, no
`~/PwrSnap`. Or: the script dies with `curl: (56) Failure writing
output to destination`.

**Root cause (1).** The provisioning body is fed to `ssh … 'bash -s'`
on stdin. Any command in it that reads stdin — `brew install` is the
classic — consumes the REST OF THE SCRIPT as its own input. bash never
sees those lines; nothing errors.

**Fix (1).** `</dev/null` on every stdin-hungry command inside any
`bash -s` heredoc payload. Grep the bundled scripts for `</dev/null`
to see the pattern before adding new provisioning steps.

**Root cause (2).** `curl … | bash </dev/null` — the redirect on
`bash` overrides the pipe, curl gets EPIPE (error 56).

**Fix (2).** Download to a temp file, then `bash /tmp/file </dev/null`.

## E2E reports exit 0 despite failed tests

**Symptom.** Log ends `10 failed` but the harness says exit 0.

**Root cause.** The tmux command was `job.sh | tee log; echo $? >
exit` — `$?` is tee's status, and without `pipefail` the pipeline
reports the last command.

**Fix.** Already in `run-e2e.sh`: the tmux session runs
`bash -c 'set -o pipefail; ~/e2e-job.sh 2>&1 | tee ~/log; echo $? > ~/log.exit'`.

## `brew: command not found` over SSH

Non-interactive SSH shells don't source the profile that adds
`/opt/homebrew/bin`. Every remote script must start with
`eval "$(/opt/homebrew/bin/brew shellenv)"`.

## softnet: VM won't boot with `--net-softnet`, or isolation probe fails

- `tart run --net-softnet` errors about privileges → the sudoers entry
  is missing. Human must run (their password required):
  `echo "$USER ALL=(ALL) NOPASSWD: $(brew --prefix)/bin/softnet" | sudo tee /etc/sudoers.d/softnet`
  Verify: `sudo -n $(brew --prefix)/bin/softnet --help` exits 0.
- Isolation probe fails ("VM can reach private address space") → do NOT
  register the runner. Check that the VM was actually started with
  `--net-softnet` (a plain restart of a cached VM may have dropped it)
  and that softnet is the brew-installed binary the sudoers rule names.
- No internet inside the VM under softnet → check host firewall/VPN.
  Corporate VPNs that hijack DNS can break the guest's resolver.

## CI checkout dies: `git-lfs filter-process: git-lfs: command not found`

**Symptom.** The job's "Checkout repository" step fails with
`git-lfs: command not found` → `fatal: the remote end hung up
unexpectedly` → git exit 128. Starts happening the moment any branch
tracks files with `filter=lfs` in `.gitattributes` (checkout of the PR
merge ref applies the PR's attributes, so the trigger can arrive "from
outside" via any PR that adopts LFS).

**Root cause.** actions-runner snapshots PATH into
`~/actions-runner/.path` at `config.sh` time and hands that PATH to
every job. Registered over a bare non-interactive SSH shell, that
snapshot is `/usr/bin:/bin:/usr/sbin:/sbin` — no `/opt/homebrew/bin`,
so no brew tool (git-lfs is merely the first casualty) exists for any
job step. The binary IS in the VM; jobs just can't see it.

**Fix.** Both runner scripts now `eval "$(/opt/homebrew/bin/brew
shellenv)"` before `config.sh`, and the persistent script rewrites
`.path` on every boot (self-heals runners registered before the fix).
To heal a live runner without waiting for a re-boot:

```bash
ssh <runner-vm> 'eval "$(/opt/homebrew/bin/brew shellenv)"; echo "$PATH" > ~/actions-runner/.path'
```

then restart the listener (`launchctl kickstart -k
gui/$UID/com.pwrsnap.gha-runner`) — `.path` is read per job, but a
restart makes the state unambiguous.

## `run-e2e.sh --local` push dies: `git-lfs-authenticate: exit status 127`

**Symptom.** The `--local` push into the VM fails with
`batch request: zsh:1: command not found: git-lfs-authenticate` →
`error: failed to push some refs`.

**Root cause.** The repo tracks files with LFS (visual-regression
`.webp` snapshots). The VM is a plain SSH remote — there is no LFS
server behind it, and `git-lfs-authenticate` is a *server-side*
command that only LFS-hosting servers (GitLab shell, Gitea, …)
provide. No PATH fix can make the upload work; the endpoint doesn't
exist.

**Fix.** `run-e2e.sh` sets `GIT_LFS_SKIP_PUSH=1` on the `--local`
push, so refs go over SSH while LFS objects don't. The VM's checkout
smudges LFS content from its own `origin` (GitHub) instead. Caveat:
an LFS object committed locally but never pushed to origin cannot
materialize in the VM — push the object to origin (any branch) first.

## Runner registration 403 / token fetch fails

`gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token`
needs repo admin. Check `gh auth status`, and that the token has the
`repo` scope (classic) or actions:write (fine-grained).

## SSH key auth stops working after re-cloning a VM

Clones inherit `authorized_keys` from their source, so clones of
`pwrsnap-dev` / `pwrsnap-runner-base` are fine. A clone of the PRISTINE
base has only password auth (`admin`/`admin`) — `vm-lib.sh`'s
`vm_install_key` handles the one-time key install via expect. If SSH
prompts for a password interactively, you're talking to a pristine
clone before key install.

## Both VMs won't start / second VM hangs at boot

Apple's Virtualization.framework allows at most 2 concurrent macOS
guests per host. `tart list` to see what's running; stop something.
Remember the ephemeral runner loop holds one slot while serving.

## Visibility flakes / vanished tmux session / mid-suite guest reboot

**Symptom.** `dock-lifecycle.spec.ts:116` or `tray-sizing.spec.ts`
visibility assertions fail intermittently in FULL-suite runs (pass
isolated). Worst case: a run dies partway, the `e2e` tmux session is
gone, and nothing wrote `~/e2e-*.log.exit`.

**Root cause (found 2026-08-01, separate investigation session).** The
VM's AppleParavirtGPU resets under the suite's Electron GPU-process
load — kernel `gpuRestart` reports appear in the guest's
`/Library/Logs/DiagnosticReports/` naming Electron Helper. Each reset
stalls WindowServer, so first paints land seconds late and
visibility-state assertions read stale answers. A storm of resets can
panic the guest kernel → mid-suite reboot (that's the vanished tmux
session).

**Fix.** Run the suite on software rendering: `run-e2e.sh` exports
`PWRSNAP_E2E_DISABLE_GPU=1` (app-side env gate; SwiftShader). Suite
runs clean (~2.5 min) with zero gpuRestarts. The specs were also
hardened to establish visibility preconditions.

**Diagnosis recipe for a dead run:** `sysctl kern.boottime` newer than
the run log's mtime = the guest rebooted under you; then check the
DiagnosticReports for gpuRestart/panic. Full write-up:
`docs/solutions/2026-08-01-vm-e2e-window-visibility-flakes.md`.
