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

// Which device
// ────────────
// The saved choice (`settings.recording.microphoneDevice`) is opened by
// its Chromium id. If that id no longer exists the system default is
// opened instead and the saved device is looked for BY NAME: Chromium's
// ids are salted per profile, so a reset salt turns every saved id into a
// stranger while the device itself is still plugged in. Only when the name
// is gone too does the monitor report `missing` — and it stays on the
// default, because a meter that shows nothing is a worse answer to "which
// microphone?" than one that shows the default and says so.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  displayDeviceLabel,
  isDefaultPseudoDevice,
  resolveDevicePreference,
  type RecordingDevicePreference
} from "@pwrsnap/shared";
import { createLevelMeterStore, peakOf, type LevelMeterStore } from "./mic-level-meter";

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
  /** Name of the device feeding the meter, without Chromium's "Default - ". */
  readonly activeLabel: string | null;
  /** What the OS default input currently is, for the "System default" row. */
  readonly defaultLabel: string | null;
  /**
   * True when the open stream is the OS default rather than a named pick:
   * no preference, or a saved one that is not attached. The recorder is then
   * told nothing and opens the default itself.
   */
  readonly followsDefault: boolean;
  /** A saved device that is attached under neither its id nor its name. */
  readonly missing: RecordingDevicePreference | null;
  /** A clipped sample arrived within the last `CLIP_HOLD_MS`. */
  readonly clipping: boolean;
  /** dBFS level, peak hold and clip latch for the picker's meter. */
  readonly meter: LevelMeterStore;
  /** The open stream, for the picker's record-and-play-back check. */
  readonly getStream: () => MediaStream | null;
};

type MonitorOptions = {
  /** Whether the microphone is switched on for this take. */
  readonly enabled: boolean;
  /** The saved choice. `null` / absent opens the system default. */
  readonly preference?: RecordingDevicePreference | null | undefined;
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

/** A `getUserMedia` rejection that means "no device answers to that id". */
function isMissingDevice(cause: unknown): boolean {
  const name = cause instanceof Error ? cause.name : "";
  return name === "NotFoundError" || name === "OverconstrainedError";
}

/**
 * Whether a saved microphone is attached, asked without opening anything.
 *
 * Record calls this when the chip never opened the microphone (a Quick
 * Capture that only offers Record). The chip is showing the saved name and
 * the recorder would be asked for it, so a device that has gone is caught
 * here, in the selector, instead of as a failed start after the user
 * pressed Record. Names are visible without a stream because main's
 * permission check grants `media` to PwrSnap's own pages (see
 * media-permissions.ts). `unknown` when the names are hidden anyway or the
 * enumeration fails: the recorder's refusal remains the backstop.
 */
export async function savedMicrophonePresence(
  preference: RecordingDevicePreference
): Promise<"attached" | "missing" | "unknown"> {
  if (typeof navigator === "undefined" || navigator.mediaDevices?.enumerateDevices === undefined) {
    return "unknown";
  }
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "audioinput" && !isDefaultPseudoDevice(d.deviceId)
    );
    if (!inputs.some((d) => d.label !== "")) return "unknown";
    const listed = inputs.map((d) => ({ deviceId: d.deviceId, label: displayDeviceLabel(d.label) }));
    return resolveDevicePreference(listed, preference).kind === "missing" ? "missing" : "attached";
  } catch {
    return "unknown";
  }
}

