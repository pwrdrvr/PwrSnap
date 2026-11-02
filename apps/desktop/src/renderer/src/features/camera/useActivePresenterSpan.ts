// Which presenter span the playhead is in, as React state that changes
// only when the playhead crosses a span boundary — not every frame. The
// stage's playhead travels outside React (`shared/playhead.ts`), so this
// subscribes to it and re-renders the presenter only at a boundary.

import { useEffect, useState, type RefObject } from "react";
import { presenterSpanAt, type PresenterSpan } from "@pwrsnap/shared";

export type TimeSubscribe = (listener: (sec: number) => void) => () => void;

function indexAt(spans: readonly PresenterSpan[], t: number): number {
  const span = presenterSpanAt(spans, t);
  return span === null ? -1 : spans.indexOf(span);
}

/** Index into `spans` of the span at the playhead, or -1. */
export function useActivePresenterSpan(
  spans: readonly PresenterSpan[],
  subscribe: TimeSubscribe | null,
  fallbackSec = 0
): number {
  const [index, setIndex] = useState(() => indexAt(spans, fallbackSec));
  useEffect(() => {
    if (spans.length === 0) {
      setIndex(-1);
      return;
    }
    if (subscribe === null) {
      setIndex(indexAt(spans, fallbackSec));
      return;
    }
    return subscribe((sec) => {
      const next = indexAt(spans, sec);
      setIndex((prev) => (prev === next ? prev : next));
    });
  }, [spans, subscribe, fallbackSec]);
  return spans.length === 0 ? -1 : index;
}

/** A `TimeSubscribe` over a <video>: every frame while it plays, and on
 *  each seek while it does not. */
export function videoTimeSubscribe(videoRef: RefObject<HTMLVideoElement | null>): TimeSubscribe {
  return (listener) => {
    const el = videoRef.current;
    if (el === null) return () => undefined;
    let frame = 0;
    const tick = (): void => {
      listener(el.currentTime);
      frame = requestAnimationFrame(tick);
    };
    const onPlay = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const onStop = (): void => {
      cancelAnimationFrame(frame);
      listener(el.currentTime);
    };
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onStop);
    el.addEventListener("seeked", onStop);
    listener(el.currentTime);
    if (!el.paused) onPlay();
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onStop);
      el.removeEventListener("seeked", onStop);
    };
  };
}
