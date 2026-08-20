// The video playhead position, published OUTSIDE React state.
//
// While a video plays, the stage's rAF loop has a new head position
// every animation frame. Routing that through `useState` re-rendered
// the whole `VideoStage` subtree — transport + timeline, ~180 elements
// including one tick span per minute of source — at up to 60 Hz, for a
// value whose only visible consumers are a 1 px line and a tenths
// timecode. Measured at ~2.4 % of a core in a production build and
// ~8.5 % under React's development build (which is what `pnpm dev`
// runs); see docs/solutions/2026-08-20-video-stage-playhead-cpu.md.
//
// So the head travels on its own channel: `set()` from the rAF loop,
// `subscribe()` from the two leaves that draw it, each writing its own
// DOM node directly. React state keeps only the DISCRETE positions —
// seek, pause, capture switch — which is all any re-render needs.
//
// Deliberately not `useSyncExternalStore`: that exists to feed a value
// back INTO render, which is the exact cost being removed here.

import { useRef } from "react";

export type PlayheadListener = (sec: number) => void;

export type PlayheadSource = {
  /** The most recently published position, in seconds. */
  get: () => number;
  /** Publish a position. Subscribers run synchronously. */
  set: (sec: number) => void;
  /** Subscribe. The listener fires immediately with the current
   *  position so a freshly mounted node places itself without waiting
   *  for the next frame, and again on every change. */
  subscribe: (listener: PlayheadListener) => () => void;
};

export function createPlayheadSource(initialSec = 0): PlayheadSource {
  let current = initialSec;
  const listeners = new Set<PlayheadListener>();
  return {
    get: () => current,
    set: (sec: number): void => {
      if (sec === current) return;
      current = sec;
      for (const listener of listeners) listener(sec);
    },
    subscribe: (listener: PlayheadListener): (() => void) => {
      listeners.add(listener);
      listener(current);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

/** One source per stage instance, stable for the component's lifetime. */
export function usePlayheadSource(): PlayheadSource {
  const ref = useRef<PlayheadSource | null>(null);
  if (ref.current === null) ref.current = createPlayheadSource();
  return ref.current;
}
