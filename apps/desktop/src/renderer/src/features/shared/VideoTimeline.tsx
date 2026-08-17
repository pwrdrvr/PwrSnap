// Timeline strip for video captures — filmstrip lane + waveform lane on
// one time axis, with a drag-scrub playhead, in/out trim handles, a
// dimming scrim outside the range, tick marks, and the
// `TRIM 0:03.4 – 0:11.2 · 7.8 s` eyebrow with a `Full clip` reset chip.
//
// Used in two places with the same machinery:
//   • Library video stage (`features/library/VideoStage.tsx`) — full
//     variant: 56 px filmstrip + 24 px waveform + ticks + playhead.
//   • Float-over post-capture toast (`compact`) — 40 px filmstrip +
//     handles + trim label; no waveform, no ticks, no playhead.
//
// The component is controlled: the caller owns `range` and
// `currentTime` and receives `onSeek` / `onRangeChange(range, commit)`.
// Persisting the range (`video:setDefaultRange`) is the caller's job —
// the strip only reports drags (`commit=false`) and releases
// (`commit=true`). Frames + audio are fetched by the caller too, so the
// float-over and the stage can share requests / caches.
//
// Plan: docs/plans/2026-08-15-001-feat-video-transport-trim-plan.md

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from "react";
import type { VideoFramesResult, VideoRange } from "@pwrsnap/shared";
import { SequenceWaveform } from "./SequenceWaveform";
import {
  clampRange,
  formatTimecode,
  fullRange,
  isFullRange,
  MIN_RANGE_SEC,
  pxToSec,
  roundTime,
  secToPx,
  tickMarks,
  trimLabel
} from "./video-range";

export type VideoTimelineProps = {
  durationSec: number;
  /** Playhead position. Ignored (not rendered) in `compact` mode. */
  currentTime?: number | undefined;
  range: VideoRange;
  /** Filmstrip descriptor from `video:frames`, `null` while loading /
   *  unavailable (lane renders an empty checker). */
  frames: VideoFramesResult | null;
  /** `undefined` = still loading, `null` = no audio track (empty lane),
   *  `Blob` = decoded by wavesurfer. Ignored in `compact` mode. */
  audioBlob?: Blob | null | undefined;
  onSeek?: ((sec: number) => void) | undefined;
  /** `commit=false` while dragging, `true` on release / keyboard set. */
  onRangeChange: (range: VideoRange, commit: boolean) => void;
  /** Called with the measured strip width (CSS px) so the caller can
   *  size its `video:frames` request. */
  onWidthChange?: ((widthPx: number) => void) | undefined;
  /** `true` when a pointer drag (scrub / trim handle) starts, `false`
   *  when it ends — release, cancel, lost capture, or unmount mid-drag.
   *
   *  Exists because `beginDrag` takes pointer capture, so a drag keeps
   *  running after the pointer leaves the strip (and, in the float-over
   *  toast, after it leaves the toast entirely). Hover-driven "user is
   *  busy" state therefore can't see the drag. The float-over feeds
   *  this into its auto-dismiss pause set so the toast can't close out
   *  from under an in-progress trim; the Library stage ignores it. */
  onInteractingChange?: ((interacting: boolean) => void) | undefined;
  compact?: boolean | undefined;
  /** Test hook / a11y label prefix. */
  label?: string | undefined;
};

type DragMode = "scrub" | "in" | "out";

const HANDLE_W = 8;

