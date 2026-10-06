// The presenter on a stage — the recording's camera track drawn over the
// screen, as an OBJECT: click it to select it, drag it to move it (it snaps
// to the edges and centre lines), drag a corner to resize it, and a
// toolbar rides above it while it is selected.
//
// The layer covers the stage frame. It works out where the video's picture
// actually sits inside that frame (`viewport` — letterboxed for `contain`,
// the whole frame for a reel's `canvas`) and places the presenter in those
// coordinates, so the preview lands where the export will put it.
//
// Drawing: a hidden <video> of the camera file is seeked to the camera
// time for the screen's playhead (`cameraTimeAt`, after the sync offset)
// and copied to a canvas ~15 times a second. A cut-out runs each frame
// through the person segmenter first. The canvas holds the CROPPED frame
// at its own pixel aspect; CSS sizes the box and draws the outline.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type RefObject
} from "react";
import {
  cameraTimeAt,
  clampPresenter,
  presenterAspect,
  presenterCornerRadius,
  presenterHeight,
  presenterLook,
  snapDrag,
  PRESENTER_MAX_WIDTH,
  PRESENTER_MIN_WIDTH,
  type AvatarStyle,
  type CaptureRecord,
  type PresenterGeometry,
  type PresenterSnapGuides
} from "@pwrsnap/shared";
import { PersonSegmenter } from "./segmentation";
import { PresenterToolbar, type PresenterAction } from "./PresenterToolbar";
import "./presenter.css";

export type PresenterPhase = "loading" | "preparing" | "ready" | "maskFailed" | "missing";

export type PresenterEditing = {
  readonly selected: boolean;
  readonly onSelect: (selected: boolean) => void;
  /** A finished gesture or a toolbar action — persist it. */
  readonly onChange: (style: AvatarStyle) => void;
  readonly onAction: (action: PresenterAction) => void;
  readonly posterUrl?: string | undefined;
  readonly inheritable?: boolean;
};

type Viewport = { x: number; y: number; width: number; height: number };
type Corner = "nw" | "ne" | "sw" | "se";
type Gesture =
  | { kind: "move"; pointerId: number; startX: number; startY: number; start: AvatarStyle; moved: boolean }
  | { kind: "resize"; pointerId: number; corner: Corner; start: AvatarStyle };

const DRAG_SLOP_PX = 3;

