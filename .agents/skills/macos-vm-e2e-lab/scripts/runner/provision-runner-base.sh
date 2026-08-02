#!/usr/bin/env bash
# Build the golden image for ephemeral GHA runner VMs: pwrsnap-runner-base.
# Starts from the provisioned dev image so node/pnpm/repo cache are warm,
# and layers the GitHub Actions runner binary on top. Never registers it —
# registration happens per-ephemeral-clone in run-ephemeral-runner.sh.
#
# Usage: ./provision-runner-base.sh [runner-version]

set -euo pipefail
cd "$(dirname "$0")/.."
source ./vm-lib.sh

RUNNER_VM=pwrsnap-runner-base
RUNNER_VERSION=${1:-}   # empty = latest

if ! vm_exists "$RUNNER_VM"; then
  if ! vm_exists "$VM_DEV"; then
    echo "!! $VM_DEV does not exist - run ./provision-dev.sh first" >&2
    exit 1
  fi
  if vm_running "$VM_DEV"; then
    echo "!! stop $VM_DEV before cloning it (tart stop $VM_DEV)" >&2
    exit 1
  fi
  echo ">> cloning $VM_DEV -> $RUNNER_VM"
  "$TART" clone "$VM_DEV" "$RUNNER_VM"
  "$TART" set "$RUNNER_VM" --cpu 8 --memory 16384 --display 1920x1080
fi

vm_start_headless "$RUNNER_VM"
IP=$(vm_wait_ip "$RUNNER_VM")
vm_wait_ssh "$IP"

echo ">> installing actions runner inside $RUNNER_VM"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" "RUNNER_VERSION=$(printf %q "$RUNNER_VERSION") bash -s" <<'REMOTE'
set -euo pipefail
if [ -z "${RUNNER_VERSION}" ]; then
  RUNNER_VERSION=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | /usr/bin/python3 -c "import json,sys;print(json.load(sys.stdin)['tag_name'].lstrip('v'))")
fi
echo "== actions/runner v${RUNNER_VERSION}"
mkdir -p ~/actions-runner && cd ~/actions-runner
if [ ! -f ./run.sh ]; then
  curl -fsSLo runner.tar.gz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"
  tar xzf runner.tar.gz && rm runner.tar.gz
fi
./config.sh --version || true
echo "== runner staged (not registered)"
REMOTE

echo ">> stopping $RUNNER_VM (golden image should be at rest)"
"$TART" stop "$RUNNER_VM" || true
echo ">> done. Start serving jobs with: ./runner/run-ephemeral-runner.sh"
