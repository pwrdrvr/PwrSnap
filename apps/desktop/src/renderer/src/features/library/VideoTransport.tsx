// Transport row for the video stage — one 36 px line:
//   ▶/⏸ · `0:03.4 / 0:16.0` (mono, tabular) · ⟲ loop-in-range · mute · ⛶
// Buttons carry the keyboard hints in their `title`s. Follows the
// EditToolbar button language (`.psl__et-btn`-like sizing, mono
// eyebrow type) but sits in-flow under the video, not floating.
//
// Buttons `preventDefault` on mousedown so focus stays on the stage
// root and the keyboard model keeps working after a click.

import { useEffect, useRef, type ReactElement } from "react";
import type { ShortcutPlatform } from "@pwrsnap/shared";
import { rendererShortcutPlatform } from "../../lib/shortcut-platform";
import type { PlayheadSource } from "../shared/playhead";
import { formatTimecode } from "../shared/video-range";
import { videoTransportKeyHints } from "./video-transport-keys";

export type VideoTransportProps = {
  playing: boolean;
  /** Discrete head position (seek / pause). While playing, the live
   *  head arrives on `playhead` instead — see `shared/playhead.ts`. */
  currentTime: number;
  /** Live playhead channel. Present, the timecode updates itself from a
   *  subscription; absent, it renders `currentTime`. */
  playhead?: PlayheadSource | undefined;
  durationSec: number;
  loopInRange: boolean;
  muted: boolean;
  /** 0..1. The element's own level, independent of `muted`. */
  volume: number;
  onTogglePlay: () => void;
  onToggleLoop: () => void;
  onToggleMute: () => void;
  onVolumeChange: (next: number) => void;
  onFullscreen: () => void;
  shortcutPlatform?: ShortcutPlatform;
};

const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

/** The elapsed half of the timecode. Writes its own text node from the
 *  playhead subscription so a playing video does not re-render the
 *  transport (four inline SVGs) 60 times a second. `formatTimecode` is
 *  tenths, so most frames change nothing and are skipped outright.
 *
 *  React still owns the initial / discrete text: it only touches the
 *  DOM when `currentTime` itself changes, so it never clobbers a live
 *  value with a stale one. */
function TransportTimecode({
  currentTime,
  playhead
}: {
  currentTime: number;
  playhead: PlayheadSource | undefined;
}): ReactElement {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (playhead === undefined) return;
    let painted: string | null = null;
    return playhead.subscribe((sec) => {
      const el = ref.current;
      if (el === null) return;
      const next = formatTimecode(sec);
      if (next === painted) return;
      painted = next;
      el.textContent = next;
    });
  }, [playhead]);
  return <b ref={ref}>{formatTimecode(currentTime)}</b>;
}

export function VideoTransport(props: VideoTransportProps): ReactElement {
  const { playing, currentTime, playhead, durationSec, loopInRange, muted, volume } = props;
  const keyHints = videoTransportKeyHints(
    props.shortcutPlatform ?? rendererShortcutPlatform()
  );
  return (
    <div className="psl__vt" role="toolbar" aria-label="Video transport" data-testid="video-transport">
      <button
        type="button"
        className="psl__vt-btn is-play"
        title={keyHints.play}
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

      <span className="psl__vt-time" title={keyHints.step} data-testid="video-transport-time">
        <TransportTimecode currentTime={currentTime} playhead={playhead} />
        <i>/</i>
        <span>{formatTimecode(durationSec)}</span>
      </span>

      <span className="psl__vt-spacer" />

      <button
        type="button"
        className={`psl__vt-btn${loopInRange ? " is-on" : ""}`}
        title={`${keyHints.loop} · ${keyHints.trim}`}
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

      {/* Mute and level as one group: the slider reveals on hover or focus,
          so the resting row keeps its single-line shape while the level is
          still reachable — and reachable by keyboard, which a hover-only
          affordance would not be. */}
      <span className="psl__vt-vol" data-testid="video-transport-volume">
      <button
        type="button"
        className={`psl__vt-btn${muted ? " is-on" : ""}`}
        title={keyHints.mute}
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
        {/* This element deliberately carries NO `onMouseDown={keepFocus}`,
            unlike every button around it. On a <button> that handler only
            suppresses focus, because a button acts on `click`. On a range
            input the value change IS the default action — Blink gates
            `RangeInputType::HandleMouseDownEvent` on
            `!event.DefaultPrevented()` — so preventing it leaves the
            slider completely inert to click and drag, keyboard-only, while
            looking entirely normal. Measured in Chromium with two
            otherwise identical inputs and the same click: guarded stayed
            at 1.0 with zero `input` events, unguarded moved to 0.26.
            Pinned by video-transport-volume.test.ts. */}
        <input
          type="range"
          className="psl__vt-vol-slider"
          min={0}
          max={1}
          step={0.01}
          // Muted reads as zero: the thumb must not sit at 80% while
          // nothing is audible.
          value={muted ? 0 : volume}
          aria-label="Volume"
          aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
          onChange={(e) => props.onVolumeChange(Number(e.target.value))}
          data-testid="video-transport-volume-slider"
        />
      </span>

      <button
        type="button"
        className="psl__vt-btn"
        title={keyHints.fullscreen}
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
