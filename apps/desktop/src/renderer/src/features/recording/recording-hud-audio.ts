import { useEffect, useRef, useState } from "react";
import type {
  RecordingAudioMuteRequest,
  RecordingAudioReading,
  RecordingAudioSource,
  RecordingBackendCapabilities,
  RecordingState
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

const SOURCES = ["microphone", "systemAudio"] as const;
const NAMES = { microphone: "microphone", systemAudio: "system audio" } as const;
type Take = Extract<RecordingState, { phase: "recording" }>;
type Fault = Extract<RecordingAudioReading, { state: "no-input" | "no-write" }>;
type Requests = Partial<Record<RecordingAudioSource, RecordingAudioMuteRequest>>;
type Notice = { tone: "warn" | "info"; text: string; announce: boolean };

export function formatHMS(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return `${hh > 0 ? `${hh}:` : ""}${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}

function takeTime(ms: number): string { return formatHMS(ms / 1000); }
function sentenceCase(text: string): string { return text.charAt(0).toUpperCase() + text.slice(1); }

function sourceFault(reading: RecordingAudioReading | undefined, enabled: boolean): Fault | undefined {
  return enabled && (reading?.state === "no-input" || reading?.state === "no-write") ? reading : undefined;
}

function faultSummary(source: RecordingAudioSource, fault: Fault): string {
  const name = sentenceCase(NAMES[source]);
  if (fault.state === "no-write") {
    return fault.lastSampleAtMs === null ? `${name} has reached the recorder without being written` :
      `${name} stopped being written at ${takeTime(fault.lastSampleAtMs)}`;
  }
  if (fault.lastSampleAtMs === null) return `${name} hasn’t sent any audio`;
  return `${name} stopped sending audio at ${takeTime(fault.lastSampleAtMs)}`;
}

function pendingAction(request: RecordingAudioMuteRequest): string {
  return `${request.muted ? "Muting" : "Unmuting"} ${NAMES[request.source]}`;
}

function audioNotice(
  state: Take,
  detect: boolean,
  toggles: boolean,
  failed: RecordingAudioMuteRequest | null,
  pending: Requests
): Notice | null {
  const actions = SOURCES.flatMap((source) => {
    const request = pending[source];
    return request?.sessionId === state.sessionId ? [pendingAction(request)] : [];
  });
  if (actions.length > 0) {
    return { tone: "info", announce: true, text: `${actions.join(" · ")}…` };
  }
  const telemetry = state.audioTelemetry;
  if (failed?.sessionId === state.sessionId && (telemetry?.[failed.source]?.muted === true) !== failed.muted) {
    const name = NAMES[failed.source];
    const action = failed.muted ? "muting" : "unmuting";
    return { tone: "warn", announce: true, text: `Couldn’t confirm ${action} ${name}` };
  }
  const faults = SOURCES.flatMap((source) => {
    const fault = sourceFault(telemetry?.[source], detect && state.capabilities[source]);
    return fault === undefined ? [] : [{ source, fault }];
  });
  if (faults.length > 0) {
    const first = faults[0]!;
    const sharedTime = first.fault.lastSampleAtMs === null ? null : takeTime(first.fault.lastSampleAtMs);
    let text: string;
    if (faults.length === 1) {
      const { source, fault } = first;
      const muted = toggles && fault.muted === true;
      text = muted && fault.state === "no-input" && fault.lastSampleAtMs !== null
        ? `${sentenceCase(NAMES[source])} is muted and stopped sending audio at ${takeTime(fault.lastSampleAtMs)}`
        : `${faultSummary(source, fault)} · recording continues`;
    } else if (faults.every(({ fault }) => fault.state === "no-input" && fault.lastSampleAtMs === null)) {
      text = "Microphone and system audio haven’t sent any audio · recording continues";
    } else if (sharedTime !== null && faults.every(({ fault }) =>
      fault.state === "no-input" && fault.lastSampleAtMs !== null &&
      takeTime(fault.lastSampleAtMs) === sharedTime
    )) {
      text = `Microphone and system audio stopped at ${sharedTime} · recording continues`;
    } else {
      text = "Microphone and system audio have sample gaps · recording continues";
    }
    return { tone: "warn", announce: true, text };
  }
  if (detect) {
    for (const source of SOURCES) {
      const reading = telemetry?.[source];
      if (state.capabilities[source] && reading?.state === "writing" && reading.recovery !== undefined) {
        const { atMs, gapMs } = reading.recovery;
        return {
          tone: "info", announce: true,
          text: `${sentenceCase(NAMES[source])} back at ${takeTime(atMs)} · ${Math.round(gapMs / 1000)} s missing`
        };
      }
    }
  }
  if (!toggles) return null;
  const muted = SOURCES.filter((source) => state.capabilities[source] && telemetry?.[source]?.muted === true);
  const first = muted[0];
  if (first === undefined) return null;
  const text = muted.length === 1 ? `${sentenceCase(NAMES[first])} muted · click its chip to unmute` :
    "Microphone and system audio muted · click a chip to unmute";
  return { tone: "info", announce: false, text };
}

export function useRecordingHudAudio(state: Take | null, backend: RecordingBackendCapabilities | null) {
  const [pending, setPending] = useState<Requests>({});
  const [failure, setFailure] = useState<RecordingAudioMuteRequest | null>(null);
  const inFlight = useRef<Requests>({});

  useEffect(() => {
    if (failure === null) return;
    const timer = setTimeout(() => setFailure(null), 4_000);
    return () => clearTimeout(timer);
  }, [failure]);

  const detect = backend?.sources.liveDisconnectDetection ?? state?.audioTelemetry !== undefined;
  const toggles = backend?.sources.midRecordingToggles === true;
  const monitor = backend?.sources.liveAudioLevels ?? state?.audioTelemetry !== undefined;

  async function toggle(source: RecordingAudioSource, muted: boolean): Promise<void> {
    if (state === null || inFlight.current[source]?.sessionId === state.sessionId) return;
    const request = { sessionId: state.sessionId, source, muted };
    inFlight.current[source] = request;
    setPending((previous) => ({ ...previous, [source]: request }));
    setFailure((previous) => previous?.source === source ? null : previous);
    let applied = false;
    try {
      applied = (await dispatch("recording:muteAudio", request)).ok;
    } catch {
      // An unavailable transport has the same presentation as a missing ack.
    } finally {
      if (inFlight.current[source] === request) {
        delete inFlight.current[source];
        setPending((previous) => {
          const next = { ...previous };
          delete next[source];
          return next;
        });
        if (!applied) setFailure(request);
      }
    }
  }

  function chip(source: RecordingAudioSource) {
    const reading = state?.audioTelemetry?.[source];
    const request = pending[source];
    const busy = request !== undefined && request.sessionId === state?.sessionId;
    const muted = toggles && reading?.muted === true;
    const fault = sourceFault(reading, detect);
    const level = monitor && reading?.state === "writing" ? reading.level : null;
    const clipping = monitor && reading?.state === "writing" && reading.clipping === true;
    const name = NAMES[source];
    const canToggle = toggles && reading !== undefined;
    const title = muted ? `Unmute ${name}` : `Mute ${name}`;
    const faultDescription = fault === undefined ? undefined :
      fault.state === "no-write" ? "Audio reached the recorder without being written" :
        fault.lastSampleAtMs === null ? "No audio yet" : `No audio since ${takeTime(fault.lastSampleAtMs)}`;
    const description = muted ? faultDescription === undefined ? "Muted · silence is recorded on its track" :
      `Muted · ${faultDescription}` :
      faultDescription ?? (reading?.state !== "writing" || level === null ? "Starting" :
        clipping ? "Recording · clipping" : level === 0 ? "Recording · quiet" : "Recording");
    return {
      state: muted ? "muted" as const : fault !== undefined ? "silent" as const : "live" as const,
      meterTone: monitor || backend === null ? "live" as const : "recorded" as const,
      ...(level === null ? {} : { level }),
      busy,
      flag: muted && fault !== undefined,
      clipping: !muted && clipping,
      ...(canToggle ? {
        onToggle: () => void toggle(source, !muted),
        controlTitle: busy ? `${pendingAction(request)}…` :
          !muted && fault !== undefined ? `${faultSummary(source, fault)} · ${title}` : title,
        why: busy ? `${description} · ${pendingAction(request)}…` : description
      } : {})
    };
  }

  return { chip, notice: state === null ? null : audioNotice(state, detect, toggles, failure, pending) };
}
