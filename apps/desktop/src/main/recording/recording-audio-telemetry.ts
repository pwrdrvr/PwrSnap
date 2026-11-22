import type {
  RecordingAudioReading,
  RecordingAudioTelemetry,
  RecordingCapabilities
} from "@pwrsnap/shared";

export type RecorderAudioTelemetryEvent = {
  event: "audioTelemetry";
  elapsedMs?: unknown;
  systemAudio?: unknown;
  microphone?: unknown;
};

const AUDIO_SOURCES = ["systemAudio", "microphone"] as const;
const SAMPLE_GAP_MS = 2_000;
// One step per segment in the shared chip, scaled in dBFS.
const SEGMENT_THRESHOLDS_DB = [-54, -42, -30, -18, -12, -6, -1];

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readAudio(value: unknown, elapsedMs: number): RecordingAudioReading | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { lastSampleAgeMs, lastInputAgeMs, rms, muted } = value as Record<string, unknown>;
  if (!(lastSampleAgeMs === null || isNonnegativeNumber(lastSampleAgeMs)) ||
      !(lastInputAgeMs === null || isNonnegativeNumber(lastInputAgeMs)) ||
      !(rms === null || isNonnegativeNumber(rms))) return undefined;
  const mute = muted === true ? { muted: true as const } : {};
  if ((lastSampleAgeMs ?? elapsedMs) > SAMPLE_GAP_MS) {
    return { ...mute, state: lastInputAgeMs !== null && lastInputAgeMs <= SAMPLE_GAP_MS ? "no-write" : "no-input" };
  }
  if (lastSampleAgeMs === null) return { ...mute, state: "waiting" };
  const db = rms === null ? null : 20 * Math.log10(rms);
  const level = db === null ? null :
    SEGMENT_THRESHOLDS_DB.filter((threshold) => db >= threshold).length / SEGMENT_THRESHOLDS_DB.length;
  return { ...mute, state: "writing", level };
}

/** The native write queue supplies ages from its own monotonic clock. Keep
 * only changes the HUD can display, and ignore unarmed sources. */
export function updateAudioTelemetry(
  current: RecordingAudioTelemetry | undefined,
  event: RecorderAudioTelemetryEvent,
  armed: RecordingCapabilities
): RecordingAudioTelemetry | undefined {
  if (!isNonnegativeNumber(event.elapsedMs)) return current;
  let next = current;
  for (const source of AUDIO_SOURCES) {
    if (!armed[source]) continue;
    const previous = current?.[source];
    const reading = readAudio(event[source], event.elapsedMs);
    if (reading === undefined) continue;
    if (previous?.state === reading.state && previous.muted === reading.muted &&
      (reading.state !== "writing" ||
        (previous.state === "writing" && previous.level === reading.level))) continue;
    next = { ...next, [source]: reading };
  }
  return next;
}
