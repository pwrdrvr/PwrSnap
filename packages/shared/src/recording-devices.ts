import { z } from "zod";

// Which microphone and which camera a new recording uses.
//
// Two identities, because two different stacks have to agree on one device:
//
// - `deviceId` is Chromium's. The selector renderer opens the device with it
//   (the level meter, the camera preview) and the sandboxed camera recorder
//   records with it. It is a salted per-origin hash, stable for this profile
//   but meaningless to anything outside Chromium.
// - `label` is the device's name as Chromium reports it. It is the only key
//   the native macOS recorder (AVFoundation) can match on, and the fallback
//   when the salt changes and every saved `deviceId` stops matching.
//
// `null` in Settings means "no choice made": the system default microphone,
// and whichever camera Chromium opens first.

export const RecordingDevicePreferenceSchema = z
  .object({
    deviceId: z.string().min(1).max(512),
    label: z.string().max(512),
  })
  .strict();
export type RecordingDevicePreference = z.infer<typeof RecordingDevicePreferenceSchema>;

/**
 * The microphone a take asked for, as handed to the native recorder.
 * Omitted from `RecordingCapabilities` means the system default input.
 */
export const RecordingMicrophoneSchema = z
  .object({
    label: z.string().min(1).max(512),
  })
  .strict();
export type RecordingMicrophone = z.infer<typeof RecordingMicrophoneSchema>;

/** The saved choices, as main seeds them into the capture selector. */
export type RecordingDeviceDefaults = {
  readonly microphone: RecordingDevicePreference | null;
  readonly camera: RecordingDevicePreference | null;
};

/**
 * Chromium's pseudo-devices that follow the OS default rather than naming a
 * device. Picking one of these is "System default", so it is stored as
 * `null`, never as a preference that would stop following the OS.
 */
const DEFAULT_PSEUDO_DEVICE_IDS: ReadonlySet<string> = new Set(["default", "communications"]);

export function isDefaultPseudoDevice(deviceId: string): boolean {
  return DEFAULT_PSEUDO_DEVICE_IDS.has(deviceId);
}

/**
 * A device name fit to show. Chromium names its pseudo-devices after the
 * device they currently point at ("Default - Desk Mic (USB)"), and a track
 * opened through one carries that label too. The prefix says nothing about
 * the hardware, so it is dropped.
 */
export function displayDeviceLabel(label: string): string {
  return label.replace(/^(Default|Communications) - /, "");
}

/**
 * Whether a `getUserMedia` rejection means "no device answers to that id",
 * as opposed to a refusal or a busy device. The chips fall back to the
 * default and look for the saved device by name only on this answer.
 */
export function isMissingDeviceError(cause: unknown): boolean {
  const name = cause instanceof Error ? cause.name : "";
  return name === "NotFoundError" || name === "OverconstrainedError";
}

/**
 * A device name short enough for a chip: without Chromium's one trailing
 * tag — the transport ("(Built-in)", "(Virtual)", "(Bluetooth)") or a USB
 * "(vendor:product)" pair. The picker still shows the whole name. A name
 * that is nothing but a tag is kept.
 */
export function shortDeviceLabel(label: string): string {
  const name = displayDeviceLabel(label);
  if (!name.endsWith(")")) return name;
  const open = name.lastIndexOf(" (");
  return open > 0 ? name.slice(0, open) : name;
}

export type DeviceCandidate = {
  readonly deviceId: string;
  readonly label: string;
};

export type DevicePreferenceResolution<T extends DeviceCandidate> =
  /** No preference: use the default. */
  | { readonly kind: "default" }
  /** The saved device is attached (by id, or by name after a salt change). */
  | { readonly kind: "found"; readonly device: T }
  /** A device was saved and is not attached. The caller decides what to say. */
  | { readonly kind: "missing"; readonly preference: RecordingDevicePreference };

/**
 * Find the saved device among the attached ones.
 *
 * The id wins. Only if no id matches is the label tried, and an empty label
 * never matches: two unnamed devices are not the same device.
 */
export function resolveDevicePreference<T extends DeviceCandidate>(
  devices: readonly T[],
  preference: RecordingDevicePreference | null | undefined
): DevicePreferenceResolution<T> {
  if (preference === null || preference === undefined) return { kind: "default" };
  const byId = devices.find((device) => device.deviceId === preference.deviceId);
  if (byId !== undefined) return { kind: "found", device: byId };
  const label = displayDeviceLabel(preference.label);
  if (label !== "") {
    const byLabel = devices.find(
      (device) => !isDefaultPseudoDevice(device.deviceId) && displayDeviceLabel(device.label) === label
    );
    if (byLabel !== undefined) return { kind: "found", device: byLabel };
  }
  return { kind: "missing", preference };
}
