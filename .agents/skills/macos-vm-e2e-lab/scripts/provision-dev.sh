#!/usr/bin/env bash
# Create + provision the interactive dev/test VM (pwrsnap-dev) from the
# pristine pulled base image. Idempotent — safe to re-run.
#
# Usage: ./provision-dev.sh [vm-name]

set -euo pipefail
cd "$(dirname "$0")"
source ./vm-lib.sh

VM=${1:-$VM_DEV}

if ! vm_exists "$VM"; then
  echo ">> cloning $VM_BASE -> $VM"
  "$TART" clone "$VM_BASE" "$VM"
  # 8 cores / 16GB is comfortable for build + headed Electron E2E;
  # host has 18 cores / 64GB.
  # 1920x1080 display: several specs drive 1440x900 windows; the tart
  # default of 1024x768 clamps them and fails layout assertions.
  "$TART" set "$VM" --cpu 8 --memory 16384 --display 1920x1080
fi

vm_start_headless "$VM"
IP=$(vm_wait_ip "$VM")
echo ">> $VM is at $IP"
vm_install_key "$VM"
vm_wait_ssh "$IP"

echo ">> provisioning inside VM"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" 'bash -s' <<'PROVISION'
set -euo pipefail
export NONINTERACTIVE=1
eval "$(/opt/homebrew/bin/brew shellenv)"

echo "== host: $(sw_vers -productVersion) $(uname -m)"

# Xcode CLT (cirruslabs base images ship it for brew; verify)
xcode-select -p >/dev/null 2>&1 || { echo "Xcode CLT missing - install manually"; exit 1; }

# tmux
if ! command -v tmux >/dev/null 2>&1; then brew install tmux </dev/null; fi

# The macOS CI lane does not compare Linux visual goldens, but Git still
# needs this filter available to check out their LFS pointers.
if ! command -v git-lfs >/dev/null 2>&1; then brew install git-lfs </dev/null; fi

# Display resolution: Virtualization.framework guests boot at a
# 1024x768 fallback framebuffer when headless (tart's --display is
# only honored by an attached viewer), and several specs drive
# 1440x900 windows. Compile a tiny CoreGraphics mode-setter and run
# it at every GUI login.
if [ ! -x "$HOME/bin/setres" ]; then
  mkdir -p "$HOME/bin"
  cat > /tmp/setres.swift <<'SWIFT'
import CoreGraphics
let d = CGMainDisplayID()
let modes = CGDisplayCopyAllDisplayModes(d, nil) as! [CGDisplayMode]
guard let m = modes.first(where: { $0.width == 1920 && $0.height == 1080 }) else {
  fputs("setres: no 1920x1080 mode available\n", stderr)
  exit(1)
}
var cfg: CGDisplayConfigRef?
CGBeginDisplayConfiguration(&cfg)
CGConfigureDisplayWithDisplayMode(cfg, d, m, nil)
exit(CGCompleteDisplayConfiguration(cfg, .permanently) == .success ? 0 : 2)
SWIFT
  swiftc -O /tmp/setres.swift -o "$HOME/bin/setres"
fi
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/com.pwrsnap.setres.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.pwrsnap.setres</string>
  <key>ProgramArguments</key><array><string>$HOME/bin/setres</string></array>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict></plist>
PLIST
"$HOME/bin/setres" || true

# nvm + pinned node
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  mkdir -p "$NVM_DIR"
  curl -fsSLo /tmp/nvm-install.sh https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh
  bash /tmp/nvm-install.sh </dev/null
fi
source "$NVM_DIR/nvm.sh"

# repo
if [ ! -d "$HOME/PwrSnap/.git" ]; then
  git clone https://github.com/pwrdrvr/PwrSnap.git "$HOME/PwrSnap" </dev/null
fi
cd "$HOME/PwrSnap"
git fetch origin --prune </dev/null

NODE_VER=$(cat .nvmrc)
nvm install "$NODE_VER" </dev/null >/dev/null
nvm alias default "$NODE_VER" >/dev/null
nvm use "$NODE_VER" >/dev/null
corepack enable >/dev/null 2>&1 || true

echo "== node: $(node -v)  pnpm: $(corepack pnpm --version 2>/dev/null || echo pending)"
echo "== provision complete"
PROVISION

echo ""
echo ">> done. Next: ./run-e2e.sh <branch> [playwright-grep-pattern]"
echo ">> interactive shell: ssh -i $SSH_KEY $SSH_USER@$IP"