export function useMicrophoneMonitor({ enabled, preference }: MonitorOptions): MicrophoneMonitor {
  const [segments, setSegments] = useState(0);
  const [silent, setSilent] = useState(false);
  const [permission, setPermission] = useState<MicPermission>("prompt");
  const [devices, setDevices] = useState<readonly MicDevice[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [fault, setFault] = useState<MicFault>("none");
  const [error, setError] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [defaultLabel, setDefaultLabel] = useState<string | null>(null);
  const [followsDefault, setFollowsDefault] = useState(true);
  const [missing, setMissing] = useState<RecordingDevicePreference | null>(null);
  const [clipping, setClipping] = useState(false);
  const [meter] = useState(createLevelMeterStore);
  const streamRef = useRef<MediaStream | null>(null);
  const getStream = useCallback(() => streamRef.current, []);
  // Bumped to force a re-open after an explicit `request()`.
  const [attempt, setAttempt] = useState(0);
  // The effect keys on the preference's fields, not its object identity:
  // main re-seeds an equal object on every show.
  const preferredId = preference?.deviceId;
  const preferredLabel = preference?.label;

  const supported =
    typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined;

  const refreshDevices = useCallback(async (): Promise<readonly MicDevice[]> => {
    if (!supported || navigator.mediaDevices.enumerateDevices === undefined) return [];
    try {
      const inputs = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === "audioinput")
        // Labels are empty until a grant exists. A list of blank rows
        // is worse than no list, so unnamed devices are dropped and
        // the chip falls back to being a plain toggle.
        .filter((d) => d.label !== "");
      // The pseudo-devices are not rows of their own: "System default" is,
      // and it names the device the "default" entry points at.
      const named = inputs
        .filter((d) => !isDefaultPseudoDevice(d.deviceId))
        .map((d) => ({ deviceId: d.deviceId, label: displayDeviceLabel(d.label) }));
      const pointer = inputs.find((d) => d.deviceId === "default");
      setDevices(named);
      setDefaultLabel(pointer !== undefined ? displayDeviceLabel(pointer.label) : null);
      return named;
    } catch {
      // Enumeration is a nicety; a failure must not break the chip.
      return [];
    }
  }, [supported]);

  // Re-list on hot-plug while open, so a newly attached microphone is a row
  // without closing the picker, and "System default" follows the OS.
  useEffect(() => {
    if (!supported || !enabled || navigator.mediaDevices.addEventListener === undefined) return;
    const onChange = (): void => {
      void refreshDevices();
    };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, [supported, enabled, refreshDevices]);

  const request = useCallback(async (): Promise<void> => {
    if (!supported) {
      setPermission("unsupported");
      return;
    }
    // Re-arm the monitor effect and let ITS `getUserMedia` be the single
    // device open. Opening a probe stream here and stopping it immediately
    // meant every retry cost two opens of the same device microseconds
    // apart — and because Chromium's macOS audio teardown is asynchronous,
    // the second could land on a device the first had not finished
    // releasing and come back `NotReadableError`, leaving the chip
    // claiming another app held the microphone as a direct result of the
    // user clicking Allow. The effect reports permission, fault and error
    // from the real open, so nothing is lost by not duplicating it.
    setAttempt((n) => n + 1);
  }, [supported]);

  // Re-probe when this window comes back to the foreground.
  //
  // The chip's Settings action opens System Settings; the user grants
  // access there and switches back. Without this the chip would still
  // read `denied` — the permission it was told about is the one from
  // before the trip — and the remedy it offers is the trip they just
  // made. Chromium does not notify a renderer that an OS grant moved,
  // so the return of focus is the only signal available.
  //
  // Only while FAULTED, and only while enabled: a `focus` on a healthy
  // chip has nothing to learn, and re-running `getUserMedia` on a chip
  // that is switched off would open the device behind the user's back.
  //
  // `denied` is not the only recoverable fault, and it is not even the
  // only one the user fixes by leaving. `describeMicError` reports both
  // `busy` ("quit the other app") and `nodevice` ("plug one in") with
  // `permission: "granted"`, and neither gets an act button — so gating
  // this on `permission === "denied"` left the two faults whose remedy
  // happens OUTSIDE the app as the two the app never re-checked. The
  // monitor effect's deps cannot change on their own, so the chip stayed
  // wrong until it was toggled off and on.
  const faulted = permission === "denied" || fault !== "none";
  useEffect(() => {
    if (!supported || !enabled || !faulted) return;
    const onFocus = (): void => {
      void request();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [supported, enabled, faulted, request]);

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
      setActiveLabel(null);
      setClipping(false);
      meter.reset();
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
      streamRef.current = null;
      void context?.close().catch(() => undefined);
      context = null;
    };
    const open = (deviceId: string | undefined): Promise<MediaStream> =>
      navigator.mediaDevices.getUserMedia({
        audio: deviceId !== undefined ? { deviceId: { exact: deviceId } } : true
      });

    void (async () => {
      try {
        // The saved device by id; if no device has that id, the default —
        // and then, below, the saved device by name.
        let lookByName = false;
        try {
          stream = await open(preferredId);
        } catch (cause) {
          if (preferredId === undefined || !isMissingDevice(cause)) throw cause;
          lookByName = true;
          stream = await open(undefined);
        }
        if (disposed) {
          stop();
          return;
        }
        const listed = await refreshDevices();
        if (disposed) {
          stop();
          return;
        }
        let named = preferredId !== undefined && !lookByName;
        let lost: RecordingDevicePreference | null = null;
        if (lookByName && preferredId !== undefined) {
          const found = resolveDevicePreference(listed, {
            deviceId: preferredId,
            label: preferredLabel ?? ""
          });
          const openedLabel = displayDeviceLabel(stream.getAudioTracks()[0]?.label ?? "");
          if (found.kind === "found" && found.device.label !== openedLabel) {
            // A different physical device: reopening it cannot collide
            // with the default's teardown (see `request`).
            stream.getTracks().forEach((track) => track.stop());
            stream = await open(found.device.deviceId);
            if (disposed) {
              stop();
              return;
            }
            named = true;
          } else if (found.kind === "found") {
            // The default IS the saved device, under a new id.
            named = true;
          } else {
            lost = { deviceId: preferredId, label: preferredLabel ?? "" };
          }
        }
        streamRef.current = stream;
        const track = stream.getAudioTracks()[0];
        setPermission("granted");
        setFault("none");
        setError(null);
        setMissing(lost);
        setFollowsDefault(!named);
        setActiveDeviceId(track?.getSettings().deviceId ?? preferredId ?? null);
        const trackLabel = displayDeviceLabel(track?.label ?? "");
        setActiveLabel(trackLabel !== "" ? trackLabel : null);

        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);
        const buffer = new Float32Array(analyser.fftSize);

        let lastSegments = -1;
        let lastSoundAt = Date.now();
        let wasSilent = false;
        let wasClipping = false;

        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(buffer);
          const next = segmentsForRms(rmsOf(buffer));
          // The fine meter goes to its own store; only the clip latch, which
          // flips a few times a minute at most, reaches React state.
          meter.push(peakOf(buffer), Date.now());
          const nowClipping = meter.get().clipping;
          if (nowClipping !== wasClipping) {
            wasClipping = nowClipping;
            setClipping(nowClipping);
          }
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
        setActiveLabel(null);
        setClipping(false);
        meter.reset();
        stop();
      }
    })();

    return () => {
      disposed = true;
      stop();
    };
  }, [enabled, preferredId, preferredLabel, supported, refreshDevices, attempt, meter]);

  return {
    segments,
    silent,
    permission,
    devices,
    activeDeviceId,
    fault,
    error,
    request,
    activeLabel,
    defaultLabel,
    followsDefault,
    missing,
    clipping,
    meter,
    getStream
  };
}
