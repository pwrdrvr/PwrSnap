#!/usr/bin/env bash
# Run the PwrSnap desktop Playwright E2E suite inside the pwrsnap-dev VM,
# in a tmux session (survives ssh disconnect; windows render on the VM's
# own display, never on the host).
#
# Usage:
#   ./run-e2e.sh <branch> [playwright-args...]
# Examples:
#   ./run-e2e.sh main
#   ./run-e2e.sh claude/some-branch --grep "clipboard"
#
# Attach to watch live TUI:  ssh into VM, `tmux attach -t e2e`
# Watch the VM's screen:     tart run pwrsnap-dev  (opens its window) or VNC

set -euo pipefail
cd "$(dirname "$0")"
source ./vm-lib.sh

BRANCH=${1:?usage: run-e2e.sh <branch> [playwright-args...]}
shift || true
EXTRA_ARGS=${*:-}

VM=${VM:-$VM_DEV}
vm_start_headless "$VM"
IP=$(vm_wait_ip "$VM")
vm_wait_ssh "$IP"

STAMP=$(date +%Y%m%d-%H%M%S)
LOG="e2e-$STAMP.log"

echo ">> launching E2E for branch '$BRANCH' in tmux session 'e2e' on $VM ($IP)"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" "BRANCH=$(printf %q "$BRANCH") LOG=$(printf %q "$LOG") EXTRA_ARGS=$(printf %q "$EXTRA_ARGS") bash -s" <<'REMOTE'
set -euo pipefail
eval "$(/opt/homebrew/bin/brew shellenv)"
if tmux has-session -t e2e 2>/dev/null; then
  echo "!! tmux session 'e2e' already exists (a run may be in progress)."
  echo "   attach: tmux attach -t e2e   kill: tmux kill-session -t e2e"
  exit 2
fi
cat > ~/e2e-job.sh <<JOB
#!/bin/bash
set -x
eval "\$(/opt/homebrew/bin/brew shellenv)"
[ -x "\$HOME/bin/setres" ] && "\$HOME/bin/setres" || true
export NVM_DIR="\$HOME/.nvm"
source "\$NVM_DIR/nvm.sh"
cd ~/PwrSnap
git fetch origin --prune
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
nvm install >/dev/null && nvm use
corepack enable >/dev/null 2>&1 || true
pnpm install
pnpm rebuild:electron-native
pnpm --filter @pwrsnap/desktop build
cd apps/desktop
pnpm exec playwright test -c playwright.config.ts $EXTRA_ARGS
JOB
chmod +x ~/e2e-job.sh
tmux new-session -d -s e2e "bash -c 'set -o pipefail; ~/e2e-job.sh 2>&1 | tee ~/$LOG; echo \$? > ~/$LOG.exit'"
echo ">> started; log: ~/$LOG"
REMOTE

echo ">> tailing log (Ctrl-C detaches; the run keeps going in tmux)"
RC=0
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" "touch ~/$LOG; tail -f ~/$LOG & TAIL=\$!; while [ ! -f ~/$LOG.exit ]; do sleep 2; done; sleep 1; kill \$TAIL 2>/dev/null; exit \$(cat ~/$LOG.exit)" || RC=$?

echo ">> E2E exited with code $RC"
if [ "$RC" -ne 0 ]; then
  echo ">> fetching playwright artifacts..."
  mkdir -p "artifacts/$STAMP"
  scp -r "${SSH_OPTS[@]}" "$SSH_USER@$IP:~/PwrSnap/apps/desktop/test-results" "artifacts/$STAMP/" 2>/dev/null || true
  echo ">> artifacts (if any): $HOME/pwrsnap-mac-vm/artifacts/$STAMP"
fi
exit "$RC"
