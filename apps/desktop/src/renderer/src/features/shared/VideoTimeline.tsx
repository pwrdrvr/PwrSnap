// Timeline strip for video captures — filmstrip lane + activity lane +
// waveform lane on one time axis, with a drag-scrub playhead, in/out
// trim handles, a dimming scrim outside the range, tick marks, and the
// `TRIM 0:03.4 – 0:11.2 · 7.8 s` eyebrow with a `Full clip` reset chip.
//
// With `onSegmentsChange` the strip also edits CUTS (the kept-segment
// model in `@pwrsnap/shared` video-segments.ts). Everything stays in
// source time — the strip never ripples — so a cut is a hatched span in
// place, and the filmstrip / waveform / activity lanes keep lining up
// with the recording:
//   • a split is a thin marker: drag it to move, double-click to remove;
//   • each side of an interior cut has its own edge handle, and dragging
//     one onto the other closes the cut back into a split;
//   • hovering a part offers `Cut` (or `Keep` over a cut) — the same
//     thing X does at the playhead;
//   • `Cut idle` removes every stretch where nothing on screen changed
//     for IDLE_MIN_SEC or more, read off the activity lane, and
//     previews what it will remove while hovered.
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
import {
  activityLevelOfMagnitude,
  cutVideoSegments,
  isFullClipEdit,
  joinVideoSegmentsAt,
  subtractVideoSpans,
  toggleVideoPiece,
  videoExportSpans,
  videoKeptDurationSec,
  videoPieces,
  videoSegmentsEqual,
  videoStillCuts,
  videoStillSpans,
  type VideoActivityLevel,
  type VideoActivityTrack,
  type VideoFramesResult,
  type VideoPiece,
  type VideoRange
} from "@pwrsnap/shared";
import type { PlayheadSource } from "./playhead";
import { SequenceWaveform } from "./SequenceWaveform";
import {
  clampRange,
  formatSpan,
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
  /** Playhead position. Ignored (not rendered) in `compact` mode.
   *  During playback this prop only carries DISCRETE positions (seek,
   *  pause) — the live head arrives on `playhead`. */
  currentTime?: number | undefined;
  /** Live playhead channel. When present the playhead line and the
   *  slider's aria value are written straight to the DOM from a
   *  subscription instead of re-rendering this subtree every frame;
   *  `currentTime` is then only the initial / fallback position. See
   *  `playhead.ts`. Absent in `compact` mode (no playhead to draw). */
  playhead?: PlayheadSource | undefined;
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
  /** Kept spans (see `useVideoTrimRange`). Omitted → one span, `range`.
   *  Interior cuts are drawn whether or not the strip may edit them. */
  segments?: readonly VideoRange[] | undefined;
  /** Present → the strip edits splits and cuts (see the header).
   *  `commit` as for `onRangeChange`. */
  onSegmentsChange?: ((segments: readonly VideoRange[], commit: boolean) => void) | undefined;
  /** On-screen activity for the activity lane and `Cut idle`.
   *  `undefined` = no lane; `null` = still analysing (empty lane). */
  activity?: VideoActivityTrack | null | undefined;
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

type DragMode =
  | { kind: "scrub" }
  | { kind: "in" }
  | { kind: "out" }
  /** The split between `segments[index - 1]` and `segments[index]`. */
  | { kind: "split"; index: number }
  /** One side of an interior cut: `segments[index]`'s start or end. */
  | { kind: "edge"; index: number; side: "start" | "end" };

const HANDLE_W = 8;
const EDGE_W = 6;
const ACTIVITY_H = 10;

/** `Cut idle` removes still stretches at least this long… */
export const IDLE_MIN_SEC = 3;
/** …keeping this much of the still screen either side of each jump, so
 *  the edit does not snap from one change straight into the next. */
export const IDLE_PAD_SEC = 0.5;

/** A boundary dragged within this many px of its neighbour lands ON it —
 *  which is how an interior cut closes back into a split. */
const SNAP_PX = 5;

/** A part narrower than this gets no hover chip; X at the playhead
 *  still works on it. */
const CHIP_MIN_PX = 28;

type ActivityPaths = { levels: Record<1 | 2 | 3, string>; idle: string };

/** One rect per run of equal-level pixel columns, max-pooled so a
 *  one-sample burst survives any strip width. Level 0 draws nothing;
 *  still stretches long enough for `Cut idle` get a hatch instead.
 *
 *  Columns map through `durationSec`, the strip's own axis — NOT the
 *  track's length. The track ends at the last decoded frame, which
 *  lands a little before the wall-clock duration the strip spans, so
 *  stretching it to the full width would put every bar a few px late. */
function activityPaths(
  track: VideoActivityTrack,
  durationSec: number,
  widthPx: number,
  heightPx: number
): ActivityPaths {
  const levels: Record<1 | 2 | 3, string> = { 1: "", 2: "", 3: "" };
  const n = track.magnitudes.length;
  const cols = Math.max(0, Math.floor(widthPx));
  if (n === 0 || cols === 0 || !(durationSec > 0) || !(track.sampleHz > 0)) {
    return { levels, idle: "" };
  }
  const samplesPerCol = (durationSec * track.sampleHz) / cols;
  const bar: Record<1 | 2 | 3, number> = { 1: 3, 2: 6, 3: heightPx };
  let runStart = 0;
  let runLevel: VideoActivityLevel = 0;
  const flush = (end: number): void => {
    if (runLevel === 0 || end <= runStart) return;
    const h = bar[runLevel];
    levels[runLevel] += `M${runStart} ${heightPx - h}h${end - runStart}v${h}h${runStart - end}z`;
  };
  for (let x = 0; x < cols; x += 1) {
    const from = Math.floor(x * samplesPerCol);
    const to = Math.max(from + 1, Math.floor((x + 1) * samplesPerCol));
    let level: VideoActivityLevel = 0;
    for (let i = from; i < Math.min(to, n); i += 1) {
      const l = activityLevelOfMagnitude(track.magnitudes[i]!);
      if (l > level) level = l;
    }
    if (level !== runLevel) {
      flush(x);
      runStart = x;
      runLevel = level;
    }
  }
  flush(cols);
  let idle = "";
  for (const span of videoStillSpans(track, { minStillSec: IDLE_MIN_SEC })) {
    const x0 = (span.start / durationSec) * cols;
    const x1 = (Math.min(span.end, durationSec) / durationSec) * cols;
    idle += `M${x0.toFixed(1)} 0h${(x1 - x0).toFixed(1)}v${heightPx}h${(x0 - x1).toFixed(1)}z`;
  }
  return { levels, idle };
}

function samePiece(a: VideoPiece | null, b: VideoPiece | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.start === b.start && a.end === b.end;
}

export function VideoTimeline(props: VideoTimelineProps): ReactElement {
  const {
    durationSec,
    currentTime = 0,
    range,
    frames,
    audioBlob,
    onSeek,
    onRangeChange,
    onSegmentsChange,
    onWidthChange,
    playhead,
    activity,
    compact = false
  } = props;
  const segs = useMemo<readonly VideoRange[]>(
    () => props.segments ?? [range],
    [props.segments, range]
  );
  const editable = onSegmentsChange !== undefined && !compact;

  const stripRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // The strip's left border width. The drag tooltip lives in a wrapper
  // BESIDE the strip — it has to escape `.vtl__strip`'s `overflow:
  // hidden` — and that wrapper's padding box is the strip's BORDER box,
  // one border wider on each side than the padding box every other
  // `left` here is measured in. Read from the DOM rather than written
  // as `1`, so the stylesheet stays free to change the border.
  const [stripBorderLeft, setStripBorderLeft] = useState(0);
  // The tooltip's own width, so it can be held inside the strip instead
  // of hanging off the end. Measured because CSS cannot reference an
  // element's own width in a `calc()`, so `translateX(-50%)` has
  // nothing to clamp against.
  const [tipWidth, setTipWidth] = useState(0);
  const [drag, setDrag] = useState<{ mode: DragMode; sec: number } | null>(null);
  const dragRef = useRef<{ mode: DragMode; pointerId: number; moved: boolean } | null>(null);
  // Where the drag started, so Escape can put things back. Captured at
  // pointerdown because by the time the user wants out, `range` has
  // already been walked to wherever they dragged it. `segments` is also
  // the base every split / edge drag frame is computed from.
  const dragStartRef = useRef<{
    range: VideoRange;
    segments: readonly VideoRange[];
    time: number;
  } | null>(null);
  // The part under the pointer, for the Cut / Keep chip.
  const [hoverPiece, setHoverPiece] = useState<VideoPiece | null>(null);
  // While `Cut idle` is hovered: what it would remove.
  const [idlePreview, setIdlePreview] = useState(false);

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
  //
  // A LAYOUT measure, deliberately — see AGENTS.md "Never mix a
  // post-transform rect with a layout measure". In the Library the
  // timeline mounts inside `.psl__focus`, whose 180ms `psl-focus-in`
  // entrance animates `scale(0.985)` -> `scale(1)`, and
  // `getBoundingClientRect()` is POST-TRANSFORM: a rect read inside
  // that window comes back ~1.5% short (measured: 985 on a 1000px
  // strip). A ResizeObserver reports LAYOUT boxes, so the finishing
  // transform notifies nothing and the short value sticks for the life
  // of the view — the out handle, the ticks and the playhead all park
  // ~14px inside the right edge, and the right scrim dims that band
  // even at FULL CLIP. It never self-heals, and it always disappears
  // the moment you resize the window to look at it.
  //
  // `clientWidth` specifically, on BOTH paths. The handles, scrims and
  // tooltip are absolutely positioned, and an absolutely-positioned
  // child resolves `left` against its containing block's PADDING box —
  // which is what `clientWidth` reports. Measured in Chromium on a
  // `border: 1px; padding: 0 10px` box: a child at `left: 0` lands on
  // the padding edge, `clientWidth` is 498 and
  // `contentBoxSize[0].inlineSize` is 478. They agree here only because
  // `.vtl__strip` has no padding, so reading the observer entry would
  // make the mount measure and the resize measure disagree the moment
  // one is added — right on open, wrong after the first resize. There
  // is nothing to gain by it either: `Math.round` below discards the
  // sub-pixel precision that is the entry's only advantage.
  //
  // The border-box width (what the rect reports) put `outX` 2px past
  // the inner right edge, where the strip's `overflow: hidden` clipped
  // the last 2px of the out handle along with its rounded corner.
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (el === null) return;
    const post = (): void => {
      const w = Math.round(el.clientWidth);
      // `clientLeft` IS the left border width — no magic number, and it
      // follows the stylesheet on its own.
      setStripBorderLeft(el.clientLeft);
      setWidth(w);
      onWidthChange?.(w);
    };
    post();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(post);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onWidthChange]);

  const pieces = useMemo(() => videoPieces(segs, durationSec), [durationSec, segs]);
  const pieceAt = (t: number): VideoPiece | null => {
    for (const piece of pieces) if (t >= piece.start && t < piece.end) return piece;
    return pieces[pieces.length - 1] ?? null;
  };

  const secAt = useCallback(
    (clientX: number): number => {
      const el = stripRef.current;
      if (el === null) return 0;
      const rect = el.getBoundingClientRect();
      return pxToSec(clientX - rect.left, durationSec, rect.width);
    },
    [durationSec]
  );

  /** The boundary a split / edge drag moves, clamped so no span drops
   *  below the minimum and snapped onto its neighbour within SNAP_PX. */
  const segmentDrag = useCallback(
    (
      mode: Extract<DragMode, { kind: "split" | "edge" }>,
      base: readonly VideoRange[],
      sec: number
    ): { segments: VideoRange[]; at: number } | null => {
      const next = base.map((s) => ({ start: s.start, end: s.end }));
      const snap = width > 0 ? (SNAP_PX / width) * durationSec : 0;
      const t = roundTime(sec);
      if (mode.kind === "split") {
        const prev = next[mode.index - 1];
        const cur = next[mode.index];
        if (prev === undefined || cur === undefined) return null;
        const at = Math.min(Math.max(t, prev.start + MIN_RANGE_SEC), cur.end - MIN_RANGE_SEC);
        prev.end = at;
        cur.start = at;
        return { segments: next, at };
      }
      const cur = next[mode.index];
      if (cur === undefined) return null;
      if (mode.side === "end") {
        const after = next[mode.index + 1];
        if (after === undefined) return null;
        let at = Math.min(Math.max(t, cur.start + MIN_RANGE_SEC), after.start);
        if (after.start - at <= snap) at = after.start;
        cur.end = at;
        return { segments: next, at };
      }
      const before = next[mode.index - 1];
      if (before === undefined) return null;
      let at = Math.max(Math.min(t, cur.end - MIN_RANGE_SEC), before.end);
      if (at - before.end <= snap) at = before.end;
      cur.start = at;
      return { segments: next, at };
    },
    [durationSec, width]
  );

  const applyDrag = useCallback(
    (mode: DragMode, sec: number, commit: boolean): void => {
      if (mode.kind === "scrub") {
        onSeek?.(roundTime(sec));
        return;
      }
      if (mode.kind === "split" || mode.kind === "edge") {
        const base = dragStartRef.current?.segments;
        if (base === undefined || onSegmentsChange === undefined) return;
        const moved = segmentDrag(mode, base, sec);
        if (moved === null) return;
        onSegmentsChange(moved.segments, commit);
        onSeek?.(moved.at);
        return;
      }
      const next =
        mode.kind === "in"
          ? clampRange({ start: Math.min(sec, range.end - MIN_RANGE_SEC), end: range.end }, durationSec)
          : clampRange({ start: range.start, end: Math.max(sec, range.start + MIN_RANGE_SEC) }, durationSec);
      onRangeChange(next, commit);
      // Park the preview on the edge being dragged. Choosing a trim
      // point you can't see the frame for is guesswork — the whole
      // reason to drag a handle is to watch where it lands.
      //
      // Seeks to the CLAMPED edge, not the raw pointer position, so the
      // preview keeps matching the handle once it stops against the
      // opposite handle's MIN_RANGE_SEC gap or a clip boundary.
      onSeek?.(mode.kind === "in" ? next.start : next.end);
    },
    [durationSec, onRangeChange, onSeek, onSegmentsChange, range.end, range.start, segmentDrag]
  );

  const beginDrag = (mode: DragMode) => (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return;
    // Body-scrub needs somewhere to seek. Without `onSeek` there's no
    // preview surface to drive, so a press on the strip body would move
    // nothing — leave those presses inert and keep the handles the only
    // interactive part.
    if (mode.kind === "scrub" && onSeek === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const strip = stripRef.current;
    if (strip === null) return;
    try {
      strip.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom */
    }
    dragRef.current = { mode, pointerId: e.pointerId, moved: false };
    // The LIVE head, not the `currentTime` prop: during playback the
    // prop only carries discrete positions, so an Escape-cancel keyed
    // off it would restore the head to wherever playback last seeked.
    dragStartRef.current = { range, segments: segs, time: playhead?.get() ?? currentTime };
    setInteracting(true);
    setHoverPiece(null);
    const sec = secAt(e.clientX);
    setDrag({ mode, sec });
    // A split or an inner edge moves only once the pointer does. A
    // press is also half of the double-click that removes a split, and
    // the few px between the pointer and the marker's centre must not
    // nudge the boundary on the way.
    if (mode.kind === "split" || mode.kind === "edge") return;
    applyDrag(mode, sec, false);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (d === null) {
      if (!editable || e.pointerType === "touch") return;
      const el = stripRef.current;
      if (el === null) return;
      const piece = pieceAt(secAt(e.clientX));
      setHoverPiece((prev) => (samePiece(prev, piece) ? prev : piece));
      return;
    }
    if (d.pointerId !== e.pointerId) return;
    d.moved = true;
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
    // A press on a split or an edge that never moved changes nothing,
    // so it commits nothing (and leaves no drag state to settle).
    if (d.moved || (d.mode.kind !== "split" && d.mode.kind !== "edge")) {
      applyDrag(d.mode, sec, true);
    }
    dragStartRef.current = null;
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
    if (sec !== undefined && (d.moved || (d.mode.kind !== "split" && d.mode.kind !== "edge"))) {
      applyDrag(d.mode, sec, true);
    }
    dragStartRef.current = null;
    setInteracting(false);
  };

  // Escape abandons the drag — the "I messed up, put it back" reflex.
  // Restores with `commit: true` so the caller settles: an uncommitted
  // range never persists AND leaves `useVideoTrimRange` stuck in its
  // dragging state, blocking upstream adoption.
  //
  // What the preview lands on differs by mode, deliberately. A scrub
  // goes back to `start.time`, the playhead's pre-drag position. A
  // handle drag parks on the RESTORED EDGE instead — that edge is the
  // thing the user just put back, so it's the frame worth confirming,
  // and the float-over has no playhead of its own (`currentTime`
  // defaults to 0 there), so honoring `start.time` would jump its
  // preview to frame 0 on every cancel.
  const cancelDrag = (): void => {
    const d = dragRef.current;
    if (d === null) return;
    const start = dragStartRef.current;
    dragRef.current = null;
    dragStartRef.current = null;
    setDrag(null);
    if (start !== null) {
      if (d.mode.kind === "scrub") {
        onSeek?.(start.time);
      } else if (d.mode.kind === "split" || d.mode.kind === "edge") {
        if (d.moved) {
          onSegmentsChange?.(start.segments, true);
          const restored =
            d.mode.kind === "split"
              ? start.segments[d.mode.index]?.start
              : d.mode.side === "start"
                ? start.segments[d.mode.index]?.start
                : start.segments[d.mode.index]?.end;
          if (restored !== undefined) onSeek?.(restored);
        }
      } else {
        onRangeChange(start.range, true);
        onSeek?.(d.mode.kind === "in" ? start.range.start : start.range.end);
      }
    }
    setInteracting(false);
    try {
      stripRef.current?.releasePointerCapture(d.pointerId);
    } catch {
      /* jsdom */
    }
  };
  const cancelDragRef = useRef(cancelDrag);
  cancelDragRef.current = cancelDrag;

  // Playhead placement runs OFF the render path — see `playhead.ts`.
  // `transform` rather than `left` so a moving head never dirties
  // layout, only the compositor.
  //
  // Quantized to device pixels, and skipped when the quantized position
  // is unchanged. This is not a throttle — it writes on every frame that
  // renders differently and never writes one that doesn't. It matters
  // because the rAF loop publishes at DISPLAY refresh while the head
  // moves at STRIP WIDTH / DURATION: a 178 s clip across a 1044 px strip
  // advances 5.9 px/sec, so on a 120 Hz display it crosses a device
  // pixel roughly every tenth frame. The other 110 writes per second
  // each produced a fresh compositor commit, draw, and swap for an
  // identical picture.
  //
  // Measured with the pixel-identical writes dropped (2026-08-20,
  // `PWRSNAP_TRACE=1`): compositor commits 118.7/sec -> 10.0/sec and
  // swaps 118.7/sec -> 61.7/sec, i.e. down to the video's own frame
  // rate, which is the floor. Complementary to the `will-change` layer
  // promotion in video-timeline.css: promotion removes the per-frame
  // RASTER, this removes the per-frame SWAP. Neither subsumes the
  // other.
  // What was last written, and to which node at which scale. Keyed on
  // the element so a remount (the playhead is absent in `compact`)
  // always writes, and on the scale so a drag to a display with a
  // different DPR re-places rather than trusting a stale device pixel.
  const placedRef = useRef<{ el: HTMLElement; devicePx: number; scale: number } | null>(null);
  const placePlayhead = useCallback(
    (sec: number): void => {
      const el = playheadRef.current;
      if (el === null) return;
      // `devicePixelRatio` is read per call on purpose — a window
      // dragged between a Retina and a non-Retina display changes it
      // without re-running this callback's deps.
      const scale = window.devicePixelRatio || 1;
      const devicePx = Math.round(secToPx(sec, durationSec, width) * scale);
      const placed = placedRef.current;
      if (
        placed !== null &&
        placed.el === el &&
        placed.scale === scale &&
        placed.devicePx === devicePx
      ) {
        return;
      }
      // Compared as a NUMBER, never by reading `el.style.transform`
      // back: Blink re-serializes what it stores, so at a fractional
      // DPR (Windows at 125% / 150%) `translateX(0.6666666666666666px)`
      // reads back as `translateX(0.666667px)`, no comparison ever
      // matches, and the skip silently stops skipping.
      placedRef.current = { el, devicePx, scale };
      el.style.transform = `translateX(${devicePx / scale}px)`;
    },
    [durationSec, width]
  );

  // The slider's aria value follows the head, but only at the tenth-
  // second precision `formatTimecode` renders — a screen reader has no
  // use for 60 announcements a second, and each write is a DOM mutation.
  const ariaTenthRef = useRef<number | null>(null);
  const publishAria = useCallback((sec: number): void => {
    const el = stripRef.current;
    if (el === null) return;
    const tenth = Math.floor(sec * 10);
    if (ariaTenthRef.current === tenth) return;
    ariaTenthRef.current = tenth;
    el.setAttribute("aria-valuenow", String(sec));
    el.setAttribute("aria-valuetext", formatTimecode(sec));
  }, []);

  useEffect(() => {
    if (playhead === undefined) return;
    return playhead.subscribe((sec) => {
      placePlayhead(sec);
      publishAria(sec);
    });
  }, [placePlayhead, playhead, publishAria]);

  // Re-place after EVERY commit (no dep array): a render triggered by
  // something else — a range change, a resize — re-renders the playhead
  // element from the stale `currentTime` prop, and this puts the live
  // position back before paint.
  useLayoutEffect(() => {
    placePlayhead(playhead?.get() ?? currentTime);
  });

  const inX = secToPx(range.start, durationSec, width);
  const outX = secToPx(range.end, durationSec, width);
  const exportSpans = useMemo(() => videoExportSpans(segs), [segs]);
  const hasCuts = exportSpans.length > 1;
  const full = isFullRange(range, durationSec);
  const pristine = segs.length === 1 && isFullClipEdit(segs, durationSec);
  const splitCount = segs.length - exportSpans.length;
  const keptSec = useMemo(() => videoKeptDurationSec(segs), [segs]);
  const ticks = useMemo(
    () => (compact ? [] : tickMarks(durationSec, width)),
    [compact, durationSec, width]
  );

  const filmH = compact ? 40 : 56;
  const waveH = compact ? 0 : 24;
  const showActivity = !compact && activity !== undefined;
  const actH = showActivity ? ACTIVITY_H : 0;
  const actPaths = useMemo(
    () =>
      activity === null || activity === undefined || compact
        ? null
        : activityPaths(activity, durationSec, width, ACTIVITY_H),
    [activity, compact, durationSec, width]
  );

  // `Cut idle`: the edit with every still stretch removed, and what that
  // takes out of the CURRENT edit (for the chip's number and preview).
  const idle = useMemo(() => {
    if (!editable || activity === null || activity === undefined) return null;
    const cuts = videoStillCuts(activity, {
      minStillSec: IDLE_MIN_SEC,
      paddingSec: IDLE_PAD_SEC,
      durationSec
    });
    if (cuts.length === 0) return null;
    const next = cutVideoSegments(segs, cuts, durationSec);
    const savedSec = keptSec - videoKeptDurationSec(next);
    if (videoSegmentsEqual(next, segs) || savedSec < MIN_RANGE_SEC) return null;
    return { next, savedSec, removed: subtractVideoSpans(segs, next, durationSec) };
  }, [activity, durationSec, editable, keptSec, segs]);
  useEffect(() => {
    if (idle === null) setIdlePreview(false);
  }, [idle]);

  const dragging = drag !== null;
  const tooltipSec = drag?.sec ?? null;
  const tooltipText = tooltipSec === null ? null : formatTimecode(tooltipSec);
  const tooltipX = tooltipSec === null ? 0 : secToPx(tooltipSec, durationSec, width);
  // Centred on the pointer, then pushed back inside the strip at either
  // end: the tip labels a position rather than points at one, so a
  // legible box that stops at the edge beats a perfectly centred one
  // with half its digits cut off. `stripBorderLeft` converts from the
  // strip's padding box (where `tooltipX` lives) into the wrapper's,
  // and the outer `max` keeps a strip narrower than the tip from
  // producing a lower bound above its upper one.
  const tipHalf = tipWidth / 2;
  const tooltipLeft =
    stripBorderLeft + Math.min(Math.max(tooltipX, tipHalf), Math.max(tipHalf, width - tipHalf));

  // A LAYOUT measure (AGENTS.md), keyed on the text rather than run on
  // every render: through a drag the timecode changes ten times a
  // second while pointermove fires at frame rate.
  useLayoutEffect(() => {
    const el = tipRef.current;
    setTipWidth(el === null ? 0 : el.offsetWidth);
  }, [tooltipText]);

  const resetRange = (): void => {
    // `setRange` keeps cuts (it only moves the outer handles), so a
    // reset of an editable strip replaces the spans outright.
    if (onSegmentsChange !== undefined) onSegmentsChange([fullRange(durationSec)], true);
    else onRangeChange(fullRange(durationSec), true);
  };

  const togglePiece = (piece: VideoPiece): void => {
    if (onSegmentsChange === undefined) return;
    onSegmentsChange(toggleVideoPiece(segs, durationSec, piece), true);
    setHoverPiece(null);
  };

  const footLabel = hasCuts
    ? `${exportSpans.length} PARTS · ${formatSpan(keptSec)} OF ${formatTimecode(durationSec)}`
    : `${full ? `FULL CLIP · ${formatTimecode(durationSec)}` : trimLabel(range)}${
        splitCount > 0 ? ` · ${splitCount} SPLIT${splitCount === 1 ? "" : "S"}` : ""
      }`;

  // The hover chip: Cut over a kept part (when another part would be
  // left), Keep over an interior cut. The trimmed head and tail belong
  // to the in / out handles and get no chip.
  const chip = (() => {
    if (!editable || drag !== null || hoverPiece === null) return null;
    const piece = hoverPiece;
    if (piece.kind === "kept" && segs.length < 2) return null;
    if (piece.kind === "cut" && piece.where !== "inner") return null;
    const x0 = secToPx(piece.start, durationSec, width);
    const x1 = secToPx(piece.end, durationSec, width);
    if (x1 - x0 < CHIP_MIN_PX) return null;
    return { piece, x: (x0 + x1) / 2 };
  })();

  useEffect(() => {
    if (!dragging) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Capture phase on `window` is the earliest point in the dispatch
      // path, so this beats every bubble-phase Escape handler in the app
      // — notably the Library's focus-mode "close the editor". Stopping
      // propagation here keeps the editor open: mid-drag, Escape means
      // "undo this drag", not "throw away the whole session".
      event.preventDefault();
      event.stopPropagation();
      cancelDragRef.current();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [dragging]);

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

      {/* The strip, and BESIDE it the drag tooltip. The tip cannot live
          inside the strip: `.vtl__strip` carries `overflow: hidden` to
          keep the filmstrip and the handles tucked inside its
          border-radius, and that clipped the tip's trailing digits off
          whenever a drag reached either end. */}
      <div className="vtl__strip-wrap">
        <div
          ref={stripRef}
          className="vtl__strip"
          style={{ height: `${filmH + actH + waveH}px` }}
          onPointerDown={beginDrag({ kind: "scrub" })}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverPiece(null)}
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

          {/* Activity lane — how much of the frame changed, per moment.
              Bars rise with the level; long still stretches (what
              `Cut idle` removes) are hatched. */}
          {showActivity && (
            <div
              className={`vtl__act${actPaths === null ? " is-loading" : ""}`}
              style={{ height: `${actH}px` }}
              aria-hidden="true"
              data-testid="video-timeline-activity"
            >
              {actPaths !== null && width > 0 && (
                <svg
                  className="vtl__act-svg"
                  width={width}
                  height={ACTIVITY_H}
                  viewBox={`0 0 ${width} ${ACTIVITY_H}`}
                  preserveAspectRatio="none"
                >
                  {actPaths.idle !== "" && <path className="vtl__act-idle" d={actPaths.idle} />}
                  {actPaths.levels[1] !== "" && <path className="vtl__act-l1" d={actPaths.levels[1]} />}
                  {actPaths.levels[2] !== "" && <path className="vtl__act-l2" d={actPaths.levels[2]} />}
                  {actPaths.levels[3] !== "" && <path className="vtl__act-l3" d={actPaths.levels[3]} />}
                </svg>
              )}
            </div>
          )}

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

          {/* Interior cuts — hatched in place; the timeline never ripples. */}
          {pieces.map((piece) =>
            piece.kind === "cut" && piece.where === "inner" ? (
              <div
                key={`cut-${piece.start}`}
                className="vtl__scrim is-cut"
                style={{
                  left: `${secToPx(piece.start, durationSec, width)}px`,
                  width: `${secToPx(piece.end, durationSec, width) - secToPx(piece.start, durationSec, width)}px`
                }}
                aria-hidden="true"
                data-testid="video-timeline-cut"
              />
            ) : null
          )}

          {/* What `Cut idle` would remove, while its chip is hovered. */}
          {idlePreview &&
            idle !== null &&
            idle.removed.map((span) => (
              <div
                key={`idle-${span.start}`}
                className="vtl__idle-preview"
                style={{
                  left: `${secToPx(span.start, durationSec, width)}px`,
                  width: `${secToPx(span.end, durationSec, width) - secToPx(span.start, durationSec, width)}px`
                }}
                aria-hidden="true"
                data-testid="video-timeline-idle-preview"
              />
            ))}

          {/* Splits (touching spans) and the two edges of every interior
              cut. Editable strips only. */}
          {editable &&
            segs.map((seg, i) => {
              if (i === 0) return null;
              const prev = segs[i - 1]!;
              if (prev.end === seg.start) {
                const x = secToPx(seg.start, durationSec, width);
                return (
                  <button
                    key={`split-${i}`}
                    type="button"
                    className={`vtl__split${
                      drag?.mode.kind === "split" && drag.mode.index === i ? " is-active" : ""
                    }`}
                    style={{ left: `${x}px` }}
                    title="Split — drag to move, double-click to remove"
                    aria-label={`Split at ${formatTimecode(seg.start)}`}
                    onPointerDown={beginDrag({ kind: "split", index: i })}
                    onDoubleClick={() =>
                      onSegmentsChange?.(joinVideoSegmentsAt(segs, seg.start), true)
                    }
                    data-testid="video-timeline-split"
                  />
                );
              }
              const outEdgeX = secToPx(prev.end, durationSec, width);
              const inEdgeX = secToPx(seg.start, durationSec, width);
              const active = (side: "start" | "end", index: number): string =>
                drag?.mode.kind === "edge" && drag.mode.index === index && drag.mode.side === side
                  ? " is-active"
                  : "";
              return [
                <button
                  key={`edge-end-${i - 1}`}
                  type="button"
                  className={`vtl__handle is-out is-edge${active("end", i - 1)}`}
                  style={{ left: `${outEdgeX - EDGE_W}px` }}
                  title="Cut starts here — drag to adjust"
                  aria-label={`Cut from ${formatTimecode(prev.end)}`}
                  onPointerDown={beginDrag({ kind: "edge", index: i - 1, side: "end" })}
                  data-testid="video-timeline-cut-in"
                />,
                <button
                  key={`edge-start-${i}`}
                  type="button"
                  className={`vtl__handle is-in is-edge${active("start", i)}`}
                  style={{ left: `${inEdgeX}px` }}
                  title="Cut ends here — drag to adjust"
                  aria-label={`Cut to ${formatTimecode(seg.start)}`}
                  onPointerDown={beginDrag({ kind: "edge", index: i, side: "start" })}
                  data-testid="video-timeline-cut-out"
                />
              ];
            })}

          {/* In / out handles */}
          <button
            type="button"
            className={`vtl__handle is-in${drag?.mode.kind === "in" ? " is-active" : ""}`}
            style={{ left: `${inX}px` }}
            title="Trim in — drag, or press I at the playhead"
            aria-label={`Trim in ${formatTimecode(range.start)}`}
            onPointerDown={beginDrag({ kind: "in" })}
            data-testid="video-timeline-in"
          />
          <button
            type="button"
            className={`vtl__handle is-out${drag?.mode.kind === "out" ? " is-active" : ""}`}
            style={{ left: `${outX - HANDLE_W}px` }}
            title="Trim out — drag, or press O at the playhead"
            aria-label={`Trim out ${formatTimecode(range.end)}`}
            onPointerDown={beginDrag({ kind: "out" })}
            data-testid="video-timeline-out"
          />

          {/* Cut / Keep for the part under the pointer. */}
          {chip !== null && (
            <button
              type="button"
              className={`vtl__piece-chip${chip.piece.kind === "cut" ? " is-restore" : ""}`}
              style={{ left: `${Math.min(Math.max(chip.x, 24), Math.max(24, width - 24))}px` }}
              title={
                chip.piece.kind === "cut"
                  ? "Keep this part again (X at the playhead)"
                  : "Cut this part (X at the playhead)"
              }
              onPointerDown={(e) => {
                // Not a scrub, and focus stays where the keyboard model is.
                e.stopPropagation();
                e.preventDefault();
              }}
              onClick={() => togglePiece(chip.piece)}
              data-testid="video-timeline-piece-chip"
            >
              {chip.piece.kind === "cut" ? "Keep" : "Cut"}
            </button>
          )}

          {/* Playhead */}
          {!compact && (
            <div
              ref={playheadRef}
              className="vtl__playhead"
              aria-hidden="true"
              data-testid="video-timeline-playhead"
            />
          )}
        </div>

        {/* Timecode tooltip while dragging */}
        {tooltipText !== null && (
          <div
            ref={tipRef}
            className="vtl__tip"
            style={{ left: `${tooltipLeft}px` }}
            aria-hidden="true"
            data-testid="video-timeline-tip"
          >
            {tooltipText}
          </div>
        )}
      </div>

      <div className="vtl__foot">
        <span className="vtl__trim-label" data-testid="video-timeline-trim-label">
          {footLabel}
        </span>
        <span className="vtl__foot-line" />
        {editable && segs.length === 1 && (
          <span className="vtl__hint" data-testid="video-timeline-hint">
            S split · X cut
          </span>
        )}
        {idle !== null && (
          <button
            type="button"
            className="vtl__chip is-accent"
            onClick={() => {
              onSegmentsChange?.(idle.next, true);
              setIdlePreview(false);
            }}
            onPointerEnter={() => setIdlePreview(true)}
            onPointerLeave={() => setIdlePreview(false)}
            onFocus={() => setIdlePreview(true)}
            onBlur={() => setIdlePreview(false)}
            title={`Cut every stretch where nothing on screen changed for ${IDLE_MIN_SEC} s or more, keeping ${IDLE_PAD_SEC} s either side`}
            data-testid="video-timeline-cut-idle"
          >
            Cut idle −{formatSpan(idle.savedSec, 0)}
          </button>
        )}
        <button
          type="button"
          className="vtl__chip"
          onClick={resetRange}
          disabled={pristine}
          title={
            editable
              ? "Reset to the whole recording — removes the trim, splits and cuts"
              : "Reset trim to the whole recording"
          }
          data-testid="video-timeline-full-clip"
        >
          Full clip
        </button>
      </div>
    </div>
  );
}
