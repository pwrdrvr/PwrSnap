#!/usr/bin/env bash
# Install (or reinstall) the launchd agent that keeps the persistent
# GHA runner alive: starts at login, boots the runner VM if stopped,
# restarts the listener when it exits (runner self-updates, VM
# hiccups). This is what makes the CI lane survive reboots and
# closed terminal sessions.
#
# Usage: ./install-launch-agent.sh
# Logs:  ~/pwrsnap-mac-vm/.runner-agent.log
# Stop:  launchctl bootout gui/$UID/com.pwrsnap.gha-runner
#        (then `tart stop pwrsnap-runner` if you want the VM down too)

set -euo pipefail

LABEL=com.pwrsnap.gha-runner
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT="$HOME/pwrsnap-mac-vm/runner/run-persistent-runner.sh"

[[ -x $SCRIPT ]] || { echo "!! $SCRIPT missing/not executable - copy the lab scripts first" >&2; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SCRIPT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd default PATH lacks /opt/homebrew/bin (tart, gh, softnet) -->
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$HOME/pwrsnap-mac-vm/.runner-agent.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/pwrsnap-mac-vm/.runner-agent.log</string>
</dict>
</plist>
PLIST

# Reload if already present, else load fresh.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo ">> $LABEL loaded. Watch: tail -f ~/pwrsnap-mac-vm/.runner-agent.log"
