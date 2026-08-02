#!/usr/bin/env bash
# Run the PwrSnap desktop Playwright E2E suite inside the pwrsnap-dev VM,
# in a tmux session (survives ssh disconnect; windows render on the VM's
# own display, never on the host).
#
# Usage:
#   ./run-e2e.sh <branch> [playwright-args...]         # branch pushed to origin
#   ./run-e2e.sh --local [repo-path] [playwright-args...]
# Examples:
#   ./run-e2e.sh main
#   ./run-e2e.sh claude/some-branch --grep "clipboard"
#   ./run-e2e.sh --local . smoke.spec.ts
#
# --local pushes the repo's current HEAD (committed state only —
# uncommitted changes do NOT travel) straight into the VM over SSH as
# branch `e2e-local`, so unpushed work can be tested without touching
# origin (the repo is public; don't push WIP there just to test).
#
# Attach to watch live TUI:  ssh into VM, `tmux attach -t e2e`
# Watch the VM's screen:     tart run pwrsnap-dev  (opens its window) or VNC

set -euo pipefail
cd "$(dirname "$0")"
source ./vm-lib.sh

LOCAL_REPO=""
LOCAL_FLAG=0
if [[ ${1:-} == "--local" ]]; then
  shift
  if [[ $# -gt 0 && -e ${1}/.git ]]; then
    LOCAL_REPO=$(cd "$1" && pwd)
    shift
  else
    LOCAL_REPO=$PWD
  fi
  [[ -e $LOCAL_REPO/.git ]] || { echo "!! --local: $LOCAL_REPO is not a git repo/worktree" >&2; exit 1; }
  LOCAL_FLAG=1
  BRANCH=e2e-local
else
  BRANCH=${1:?usage: run-e2e.sh <branch>|--local [repo-path] [playwright-args...]}
  shift || true
fi
EXTRA_ARGS=${*:-}

VM=${VM:-$VM_DEV}
vm_start_headless "$VM"
IP=$(vm_wait_ip "$VM")
vm_wait_ssh "$IP"

STAMP=$(date +%Y%m%d-%H%M%S)
LOG="e2e-$STAMP.log"

if [[ $LOCAL_FLAG == 1 ]]; then
  echo ">> pushing local HEAD of $LOCAL_REPO into VM branch 'e2e-local'"
  GIT_SSH_COMMAND="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" \
    git -C "$LOCAL_REPO" push -q -f "$SSH_USER@$IP:PwrSnap" HEAD:refs/heads/e2e-local
fi

echo ">> launching E2E for branch '$BRANCH' in tmux session 'e2e' on $VM ($IP)"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" "BRANCH=$(printf %q "$BRANCH") LOCAL=$(printf %q "$LOCAL_FLAG") LOG=$(printf %q "$LOG") EXTRA_ARGS=$(printf %q "$EXTRA_ARGS") bash -s" <<'REMOTE'
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
if [ "$LOCAL" = "1" ]; then
  # branch was pushed into this repo over SSH; detached checkout so
  # e2e-local is never the checked-out branch (keeps future pushes legal)
  git checkout -f --detach e2e-local
else
  git fetch origin --prune
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
fi
nvm install >/dev/null && nvm use
corepack enable >/dev/null 2>&1 || true
pnpm install
pnpm rebuild:electron-native
pnpm --filter @pwrsnap/desktop build
cd apps/desktop
# Software rendering inside the VM: AppleParavirtGPU GPU-resets under
# the suite's Electron GPU submissions (kernel gpuRestart reports →
# WindowServer stalls → paint-latency flakes; worst case panics the
# guest into a mid-suite reboot). SwiftShader avoids the paravirt GPU.
# See PwrSnap docs/solutions/2026-08-01-vm-e2e-window-visibility-flakes.md.
export PWRSNAP_E2E_DISABLE_GPU=1
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
