// The Sizzle timeline — composition root. One horizontal project time
// axis: ruler · scene regions · clips · waveform, a playhead that spans
// them, zoom (Fit · 1× · 2× · 4×, ⌘+ / ⌘−) with horizontal scroll past
// fit, and pointer-capture scrubbing that drives the preview.
//
// Built as a sibling of the Library's `VideoTimeline`: the math layer is
// the shared `video-range.ts` (px↔sec, ticks, timecodes) and the scrub is
// the same pointer-capture contract. The model is pure and comes from
// `timeline-model.ts`; nothing here decides exactness.

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
import { clampTime, formatTimecode, roundTime, tickMarks } from "../../shared/video-range";
import { isTypingTarget } from "../sizzle-helpers";
import { ClipLane } from "./ClipLane";
import { Playhead } from "./Playhead";
import { SceneRegions } from "./SceneRegions";
import { TimelineRuler } from "./TimelineRuler";
import { WaveformLane } from "./WaveformLane";
import { WordRibbon } from "./WordRibbon";
import { pxPerSecFor, TIMELINE_ZOOMS, zoomIn, zoomOut, type TimelineZoom } from "./density";
import type { TimelineClip, TimelineModel, TimelineSceneRegion, TimelineWord } from "./timeline-model";
import "./timeline.css";

export type SizzleTimelineProps = {
  model: TimelineModel;
  captureMap: Map<string, CaptureRecord>;
  /** Decoded narration per scene id (wavesurfer draws it). */
  audioBlobs: Record<string, Blob>;
  /** Playhead position on the project axis. */
  playheadSec: number;
  /** Scrub: called continuously while the pointer is down on the lanes. */
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
  /** Initial zoom (tests). Defaults to fit-to-width. */
  initialZoom?: TimelineZoom | undefined;
};

/** Space past the end of the reel at zoom, so the last clip is not flush
 *  against the scroll edge. */
const TAIL_PX = 40;

export function SizzleTimeline(props: SizzleTimelineProps): ReactElement {
  const {
    model,
    captureMap,
    audioBlobs,
    playheadSec,
    onScrub,
    selectedClipId,
    onSelectClip,
    selectedSceneId = null,
    onSelectScene,
    onClickWord,
    onSynthesize,
    initialZoom = "fit"
  } = props;

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lanesRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState<TimelineZoom>(initialZoom);
  const [scrubbing, setScrubbing] = useState(false);
  const dragRef = useRef<number | null>(null);

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
    const el = scrollRef.current;
    if (el === null || zoom === "fit") return;
    const head = x(playheadSec);
    const left = el.scrollLeft;
    const view = el.clientWidth;
    if (head < left + 24) el.scrollLeft = Math.max(0, head - view * 0.25);
    else if (head > left + view - 24) el.scrollLeft = Math.max(0, head - view * 0.75);
  }, [playheadSec, x, zoom]);

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

  // Scrub: pointer capture on the lanes, like VideoTimeline's scrub mode.
  // Clips and regions stop propagation on pointerdown so a click on them
  // selects instead of scrubbing.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const el = lanesRef.current;
    if (el === null) return;
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      /* jsdom */
    }
    dragRef.current = event.pointerId;
    setScrubbing(true);
    onScrub(roundTime(secAt(event.clientX)));
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current !== event.pointerId) return;
    onScrub(roundTime(secAt(event.clientX)));
  };
  const endScrub = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current !== event.pointerId) return;
    dragRef.current = null;
    setScrubbing(false);
    onScrub(roundTime(secAt(event.clientX)));
    try {
      lanesRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      /* jsdom */
    }
  };
  const onLostPointerCapture = (): void => {
    dragRef.current = null;
    setScrubbing(false);
  };

  const clipCount = model.scenes.reduce((n, s) => n + s.clips.length, 0);
  const warnings = model.scenes.flatMap((s) =>
    s.clips.filter((c) => c.unresolved || (c.tooShort && c.exact))
  );

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
            className={"szt__lanes" + (scrubbing ? " is-scrubbing" : "")}
            style={{ width: `${lanesWidth}px` }}
            role="slider"
            aria-label="Reel playhead"
            aria-valuemin={0}
            aria-valuemax={totalSec}
            aria-valuenow={playheadSec}
            aria-valuetext={formatTimecode(playheadSec)}
            tabIndex={-1}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endScrub}
            onPointerCancel={endScrub}
            onLostPointerCapture={onLostPointerCapture}
            onClick={(event) => {
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
              onSelectClip={onSelectClip}
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
            <Playhead leftPx={x(playheadSec)} sec={playheadSec} widthPx={lanesWidth} />
          </div>
        </div>
      </div>
      {warnings.length > 0 ? (
        <div className="szt__warns" aria-label="Timeline warnings">
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
      ) : null}
    </section>
  );
}
