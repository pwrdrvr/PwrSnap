// Bus-boundary validation for the `recording` section of settings:write,
// focused on `quickCaptureAction` — the Snap-vs-Record chooser policy.
// The Settings page only ever sends one of three literals, but the
// validator is what a hand-rolled IPC message (or a future caller) hits,
// and main READS this value to decide whether a commit records. A junk
// value must be refused at the boundary rather than persisted and then
// resolved to something arbitrary at capture time.

import { describe, expect, test } from "vitest";
import { QUICK_CAPTURE_ACTIONS } from "@pwrsnap/shared";
import { validateSettingsWrite } from "../settings-validators";

function writeQuickCaptureAction(quickCaptureAction: unknown) {
  return validateSettingsWrite({ recording: { quickCaptureAction } });
}

describe("validateSettingsWrite — recording.quickCaptureAction", () => {
  test("accepts every declared action", () => {
    for (const action of QUICK_CAPTURE_ACTIONS) {
      expect(writeQuickCaptureAction(action).ok, action).toBe(true);
    }
  });

  test("rejects anything else", () => {
    // "video" is the tempting near-miss: it's the selector's INTENT
    // vocabulary, not the policy's.
    expect(writeQuickCaptureAction("video").ok).toBe(false);
    expect(writeQuickCaptureAction("Ask").ok).toBe(false);
    expect(writeQuickCaptureAction("").ok).toBe(false);
    expect(writeQuickCaptureAction(null).ok).toBe(false);
    expect(writeQuickCaptureAction(0).ok).toBe(false);
    expect(writeQuickCaptureAction(true).ok).toBe(false);
  });

  test("an absent action leaves the rest of the block validating normally", () => {
    expect(validateSettingsWrite({ recording: { videoCaptureCursor: false } }).ok).toBe(
      true
    );
    expect(validateSettingsWrite({ recording: {} }).ok).toBe(true);
  });
});

describe("validateSettingsWrite — recording.mp4Include*", () => {
  test.each(["mp4IncludeMicrophone", "mp4IncludeSystemAudio"])("%s accepts booleans", (key) => {
    expect(validateSettingsWrite({ recording: { [key]: false } }).ok).toBe(true);
    expect(validateSettingsWrite({ recording: { [key]: true } }).ok).toBe(true);
  });

  // Main reads these to decide whether an MP4 carries someone's
  // microphone; a string "false" is truthy and must never be persisted.
  test.each(["mp4IncludeMicrophone", "mp4IncludeSystemAudio"])("%s rejects non-booleans", (key) => {
    for (const value of ["false", 0, null, {}]) {
      const result = validateSettingsWrite({ recording: { [key]: value } });
      expect(result.ok, `${key}=${JSON.stringify(value)}`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(`invalid_recording_${key}`);
    }
  });
});
