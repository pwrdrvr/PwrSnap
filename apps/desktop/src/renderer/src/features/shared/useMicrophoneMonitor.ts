// Live microphone monitoring for the pre-flight selector.
//
// Why the renderer and not the native recorder
// ────────────────────────────────────────────
// The level meter, the device list and the first-use permission prompt
// are all reachable from standard web APIs inside the sandboxed
// selector renderer: `getUserMedia` opens the device (and is what makes
// macOS show its own TCC prompt), `enumerateDevices` names them, and an
// `AnalyserNode` gives the level. None of it needs a native helper, a
// new IPC verb, or a second audio tap alongside the recorder's
// AVAssetWriter — which is what issue #71 assumed this would cost.
//
// The recorder still owns the actual recording. This is a preview.
//
// When the stream is open
// ───────────────────────
// ONLY while the microphone is switched on for the take. Opening it
// whenever the selector appears would light the macOS orange
// microphone indicator for a user who is about to take a silent
// screenshot, and would fire the first-use TCC prompt at someone who
// never asked for audio. So: chip off, no stream, no indicator, no
// prompt. Turning the chip on opens the device — and the prompt that
// appears is then a direct consequence of something the user just did.
//
// Why the level is quantized before it reaches React
// ──────────────────────────────────────────────────
// The meter has seven segments. Publishing a float at animation-frame
// rate would re-render the selector overlay ~60x/second to move nothing
// most of the time, and this app has already paid for exactly that
// class of over-rendering once (a 1px playhead re-rasterizing a tile
// 120 times a second — docs/solutions/2026-08-20-video-playback-gpu-
// process-burn.md). We sample at 30Hz and publish only when the SEGMENT
// COUNT changes, so a steady voice re-renders a couple of times a
// second and silence re-renders not at all.

import { useCallback, useEffect, useRef, useState } from "react";

/** Number of lit segments the meter can show. Matches SourceChip.css. */
const METER_SEGMENTS = 7;
/** Sampling cadence. Fast enough to feel live, far below frame rate. */
const SAMPLE_INTERVAL_MS = 33;
/** Silence for this long, while enabled, flips the chip to `silent`. */
const SILENCE_GRACE_MS = 3_000;
/**
 * Full-scale reference for the meter. Speech at a normal distance sits
 * around 0.05–0.15 RMS; mapping 1.0 to full scale would leave a working
 * microphone showing one segment. 0.35 puts conversational speech
 * around the middle of the meter and leaves the top two segments — the
 * warm ones — for genuine clipping.
 */
const RMS_FULL_SCALE = 0.35;

export type MicPermission = "granted" | "denied" | "prompt" | "unsupported";

/**
 * Why the device could not be opened, as a value rather than as English.
 *
 * The chip picks a presentation state from this; `error` carries the
 * sentence a human reads. Keeping them separate is what stops the chip
 * from string-matching a message that a Chromium update can reword.
 */
export type MicFault = "none" | "denied" | "nodevice" | "busy" | "unknown";

export type MicDevice = {
  readonly deviceId: string;
  readonly label: string;
};

export type MicrophoneMonitor = {
  /** 0..7 — already quantized to meter segments. */
  readonly segments: number;
  /** True once enabled and no samples above the floor for 3s. */
  readonly silent: boolean;
  readonly permission: MicPermission;
  readonly devices: readonly MicDevice[];
  /** Device actually feeding the meter, once a stream is open. */
  readonly activeDeviceId: string | null;
  /** Machine-readable companion to `error`. `"none"` while healthy. */
  readonly fault: MicFault;
  /** Non-null when the device could not be opened. */
  readonly error: string | null;
  /**
   * Open the device, prompting if macOS has not been asked yet. This is
   * what the chip's "Allow" action calls. Resolves once the permission
   * state is known either way.
   */
  readonly request: () => Promise<void>;
};

type MonitorOptions = {
  /** Whether the microphone is switched on for this take. */
  readonly enabled: boolean;
  /** Preferred device; falls back to the system default when absent. */
  readonly deviceId?: string | undefined;
};

function rmsOf(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = buffer[i]!;
    sum += sample * sample;
  }
  return Math.sqrt(sum / buffer.length);
}

/** Map an RMS reading to a lit-segment count. */
export function segmentsForRms(rms: number): number {
  const scaled = Math.min(1, Math.max(0, rms / RMS_FULL_SCALE));
  return Math.round(scaled * METER_SEGMENTS);
}

