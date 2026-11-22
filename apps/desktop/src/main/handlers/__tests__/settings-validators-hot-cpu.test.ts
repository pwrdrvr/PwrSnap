import { migrateHotCpuCaptureRules } from "@pwrsnap/shared";
import { expect, test } from "vitest";
import { validateSettingsWrite } from "../settings-validators";

test.each([
  { hotCpuProfilingTriggerMode: "slowburn" },
  { hotCpuProfilingSlowburnThresholdPercent: 15.5 }
])("settings:write rejects a write to a downgrade mirror explicitly", (general) => {
  expect(validateSettingsWrite({ general })).toMatchObject({
    ok: false, error: { kind: "validation", code: "read_only_hot_cpu_mirror" }
  });
  expect(validateSettingsWrite({ general: { hotCpuProfilingRules: migrateHotCpuCaptureRules("slowburn") } }).ok).toBe(true);
});
