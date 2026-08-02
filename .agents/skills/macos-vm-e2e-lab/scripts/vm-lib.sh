#!/usr/bin/env bash
# Shared helpers for PwrSnap macOS VM management (Tart).
# Source this from the other scripts; do not run directly.

set -euo pipefail

TART=${TART:-tart}
VM_DEV=${VM_DEV:-pwrsnap-dev}
VM_BASE=${VM_BASE:-pwrsnap-sequoia-base}
SSH_KEY="$HOME/pwrsnap-mac-vm/id_ed25519"
SSH_USER=admin
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5)

vm_exists() { "$TART" list --format json | /usr/bin/python3 -c "import json,sys;print(any(v['Name']==sys.argv[1] for v in json.load(sys.stdin)))" "$1" | grep -q True; }

vm_running() { "$TART" list --format json | /usr/bin/python3 -c "import json,sys;print(any(v['Name']==sys.argv[1] and v.get('State')=='running' for v in json.load(sys.stdin)))" "$1" | grep -q True; }

vm_start_headless() {
  local vm=$1
  if vm_running "$vm"; then return 0; fi
  # --vnc-experimental + --no-graphics: the VNC server gives the guest a
  # display device, and --no-graphics stops tart from auto-opening the
  # vnc:// URL in Screen Sharing (without it, every VM boot leaks a
  # host Screen Sharing window that sticks at "Reconnecting..." after
  # the VM stops). Guest resolution is handled in-guest by ~/bin/setres
  # (see provision-dev.sh), not by the viewer. The vnc:// URL for
  # peeking lands in the .run.log.
  echo ">> starting $vm (headless, vnc display)"
  nohup "$TART" run "$vm" --vnc-experimental --no-graphics >"$HOME/pwrsnap-mac-vm/.$vm.run.log" 2>&1 &
  disown || true
}

vm_wait_ip() {
  local vm=$1 tries=${2:-60} ip=""
  for _ in $(seq 1 "$tries"); do
    ip=$("$TART" ip "$vm" 2>/dev/null || true)
    if [[ -n "$ip" ]]; then echo "$ip"; return 0; fi
    sleep 2
  done
  echo "timed out waiting for $vm IP" >&2
  return 1
}

vm_wait_ssh() {
  local ip=$1 tries=${2:-60}
  for _ in $(seq 1 "$tries"); do
    if ssh "${SSH_OPTS[@]}" "$SSH_USER@$ip" true 2>/dev/null; then return 0; fi
    sleep 2
  done
  echo "timed out waiting for ssh on $ip" >&2
  return 1
}

vm_ssh() {
  local vm=$1; shift
  local ip
  ip=$(vm_wait_ip "$vm")
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$ip" "$@"
}

# One-time: install our pubkey into a VM that still uses password auth
# (cirruslabs images: admin/admin). Uses the built-in expect.
vm_install_key() {
  local vm=$1 ip
  ip=$(vm_wait_ip "$vm")
  [[ -f $SSH_KEY ]] || ssh-keygen -t ed25519 -N "" -f "$SSH_KEY" -C "pwrsnap-mac-vm"
  if ssh "${SSH_OPTS[@]}" "$SSH_USER@$ip" true 2>/dev/null; then
    echo ">> key auth already works for $vm"
    return 0
  fi
  local pub
  pub=$(cat "$SSH_KEY.pub")
  /usr/bin/expect <<EOF
set timeout 30
spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null $SSH_USER@$ip "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$pub' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
expect {
  -re "assword:" { send "admin\r"; exp_continue }
  eof {}
}
EOF
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$ip" true
  echo ">> key installed for $vm"
}