/** A `getUserMedia` rejection, turned into something a chip can say. */
export function describeMicError(cause: unknown): {
  permission: MicPermission;
  fault: MicFault;
  message: string;
} {
  const name = cause instanceof Error ? cause.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      // Chromium reports the OS denial and a user "Don't Allow" the
      // same way; both end at the same remedy, System Settings.
      return { permission: "denied", fault: "denied", message: "Microphone access is blocked" };
    case "NotFoundError":
    case "OverconstrainedError":
      return { permission: "granted", fault: "nodevice", message: "No microphone found" };
    case "NotReadableError":
      // The device exists and is permitted but another app holds it.
      return {
        permission: "granted",
        fault: "busy",
        message: "Microphone is in use by another app"
      };
    default:
      return {
        permission: "prompt",
        fault: "unknown",
        message: "Microphone could not be opened"
      };
  }
}

export function useMicrophoneMonitor({ enabled, deviceId }: MonitorOptions): MicrophoneMonitor {
  const [segments, setSegments] = useState(0);
  const [silent, setSilent] = useState(false);
  const [permission, setPermission] = useState<MicPermission>("prompt");
  const [devices, setDevices] = useState<readonly MicDevice[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [fault, setFault] = useState<MicFault>("none");
  const [error, setError] = useState<string | null>(null);
  // Bumped to force a re-open after an explicit `request()`.
  const [attempt, setAttempt] = useState(0);

  const supported =
    typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined;

  const refreshDevices = useCallback(async (): Promise<void> => {
    if (!supported || navigator.mediaDevices.enumerateDevices === undefined) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(
        all
          .filter((d) => d.kind === "audioinput")
          // Labels are empty until a grant exists. A list of blank rows
          // is worse than no list, so unnamed devices are dropped and
          // the chip falls back to being a plain toggle.
          .filter((d) => d.label !== "")
          .map((d) => ({ deviceId: d.deviceId, label: d.label }))
      );
    } catch {
      // Enumeration is a nicety; a failure must not break the chip.
    }
  }, [supported]);

  const request = useCallback(async (): Promise<void> => {
    if (!supported) {
      setPermission("unsupported");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Release immediately — this call exists to move the OS grant,
      // not to hold the device. The monitor effect opens the real
      // stream once `enabled` is true.
      stream.getTracks().forEach((track) => track.stop());
      setPermission("granted");
      setFault("none");
      setError(null);
      await refreshDevices();
      setAttempt((n) => n + 1);
    } catch (cause) {
      const described = describeMicError(cause);
      setPermission(described.permission);
      setFault(described.fault);
      setError(described.message);
    }
  }, [supported, refreshDevices]);

  useEffect(() => {
    if (!supported) {
      setPermission("unsupported");
      return;
    }
    if (!enabled) {
      // Switched off: drop everything so the OS indicator goes out.
      setSegments(0);
      setSilent(false);
      setActiveDeviceId(null);
      return;
    }

    let disposed = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = (): void => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      void context?.close().catch(() => undefined);
      context = null;
    };

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId !== undefined ? { deviceId: { exact: deviceId } } : true
        });
        if (disposed) {
          stop();
          return;
        }
        setPermission("granted");
        setFault("none");
        setError(null);
        setActiveDeviceId(
          stream.getAudioTracks()[0]?.getSettings().deviceId ?? deviceId ?? null
        );
        void refreshDevices();

        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);
        const buffer = new Float32Array(analyser.fftSize);

        let lastSegments = -1;
        let lastSoundAt = Date.now();
        let wasSilent = false;

        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(buffer);
          const next = segmentsForRms(rmsOf(buffer));
          // Publish only on a segment change — see the header note on
          // why this does not run at frame rate.
          if (next !== lastSegments) {
            lastSegments = next;
            setSegments(next);
          }
          const now = Date.now();
          if (next > 0) lastSoundAt = now;
          const nowSilent = now - lastSoundAt >= SILENCE_GRACE_MS;
          if (nowSilent !== wasSilent) {
            wasSilent = nowSilent;
            setSilent(nowSilent);
          }
        }, SAMPLE_INTERVAL_MS);
      } catch (cause) {
        if (disposed) return;
        const described = describeMicError(cause);
        setPermission(described.permission);
        setFault(described.fault);
        setError(described.message);
        setSegments(0);
        stop();
      }
    })();

    return () => {
      disposed = true;
      stop();
    };
  }, [enabled, deviceId, supported, refreshDevices, attempt]);

  return { segments, silent, permission, devices, activeDeviceId, fault, error, request };
}
