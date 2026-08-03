#!/usr/bin/env bash
# Serve GitHub Actions jobs from ONE persistent, network-isolated macOS VM.
#
# This is an organization runner in the restricted "PwrDrvr macOS" group,
# shared only with PwrSnap and PwrAgent. It is deliberately not a repo-scoped
# PwrSnap runner: one softnet-isolated VM can serialize trusted same-repo jobs
# from both desktop projects without maintaining two runner fleets.
#
# This is the default runner mode. Compared to run-ephemeral-runner.sh
# (fresh VM per job), the persistent VM keeps the actions-runner _work
# directory, pnpm store, and node toolchain warm between jobs — no
# re-clone / re-install tax per run — and occupies exactly one of the
# host's two macOS-VM slots, leaving the other free for pwrsnap-dev.
#
# What it keeps from the security model (repo is PUBLIC):
#   - softnet isolation: internet only, RFC1918/host LAN blocked,
#     verified from inside the VM before the runner starts; and
#   - the workflow-side fork-PR guard + "require approval for all
#     external contributors" (jobs only run for same-repo branches).
# What it gives up: the clean-slate-per-job guarantee. Same-repo job
# state can persist inside the VM between runs. If that ever matters
# (or just periodically), re-baseline with:
#     tart stop pwrsnap-runner; tart delete pwrsnap-runner
#   and re-run this script — it re-clones from pwrsnap-runner-base and
#   re-registers under the same runner name (--replace).
#
# A single runner process serves ONE job at a time by construction.
#
# Prereqs: same as the ephemeral loop (runner base image, gh CLI with
# org-runner permission, softnet sudoers entry).
#
# Usage: ./run-persistent-runner.sh        # register if needed, serve until Ctrl-C

set -euo pipefail
RUNNER_SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$RUNNER_SCRIPT_DIR/.."
source ./vm-lib.sh

ORGANIZATION=pwrdrvr
RUNNER_GROUP="PwrDrvr macOS"
BASE=pwrsnap-runner-base
VM=pwrsnap-runner
LABELS="pwrdrvr-macos"
RUNNER_NAME="$(hostname -s)-pwrdrvr-macos-runner"

if ! vm_exists "$VM"; then
  if ! vm_exists "$BASE"; then
    echo "!! $BASE does not exist - run ./runner/provision-runner-base.sh first" >&2
    exit 1
  fi
  echo ">> cloning $BASE -> $VM"
  "$TART" clone "$BASE" "$VM"
fi

if ! vm_running "$VM"; then
  echo ">> booting $VM with softnet isolation"
  nohup "$TART" run "$VM" --vnc-experimental --no-graphics --net-softnet \
    >"$HOME/pwrsnap-mac-vm/.$VM.run.log" 2>&1 &
  disown || true
fi

IP=$(vm_wait_ip "$VM")
vm_wait_ssh "$IP"

echo ">> [$VM] verifying network isolation"
if ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" \
    "curl -m 5 -so /dev/null http://192.168.1.1 || nc -z -G 3 10.0.0.1 22" 2>/dev/null; then
  echo "!! [$VM] VM can reach private address space - softnet not active? ABORTING." >&2
  echo "!! (was the VM booted without --net-softnet earlier? tart stop $VM and retry)" >&2
  exit 1
fi
if ! ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" "curl -m 10 -so /dev/null https://api.github.com"; then
  echo "!! [$VM] VM has no internet - softnet misconfigured? ABORTING." >&2
  exit 1
fi

# Register once; a re-baselined VM (fresh clone) has no .runner and
# re-registers under the same name, replacing the stale entry. Do not silently
# repurpose a repo-scoped configuration: use migrate-persistent-runner-to-org.sh
# so its remote runner record is removed before registration moves scopes.
REGISTERED_URL=$(ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" 'python3 - <<'"'"'PY'"'"'
import json
from pathlib import Path
path = Path.home() / "actions-runner" / ".runner"
if path.exists():
    print(json.loads(path.read_text(encoding="utf-8-sig")).get("gitHubUrl", ""))
PY')
if [[ -n "$REGISTERED_URL" && "$REGISTERED_URL" != "https://github.com/$ORGANIZATION" ]]; then
  echo "!! [$VM] is registered to $REGISTERED_URL, not the shared organization." >&2
  echo "!! Run ./runner/migrate-persistent-runner-to-org.sh once." >&2
  exit 2
fi
if [[ -z "$REGISTERED_URL" ]]; then
  # Group administration is needed only for a first registration or a
  # re-baselined VM. Ordinary launchd restarts retain the local org
  # registration and do not require the broad admin:org token scope.
  "$RUNNER_SCRIPT_DIR/configure-shared-runner-group.sh"
  echo ">> [$VM] registering shared runner '$RUNNER_NAME' (persistent, non-ephemeral)"
  TOKEN=$(gh api -X POST "orgs/$ORGANIZATION/actions/runners/registration-token" -q .token)
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" \
    "TOKEN=$(printf %q "$TOKEN") NAME=$(printf %q "$RUNNER_NAME") LABELS=$(printf %q "$LABELS") RUNNER_GROUP=$(printf %q "$RUNNER_GROUP") bash -s" <<'REMOTE'
set -euo pipefail
# Homebrew on PATH BEFORE config.sh: the runner snapshots PATH into
# .path at configure time and hands that PATH to every job. A bare
# ssh shell's PATH has no /opt/homebrew/bin, which breaks any job
# step that shells out to a brew tool — git-lfs during checkout was
# the first real casualty (LFS smudge -> "git-lfs: command not
# found" -> checkout exit 128).
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/actions-runner
./config.sh --unattended \
  --url https://github.com/pwrdrvr \
  --token "$TOKEN" \
  --name "$NAME" \
  --runnergroup "$RUNNER_GROUP" \
  --labels "$LABELS" \
  --replace
REMOTE
else
  echo ">> [$VM] already registered to shared organization"
fi

echo ">> [$VM] serving jobs (one at a time) — Ctrl-C stops the listener; VM stays up"
echo ">>       stop the VM too with: tart stop $VM"
# Refresh .path on EVERY boot, not just at registration: it self-heals
# runners registered before the brew-shellenv fix above, and keeps job
# PATH correct if the image's brew layout ever moves.
# launchd preserves the Tart process group so a service reload does not shut
# down the VM. That can leave a detached SSH-backed Runner.Listener behind;
# remove it before this service establishes its single listener.
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" \
  'pkill -f "[R]unner.Listener" 2>/dev/null || true'
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" 'eval "$(/opt/homebrew/bin/brew shellenv)"; echo "$PATH" > ~/actions-runner/.path; cd ~/actions-runner && ./run.sh'