export function VideoTimeline(props: VideoTimelineProps): ReactElement {
  const {
    durationSec,
    currentTime = 0,
    range,
    frames,
    audioBlob,
    onSeek,
    onRangeChange,
    onWidthChange,
    compact = false
  } = props;

  const stripRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<{ mode: DragMode; sec: number } | null>(null);
  const dragRef = useRef<{ mode: DragMode; pointerId: number } | null>(null);

  // Interaction notification goes through a ref so the unmount cleanup
  // can reach the latest callback without re-subscribing, and so a
  // parent that re-creates the function each render doesn't churn.
  const interactingCbRef = useRef(props.onInteractingChange);
  interactingCbRef.current = props.onInteractingChange;
  const interactingRef = useRef(false);
  const setInteracting = useCallback((next: boolean): void => {
    if (interactingRef.current === next) return;
    interactingRef.current = next;
    interactingCbRef.current?.(next);
  }, []);

  // Measure the strip so px↔sec math and the frames request agree.
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (el === null) return;
    const post = (): void => {
      const w = Math.round(el.getBoundingClientRect().width);
      setWidth(w);
      onWidthChange?.(w);
    };
    post();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(post);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onWidthChange]);

  const secAt = useCallback(
    (clientX: number): number => {
      const el = stripRef.current;
      if (el === null) return 0;
      const rect = el.getBoundingClientRect();
      return pxToSec(clientX - rect.left, durationSec, rect.width);
    },
    [durationSec]
  );

  const applyDrag = useCallback(
    (mode: DragMode, sec: number, commit: boolean): void => {
      if (mode === "scrub") {
        onSeek?.(roundTime(sec));
        return;
      }
      const next =
        mode === "in"
          ? clampRange({ start: Math.min(sec, range.end - MIN_RANGE_SEC), end: range.end }, durationSec)
          : clampRange({ start: range.start, end: Math.max(sec, range.start + MIN_RANGE_SEC) }, durationSec);
      onRangeChange(next, commit);
    },
    [durationSec, onRangeChange, onSeek, range.end, range.start]
  );

  const beginDrag = (mode: DragMode) => (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return;
    // Compact strips (float-over) have no player to scrub — only the
    // handles are interactive there.
    if (mode === "scrub" && onSeek === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const strip = stripRef.current;
    if (strip === null) return;
    try {
      strip.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom */
    }
    dragRef.current = { mode, pointerId: e.pointerId };
    setInteracting(true);
    const sec = secAt(e.clientX);
    setDrag({ mode, sec });
    applyDrag(mode, sec, false);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    const sec = secAt(e.clientX);
    setDrag({ mode: d.mode, sec });
    applyDrag(d.mode, sec, false);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    const sec = secAt(e.clientX);
    setDrag(null);
    applyDrag(d.mode, sec, true);
    setInteracting(false);
    try {
      stripRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* jsdom */
    }
  };

  // Capture released without a pointerup / pointercancel (the OS took
  // the gesture over). Finish the drag so the range still commits — an
  // uncommitted range never persists and pins `useVideoTrimRange`'s
  // dragging flag — and so the interaction hold drops.
  //
  // Deliberately commits at the LAST OBSERVED drag position rather than
  // re-deriving one from the event: `lostpointercapture` is not a
  // positional event, and its coordinates need not reflect where the
  // pointer actually is. Committing `secAt(0)` from a zeroed event would
  // silently persist a MIN_RANGE_SEC sliver over the user's clip.
  //
  // `endDrag` nulls `dragRef` before calling `releasePointerCapture`, so
  // the lostpointercapture that a normal release fires lands here as a
  // no-op. (Capture lost because the strip left the DOM does NOT reach
  // this handler — the event has no path to React's delegated root
  // listener once the node is detached. That case is covered by the
  // unmount cleanup below, which drops the hold without committing.)
  const onLostPointerCapture = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    const sec = drag?.sec;
    setDrag(null);
    if (sec !== undefined) applyDrag(d.mode, sec, true);
    setInteracting(false);
  };

  // No drag-cancel gesture: the range follows the pointer and commits
  // on release, matching the handles' direct-manipulation feel.

  const inX = secToPx(range.start, durationSec, width);
  const outX = secToPx(range.end, durationSec, width);
  const playX = secToPx(currentTime, durationSec, width);
  const full = isFullRange(range, durationSec);
  const ticks = useMemo(
    () => (compact ? [] : tickMarks(durationSec, width)),
    [compact, durationSec, width]
  );

  const filmH = compact ? 40 : 56;
  const waveH = compact ? 0 : 24;

  const dragging = drag !== null;
  const tooltipSec = drag?.sec ?? null;
  const tooltipX = tooltipSec === null ? 0 : secToPx(tooltipSec, durationSec, width);

  const resetRange = (): void => {
    onRangeChange(fullRange(durationSec), true);
  };

  useEffect(() => {
    // Unmount mid-drag (capture navigated away): drop the pointer
    // bookkeeping so a late pointerup can't fire into a dead closure,
    // and release the interaction hold so the caller isn't pinned.
    return () => {
      dragRef.current = null;
      if (interactingRef.current) {
        interactingRef.current = false;
        interactingCbRef.current?.(false);
      }
    };
  }, []);

  return (
    <div
      className={`vtl${compact ? " vtl--compact" : ""}${dragging ? " is-dragging" : ""}`}
      data-testid={compact ? "video-timeline-compact" : "video-timeline"}
      // A pointer drag on a handle produces a native click after pointerup.
      // The timeline is direct manipulation, so that click must not reach a
      // parent capture/card handler and navigate away from the active video.
      onClick={(event) => event.stopPropagation()}
    >
      {!compact && (
        <div className="vtl__ticks" aria-hidden="true">
          {ticks.map((t) => (
            <span
              key={t.sec}
              className={`vtl__tick${t.major ? " is-major" : ""}`}
              style={{ left: `${secToPx(t.sec, durationSec, width)}px` }}
            >
              {t.label !== null && <i>{t.label}</i>}
            </span>
          ))}
        </div>
      )}

      <div
        ref={stripRef}
        className="vtl__strip"
        style={{ height: `${filmH + waveH}px` }}
        onPointerDown={beginDrag("scrub")}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={onLostPointerCapture}
        role="slider"
        aria-label={props.label ?? "Video timeline"}
        aria-valuemin={0}
        aria-valuemax={durationSec}
        aria-valuenow={currentTime}
        aria-valuetext={formatTimecode(currentTime)}
        tabIndex={-1}
      >
        {/* Filmstrip lane */}
        <div
          className="vtl__film"
          style={
            {
              height: `${filmH}px`,
              "--vtl-cells": frames?.frameCount ?? 24
            } as CSSProperties
          }
          aria-hidden="true"
        >
          {frames !== null ? (
            <img
              className="vtl__film-img"
              src={frames.url}
              alt=""
              draggable={false}
              decoding="async"
            />
          ) : (
            <div className="vtl__film-empty" />
          )}
        </div>

        {/* Waveform lane */}
        {!compact && (
          <div className="vtl__wave" style={{ height: `${waveH}px` }} aria-hidden="true">
            {audioBlob instanceof Blob ? (
              <SequenceWaveform audioBlob={audioBlob} height={waveH} className="vtl__wave-surfer" />
            ) : (
              <div className={`vtl__wave-empty${audioBlob === undefined ? " is-loading" : ""}`} />
            )}
          </div>
        )}

        {/* Dimming scrim outside the range */}
        <div className="vtl__scrim is-left" style={{ width: `${inX}px` }} aria-hidden="true" />
        <div
          className="vtl__scrim is-right"
          style={{ left: `${outX}px`, right: 0 }}
          aria-hidden="true"
        />

        {/* In / out handles */}
        <button
          type="button"
          className={`vtl__handle is-in${drag?.mode === "in" ? " is-active" : ""}`}
          style={{ left: `${inX}px` }}
          title="Trim in — drag, or press I at the playhead"
          aria-label={`Trim in ${formatTimecode(range.start)}`}
          onPointerDown={beginDrag("in")}
          data-testid="video-timeline-in"
        />
        <button
          type="button"
          className={`vtl__handle is-out${drag?.mode === "out" ? " is-active" : ""}`}
          style={{ left: `${outX - HANDLE_W}px` }}
          title="Trim out — drag, or press O at the playhead"
          aria-label={`Trim out ${formatTimecode(range.end)}`}
          onPointerDown={beginDrag("out")}
          data-testid="video-timeline-out"
        />

        {/* Playhead */}
        {!compact && (
          <div
            className="vtl__playhead"
            style={{ left: `${playX}px` }}
            aria-hidden="true"
            data-testid="video-timeline-playhead"
          />
        )}

        {/* Timecode tooltip while dragging */}
        {tooltipSec !== null && (
          <div className="vtl__tip" style={{ left: `${tooltipX}px` }} aria-hidden="true">
            {formatTimecode(tooltipSec)}
          </div>
        )}
      </div>

      <div className="vtl__foot">
        <span className="vtl__trim-label" data-testid="video-timeline-trim-label">
          {full ? `FULL CLIP · ${formatTimecode(durationSec)}` : trimLabel(range)}
        </span>
        <span className="vtl__foot-line" />
        <button
          type="button"
          className="vtl__chip"
          onClick={resetRange}
          disabled={full}
          title="Reset trim to the whole recording"
          data-testid="video-timeline-full-clip"
        >
          Full clip
        </button>
      </div>
    </div>
  );
}
