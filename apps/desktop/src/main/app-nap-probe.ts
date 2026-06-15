// DIAGNOSTIC (temporary): directly observe whether this process is being
// throttled / App-Napped while idle — the suspected cause of the slow
// capture hotkey when the process has no visible window.
//
// Mechanism: a steady timer. macOS App Nap (and Chromium backgrounding)
// COALESCE timers when a process is throttled — a timer asking to fire
// every PROBE_INTERVAL_MS fires much later instead. So a "gap" between
// consecutive ticks that's well over the interval means the process was
// asleep/throttled during that gap. If the user presses ⌘⇧C right after
// such a gap, the keypress paid a wake-up tax the in-process logs can't
// see. A steady ~interval (no gaps) while idle means it is NOT being
// napped — and we look elsewhere for the latency.
//
// Also reads back NSAppSleepDisabled so we can tell whether the opt-out
// in disable-app-nap.ts actually landed in this process's defaults.
//
// Remove once the latency is root-caused.

import { systemPreferences } from "electron";
import { getMainLogger } from "./log";

const PROBE_INTERVAL_MS = 2_000;
// Tick later than this ⇒ the event loop was stalled / the process was
// throttled. ~2× the interval gives slack for normal scheduling jitter.
const GAP_THRESHOLD_MS = 4_000;

export function startAppNapProbe(): void {
  if (process.platform !== "darwin") return;
  const log = getMainLogger("pwrsnap:app-nap-probe");

  try {
    const sleepDisabled = systemPreferences.getUserDefault(
      "NSAppSleepDisabled",
      "boolean"
    );
    log.info("probe: NSAppSleepDisabled read-back", { value: sleepDisabled });
  } catch (cause) {
    log.warn("probe: failed to read NSAppSleepDisabled", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }

  let last = Date.now();
  // unref so it never blocks app quit / E2E teardown. In Electron the
  // main loop keeps the timer ticking regardless while the app runs.
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    if (gap > GAP_THRESHOLD_MS) {
      // The process was throttled/napped for ~gap ms. A hotkey press
      // landing right after a gap like this is the slow one.
      log.info("probe: heartbeat GAP — process was throttled/napped", {
        gapMs: gap,
        expectedMs: PROBE_INTERVAL_MS
      });
    }
  }, PROBE_INTERVAL_MS);
  timer.unref();

  log.info("probe: App Nap heartbeat started", { intervalMs: PROBE_INTERVAL_MS });
}
