// The Sizzle timeline — composition root. One horizontal project time
// axis: ruler · scene regions · clips · waveform · word ribbon, a playhead
// that spans them, zoom (Fit · 1× · 2× · 4×, ⌘+ / ⌘−) with horizontal
// scroll past fit, pointer-capture scrubbing that drives the preview, and
// clip drags (move / retime) that commit ONCE on release.
//
// Built as a sibling of the Library's `VideoTimeline`: the math layer is
// the shared `video-range.ts` (px↔sec, ticks, timecodes) and both the
// scrub and the drags follow its pointer-capture contract — capture on
// the lanes, drag-local state while the pointer is down, one commit on
// release, `lostpointercapture` commits at the last observed position,
// Escape abandons. The model is pure and comes from `timeline-model.ts`;
// the drag math is pure and comes from `retime.ts`; nothing here decides
// exactness or writes timings.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from "react";
import type { CaptureRecord } from "@pwrsnap/shared";
import type { PlayheadSource } from "../../shared/playhead";
import { clampTime, formatTimecode, roundTime, tickMarks } from "../../shared/video-range";
import { isTypingTarget } from "../sizzle-helpers";
import { ClipLane, type BeginClipDrag, type ClipDragView } from "./ClipLane";
import { Playhead } from "./Playhead";
import { SceneRegions } from "./SceneRegions";
import { TimelineRuler } from "./TimelineRuler";
import { WaveformLane } from "./WaveformLane";
import { WordRibbon } from "./WordRibbon";
import { pxPerSecFor, TIMELINE_ZOOMS, zoomIn, zoomOut, type TimelineZoom } from "./density";
import {
  clampToBounds,
  clipStartDragBounds,
  finalEndDragBounds,
  previewClipStarts,
  type DragBounds,
  type DragKind,
  type TimelineDragCommit
} from "./retime";
import type { TimelineClip, TimelineModel, TimelineSceneRegion, TimelineWord } from "./timeline-model";
import "./timeline.css";

export type SizzleTimelineProps = {
  model: TimelineModel;
  captureMap: Map<string, CaptureRecord>;
  /** Decoded narration per scene id (wavesurfer draws it). */
  audioBlobs: Record<string, Blob>;
  /** The project-axis playhead. A SOURCE, not a number: the head moves at
   *  display refresh and this subtree holds every clip and word, so the
   *  position must not travel through React state. */
  head: PlayheadSource;
  /** Scrub: called continuously while the pointer is down on the lanes —
   *  and while a clip drags, with the edge being dragged (the preview parks
   *  on the frame the user is placing). */
  onScrub: (sec: number) => void;
  selectedClipId: string | null;
  onSelectClip: (clip: TimelineClip | null) => void;
  selectedSceneId?: string | null | undefined;
  onSelectScene?: ((sceneId: string) => void) | undefined;
  /** Click a word in the ribbon: anchor the selected clip (or the clip
   *  covering that moment) to it — or un-anchor if it already is. */
  onClickWord?: ((scene: TimelineSceneRegion, word: TimelineWord) => void) | undefined;
  /** The estimated region's "Synthesize narration" affordance. Explicit
   *  click only — it spends TTS credits. */
  onSynthesize?: ((sceneId: string) => void) | undefined;
  /** A finished clip drag (one per gesture). Absent = the lane is
   *  read-only: no grips, no body drag. */
  onDragCommit?: ((commit: TimelineDragCommit) => void) | undefined;
  /** Initial zoom (tests). Defaults to fit-to-width. */
  initialZoom?: TimelineZoom | undefined;
};

/** Space past the end of the reel at zoom, so the last clip is not flush
 *  against the scroll edge. */
const TAIL_PX = 40;
/** A body press becomes a drag past this; under it, it is a click. */
export const DRAG_THRESHOLD_PX = 4;

type ClipDragState = {
  pointerId: number;
  scene: TimelineSceneRegion;
  clip: TimelineClip;
  kind: DragKind;
  bounds: DragBounds;
  originX: number;
  /** Body drags keep the pointer's offset from the clip's start so the
   *  clip follows the hand; grips drag the edge itself. */
  grabOffsetSec: number;
  /** A press arms; it becomes a drag past DRAG_THRESHOLD_PX. A press that
   *  never does is a CLICK — it selects the clip and commits nothing (a
   *  zero-movement press on a grip must not pin an auto clip). */
  active: boolean;
  /** Last observed (clamped, scene-local) target. */
  sec: number;
};

