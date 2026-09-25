// Two-row × three-card grid for video exports. Used by the
// library DetailRail's footer when the selected capture is a
// video.
//
// Top row: GIF LOW / MED / HIGH
// Bottom row: MP4 LOW / MED / HIGH
//
// The MP4 eyebrow carries one toggle per audio track the take recorded
// (Mic / System), so the choice of whether a track ships sits right
// beside the cards it governs. GIF never carries audio, so its row has
// none. A take with no audio says so instead.
//
// Each card is a <VideoExportCard>; the grid wires the per-cell
// state, metrics, and callbacks. The grid is purely presentational
// — state lives in `useVideoExportPresets`, metrics in
// `useVideoPresetMetrics`. The DetailRail composes them.

import type { ReactElement } from "react";
import {
  acceleratorToDisplayText,
  type ShortcutPlatform,
  type VideoPreset
} from "@pwrsnap/shared";
import { rendererShortcutPlatform } from "../../lib/shortcut-platform";
import type { Mp4AudioControl, Mp4AudioTrack } from "./useMp4ExportAudio";
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
  /** Explicit override for deterministic platform-presentation tests. */
  readonly shortcutPlatform?: ShortcutPlatform;
  /** Hide chords when the embedding surface delegates numbered keys elsewhere. */
  readonly showShortcutHints?: boolean;
  /** MP4 audio toggles for the MP4 eyebrow. Omitted → no toggles. */
  readonly mp4Audio?: Mp4AudioControl | undefined;
};

const PRESETS: readonly VideoPreset[] = ["low", "med", "high"] as const;
const PRESET_LABELS: Readonly<Record<VideoPreset, string>> = {
  low: "Low",
  med: "Med",
  high: "High"
};

// The active parent surface owns these chords. This grid only renders the
// matching hint, so multiple grids never install duplicate listeners.
const ACCELERATOR: Readonly<Record<`${"gif" | "mp4"}-${VideoPreset}`, string>> = {
  "gif-low": "CommandOrControl+1",
  "gif-med": "CommandOrControl+2",
  "gif-high": "CommandOrControl+3",
  "mp4-low": "CommandOrControl+4",
  "mp4-med": "CommandOrControl+5",
  "mp4-high": "CommandOrControl+6"
};

const EMPTY_FALLBACK = { dim: "—", bytes: "—" };

const FORMAT_LABELS: Readonly<Record<"gif" | "mp4", string>> = {
  gif: "GIF",
  mp4: "MP4"
};

const AUDIO_TRACKS: readonly Mp4AudioTrack[] = ["microphone", "systemAudio"] as const;
const AUDIO_SHORT: Readonly<Record<Mp4AudioTrack, string>> = {
  microphone: "Mic",
  systemAudio: "System"
};
const AUDIO_LONG: Readonly<Record<Mp4AudioTrack, string>> = {
  microphone: "Microphone",
  systemAudio: "System audio"
};

/** SourceChip's microphone / speaker glyphs at 11px. Left out adds a
 *  slash (mic) or an x (speaker), so the state never rests on colour. */
function AudioTrackGlyph({
  track,
  kept
}: {
  readonly track: Mp4AudioTrack;
  readonly kept: boolean;
}): ReactElement {
  const common = {
    width: 11,
    height: 11,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };
  if (track === "microphone") {
    return (
      <svg {...common}>
        <rect x="5.6" y="1.6" width="4.8" height="8" rx="2.4" />
        <path d="M3.2 7.4a4.8 4.8 0 0 0 9.6 0" />
        <path d="M8 12.2v2.2" />
        {kept ? null : <path d="M2 2l12 12" />}
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M2.2 6.2h2.4L8 3.2v9.6L4.6 9.8H2.2z" />
      {kept ? (
        <>
          <path d="M10.8 6.1a2.6 2.6 0 0 1 0 3.8" />
          <path d="M12.7 4.2a5.2 5.2 0 0 1 0 7.6" />
        </>
      ) : (
        <path d="M10.6 6.2l3.6 3.6M14.2 6.2l-3.6 3.6" />
      )}
    </svg>
  );
}

/** Right-hand end of the MP4 eyebrow: a toggle per recorded track, or a
 *  plain statement when the take has none. Nothing while the preference
 *  is still loading — a toggle that might flip on its own is worse than
 *  a beat of empty eyebrow. */
function Mp4AudioToggles({ control }: { readonly control: Mp4AudioControl }): ReactElement | null {
  const tracks = AUDIO_TRACKS.filter((track) => control.recorded[track]);
  if (tracks.length === 0) {
    return (
      <span className="psl__copy-audio-none" data-testid="psl-copy-audio-none">
        <AudioTrackGlyph track="systemAudio" kept={false} />
        <span>No audio recorded</span>
      </span>
    );
  }
  const kept = control.kept;
  if (kept === null) return null;
  return (
    <span className="psl__copy-audio" role="group" aria-label="Audio in MP4 exports">
      {tracks.map((track) => {
        const on = kept[track];
        return (
          <button
            key={track}
            type="button"
            className="psl__copy-audio-toggle"
            data-track={track}
            aria-pressed={on}
            // The visible "Mic" / "System" leads the accessible name
            // (label-in-name); aria-pressed carries the state, so the
            // visible "off" is hidden from AT rather than read twice.
            aria-label={`${AUDIO_SHORT[track]} audio in MP4 exports`}
            title={
              on
                ? `${AUDIO_LONG[track]} is in MP4 exports — click to leave it out`
                : `${AUDIO_LONG[track]} is left out of MP4 exports — click to include it`
            }
            onClick={() => control.onToggle(track, !on)}
          >
            <AudioTrackGlyph track={track} kept={on} />
            <span>{AUDIO_SHORT[track]}</span>
            {on ? null : <span aria-hidden="true">off</span>}
          </button>
        );
      })}
    </span>
  );
}

export function VideoExportPresetGrid({
  metrics,
  states,
  onCopy,
  onCopyPath,
  onDrag,
  fallback,
  shortcutPlatform = rendererShortcutPlatform(),
  showShortcutHints = true,
  mp4Audio
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
              High"). */}
          <div className="psl__copy-format-eyebrow">
            <span>{FORMAT_LABELS[format]}</span>
            <span className="psl__copy-format-eyebrow-line" />
            {format === "mp4" && mp4Audio !== undefined ? (
              <Mp4AudioToggles control={mp4Audio} />
            ) : null}
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
                  kbd={
                    showShortcutHints
                      ? acceleratorToDisplayText(ACCELERATOR[key], shortcutPlatform)
                      : null
                  }
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
