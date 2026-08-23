// Reel-level transport: play the WHOLE reel from the timeline, not one
// scene at a time.
//
// Before this, the only way to watch a reel end to end was Render →
// Reveal in Finder: the preview stage lived inside a sequence scene's
// card, and a legacy one-capture scene had no stage at all.
//
// Two design points worth keeping:
//
//  1. The head travels on a `PlayheadSource` (features/shared/playhead.ts),
//     NOT React state. That channel exists because routing a per-frame
//     position through `useState` re-rendered a whole stage subtree at
//     display refresh — measured, and written up in
//     docs/solutions/2026-08-20-video-stage-playhead-cpu.md. This reel has
//     up to 80 clips plus a word ribbon in the same subtree, so the same
//     rule applies with more at stake. React state here holds only the
//     DISCRETE facts: are we playing, and which scene is under the head.
//
//  2. The rAF clock is the master and audio is slaved to it. A reel mixes
//     scenes that HAVE synthesized narration with scenes that do not — an
//     estimated scene has no audio file in existence yet, and a scene whose
//     audio the export takes from the clip itself has none to preview. A
//     single monotonic clock is the only thing that can run across both, so
//     the picture always plays and sound joins wherever it exists; the
//     transport says which case you are in rather than looking broken.
//     Drift is corrected against the clock the same way the stage corrects
//     video.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PlayheadSource } from "../shared/playhead";
import type { TimelineModel } from "./timeline/timeline-model";

/** Re-seek the narration when it drifts from the master clock by more
 *  than this. Matches the preview stage's video drift tolerance. */
const AUDIO_DRIFT_TOLERANCE_SEC = 0.25;

// Volume is module-scoped, like the chat pane's width: it survives a remount
// within a session and resets on launch. It is a property of how the operator
// is listening right now, not of the reel, so it does not belong in Settings.
let savedVolume = 1;
let savedMuted = false;

/** Test-only: reset the session-scoped listening state between cases. */
export function resetReelVolumeForTests(): void {
  savedVolume = 1;
  savedMuted = false;
}

export type ReelPlayback = {
  playing: boolean;
  /** Scene under the head. Discrete — changes at scene boundaries only. */
  activeSceneId: string | null;
  /** False when the scene under the head has no narration to sound — an
   *  estimated scene, or one whose audio the export takes from the clip. The
   *  transport says so rather than looking broken. */
  activeSceneHasAudio: boolean;
  volume: number;
  muted: boolean;
  setVolume: (next: number) => void;
  toggleMuted: () => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** Move the head without changing play/pause. */
  seek: (sec: number) => void;
};

