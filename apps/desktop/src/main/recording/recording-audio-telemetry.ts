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
const RECOVERY_MS = 5_000;
// One step per segment in the shared chip, scaled in dBFS.
const SEGMENT_THRESHOLDS_DB = [-60, -48, -36, -27, -18, -10, -3];

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readAudio(
  value: unknown,
  elapsedMs: number,
  previous: RecordingAudioReading | undefined
): RecordingAudioReading | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { lastSampleAgeMs, lastInputAgeMs, rms, muted, clipping } = value as Record<string, unknown>;
  if (!(lastSampleAgeMs === null || isNonnegativeNumber(lastSampleAgeMs)) ||
      !(lastInputAgeMs === null || isNonnegativeNumber(lastInputAgeMs)) ||
      !(rms === null || isNonnegativeNumber(rms))) return undefined;
  const mute = muted === true ? { muted: true as const } : {};
  const sampleAt = lastSampleAgeMs === null ? null : Math.max(0, Math.round(elapsedMs - lastSampleAgeMs));
  if ((lastSampleAgeMs ?? elapsedMs) > SAMPLE_GAP_MS) {
    return {
      ...mute,
      state: lastInputAgeMs !== null && lastInputAgeMs <= SAMPLE_GAP_MS ? "no-write" : "no-input",
      lastSampleAtMs: sampleAt
    };
  }
  if (sampleAt === null) return { ...mute, state: "waiting" };
  const segments = SEGMENT_THRESHOLDS_DB.length;
  const db = rms === null ? null : 20 * Math.log10(rms);
  const wanted = db === null ? null : SEGMENT_THRESHOLDS_DB.filter((threshold) => db >= threshold).length;
  const priorLevel = previous?.state === "writing" ? previous.level : null;
  const priorSegments = Math.round((priorLevel ?? 0) * segments);
  const level = wanted === null ? priorLevel :
    Math.max(wanted, priorSegments - 1) / segments;
  let recovery = previous?.state === "writing" ? previous.recovery : undefined;
  if (previous?.state === "no-input" || previous?.state === "no-write") {
    recovery = { atMs: sampleAt, gapMs: Math.max(0, sampleAt - (previous.lastSampleAtMs ?? 0)) };
  }
  return {
    ...mute, state: "writing", level,
    ...(clipping === true ? { clipping: true as const } : {}),
    ...(recovery !== undefined && elapsedMs - recovery.atMs < RECOVERY_MS ? { recovery } : {})
  };
}

function readingsMatch(previous: RecordingAudioReading | undefined, next: RecordingAudioReading): boolean {
  if (previous?.state !== next.state || previous.muted !== next.muted) return false;
  switch (next.state) {
    case "waiting": return true;
    case "writing":
      return previous.state === "writing" && previous.level === next.level &&
        previous.clipping === next.clipping && previous.recovery === next.recovery;
    case "no-input":
    case "no-write":
      return (previous.state === "no-input" || previous.state === "no-write") &&
        previous.lastSampleAtMs === next.lastSampleAtMs;
  }
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
    const reading = readAudio(event[source], event.elapsedMs, previous);
    if (reading === undefined || readingsMatch(previous, reading)) continue;
    next = { ...next, [source]: reading };
  }
  return next;
}