export function SizzleTimeline(props: SizzleTimelineProps): ReactElement {
  const {
    model,
    captureMap,
    audioBlobs,
    head,
    onScrub,
    selectedClipId,
    onSelectClip,
    selectedSceneId = null,
    onSelectScene,
    onClickWord,
    onSynthesize,
    onDragCommit,
    initialZoom = "fit"
  } = props;

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lanesRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState<TimelineZoom>(initialZoom);
  const [scrubbing, setScrubbing] = useState(false);
  const scrubRef = useRef<number | null>(null);
  const clipDragRef = useRef<ClipDragState | null>(null);
  const [dragView, setDragView] = useState<ClipDragView | null>(null);
  // The click that follows a drag's pointerup (or an Escape-cancel) is not
  // a click: it must neither select nor clear the selection.
  const suppressClickRef = useRef(false);

  // Measure the SCROLL VIEWPORT (not the bordered canvas) so fit-to-width
  // fills it exactly — measuring the canvas made the lanes 2 px (the
  // border) wider than the viewport and put a horizontal scrollbar on a
  // reel that fits.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const post = (): void => setWidth(Math.floor(el.getBoundingClientRect().width));
    post();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(post);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalSec = model.totalSec;
  const fitPxPerSec = pxPerSecFor("fit", width, totalSec);
  const pxPerSec = pxPerSecFor(zoom, width, totalSec);
  const contentWidth = Math.max(width, Math.round(totalSec * pxPerSec));
  const lanesWidth = zoom === "fit" ? contentWidth : contentWidth + TAIL_PX;
  const x = useCallback((sec: number): number => sec * pxPerSec, [pxPerSec]);
  const ticks = useMemo(() => tickMarks(totalSec, contentWidth), [totalSec, contentWidth]);

  // Keep the playhead in view while scrubbing / playing at zoom.
  useEffect(() => {
    if (zoom === "fit") return;
    return head.subscribe((sec) => {
      const el = scrollRef.current;
      if (el === null) return;
      const at = sec * pxPerSec;
      const left = el.scrollLeft;
      const view = el.clientWidth;
      if (at < left + 24) el.scrollLeft = Math.max(0, at - view * 0.25);
      else if (at > left + view - 24) el.scrollLeft = Math.max(0, at - view * 0.75);
    });
  }, [head, pxPerSec, zoom]);

  // ⌘+ / ⌘− zoom, never stolen from a text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        setZoom((z) => zoomIn(z, fitPxPerSec));
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setZoom((z) => zoomOut(z, fitPxPerSec));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fitPxPerSec]);

  const secAt = useCallback(
    (clientX: number): number => {
      const el = lanesRef.current;
      if (el === null || pxPerSec <= 0) return 0;
      const rect = el.getBoundingClientRect();
      return clampTime((clientX - rect.left) / pxPerSec, totalSec);
    },
    [pxPerSec, totalSec]
  );

  // ── Clip drags (plan §4.4) ────────────────────────────────────────────
  // Drag-local state in a ref + one view-state for the re-flow preview;
  // nothing is written until `finishClipDrag(true)`.
  const moveClipDrag = (clientX: number): void => {
    const d = clipDragRef.current;
    if (d === null) return;
    if (!d.active) {
      if (Math.abs(clientX - d.originX) < DRAG_THRESHOLD_PX) return;
      d.active = true;
    }
    const sec = clampToBounds(secAt(clientX) - d.scene.startSec - d.grabOffsetSec, d.bounds);
    d.sec = sec;
    const starts =
      d.kind === "start"
        ? previewClipStarts(d.scene, d.clip.index, sec)
        : d.scene.clips.map((c) => c.localStartSec);
    const endSec = d.kind === "end" ? sec : (d.scene.clips.at(-1)?.localEndSec ?? d.scene.durationSec);
    setDragView({ sceneId: d.scene.sceneId, index: d.clip.index, kind: d.kind, starts, endSec, sec });
    // Park the preview on the edge being dragged — placing a cut you
    // cannot see the frame for is guesswork.
    onScrub(roundTime(d.scene.startSec + sec));
  };
  const finishClipDrag = (commit: boolean): void => {
    const d = clipDragRef.current;
    if (d === null) return;
    clipDragRef.current = null;
    setDragView(null);
    // Either way the browser's trailing `click` is not a click of ours: with
    // capture on the lanes it lands on the LANES (the capturing element),
    // where it would read as a bare-track press and clear the selection.
    suppressClickRef.current = true;
    if (d.active) {
      if (commit) {
        onDragCommit?.({
          sceneId: d.scene.sceneId,
          beatId: d.clip.beatId,
          index: d.clip.index,
          kind: d.kind,
          sec: d.sec,
          clipStartSec: d.clip.localStartSec,
          clipEndSec: d.clip.localEndSec
        });
      }
    } else if (commit) {
      // A press that never became a drag: a click on the clip (or its
      // grip) — select it, write nothing.
      onSelectClip(d.clip);
    }
    try {
      lanesRef.current?.releasePointerCapture(d.pointerId);
    } catch {
      /* jsdom */
    }
  };
  const beginClipDrag: BeginClipDrag = (clip, kind, event, grab): void => {
    if (event.button !== 0) return;
    event.stopPropagation(); // not a scrub
    if (onDragCommit === undefined) return;
    const scene = model.scenes.find((s) => s.sceneId === clip.sceneId);
    const el = lanesRef.current;
    if (scene === undefined || el === null) return;
    event.preventDefault(); // no text selection / image drag under the gesture
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      /* jsdom */
    }
    suppressClickRef.current = false;
    const bounds = kind === "start" ? clipStartDragBounds(scene, clip.index) : finalEndDragBounds(scene);
    const edgeSec = kind === "start" ? clip.localStartSec : clip.localEndSec;
    const pointerSec = secAt(event.clientX) - scene.startSec;
    clipDragRef.current = {
      pointerId: event.pointerId,
      scene,
      clip,
      kind,
      bounds,
      originX: event.clientX,
      grabOffsetSec: grab ? pointerSec - edgeSec : 0,
      active: false,
      sec: edgeSec
    };
  };
  // Escape abandons the drag — nothing was written, so nothing to restore
  // beyond dropping the preview. Through a ref so the listener is bound once.
  const cancelClipDragRef = useRef<() => void>(() => undefined);
  cancelClipDragRef.current = () => finishClipDrag(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || clipDragRef.current === null) return;
      event.preventDefault();
      cancelClipDragRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Unmount mid-drag: drop the hold without committing.
  useEffect(
    () => () => {
      clipDragRef.current = null;
    },
    []
  );

  // ── Scrub: pointer capture on the lanes, like VideoTimeline's scrub mode.
  // Clips, grips, and regions stop propagation on pointerdown so a press on
  // them selects / drags instead of scrubbing.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const el = lanesRef.current;
    if (el === null) return;
    suppressClickRef.current = false;
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      /* jsdom */
    }
    scrubRef.current = event.pointerId;
    setScrubbing(true);
    onScrub(roundTime(secAt(event.clientX)));
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (clipDragRef.current?.pointerId === event.pointerId) {
      moveClipDrag(event.clientX);
      return;
    }
    if (scrubRef.current !== event.pointerId) return;
    onScrub(roundTime(secAt(event.clientX)));
  };
  // The OS took the gesture (notification, ⌘-Tab, trackpad takeover).
  // A cancelled drag is ABANDONED, not committed at whatever coordinates
  // the cancel carried — those need not reflect where the pointer is.
  const cancelPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (clipDragRef.current?.pointerId === event.pointerId) {
      finishClipDrag(false);
      return;
    }
    if (scrubRef.current !== event.pointerId) return;
    scrubRef.current = null;
    setScrubbing(false);
  };
  const endPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (clipDragRef.current?.pointerId === event.pointerId) {
      moveClipDrag(event.clientX); // a flick with no move events still counts
      finishClipDrag(true);
      return;
    }
    if (scrubRef.current !== event.pointerId) return;
    scrubRef.current = null;
    setScrubbing(false);
    onScrub(roundTime(secAt(event.clientX)));
    try {
      lanesRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      /* jsdom */
    }
  };
  // Capture released without a pointerup (the OS took the gesture). A
  // drag commits at its LAST OBSERVED position — `lostpointercapture`
  // carries no usable coordinates (same reasoning as VideoTimeline).
  const onLostPointerCapture = (): void => {
    if (clipDragRef.current !== null) {
      finishClipDrag(true);
      return;
    }
    scrubRef.current = null;
    setScrubbing(false);
  };

  const clipCount = model.scenes.reduce((n, s) => n + s.clips.length, 0);
  const warnings = model.scenes.flatMap((s) =>
    s.clips.filter((c) => c.unresolved || (c.tooShort && c.exact))
  );
  const dragScene = dragView === null ? null : model.scenes.find((s) => s.sceneId === dragView.sceneId) ?? null;
  const dragTipSec = dragView !== null && dragScene !== null ? dragScene.startSec + dragView.sec : null;

  return (
    <section className="szt" aria-label="Reel timeline" data-testid="sizzle-timeline">
      <div className="szt__bar">
        <span className="szt__eyebrow">Timeline</span>
        <span className="szt__meta" data-testid="sizzle-timeline-meta">
          {model.scenes.length} scene{model.scenes.length === 1 ? "" : "s"} · {clipCount} clip
          {clipCount === 1 ? "" : "s"} · {model.exact ? null : <span className="szt__tilde">~</span>}
          {formatTimecode(totalSec)}
          {pxPerSec > 0 ? ` · ${Math.round(pxPerSec)} px/s` : ""}
        </span>
        <span className="szt__spacer" />
        <span className="szt__kbd" aria-hidden="true">
          <i>⌘−</i>
          <i>⌘+</i>
        </span>
        <div className="szt__zoom" role="group" aria-label="Timeline zoom">
          {TIMELINE_ZOOMS.map((z) => (
            <button
              key={String(z)}
              type="button"
              className={z === zoom ? "is-on" : ""}
              aria-pressed={z === zoom}
              onClick={() => setZoom(z)}
              data-testid={`sizzle-timeline-zoom-${String(z)}`}
            >
              {z === "fit" ? "Fit" : `${z}×`}
            </button>
          ))}
        </div>
      </div>
      <div className="szt__canvas" ref={canvasRef}>
        <div className="szt__scroll" ref={scrollRef}>
          <div
            ref={lanesRef}
            className={
              "szt__lanes" +
              (scrubbing ? " is-scrubbing" : "") +
              (dragView !== null ? " is-dragging-clip" : "")
            }
            style={{ width: `${lanesWidth}px` }}
            role="slider"
            aria-label="Reel playhead"
            aria-valuemin={0}
            aria-valuemax={totalSec}
            aria-valuenow={head.get()}
            aria-valuetext={formatTimecode(head.get())}
            tabIndex={-1}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={cancelPointer}
            onLostPointerCapture={onLostPointerCapture}
            onClick={(event) => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              // A press on bare track (not a clip / region) clears the
              // selection — direct manipulation, not a form.
              if (event.target === event.currentTarget) onSelectClip(null);
            }}
            data-testid="sizzle-timeline-lanes"
          >
            {model.scenes
              .filter((s) => !s.exact)
              .map((s) => (
                <div
                  key={`est-${s.sceneId}`}
                  className="szt__est"
                  style={{ left: `${x(s.startSec)}px`, width: `${Math.max(0, x(s.endSec) - x(s.startSec))}px` }}
                  data-testid={`sizzle-timeline-estimated-${s.index}`}
                />
              ))}
            <TimelineRuler ticks={ticks} x={x} />
            <SceneRegions
              model={model}
              x={x}
              selectedSceneId={selectedSceneId}
              onSelectScene={onSelectScene}
            />
            <ClipLane
              model={model}
              x={x}
              captureMap={captureMap}
              selectedClipId={selectedClipId}
              onSelectClip={(clip) => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                onSelectClip(clip);
              }}
              drag={dragView}
              onBeginDrag={onDragCommit !== undefined ? beginClipDrag : undefined}
            />
            <WaveformLane model={model} x={x} audioBlobs={audioBlobs} />
            <WordRibbon
              model={model}
              x={x}
              pxPerSec={pxPerSec}
              widthPx={lanesWidth}
              onClickWord={(scene, word) => onClickWord?.(scene, word)}
              onSynthesize={(sceneId) => onSynthesize?.(sceneId)}
            />
            <Playhead head={head} pxPerSec={pxPerSec} widthPx={lanesWidth} />
            {dragTipSec !== null ? (
              <span
                className="szt__drag-tip"
                style={{ left: `${x(dragTipSec)}px` }}
                aria-hidden="true"
                data-testid="sizzle-timeline-drag-tip"
              >
                {formatTimecode(dragTipSec)}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {warnings.length > 0 ? (
        // Scrolls WITH the axis: these chips are positioned in content-space
        // pixels, so painting them in a static strip put them off-screen at
        // zoom and left them pointing at the wrong time after any scroll.
        <div className="szt__warns-scroll">
          <div
            className="szt__warns"
            style={{ width: `${lanesWidth}px` }}
            aria-label="Timeline warnings"
          >
          {warnings.map((c) => (
            <span
              key={c.beatId}
              className="szt__warn"
              style={{ left: `${x(c.startSec)}px` }}
              data-testid={`sizzle-timeline-warn-${c.beatId}`}
            >
              {c.unresolved
                ? `unresolved anchor ${c.timing.kind === "phrase" ? JSON.stringify(c.timing.phrase) : ""} · auto`
                : "too fast to read"}
            </span>
          ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
