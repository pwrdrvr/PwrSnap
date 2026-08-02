#!/usr/bin/env bash
# Open a DURABLE Screen Sharing session to a lab VM.
#
# Connects to the guest's built-in Screen Sharing service (port 5900,
# admin/admin) at the VM's DHCP address — which is stable across VM
# restarts because tart pins the VM's MAC. Screen Sharing's own
# "reconnect" works after a VM recycle, unlike tart's --vnc-experimental
# URL (random port + password every boot; use that only for recovery /
# pre-login screens).
#
# Usage: ./vnc.sh [vm-name]   (default: pwrsnap-dev)

set -euo pipefail
VM=${1:-pwrsnap-dev}
IP=$(tart ip "$VM")
exec open "vnc://admin:admin@$IP"
