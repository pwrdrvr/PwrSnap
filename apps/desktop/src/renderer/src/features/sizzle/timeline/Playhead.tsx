// The playhead line spanning every lane, with the accent cap at the ruler
// and a timecode tag.
//
// It SUBSCRIBES to the head rather than taking a `playheadSec` prop, and
// writes `transform` + the timecode straight to its own DOM nodes. The
// head moves at display refresh while the reel plays or a scrub drags,
// and this lane's siblings are up to 80 clips plus a word ribbon — so
// routing the position through React state re-rendered all of it per
// frame. That is the exact cost `features/shared/playhead.ts` was built
// to remove (measured; see docs/solutions/2026-08-20-video-stage-playhead-cpu.md),
// and this timeline has more in the subtree than the stage that motivated it.

import { useEffect, useRef, type ReactElement } from "react";
import type { PlayheadSource } from "../../shared/playhead";
import { formatTimecode } from "../../shared/video-range";

/** Room the timecode tag needs to the right of the line. Near the lanes'
 *  right edge the tag flips to the left so it stays inside them. */
export const PLAYHEAD_TAG_PX = 56;

export function Playhead({
  head,
  pxPerSec,
  widthPx
}: {
  head: PlayheadSource;
  pxPerSec: number;
  /** The lanes' width, so the tag can flip instead of overflowing. */
  widthPx: number;
}): ReactElement {
  const lineRef = useRef<HTMLDivElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);

  useEffect(
    () =>
      head.subscribe((sec) => {
        const line = lineRef.current;
        if (line === null) return;
        const leftPx = sec * pxPerSec;
        // Quantized to device pixels: the head publishes at refresh rate but
        // only moves a visible amount every few frames on a long reel, and a
        // no-op transform write still costs a compositor commit.
        const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
        const quantized = Math.round(leftPx * dpr) / dpr;
        line.style.transform = `translateX(${quantized}px)`;
        const flip = widthPx > 0 && leftPx + PLAYHEAD_TAG_PX > widthPx;
        line.classList.toggle("is-flip", flip);
        if (timeRef.current !== null) timeRef.current.textContent = formatTimecode(sec);
      }),
    [head, pxPerSec, widthPx]
  );

  return (
    <div className="szt__playhead" aria-hidden="true" ref={lineRef} data-testid="sizzle-timeline-playhead">
      <span className="szt__playhead-time" ref={timeRef}>
        {formatTimecode(head.get())}
      </span>
    </div>
  );
}
