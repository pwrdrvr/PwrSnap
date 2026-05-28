// Presentational two-button row (GIF + MP4) rendered against a
// `VideoExportState`. Used by the float-over toast, the tray
// popover's last-snap section, and the library DetailRail's footer.
//
// Returns a fragment of two `<button>` elements styled with
// `.fo__copy-btn*` classes (shared with the image L/M/H buttons via
// CopyButton.tsx). Surrounding GRID layout is the consumer's job —
// each surface already has its own slot (`fo__copy`,
// `ps-tray__last-copy`, `psl__copy-row`) with surface-specific
// positioning, padding, and 2-column inline-style overrides. Keeping
// the wrapper out here keeps the component honest about what it owns
// (the buttons) versus what the consumer owns (where they sit).

import type { ReactElement } from "react";
import type { VideoExportState } from "./useVideoExport";

export type VideoExportButtonsProps = {
  readonly exportState: VideoExportState;
  /** Drives the MP4 button's idle-state subtitle ("with audio" vs
   *  "silent"). GIF is always silent regardless of source. */
  readonly hasSystemAudio: boolean;
  readonly hasMicrophoneAudio: boolean;
  readonly onExport: (format: "gif" | "mp4") => void;
};

const FORMATS = ["gif", "mp4"] as const;

export function VideoExportButtons({
  exportState,
  hasSystemAudio,
  hasMicrophoneAudio,
  onExport
}: VideoExportButtonsProps): ReactElement {
  return (
    <>
      {FORMATS.map((format) => {
        const running =
          exportState.kind === "running" && exportState.format === format;
        const done =
          exportState.kind === "done" && exportState.format === format;
        const errored =
          exportState.kind === "error" && exportState.format === format;
        const subtitle = running
          ? "Encoding…"
          : done
            ? "Saved"
            : errored
              ? "Failed — retry"
              : format === "gif"
                ? "Silent · share-friendly"
                : hasSystemAudio || hasMicrophoneAudio
                  ? "Full clip · with audio"
                  : "Full clip · silent";
        return (
          <button
            key={format}
            type="button"
            className="fo__copy-btn"
            disabled={exportState.kind === "running"}
            onClick={() => onExport(format)}
          >
            <span className="fo__copy-btn-row1">
              <span className="fo__copy-label">{format.toUpperCase()}</span>
            </span>
            <span className="fo__copy-meta">
              <span className="fo__copy-bytes">{subtitle}</span>
            </span>
          </button>
        );
      })}
    </>
  );
}
