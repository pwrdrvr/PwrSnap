import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  cameraTimeAt,
  DEFAULT_AVATAR_STYLE,
  type AvatarStyle,
  type CaptureRecord,
} from "@pwrsnap/shared";
import { PersonSegmenter } from "./segmentation";
import "./camera.css";

export function AvatarOverlay({
  capture,
  videoRef,
  avatar,
  time = 0,
  fit = "contain",
}: {
  capture: CaptureRecord;
  videoRef?: RefObject<HTMLVideoElement | null> | undefined;
  avatar?: AvatarStyle | null | undefined;
  time?: number;
  fit?: "contain" | "canvas";
}) {
  const output = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");
  const [viewport, setViewport] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const style = avatar ?? capture.video?.avatar ?? DEFAULT_AVATAR_STYLE;
  const camera = capture.video?.camera;
  const latest = useRef({ style, time });
  latest.current = { style, time };
  useLayoutEffect(() => {
    const parent = output.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const resize = () => {
      const width = parent.clientWidth,
        height = parent.clientHeight;
      const sourceWidth = capture.width_px || width,
        sourceHeight = capture.height_px || height;
      const scale = Math.min(width / sourceWidth, height / sourceHeight);
      const w = fit === "canvas" ? width : sourceWidth * scale,
        h = fit === "canvas" ? height : sourceHeight * scale;
      setViewport({
        x: (width - w) / 2,
        y: (height - h) / 2,
        width: w,
        height: h,
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    resize();
    return () => observer.disconnect();
  }, [capture.width_px, capture.height_px, camera, style.visible, fit]);
  useEffect(() => {
    if (!camera || !style.visible) return;
    let retired = false,
      busy = false,
      frame = 0,
      lastTime = -1;
    let lastStyle: AvatarStyle | null = null;
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.src = `pwrsnap-capture://c/${capture.id}`;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const canvas = document.createElement("canvas"),
      maskCanvas = document.createElement("canvas");
    let engine: PersonSegmenter | null = null;
    let maskFailed = false;
    setError("");
    async function paint() {
      const target = output.current;
      if (retired || !target || busy || video.readyState < 2) return;
      const source = videoRef?.current;
      const desired = cameraTimeAt(
        (source?.currentTime ?? latest.current.time) -
          (latest.current.style.syncOffsetSec ?? 0),
        camera!,
      );
      if (desired === null) {
        lastTime = -1;
        target.getContext("2d")?.clearRect(0, 0, target.width, target.height);
        video.pause();
        return;
      }
      if (Math.abs(video.currentTime - desired) > 0.08)
        video.currentTime = desired;
      video.playbackRate = Math.max(0.0625, source?.playbackRate ?? 1);
      if (source && !source.paused && !source.ended)
        void video.play().catch(() => undefined);
      else video.pause();
      if (
        video.seeking ||
        (Math.abs(lastTime - video.currentTime) < 0.001 &&
          lastStyle === latest.current.style)
      )
        return;
      busy = true;
      try {
        const width = Math.min(640, camera!.width),
          height = Math.round((width * camera!.height) / camera!.width);
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d")!;
        context.drawImage(video, 0, 0, width, height);
        lastTime = video.currentTime;
        const current = latest.current.style;
        lastStyle = current;
        if (current.background === "remove" && !maskFailed) {
          let mask: ImageData | null = null;
          try {
            engine ??= new PersonSegmenter();
            mask = await engine.mask(canvas);
          } catch {
            if (retired) return;
            maskFailed = true;
            engine?.close();
          }
          if (retired) return;
          if (mask) {
            for (let i = 0; i < mask.data.length; i += 4)
              mask.data[i + 3] = mask.data[i]!;
            maskCanvas.width = mask.width;
            maskCanvas.height = mask.height;
            maskCanvas.getContext("2d")!.putImageData(mask, 0, 0);
            context.globalCompositeOperation = "destination-in";
            context.drawImage(maskCanvas, 0, 0, width, height);
            context.globalCompositeOperation = "source-over";
          }
        }
        const crop = current.crop;
        target.width = Math.max(1, Math.round(width * crop.width));
        target.height = Math.max(1, Math.round(height * crop.height));
        setError(maskFailed && current.background === "remove"
          ? "Background removal unavailable. Showing the original camera."
          : "");
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
            target.height,
          );
      } catch (cause) {
        if (!retired) {
          target.getContext("2d")?.clearRect(0, 0, target.width, target.height);
          setError(
            cause instanceof Error
              ? cause.message
              : "Background removal unavailable",
          );
        }
      } finally {
        busy = false;
      }
    }
    video.onerror = () => {
      if (!retired) setError("Camera track could not be opened.");
    };
    video.load();
    let tick = 0;
    const loop = (now: number) => {
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
  if (!camera || !style.visible) return null;
  return (
    <>
      <canvas
        className="avatar-overlay"
        ref={output}
        aria-label="Presenter camera"
        style={{
          left: viewport.x + style.x * viewport.width,
          top: viewport.y + style.y * viewport.height,
          width: style.width * viewport.width,
          transform: style.mirror ? "scaleX(-1)" : undefined,
        }}
      />
      {error && (
        <span className="avatar-error" role="status">
          Presenter: {error}
        </span>
      )}
    </>
  );
}
