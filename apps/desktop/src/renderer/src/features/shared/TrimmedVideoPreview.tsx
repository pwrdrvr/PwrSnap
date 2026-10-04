import { useCallback, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import type { VideoRange } from "@pwrsnap/shared";
import type { HoverAutoplayVideoProps } from "./HoverAutoplayVideo";
import { useVideoPlaybackSrc } from "./useVideoPlaybackSrc";
import { DEFAULT_FRAME_STEP_SEC, formatTimecode, rangeDuration, roundTime } from "./video-range";

/** The source media never paints the preview directly. A seek can decode
 *  a frame before its requested timestamp, and JS boundary checks can run
 *  after an out-of-range frame has been submitted to the compositor. Copy
 *  only kept decoded frames to the visible canvas; discarded frames can
 *  then neither flash on load/seek nor appear when playback overshoots.
 *  A small canvas also bounds copying cost for Retina recordings. */
export function TrimmedVideoPreview({
  captureId, video, range, style, videoRef: externalRef
}: HoverAutoplayVideoProps & { range: VideoRange }): ReactElement {
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const paintedTime = useRef<number | null>(null);
  const atOutPoint = useRef(false);
  const lastSeek = useRef<number | null>(null);
  const resume = useRef<{ time: number; playing: boolean } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const duration = roundTime(rangeDuration(range));

  const clearPicture = useCallback((): void => {
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    paintedTime.current = null;
  }, []);
  const src = useVideoPlaybackSrc({
    captureId, video,
    onBeforeSwap: () => {
      const el = mediaRef.current;
      if (el !== null) resume.current = { time: el.currentTime, playing: !el.paused };
      clearPicture();
    }
  });
  const setMedia = useCallback((el: HTMLVideoElement | null): void => {
    mediaRef.current = el;
    if (externalRef !== undefined) externalRef.current = el;
  }, [externalRef]);

  const publish = useCallback((time: number): void => {
    const r = rangeRef.current;
    setElapsed(roundTime(atOutPoint.current && mediaRef.current?.paused === true
      ? rangeDuration(r)
      : Math.min(Math.max(time - r.start, 0), rangeDuration(r))));
  }, []);

  // The out-point is excluded. Park just inside it when scrubbing the
  // out-handle so the decoder can return the last kept frame, not a
  // frame beginning at the first discarded timestamp.
  const boundedTime = useCallback((time: number): number => {
    const r = rangeRef.current;
    const last = Math.max(r.start, r.end - Math.min(DEFAULT_FRAME_STEP_SEC, rangeDuration(r) / 2));
    return Math.max(r.start, Math.min(time, last));
  }, []);
  const seek = useCallback((time: number): void => {
    const el = mediaRef.current;
    if (el === null) return;
    atOutPoint.current = time >= rangeRef.current.end;
    const target = boundedTime(time);
    lastSeek.current = target;
    el.currentTime = target;
    publish(time);
  }, [boundedTime, publish]);
  const play = useCallback((): void => {
    const el = mediaRef.current;
    if (el === null) return;
    const r = rangeRef.current;
    if (el.currentTime < r.start || el.currentTime >= r.end || elapsed >= rangeDuration(r)) {
      seek(r.start);
    }
    void el.play().catch(() => setPlaying(false));
  }, [elapsed, seek]);

  // Before paint, retire any picture removed by a trim (including a
  // paused picture) and move the source head into the new selection.
  useLayoutEffect(() => {
    atOutPoint.current = false;
    const time = paintedTime.current;
    if (time !== null && (time < range.start || time >= range.end)) clearPicture();
    const el = mediaRef.current;
    if (el === null) return;
    if (el.currentTime < range.start || el.currentTime >= range.end) seek(el.currentTime);
    else publish(el.currentTime);
  }, [range.start, range.end, clearPicture, publish, seek]);

  useLayoutEffect(() => {
    clearPicture();
    setPlaying(false);
  }, [src, clearPicture]);

  useLayoutEffect(() => {
    const el = mediaRef.current;
    if (el === null) return;
    let raf = 0;
    let vfc = 0;
    let disposed = false;
    const checkTime = (): void => {
      const r = rangeRef.current;
      if (el.currentTime >= r.end) {
        atOutPoint.current = true;
        el.pause();
        publish(r.end);
      } else if (el.currentTime < r.start) {
        seek(r.start);
      } else {
        publish(el.currentTime);
      }
    };
    const tick = (): void => {
      if (disposed || el.paused) return;
      checkTime();
      if (!el.paused) raf = requestAnimationFrame(tick);
    };
    const onPlay = (): void => {
      setPlaying(true);
      cancelAnimationFrame(raf);
      checkTime();
      if (!el.paused) raf = requestAnimationFrame(tick);
    };
    const onPause = (): void => {
      setPlaying(false);
      cancelAnimationFrame(raf);
      publish(el.currentTime);
    };
    const onLoaded = (): void => {
      const saved = resume.current;
      resume.current = null;
      seek(saved?.time ?? rangeRef.current.start);
      if (saved?.playing === true) void el.play().catch(() => setPlaying(false));
    };
    const onSeeking = (): void => {
      const r = rangeRef.current;
      // Chromium quantizes currentTime to the media clock. An internal
      // out-point seek must survive that rounding without losing its
      // logical end-of-selection readout.
      if (lastSeek.current === null || Math.abs(el.currentTime - lastSeek.current) > 0.001) {
        atOutPoint.current = false;
      }
      if (el.currentTime < r.start || el.currentTime >= r.end) seek(el.currentTime);
      else publish(el.currentTime);
    };
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (disposed) return;
      const r = rangeRef.current;
      // mediaTime, not currentTime: the latter is a playback clock, not
      // proof that the decoded picture belongs to the kept interval.
      if (!el.seeking && metadata.mediaTime >= r.start && metadata.mediaTime < r.end) {
        const canvas = canvasRef.current;
        if (canvas !== null) {
          const width = Math.min(metadata.width, 800);
          const height = Math.max(1, Math.round(metadata.height * width / metadata.width));
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }
          canvas.getContext("2d")?.drawImage(el, 0, 0, width, height);
          paintedTime.current = metadata.mediaTime;
        }
      }
      if (!el.seeking) checkTime();
      vfc = el.requestVideoFrameCallback(onFrame);
    };
    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("seeking", onSeeking);
    el.addEventListener("timeupdate", checkTime);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("loadstart", clearPicture);
    // Electron's Chromium supports rVFC. If it is unavailable, leave
    // the picture blank rather than display an unverified source frame.
    if (typeof el.requestVideoFrameCallback === "function") vfc = el.requestVideoFrameCallback(onFrame);
    if (el.readyState >= 1) onLoaded();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (typeof el.cancelVideoFrameCallback === "function") el.cancelVideoFrameCallback(vfc);
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("seeking", onSeeking);
      el.removeEventListener("timeupdate", checkTime);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("loadstart", clearPicture);
    };
  }, [captureId, src, clearPicture, publish, seek]);

  return (
    <div className="video-preview" data-hover-autoplay onMouseEnter={play}
      onMouseLeave={() => mediaRef.current?.pause()} style={style}>
      <video ref={setMedia} src={src} muted={muted} playsInline preload="metadata"
        className="video-preview__source" aria-hidden="true" />
      <canvas ref={canvasRef} className="video-preview__picture" role="img" aria-label="Trimmed recording preview" />
      <div className="video-preview__controls">
        <div className="video-preview__row">
          <button type="button" onClick={() => playing ? mediaRef.current?.pause() : play()}>
            {playing ? "Pause" : "Play"}
          </button>
          <span data-testid="preview-timecode">{formatTimecode(elapsed)} / {formatTimecode(duration)}</span>
          <button type="button" onClick={() => setMuted((value) => !value)} aria-pressed={!muted}>
            {muted ? "Sound off" : "Sound on"}
          </button>
          <button type="button" onClick={(event) => {
            void event.currentTarget.closest(".video-preview")?.requestFullscreen().catch(() => undefined);
          }}>Full screen</button>
        </div>
        <input type="range" aria-label="Preview position" min={0} max={duration} step={0.001}
          value={Math.min(elapsed, duration)} onChange={(event) => {
            mediaRef.current?.pause();
            seek(range.start + Number(event.currentTarget.value));
          }} />
      </div>
    </div>
  );
}
