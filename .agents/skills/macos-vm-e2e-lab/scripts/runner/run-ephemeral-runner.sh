#!/usr/bin/env bash
# Serve GitHub Actions jobs from ephemeral, network-isolated macOS VMs in the
# restricted PwrDrvr organization runner group shared by PwrSnap and PwrAgent.
#
# Loop: clone pwrsnap-runner-base -> ephemeral VM -> boot with softnet
# isolation (internet OK, RFC1918/local network BLOCKED) -> register as an
# --ephemeral runner -> serve exactly ONE job -> destroy the VM -> repeat.
# A fork PR that lands on this runner gets a throwaway VM with no line of
# sight to the LAN, and the VM is deleted the moment the job ends.
#
# Prereqs:
#   - ./runner/provision-runner-base.sh has been run
#   - gh CLI authenticated with organization runner-management permission
#   - passwordless sudo for softnet (one-time, needs YOUR password):
#       echo "$USER ALL=(ALL) NOPASSWD: $(brew --prefix)/bin/softnet" | \
#         sudo tee /etc/sudoers.d/softnet
#
# Usage: ./run-ephemeral-runner.sh [--once]

set -euo pipefail
RUNNER_SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$RUNNER_SCRIPT_DIR/.."
source ./vm-lib.sh

ORGANIZATION=pwrdrvr
RUNNER_GROUP="PwrDrvr macOS"
BASE=pwrsnap-runner-base
LABELS="pwrdrvr-macos"
ONCE=${1:-}

"$RUNNER_SCRIPT_DIR/configure-shared-runner-group.sh"

serve_one_job() {
  local vm="pwrsnap-runner-$(date +%s)"
  local rc=0

  echo ">> [$vm] cloning from $BASE"
  "$TART" clone "$BASE" "$vm"

  cleanup() {
    echo ">> [$vm] destroying"
    "$TART" stop "$vm" 2>/dev/null || true
    "$TART" delete "$vm" 2>/dev/null || true
  }
  trap cleanup RETURN

  echo ">> [$vm] booting with softnet isolation"
  nohup "$TART" run "$vm" --vnc-experimental --no-graphics --net-softnet \
    >"$HOME/pwrsnap-mac-vm/.$vm.run.log" 2>&1 &
  disown || true

  local ip
  ip=$(vm_wait_ip "$vm") || return 1
  vm_wait_ssh "$ip" || return 1

  # Sanity: isolation must actually hold before we hand the VM a job.
  echo ">> [$vm] verifying network isolation"
  if ssh "${SSH_OPTS[@]}" "$SSH_USER@$ip" \
      "curl -m 5 -so /dev/null http://192.168.1.1 || nc -z -G 3 10.0.0.1 22" 2>/dev/null; then
    echo "!! [$vm] VM can reach private address space - softnet not active? ABORTING." >&2
    return 1
  fi
  if ! ssh "${SSH_OPTS[@]}" "$SSH_USER@$ip" "curl -m 10 -so /dev/null https://api.github.com"; then
    echo "!! [$vm] VM has no internet - softnet misconfigured? ABORTING." >&2
    return 1
  fi

  echo ">> [$vm] fetching registration token"
  local token
  token=$(gh api -X POST "orgs/$ORGANIZATION/actions/runners/registration-token" -q .token)

  echo ">> [$vm] registering ephemeral runner + serving one job"
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$ip" \
    "TOKEN=$(printf %q "$token") VMNAME=$(printf %q "$vm") LABELS=$(printf %q "$LABELS") RUNNER_GROUP=$(printf %q "$RUNNER_GROUP") bash -s" <<'REMOTE' || rc=$?
set -euo pipefail
# Homebrew on PATH before config.sh — the runner snapshots PATH into
# .path at configure time for every job (git-lfs et al live in
# /opt/homebrew/bin). See run-persistent-runner.sh for the war story.
eval "$(/opt/homebrew/bin/brew shellenv)"
cd ~/actions-runner
./config.sh --unattended --ephemeral \
  --url https://github.com/pwrdrvr \
  --token "$TOKEN" \
  --name "$VMNAME" \
  --runnergroup "$RUNNER_GROUP" \
  --labels "$LABELS" \
  --replace
./run.sh
REMOTE

  echo ">> [$vm] job cycle finished (rc=$rc)"
  return 0
}

while true; do
  serve_one_job || { echo ">> cycle failed; backing off 30s"; sleep 30; }
  [[ "$ONCE" == "--once" ]] && break
done
