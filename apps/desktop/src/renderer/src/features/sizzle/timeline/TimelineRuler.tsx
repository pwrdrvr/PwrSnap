// Tick row along the top of the timeline. `tickMarks()` (shared with the
// Library video timeline) coarsens its ladder by px/sec, so it needs no
// zoom-specific handling here.

import type { ReactElement } from "react";
import type { TickMark } from "../../shared/video-range";

export function TimelineRuler({
  ticks,
  x
}: {
  ticks: TickMark[];
  x: (sec: number) => number;
}): ReactElement {
  return (
    <div className="szt__lane szt__lane--ruler" aria-hidden="true" data-testid="sizzle-timeline-ruler">
      {ticks.map((t) => (
        <span
          key={t.sec}
          className={"szt__tick" + (t.major ? " is-major" : "")}
          style={{ left: `${x(t.sec)}px` }}
        >
          {t.label !== null && <i>{t.label}</i>}
        </span>
      ))}
    </div>
  );
}
