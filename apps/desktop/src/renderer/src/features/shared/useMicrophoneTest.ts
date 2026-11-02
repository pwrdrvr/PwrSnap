// "Test": record a few seconds from the open microphone and play them back,
// so someone checking their gain can hear it as well as see it.
//
// What this must never do
// ───────────────────────
// - Reach the take. It records the selector's OWN preview stream with a
//   `MediaRecorder` in this renderer; the native recorder is not involved
//   and is not running yet. The selector hides when a take starts, and a
//   hidden selector cancels any test in flight (see `visibilitychange`),
//   so the playback cannot play into the first seconds of a recording
//   that captures system audio.
// - Persist audio. The chunks live in this closure, are decoded straight
//   into an `AudioBuffer` (no blob URL, no file, no IPC), and are dropped
//   when playback ends or the test is cancelled.

import { useCallback, useEffect, useRef, useState } from "react";

/** Length of the check, in seconds. Long enough for "testing, one two". */
export const MIC_TEST_SECONDS = 3;

export type MicTestPhase = "idle" | "recording" | "playing" | "failed";

export type MicrophoneTest = {
  readonly phase: MicTestPhase;
  /** Whole seconds left in `recording`. */
  readonly secondsLeft: number;
  /** Set in `failed`. */
  readonly error: string | null;
  /** Whether this renderer can run the check at all. */
  readonly available: boolean;
  readonly start: () => void;
  readonly cancel: () => void;
};

type Running = {
  recorder: MediaRecorder | null;
  context: AudioContext | null;
  source: AudioBufferSourceNode | null;
  timers: Array<ReturnType<typeof setTimeout>>;
  cancelled: boolean;
};

export function useMicrophoneTest({
  getStream,
  deviceKey
}: {
  readonly getStream: () => MediaStream | null;
  /**
   * The device being tested. A change cancels the check: a recording that
   * started on one microphone and finished on another tests neither.
   */
  readonly deviceKey: string | null;
}): MicrophoneTest {
  const [phase, setPhase] = useState<MicTestPhase>("idle");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const running = useRef<Running | null>(null);
  const available =
    typeof MediaRecorder !== "undefined" && typeof AudioContext !== "undefined";

  const teardown = useCallback((): void => {
    const run = running.current;
    if (run === null) return;
    running.current = null;
    run.cancelled = true;
    run.timers.forEach((timer) => clearTimeout(timer));
    if (run.recorder !== null && run.recorder.state !== "inactive") {
      try {
        run.recorder.stop();
      } catch {
        /* already stopping */
      }
    }
    try {
      run.source?.stop();
    } catch {
      /* never started */
    }
    void run.context?.close().catch(() => undefined);
  }, []);

  const cancel = useCallback((): void => {
    teardown();
    setPhase("idle");
    setSecondsLeft(0);
  }, [teardown]);

  const fail = useCallback(
    (message: string): void => {
      teardown();
      setPhase("failed");
      setSecondsLeft(0);
      setError(message);
    },
    [teardown]
  );

  const start = useCallback((): void => {
    teardown();
    setError(null);
    const stream = getStream();
    if (!available || stream === null) {
      fail("Turn the microphone on to test it.");
      return;
    }
    const run: Running = { recorder: null, context: null, source: null, timers: [], cancelled: false };
    running.current = run;
    const chunks: Blob[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream);
    } catch {
      fail("This microphone cannot be tested here.");
      return;
    }
    run.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      if (!run.cancelled) fail("The test recording stopped.");
    };
    recorder.onstop = () => {
      if (run.cancelled) return;
      void (async () => {
        try {
          const bytes = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer();
          chunks.length = 0;
          if (run.cancelled) return;
          const context = new AudioContext();
          run.context = context;
          const decoded = await context.decodeAudioData(bytes);
          if (run.cancelled) return;
          const source = context.createBufferSource();
          source.buffer = decoded;
          source.connect(context.destination);
          source.onended = () => {
            if (run.cancelled) return;
            teardown();
            setPhase("idle");
          };
          run.source = source;
          setPhase("playing");
          source.start();
        } catch {
          if (!run.cancelled) fail("The test recording could not be played back.");
        }
      })();
    };
    recorder.start();
    setPhase("recording");
    setSecondsLeft(MIC_TEST_SECONDS);
    for (let s = 1; s < MIC_TEST_SECONDS; s += 1) {
      run.timers.push(setTimeout(() => setSecondsLeft(MIC_TEST_SECONDS - s), s * 1000));
    }
    run.timers.push(
      setTimeout(() => {
        setSecondsLeft(0);
        if (recorder.state !== "inactive") recorder.stop();
      }, MIC_TEST_SECONDS * 1000)
    );
  }, [available, fail, getStream, teardown]);

  // A different device, or none: whatever was being tested is gone.
  const lastKey = useRef(deviceKey);
  useEffect(() => {
    if (lastKey.current === deviceKey) return;
    lastKey.current = deviceKey;
    cancel();
  }, [deviceKey, cancel]);

  // A hidden selector (a take starting, a cancel) stops the check, so its
  // playback can never sound during a recording.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.hidden) cancel();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      teardown();
    };
  }, [cancel, teardown]);

  return { phase, secondsLeft, error, available, start, cancel };
}
