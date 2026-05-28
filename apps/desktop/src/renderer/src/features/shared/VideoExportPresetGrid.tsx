// Two-row × three-card grid for video exports. Used by the
// library DetailRail's footer when the selected capture is a
// video.
//
// Top row: GIF LOW / MED / HIGH
// Bottom row: MP4 LOW / MED / HIGH
//
// Each card is a <VideoExportCard>; the grid wires the per-cell
// state, metrics, and callbacks. The grid is purely presentational
// — state lives in `useVideoExportPresets`, metrics in
// `useVideoPresetMetrics`. The DetailRail composes them.

import type { ReactElement } from "react";
import type { VideoPreset } from "@pwrsnap/shared";
import { VideoExportCard, readMetric } from "./VideoExportCard";
import {
  videoPresetKey,
  type VideoPresetMetricMap
} from "./useVideoPresetMetrics";
import type {
  VideoExportPresetsState,
  UseVideoExportPresetsResult
} from "./useVideoExportPresets";

export type VideoExportPresetGridProps = {
  readonly metrics: VideoPresetMetricMap;
  readonly states: VideoExportPresetsState;
  readonly onCopy: UseVideoExportPresetsResult["triggerCopy"];
  readonly onCopyPath: UseVideoExportPresetsResult["triggerCopyPath"];
  readonly onDrag: UseVideoExportPresetsResult["triggerDrag"];
  /** Optional fallback estimated bytes per cell — surfaced when
   *  `metrics` hasn't loaded yet (first paint, before the
   *  `video:presetMetrics` IPC resolves). Computed by the caller
   *  against the source dims using the same per-preset model the
   *  main-side estimator uses. */
  readonly fallback?: Partial<Record<`${"gif" | "mp4"}-${VideoPreset}`, { dim: string; bytes: string }>>;
};

const PRESETS: readonly VideoPreset[] = ["low", "med", "high"] as const;
const PRESET_LABELS: Readonly<Record<VideoPreset, string>> = {
  low: "Low",
  med: "Med",
  high: "High"
};

// ⌘1 / ⌘2 / ⌘3 → GIF L/M/H ; ⌘4 / ⌘5 / ⌘6 → MP4 L/M/H. The
// surrounding grid container binds the shortcuts via a keydown
// handler; the kbd labels here are just visual cues.
const KBD: Readonly<Record<`${"gif" | "mp4"}-${VideoPreset}`, string>> = {
  "gif-low": "⌘1",
  "gif-med": "⌘2",
  "gif-high": "⌘3",
  "mp4-low": "⌘4",
  "mp4-med": "⌘5",
  "mp4-high": "⌘6"
};

const EMPTY_FALLBACK = { dim: "—", bytes: "—" };

const FORMAT_LABELS: Readonly<Record<"gif" | "mp4", string>> = {
  gif: "GIF",
  mp4: "MP4"
};

export function VideoExportPresetGrid({
  metrics,
  states,
  onCopy,
  onCopyPath,
  onDrag,
  fallback
}: VideoExportPresetGridProps): ReactElement {
  return (
    <>
      {(["gif", "mp4"] as const).map((format) => (
        <div
          key={format}
          className="psl__copy-row-group"
          data-testid={`psl-copy-row-video-${format}-group`}
        >
          {/* Format header — distinguishes the GIF row from the MP4
              row at a glance. Without this the two rows are
              visually identical (cards labeled just "Low / Med /
              High") and the kbd hints (⌘1-3 vs ⌘4-6) are too
              small to disambiguate. */}
          <div className="psl__copy-format-eyebrow">
            <span>{FORMAT_LABELS[format]}</span>
            <span className="psl__copy-format-eyebrow-line" />
          </div>
          <div
            className="psl__copy-row"
            data-testid={`psl-copy-row-video-${format}`}
          >
            {PRESETS.map((preset) => {
              const key = videoPresetKey(format, preset);
              const cellMetric = metrics[key];
              const cellFallback = fallback?.[key] ?? EMPTY_FALLBACK;
              const cellState = states[key] ?? { kind: "idle" as const };
              const { dim, bytes } = readMetric(cellMetric, cellFallback);
              return (
                <VideoExportCard
                  key={key}
                  format={format}
                  preset={preset}
                  label={PRESET_LABELS[preset]}
                  kbd={KBD[key]}
                  dim={dim}
                  bytes={bytes}
                  state={cellState}
                  onCopy={() => onCopy(format, preset)}
                  onCopyPath={() => onCopyPath(format, preset)}
                  onDrag={() => onDrag(format, preset)}
                />
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
