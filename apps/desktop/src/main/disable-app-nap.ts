// Opt this process out of macOS App Nap.
//
// App Nap suspends / throttles a process that has NO visible window and
// isn't frontmost — exactly the state the capture agent sits in
// permanently (its windows — tray popover, float-over, standby
// selectors — are all hidden), and the state combined mode falls into
// whenever the Library window is closed. A napped process wakes slowly,
// so the global capture hotkey (⌘⇧C) pays a ~0.5–1s wake-up tax: the OS
// has to spin the process back up before it even runs the globalShortcut
// callback, and only THEN does the (fast, ~280ms) snapshot → picker
// pipeline run. The latency is entirely upstream of anything we can log.
//
// `NSAppSleepDisabled` is the targeted opt-out: it disables App Nap for
// this app WITHOUT preventing system idle sleep. We deliberately do NOT
// use `powerSaveBlocker('prevent-app-suspension')` — on macOS that
// asserts `kIOPMAssertPreventUserIdleSystemSleep`, which keeps the whole
// machine awake (battery drain) and is far heavier than we need.
//
// Only the process that owns the global hotkeys + capture pipeline needs
// this (agent / combined). The library process owns no hotkeys, so a
// napped library never affects capture latency — leave it nap-eligible.
// macOS-only; no-op elsewhere.

import { systemPreferences } from "electron";
import { getMainLogger } from "./log";

export function disableAppNap(): void {
  if (process.platform !== "darwin") return;
  const log = getMainLogger("pwrsnap:app-nap");
  try {
    systemPreferences.setUserDefault("NSAppSleepDisabled", "boolean", true);
    log.info("App Nap disabled for this process (NSAppSleepDisabled=true)");
  } catch (cause) {
    log.warn("failed to disable App Nap", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}
