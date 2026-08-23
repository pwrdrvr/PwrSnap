import { describe, expect, test } from "vitest";
import { validateSettingsWrite } from "../settings-validators";

describe("validateSettingsWrite recording.quickCaptureAction", () => {
  test.each(["ask", "snap", "record"] as const)("accepts %s", (quickCaptureAction) => {
    const result = validateSettingsWrite({ recording: { quickCaptureAction } });
    expect(result.ok).toBe(true);
  });

  test("accepts an omitted action in a partial recording patch", () => {
    expect(validateSettingsWrite({ recording: { includeMicrophone: true } }).ok).toBe(true);
  });

  test.each(["sometimes", null, true, 1, {}])("rejects malformed action %j", (value) => {
    const result = validateSettingsWrite({
      recording: { quickCaptureAction: value }
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toEqual({
      kind: "validation",
      code: "invalid_recording_quickCaptureAction",
      message:
        'settings:write: recording.quickCaptureAction must be "ask", "snap", or "record"'
    });
  });
});