export function useReelPlayback(args: {
  model: TimelineModel;
  head: PlayheadSource;
  /** Decoded narration per scene id; scenes absent from it play silent. */
  audioBlobs: Record<string, Blob>;
  /** The reel player's own <audio>. Kept separate from the per-scene
   *  preview element so the two can never both be sounding. */
  audioRef: React.RefObject<HTMLAudioElement | null>;
  /** Stop any single-scene preview before the reel takes over. */
  onTakeOver?: (() => void) | undefined;
}): ReelPlayback {
  const { model, head, audioBlobs, audioRef, onTakeOver } = args;
  const [playing, setPlaying] = useState(false);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [volume, setVolumeState] = useState(savedVolume);
  const [muted, setMutedState] = useState(savedMuted);

  // Master clock: wall time when playback started, and the head position
  // it started from. Playing position = startedFromSec + elapsed.
  const clockRef = useRef<{ startedAtMs: number; fromSec: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const audioSceneRef = useRef<string | null>(null);

  // The model changes identity as the user edits; the loop reads it
  // through a ref so a re-render never restarts playback mid-frame.
  const modelRef = useRef(model);
  modelRef.current = model;

  const revokeUrl = useCallback((): void => {
    if (objectUrlRef.current !== null) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  /** Point the reel's <audio> at the scene under `sec` and park it at the
   *  right offset. Silent scenes detach the source entirely. */
  const syncAudio = useCallback(
    (sceneId: string | null, localSec: number, shouldPlay: boolean): void => {
      const el = audioRef.current;
      if (el === null) return;
      const blob = sceneId === null ? undefined : audioBlobs[sceneId];
      if (blob === undefined) {
        // Nothing to sound for this scene — the picture keeps playing.
        if (audioSceneRef.current !== null) {
          el.pause();
          el.removeAttribute("src");
          el.load();
          audioSceneRef.current = null;
          revokeUrl();
        }
        return;
      }
      if (audioSceneRef.current !== sceneId) {
        revokeUrl();
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        el.src = url;
        audioSceneRef.current = sceneId;
        try {
          el.currentTime = Math.max(0, localSec);
        } catch {
          // Metadata not ready; the drift check below re-seeks shortly.
        }
      } else if (Math.abs(el.currentTime - localSec) > AUDIO_DRIFT_TOLERANCE_SEC) {
        try {
          el.currentTime = Math.max(0, localSec);
        } catch {
          /* not seekable yet */
        }
      }
      el.volume = muted ? 0 : volume;
      el.muted = muted;
      if (shouldPlay) void el.play().catch(() => undefined);
      else el.pause();
    },
    [audioBlobs, audioRef, muted, revokeUrl, volume]
  );

  // Keep a sounding element in step with the controls even when the head is
  // not moving (adjusting the slider while paused, or mid-scene).
  useEffect(() => {
    const el = audioRef.current;
    if (el === null) return;
    el.volume = muted ? 0 : volume;
    el.muted = muted;
  }, [audioRef, muted, volume]);

  const setVolume = useCallback((next: number): void => {
    const clamped = Math.min(1, Math.max(0, next));
    savedVolume = clamped;
    setVolumeState(clamped);
    // Nudging the slider off zero is an unmute — otherwise the control lies.
    if (clamped > 0 && savedMuted) {
      savedMuted = false;
      setMutedState(false);
    }
  }, []);

  const toggleMuted = useCallback((): void => {
    savedMuted = !savedMuted;
    setMutedState(savedMuted);
  }, []);

  // The rAF loop below is created once per play() and would otherwise hold
  // the applyPosition — and therefore the audioBlobs — from that render. A
  // narration blob that finishes decoding mid-playback has to start sounding.
  const applyPositionRef = useRef<(sec: number, shouldPlay: boolean) => void>(() => undefined);

  /** Publish `sec`, update the discrete scene, and keep audio in step. */
  const applyPosition = useCallback(
    (sec: number, shouldPlay: boolean): void => {
      const current = modelRef.current;
      head.set(sec);
      const region =
        current.scenes.find((s) => sec >= s.startSec && sec < s.endSec) ?? current.scenes.at(-1) ?? null;
      const sceneId = region?.sceneId ?? null;
      setActiveSceneId((prev) => (prev === sceneId ? prev : sceneId));
      syncAudio(sceneId, region === null ? 0 : Math.max(0, sec - region.startSec), shouldPlay);
    },
    [head, syncAudio]
  );
  useEffect(() => {
    applyPositionRef.current = applyPosition;
  }, [applyPosition]);

  const stopLoop = useCallback((): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    clockRef.current = null;
  }, []);

  const pause = useCallback((): void => {
    stopLoop();
    setPlaying(false);
    audioRef.current?.pause();
  }, [audioRef, stopLoop]);

  const seek = useCallback(
    (sec: number): void => {
      const total = modelRef.current.totalSec;
      const next = Math.min(Math.max(0, sec), Math.max(0, total));
      // Re-anchor the clock so a seek during playback does not jump back.
      if (clockRef.current !== null) {
        clockRef.current = { startedAtMs: performance.now(), fromSec: next };
      }
      applyPosition(next, clockRef.current !== null);
    },
    [applyPosition]
  );

  const play = useCallback((): void => {
    const total = modelRef.current.totalSec;
    if (!(total > 0)) return;
    onTakeOver?.();
    // Replay from the top when the head is parked at the end.
    const from = head.get() >= total - 0.01 ? 0 : head.get();
    clockRef.current = { startedAtMs: performance.now(), fromSec: from };
    setPlaying(true);
    applyPosition(from, true);
    const tick = (): void => {
      const clock = clockRef.current;
      if (clock === null) return;
      const elapsed = (performance.now() - clock.startedAtMs) / 1000;
      const sec = clock.fromSec + elapsed;
      const end = modelRef.current.totalSec;
      if (sec >= end) {
        applyPositionRef.current(end, false);
        stopLoop();
        setPlaying(false);
        audioRef.current?.pause();
        return;
      }
      applyPositionRef.current(sec, true);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [applyPosition, audioRef, head, onTakeOver, stopLoop]);

  const toggle = useCallback((): void => {
    if (playing) pause();
    else play();
  }, [pause, play, playing]);

  // Editing the reel while it plays changes where every clip sits, so
  // stop rather than let the head run against a stale layout.
  const sceneShapeKey = model.scenes.map((s) => `${s.sceneId}:${s.endSec.toFixed(3)}`).join(",");
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    if (wasPlayingRef.current && playing) pause();
    wasPlayingRef.current = playing;
    // Only the SHAPE matters; a re-render with the same layout must not stop playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneShapeKey]);

  useEffect(
    () => () => {
      stopLoop();
      revokeUrl();
    },
    [revokeUrl, stopLoop]
  );

  const activeSceneHasAudio = activeSceneId !== null && audioBlobs[activeSceneId] !== undefined;

  return {
    playing,
    activeSceneId,
    activeSceneHasAudio,
    volume,
    muted,
    setVolume,
    toggleMuted,
    play,
    pause,
    toggle,
    seek
  };
}
