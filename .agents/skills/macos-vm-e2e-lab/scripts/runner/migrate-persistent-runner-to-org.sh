#!/usr/bin/env bash
# One-time migration for a persistent runner that was originally configured
# directly against pwrdrvr/PwrSnap. Stop the listener, remove its repo runner
# registration, clear the local config, then let the normal persistent script
# register it into the selected-repository organization group.

set -euo pipefail

RUNNER_SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$RUNNER_SCRIPT_DIR/.."
source ./vm-lib.sh

ORGANIZATION=pwrdrvr
LEGACY_REPOSITORY=pwrdrvr/PwrSnap
VM=pwrsnap-runner
LAUNCH_AGENT=com.pwrsnap.gha-runner

"$RUNNER_SCRIPT_DIR/configure-shared-runner-group.sh"

if ! vm_exists "$VM"; then
  echo "$VM does not exist; there is no persistent runner to migrate." >&2
  exit 1
fi

IP=$(vm_wait_ip "$VM")
RUNNER_NAME=$(ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" 'python3 - <<'"'"'PY'"'"'
import json
from pathlib import Path
path = Path.home() / "actions-runner" / ".runner"
if path.exists():
    print(json.loads(path.read_text(encoding="utf-8-sig")).get("agentName", ""))
PY')
if [[ -z "$RUNNER_NAME" ]]; then
  echo "$VM has no local Actions runner configuration; start the shared runner normally." >&2
  exit 1
fi

echo ">> stopping existing launchd listener $LAUNCH_AGENT"
launchctl bootout "gui/$(id -u)/$LAUNCH_AGENT" 2>/dev/null || true

RUNNER_ID=$(gh api "repos/$LEGACY_REPOSITORY/actions/runners?per_page=100" \
  --jq ".runners[] | select(.name == \"$RUNNER_NAME\") | .id" || true)
if [[ -n "$RUNNER_ID" ]]; then
  echo ">> removing legacy repository runner registration: $RUNNER_NAME ($RUNNER_ID)"
  gh api --method DELETE "repos/$LEGACY_REPOSITORY/actions/runners/$RUNNER_ID" >/dev/null
fi

echo ">> clearing local repository runner configuration"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" \
  'pkill -f Runner.Listener 2>/dev/null || true; cd ~/actions-runner && ./config.sh remove --local'

echo ">> starting the shared organization runner through launchd"
# The lab scripts must be copied into ~/pwrsnap-mac-vm before this migration:
# install-launch-agent.sh deliberately points launchd there rather than back
# into a disposable source checkout. It owns the listener after this command
# exits, including across terminal closes and host restarts.
"$RUNNER_SCRIPT_DIR/install-launch-agent.sh"
