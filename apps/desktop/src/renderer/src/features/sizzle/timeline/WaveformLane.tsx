// The narration waveform under the clips, on the SAME axis. Each resolved
// scene with decoded audio draws wavesurfer across its region; an
// estimated scene (or a resolved one whose audio is still loading) shows
// the idle dashed baseline — no fabricated variation.

import type { ReactElement } from "react";
import { SequenceWaveform } from "../../shared/SequenceWaveform";
import type { TimelineModel } from "./timeline-model";

const WAVE_HEIGHT_PX = 24;

export function WaveformLane({
  model,
  x,
  audioBlobs
}: {
  model: TimelineModel;
  x: (sec: number) => number;
  /** Decoded narration per scene id. */
  audioBlobs: Record<string, Blob>;
}): ReactElement {
  return (
    <div className="szt__lane" aria-hidden="true" data-testid="sizzle-timeline-waveform">
      {model.scenes.map((scene) => {
        const left = x(scene.startSec);
        const width = Math.max(0, x(scene.endSec) - left);
        const blob = scene.exact ? audioBlobs[scene.sceneId] : undefined;
        if (blob === undefined) {
          const bars = Math.max(8, Math.floor(width / 9));
          return (
            <span
              key={scene.sceneId}
              className="szt__wave-idle"
              style={{ left: `${left}px`, width: `${width}px` }}
              data-testid={`sizzle-timeline-wave-idle-${scene.index}`}
            >
              <span className="szt__wave-idle-bars">
                {Array.from({ length: bars }, (_, i) => (
                  <i key={i} />
                ))}
              </span>
            </span>
          );
        }
        return (
          <span
            key={scene.sceneId}
            className="szt__wave"
            style={{ left: `${left}px`, width: `${width}px` }}
            data-testid={`sizzle-timeline-wave-${scene.index}`}
          >
            <SequenceWaveform audioBlob={blob} height={WAVE_HEIGHT_PX} />
          </span>
        );
      })}
    </div>
  );
}
