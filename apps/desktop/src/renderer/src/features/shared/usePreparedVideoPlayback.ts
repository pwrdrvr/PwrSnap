import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

type Phase = "preparing" | "loading" | "ready" | "error";
type PlaybackState = { original: string; target: string | undefined; src: string; phase: Phase };
type Position = { original: string; time: number; playing: boolean; rate: number; volume: number };

/** Show and scrub the original immediately. Only a background HEAD request
 * waits for audio mixing; the media element switches after publication. */
export function usePreparedVideoPlayback(
  videoRef: RefObject<HTMLVideoElement | null>,
  original: string,
  prepared: string | undefined
) {
  const [state, setState] = useState<PlaybackState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const position = useRef<Position | null>(null);
  const current = state?.original === original && state.target === prepared ? state : null;
  const phase = current?.phase ?? (prepared ? "preparing" : "ready");
  const src = current?.src ?? original;

  useEffect(() => {
    position.current = null;
    if (prepared === undefined) return;
    const controller = new AbortController();
    setState({ original, target: prepared, src: original, phase: "preparing" });
    void (async () => {
      try {
        const response = await fetch(prepared, { method: "HEAD", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`Playback preparation failed: ${response.status}`);
        if (controller.signal.aborted) return;
        const el = videoRef.current;
        if (el !== null) position.current = {
          original, time: el.currentTime, playing: !el.paused,
          rate: el.playbackRate, volume: el.volume
        };
        setState({ original, target: prepared, src: prepared, phase: "loading" });
      } catch {
        if (!controller.signal.aborted) {
          setState({ original, target: prepared, src: original, phase: "error" });
        }
      }
    })();
    return () => controller.abort();
  }, [original, prepared, attempt, videoRef]);

  const onLoadedMetadata = useCallback(() => {
    const el = videoRef.current;
    if (el === null || (el.currentSrc && el.currentSrc !== src)) return;
    const saved = position.current;
    position.current = null;
    if (saved?.original === original) {
      el.currentTime = Number.isFinite(el.duration) ? Math.min(saved.time, el.duration) : saved.time;
      el.playbackRate = saved.rate;
      el.volume = saved.volume;
      if (saved.playing) void el.play().catch(() => undefined);
    }
    if (phase === "loading") {
      setState({ original, target: prepared, src, phase: "ready" });
    }
  }, [original, prepared, phase, src, videoRef]);

  const onError = useCallback(() => {
    if (src !== original) setState({ original, target: prepared, src: original, phase: "error" });
  }, [original, prepared, src]);

  const cancelResume = useCallback(() => {
    if (position.current !== null) position.current.playing = false;
  }, []);

  return {
    src,
    phase,
    audioUnavailable: phase !== "ready",
    onLoadedMetadata,
    onError,
    cancelResume,
    retry: () => setAttempt((value) => value + 1)
  };
}
