import { describe, expect, test } from "vitest";
import {
  displayDeviceLabel,
  isDefaultPseudoDevice,
  RecordingDevicePreferenceSchema,
  RecordingMicrophoneSchema,
  resolveDevicePreference
} from "../recording-devices";

const attached = [
  { deviceId: "default", label: "Default - Oatmeal Desk Mic (USB)" },
  { deviceId: "id-oatmeal", label: "Oatmeal Desk Mic (USB)" },
  { deviceId: "id-granola", label: "Granola Interface" },
  { deviceId: "id-unnamed", label: "" }
];

describe("resolveDevicePreference", () => {
  test("no preference is the default", () => {
    expect(resolveDevicePreference(attached, null)).toEqual({ kind: "default" });
    expect(resolveDevicePreference(attached, undefined)).toEqual({ kind: "default" });
  });

  test("the id wins", () => {
    // Even when the label now belongs to a different device.
    const found = resolveDevicePreference(attached, { deviceId: "id-granola", label: "Oatmeal Desk Mic (USB)" });
    expect(found).toEqual({ kind: "found", device: attached[2] });
  });

  // Chromium's ids are salted per profile. A reset salt must not lose a
  // microphone that is still plugged in.
  test("a stale id falls back to the name", () => {
    const found = resolveDevicePreference(attached, { deviceId: "id-from-old-salt", label: "Granola Interface" });
    expect(found).toEqual({ kind: "found", device: attached[2] });
  });

  test("the name match never lands on the default pseudo-device", () => {
    const found = resolveDevicePreference(attached, {
      deviceId: "id-from-old-salt",
      label: "Default - Oatmeal Desk Mic (USB)"
    });
    expect(found).toEqual({ kind: "found", device: attached[1] });
  });

  test("an empty saved name never matches an unnamed device", () => {
    const pref = { deviceId: "id-from-old-salt", label: "" };
    expect(resolveDevicePreference(attached, pref)).toEqual({ kind: "missing", preference: pref });
  });

  test("absent by id and by name is missing, not the default", () => {
    const pref = { deviceId: "id-muesli", label: "Muesli Mic" };
    expect(resolveDevicePreference(attached, pref)).toEqual({ kind: "missing", preference: pref });
    expect(resolveDevicePreference([], pref)).toEqual({ kind: "missing", preference: pref });
  });
});

describe("device labels", () => {
  test("Chromium's pseudo-device prefixes are dropped", () => {
    expect(displayDeviceLabel("Default - Granola Interface")).toBe("Granola Interface");
    expect(displayDeviceLabel("Communications - Granola Interface")).toBe("Granola Interface");
    expect(displayDeviceLabel("Granola Interface")).toBe("Granola Interface");
    // Only a leading prefix: a device can have "Default" in its own name.
    expect(displayDeviceLabel("Granola Default - Mic")).toBe("Granola Default - Mic");
  });

  test("pseudo-device ids", () => {
    expect(isDefaultPseudoDevice("default")).toBe(true);
    expect(isDefaultPseudoDevice("communications")).toBe(true);
    expect(isDefaultPseudoDevice("id-granola")).toBe(false);
  });
});

describe("schemas", () => {
  test("a preference needs an id; its label may be empty", () => {
    expect(RecordingDevicePreferenceSchema.safeParse({ deviceId: "id", label: "" }).success).toBe(true);
    expect(RecordingDevicePreferenceSchema.safeParse({ deviceId: "", label: "Mic" }).success).toBe(false);
    expect(RecordingDevicePreferenceSchema.safeParse({ deviceId: "id", label: "Mic", x: 1 }).success).toBe(false);
  });

  test("the recorder's microphone needs a name to match on", () => {
    expect(RecordingMicrophoneSchema.safeParse({ label: "Granola Interface" }).success).toBe(true);
    expect(RecordingMicrophoneSchema.safeParse({ label: "" }).success).toBe(false);
    expect(RecordingMicrophoneSchema.safeParse({ label: "x".repeat(513) }).success).toBe(false);
  });
});