export function PresenterLayer({
  capture,
  style,
  videoRef,
  time = 0,
  fit = "contain",
  editing,
  onPhase
}: {
  readonly capture: CaptureRecord;
  /** Resolved — never null. Hidden presenters are not drawn at all. */
  readonly style: AvatarStyle;
  readonly videoRef?: RefObject<HTMLVideoElement | null> | undefined;
  /** Screen time when there is no live element to follow (a still). */
  readonly time?: number;
  readonly fit?: "contain" | "canvas";
  readonly editing?: PresenterEditing | undefined;
  readonly onPhase?: ((phase: PresenterPhase) => void) | undefined;
}): ReactElement | null {
  const camera = capture.video?.camera ?? null;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const output = useRef<HTMLCanvasElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, width: 0, height: 0 });
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [phase, setPhase] = useState<PresenterPhase>("loading");
  const [draft, setDraft] = useState<AvatarStyle | null>(null);
  const [guides, setGuides] = useState<PresenterSnapGuides>({ x: null, y: null });
  const [hover, setHover] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const shown = draft ?? style;
  const latest = useRef({ style: shown, time });
  latest.current = { style: shown, time };
  const onPhaseRef = useRef(onPhase);
  onPhaseRef.current = onPhase;

  useEffect(() => {
    onPhaseRef.current?.(phase);
  }, [phase]);

  // Where the picture sits inside the frame. Layout box (clientWidth), not
  // a post-transform rect: the Library stage mounts inside an entrance
  // animation (see AGENTS.md "Never mix a post-transform rect…").
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const resize = (): void => {
      const width = root.clientWidth;
      const height = root.clientHeight;
      setFrameSize({ width, height });
      if (fit === "canvas") {
        setViewport({ x: 0, y: 0, width, height });
        return;
      }
      const sourceWidth = capture.width_px || width;
      const sourceHeight = capture.height_px || height;
      const scale = Math.min(width / sourceWidth, height / sourceHeight);
      const w = sourceWidth * scale;
      const h = sourceHeight * scale;
      setViewport({ x: (width - w) / 2, y: (height - h) / 2, width: w, height: h });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    resize();
    return () => observer.disconnect();
  }, [capture.width_px, capture.height_px, fit]);

  // The paint loop.
  useEffect(() => {
    if (!camera || !style.visible) return;
    let retired = false;
    let busy = false;
    let frame = 0;
    let lastTime = -1;
    let lastStyle: AvatarStyle | null = null;
    let engine: PersonSegmenter | null = null;
    let maskFailed = false;
    let masked = false;
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.src = `pwrsnap-capture://c/${capture.id}`;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const canvas = document.createElement("canvas");
    const maskCanvas = document.createElement("canvas");
    setPhase("loading");

    async function paint(): Promise<void> {
      const target = output.current;
      if (retired || !target || busy || video.readyState < 2 || !camera) return;
      const source = videoRef?.current;
      const current = latest.current.style;
      const desired = cameraTimeAt(
        (source?.currentTime ?? latest.current.time) - (current.syncOffsetSec ?? 0),
        camera
      );
      if (desired === null) {
        lastTime = -1;
        target.getContext("2d")?.clearRect(0, 0, target.width, target.height);
        video.pause();
        return;
      }
      if (Math.abs(video.currentTime - desired) > 0.08) video.currentTime = desired;
      video.playbackRate = Math.max(0.0625, source?.playbackRate ?? 1);
      if (source && !source.paused && !source.ended) void video.play().catch(() => undefined);
      else video.pause();
      if (video.seeking || (Math.abs(lastTime - video.currentTime) < 0.001 && lastStyle === current)) return;
      busy = true;
      try {
        const width = Math.min(640, camera.width);
        const height = Math.round((width * camera.height) / camera.width);
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d")!;
        context.drawImage(video, 0, 0, width, height);
        lastTime = video.currentTime;
        lastStyle = current;
        const wantsCut = current.background === "remove";
        if (wantsCut && !maskFailed) {
          if (!masked) setPhase("preparing");
          let mask: ImageData | null = null;
          try {
            engine ??= new PersonSegmenter();
            mask = await engine.mask(canvas);
          } catch {
            if (retired) return;
            maskFailed = true;
            engine?.close();
            setPhase("maskFailed");
          }
          if (retired) return;
          if (mask) {
            for (let i = 0; i < mask.data.length; i += 4) mask.data[i + 3] = mask.data[i]!;
            maskCanvas.width = mask.width;
            maskCanvas.height = mask.height;
            maskCanvas.getContext("2d")!.putImageData(mask, 0, 0);
            context.globalCompositeOperation = "destination-in";
            context.drawImage(maskCanvas, 0, 0, width, height);
            context.globalCompositeOperation = "source-over";
            masked = true;
          }
        }
        const crop = current.crop;
        target.width = Math.max(1, Math.round(width * crop.width));
        target.height = Math.max(1, Math.round(height * crop.height));
        target
          .getContext("2d")!
          .drawImage(
            canvas,
            crop.x * width,
            crop.y * height,
            crop.width * width,
            crop.height * height,
            0,
            0,
            target.width,
            target.height
          );
        if (!wantsCut || masked) setPhase("ready");
      } catch {
        if (!retired) target.getContext("2d")?.clearRect(0, 0, target.width, target.height);
      } finally {
        busy = false;
      }
    }

    video.onerror = () => {
      if (!retired) setPhase("missing");
    };
    video.load();
    let tick = 0;
    const loop = (now: number): void => {
      if (retired) return;
      if (now - tick >= 66) {
        tick = now;
        void paint();
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      retired = true;
      cancelAnimationFrame(frame);
      video.pause();
      video.removeAttribute("src");
      video.load();
      engine?.close();
    };
  }, [capture.id, camera, style.visible, videoRef]);

  const geometry: PresenterGeometry | null =
    camera && viewport.width > 0 && viewport.height > 0
      ? { cameraAspect: camera.width / camera.height, canvasAspect: viewport.width / viewport.height }
      : null;

  const toolbarShown = editing?.selected === true && style.visible && draft === null;
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!toolbarShown || !bar || typeof ResizeObserver === "undefined") return;
    const measure = (): void => setBarWidth(bar.offsetWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    measure();
    return () => observer.disconnect();
  }, [toolbarShown]);

  const endGesture = useCallback((): void => {
    gesture.current = null;
    setGuides({ x: null, y: null });
  }, []);

  if (!camera) return null;

  const box =
    geometry === null
      ? null
      : {
          left: viewport.x + shown.x * viewport.width,
          top: viewport.y + shown.y * viewport.height,
          width: shown.width * viewport.width,
          height: presenterHeight(shown, geometry) * viewport.height
        };

  const editable = editing !== undefined && geometry !== null;
  const selected = editable && editing.selected && shown.visible;
  const look = presenterLook(shown);
  // A cut-out is drawn raw while the mask is unavailable; say so in the
  // outline too — a square edge is what the user is actually looking at.
  const drawnLook = look === "cut" && phase === "maskFailed" ? "square" : look;
  const radius =
    box === null
      ? 0
      : drawnLook === "circle"
        ? Math.min(box.width, box.height) / 2
        : drawnLook === "rounded"
          ? presenterCornerRadius("rounded") * Math.min(box.width, box.height)
          : 0;

  const onBoxPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!editable || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    editing.onSelect(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = {
      kind: "move",
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      start: shown,
      moved: false
    };
  };

  const onHandlePointerDown = (corner: Corner) => (e: ReactPointerEvent<HTMLElement>): void => {
    if (!editable || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    rootRef.current?.querySelector<HTMLElement>(".pres-obj")?.setPointerCapture(e.pointerId);
    gesture.current = { kind: "resize", pointerId: e.pointerId, corner, start: shown };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId || geometry === null) return;
    if (g.kind === "move") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (!g.moved && Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
      g.moved = true;
      const raw = { ...g.start, x: g.start.x + dx / viewport.width, y: g.start.y + dy / viewport.height };
      // ⌘ places freely, the way the editor's own drags do.
      const next = e.metaKey ? { style: clampPresenter(raw, geometry), guides: { x: null, y: null } } : snapDrag(raw, geometry);
      setDraft(next.style);
      setGuides(next.guides);
      return;
    }
    const root = rootRef.current?.getBoundingClientRect();
    if (!root) return;
    // Resize about the opposite corner, keeping the crop's aspect.
    const s = g.start;
    const h0 = presenterHeight(s, geometry);
    const fixedX = g.corner === "nw" || g.corner === "sw" ? s.x + s.width : s.x;
    const fixedY = g.corner === "nw" || g.corner === "ne" ? s.y + h0 : s.y;
    const px = (e.clientX - root.left - viewport.x) / viewport.width;
    const py = (e.clientY - root.top - viewport.y) / viewport.height;
    const aspect = presenterAspect(s.crop, geometry.cameraAspect);
    const fromX = Math.abs(px - fixedX);
    const fromY = (Math.abs(py - fixedY) * aspect) / geometry.canvasAspect;
    const width = Math.min(PRESENTER_MAX_WIDTH, Math.max(PRESENTER_MIN_WIDTH, Math.max(fromX, fromY)));
    const height = presenterHeight({ ...s, width }, geometry);
    const x = g.corner === "nw" || g.corner === "sw" ? fixedX - width : fixedX;
    const y = g.corner === "nw" || g.corner === "ne" ? fixedY - height : fixedY;
    setDraft(clampPresenter({ ...s, width, x, y }, geometry));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const committed = draft;
    endGesture();
    setDraft(null);
    if (editable && committed !== null && (g.kind === "resize" || g.moved)) editing.onChange(committed);
  };

  const toolbarAbove = box !== null && box.top > 52;
  const barLeft =
    box === null
      ? 0
      : Math.max(6, Math.min(box.left + box.width - barWidth, frameSize.width - barWidth - 6));

  return (
    <div
      ref={rootRef}
      className="pres-layer"
      data-presenter-bounds=""
      data-testid="presenter-layer"
      data-phase={phase}
    >
      {shown.visible && box !== null ? (
        <>
          {guides.x !== null ? (
            <i
              className="pres-guide pres-guide--v"
              style={{ left: viewport.x + guides.x * viewport.width, top: viewport.y, height: viewport.height }}
              aria-hidden="true"
            />
          ) : null}
          {guides.y !== null ? (
            <i
              className="pres-guide pres-guide--h"
              style={{ top: viewport.y + guides.y * viewport.height, left: viewport.x, width: viewport.width }}
              aria-hidden="true"
            />
          ) : null}
          <div
            className={
              "pres-obj" +
              (editable ? " is-editable" : "") +
              (selected ? " is-selected" : "") +
              (hover && !selected ? " is-hover" : "") +
              (draft !== null ? " is-dragging" : "")
            }
            data-look={drawnLook}
            data-presenter-ui=""
            data-testid="presenter-object"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            onPointerDown={onBoxPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              endGesture();
              setDraft(null);
            }}
            onPointerEnter={() => setHover(true)}
            onPointerLeave={() => setHover(false)}
            {...(editable ? { "aria-label": "Presenter", role: "group" } : {})}
          >
            <div className="pres-obj__clip" style={{ borderRadius: radius } as CSSProperties}>
              <canvas
                ref={output}
                className="pres-obj__canvas"
                aria-label="Presenter camera"
                style={shown.mirror ? { transform: "scaleX(-1)" } : undefined}
              />
            </div>
            {phase === "preparing" ? (
              <span className="pres-obj__busy" role="status">
                <i />
                Preparing cut-out
              </span>
            ) : null}
            {selected ? (
              <div className="pres-sel" aria-hidden="true">
                <span className="pres-sel__tag">Presenter</span>
                {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                  <i key={corner} className={`pres-sel__h is-${corner}`} onPointerDown={onHandlePointerDown(corner)} />
                ))}
              </div>
            ) : null}
          </div>
          {selected && draft === null && geometry !== null ? (
            <div
              ref={barRef}
              className="pres-bar-anchor"
              style={
                toolbarAbove
                  ? { left: barLeft, bottom: frameSize.height - box.top + 30 }
                  : { left: barLeft, top: box.top + box.height + 10 }
              }
            >
              <PresenterToolbar
                style={shown}
                geometry={geometry}
                posterUrl={editing.posterUrl}
                inheritable={editing.inheritable === true}
                menuSide={toolbarAbove ? "down" : "up"}
                onAction={editing.onAction}
              />
            </div>
          ) : null}
        </>
      ) : null}
      {phase === "maskFailed" && look === "cut" && shown.visible ? (
        <div className="pres-toast" role="status" data-testid="presenter-mask-failed">
          <PresenterToastIcon />
          <span>
            <b>Background removal isn’t available.</b> Showing the camera as recorded.
          </span>
        </div>
      ) : null}
      {phase === "missing" && shown.visible ? (
        <div className="pres-toast pres-toast--bad" role="status" data-testid="presenter-missing">
          <PresenterToastIcon />
          <span>
            <b>Camera file missing.</b> The presenter can’t be shown or exported.
          </span>
        </div>
      ) : null}
    </div>
  );
}

function PresenterToastIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.2l6.2 11H1.8z" />
      <path d="M8 6.6v3M8 11.6v.1" />
    </svg>
  );
}
