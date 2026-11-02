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

describe("validateSettingsWrite — recording.showRecentCaptureSidebar", () => {
  test("accepts booleans", () => {
    for (const value of [true, false]) {
      expect(validateSettingsWrite({ recording: { showRecentCaptureSidebar: value } }).ok).toBe(
        true
      );
    }
  });

  // Main reads this to decide whether the dock window shows; a string
  // "false" is truthy and must never be persisted.
  test("rejects non-booleans", () => {
    for (const value of ["false", 0, null, {}]) {
      const result = validateSettingsWrite({ recording: { showRecentCaptureSidebar: value } });
      expect(result.ok, JSON.stringify(value)).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_recording_showRecentCaptureSidebar");
      }
    }
  });
});

describe("validateSettingsWrite — recording.microphoneDevice / cameraDevice", () => {
  const desk = { deviceId: "chromium-id-oatmeal", label: "Oatmeal Desk Mic (USB)" };

  test.each(["microphoneDevice", "cameraDevice"])("%s accepts a full choice and null", (key) => {
    expect(validateSettingsWrite({ recording: { [key]: desk } }).ok).toBe(true);
    // null is "System default", the picker's first row.
    expect(validateSettingsWrite({ recording: { [key]: null } }).ok).toBe(true);
  });

  // A choice the chips can neither open by id nor find by name would be
  // persisted, then silently fail to open on every later show.
  test.each(["microphoneDevice", "cameraDevice"])("%s refuses a half-filled or stray shape", (key) => {
    for (const bad of [
      { deviceId: "chromium-id-oatmeal" },
      { label: "Oatmeal Desk Mic" },
      { deviceId: "", label: "Oatmeal Desk Mic" },
      { ...desk, extra: true },
      "chromium-id-oatmeal",
      0
    ]) {
      const result = validateSettingsWrite({ recording: { [key]: bad } });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(`invalid_recording_${key}`);
    }
  });
});
