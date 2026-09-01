import type { Settings } from "@pwrsnap/shared";

import { getDesktopSettingsStore } from "../settings/desktop-settings-store";
import type { CaptureLatencyTrace } from "./capture-latency-trace";
import { sampleCursor, type CursorSample } from "./cursor-sample";

type CursorCaptureSettingsDependencies = {
  readSettings: () => Promise<Settings>;
  sample: () => Promise<CursorSample | null>;
};

const productionDependencies: CursorCaptureSettingsDependencies = {
  readSettings: () => getDesktopSettingsStore().read(),
  sample: sampleCursor
};

/** Kick off the cursor sample if image cursor capture is enabled. All image
 *  capture entry points share this function. The settings lookup resolves
 *  from the process-owned snapshot after startup hydration; it performs no
 *  disk read, config parse, or agent discovery on repeated captures. */
export function startCursorSampleIfEnabled(
  trace?: CaptureLatencyTrace,
  dependencies: CursorCaptureSettingsDependencies = productionDependencies
): Promise<CursorSample | null> {
  return (async () => {
    const settingsStage = trace?.begin("settings_read");
    let enabled = false;
    try {
      const settings = await dependencies.readSettings();
      enabled = settings.recording.imageCaptureCursor;
      if (settingsStage !== undefined) {
        trace?.end(settingsStage, { outcome: "read", cursorEnabled: enabled });
      }
    } catch {
      if (settingsStage !== undefined) {
        trace?.end(settingsStage, { outcome: "failed" });
      }
      return null;
    }
    if (!enabled) {
      trace?.mark("cursor_sample", { outcome: "disabled" });
      return null;
    }
    const sampleStage = trace?.begin("cursor_sample");
    try {
      const sample = await dependencies.sample();
      if (sampleStage !== undefined) {
        trace?.end(sampleStage, {
          outcome: sample === null ? "unavailable" : "sampled"
        });
      }
      return sample;
    } catch {
      if (sampleStage !== undefined) {
        trace?.end(sampleStage, { outcome: "failed" });
      }
      return null;
    }
  })();
}
