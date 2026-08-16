// Transport row for the video stage — one 36 px line:
//   ▶/⏸ · `0:03.4 / 0:16.0` (mono, tabular) · ⟲ loop-in-range · mute · ⛶
// Buttons carry the keyboard hints in their `title`s. Follows the
// EditToolbar button language (`.psl__et-btn`-like sizing, mono
// eyebrow type) but sits in-flow under the video, not floating.
//
// Buttons `preventDefault` on mousedown so focus stays on the stage
// root and the keyboard model keeps working after a click.

import type { ReactElement } from "react";
import { formatTimecode } from "../shared/video-range";
import { KEY_HINTS } from "./video-transport-keys";

export type VideoTransportProps = {
  playing: boolean;
  currentTime: number;
  durationSec: number;
  loopInRange: boolean;
  muted: boolean;
  onTogglePlay: () => void;
  onToggleLoop: () => void;
  onToggleMute: () => void;
  onFullscreen: () => void;
};

const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

export function VideoTransport(props: VideoTransportProps): ReactElement {
  const { playing, currentTime, durationSec, loopInRange, muted } = props;
  return (
    <div className="psl__vt" role="toolbar" aria-label="Video transport" data-testid="video-transport">
      <button
        type="button"
        className="psl__vt-btn is-play"
        title={KEY_HINTS.play}
        aria-label={playing ? "Pause" : "Play"}
        aria-pressed={playing}
        onMouseDown={keepFocus}
        onClick={props.onTogglePlay}
        data-testid="video-transport-play"
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
          </svg>
        )}
      </button>

      <span className="psl__vt-time" title={KEY_HINTS.step} data-testid="video-transport-time">
        <b>{formatTimecode(currentTime)}</b>
        <i>/</i>
        <span>{formatTimecode(durationSec)}</span>
      </span>

      <span className="psl__vt-spacer" />

      <button
        type="button"
        className={`psl__vt-btn${loopInRange ? " is-on" : ""}`}
        title={`${KEY_HINTS.loop} · ${KEY_HINTS.trim}`}
        aria-label="Loop in range"
        aria-pressed={loopInRange}
        onMouseDown={keepFocus}
        onClick={props.onToggleLoop}
        data-testid="video-transport-loop"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M17 2l4 4-4 4" />
          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
          <path d="M7 22l-4-4 4-4" />
          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
        </svg>
        <span className="psl__vt-btn-label">loop</span>
      </button>

      <button
        type="button"
        className={`psl__vt-btn${muted ? " is-on" : ""}`}
        title={KEY_HINTS.mute}
        aria-label={muted ? "Unmute" : "Mute"}
        aria-pressed={muted}
        onMouseDown={keepFocus}
        onClick={props.onToggleMute}
        data-testid="video-transport-mute"
      >
        {muted ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M11 5L6 9H2v6h4l5 4V5z" />
            <path d="M23 9l-6 6M17 9l6 6" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M11 5L6 9H2v6h4l5 4V5z" />
            <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            <path d="M19 5a9 9 0 0 1 0 14" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="psl__vt-btn"
        title={KEY_HINTS.fullscreen}
        aria-label="Fullscreen"
        onMouseDown={keepFocus}
        onClick={props.onFullscreen}
        data-testid="video-transport-fullscreen"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
        </svg>
      </button>
    </div>
  );
}
