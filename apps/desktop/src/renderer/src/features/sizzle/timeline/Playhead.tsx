// The playhead line spanning every lane, with the accent cap at the ruler
// and a timecode tag. Positioned with `transform` so a moving head never
// dirties layout — same reasoning as the Library video timeline.

import type { ReactElement } from "react";
import { formatTimecode } from "../../shared/video-range";

/** Room the timecode tag needs to the right of the line. Near the lanes'
 *  right edge the tag flips to the left so it never overflows the scroll
 *  area (an overflowing tag puts a scrollbar on a reel that fits). */
export const PLAYHEAD_TAG_PX = 56;

export function Playhead({
  leftPx,
  sec,
  widthPx
}: {
  leftPx: number;
  sec: number;
  /** The lanes' width. */
  widthPx: number;
}): ReactElement {
  // Unmeasured (0) = never flip; the first measured layout decides.
  const flip = widthPx > 0 && leftPx + PLAYHEAD_TAG_PX > widthPx;
  return (
    <div
      className={"szt__playhead" + (flip ? " is-flip" : "")}
      style={{ transform: `translateX(${leftPx}px)` }}
      aria-hidden="true"
      data-testid="sizzle-timeline-playhead"
    >
      <span className="szt__playhead-time">{formatTimecode(sec)}</span>
    </div>
  );
}
