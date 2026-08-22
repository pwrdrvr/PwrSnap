// The playhead line spanning every lane, with the accent cap at the ruler
// and a timecode tag. Positioned with `transform` so a moving head never
// dirties layout — same reasoning as the Library video timeline.

import type { ReactElement } from "react";
import { formatTimecode } from "../../shared/video-range";

export function Playhead({ leftPx, sec }: { leftPx: number; sec: number }): ReactElement {
  return (
    <div
      className="szt__playhead"
      style={{ transform: `translateX(${leftPx}px)` }}
      aria-hidden="true"
      data-testid="sizzle-timeline-playhead"
    >
      <span className="szt__playhead-time">{formatTimecode(sec)}</span>
    </div>
  );
}
