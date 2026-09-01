import type { Rect } from "./region-math";

export type FrozenFrame = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  transferMode: "2d";
};

export type EncodedFrozenCrop = {
  blob: Blob;
  width: number;
  height: number;
  mimeType: "image/png";
};

export type PhysicalCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function stopDisplayStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

const FROZEN_FRAME_ACQUISITION_TIMEOUT_MS = 10_000;
export const FROZEN_DISPLAY_MEDIA_CONSTRAINTS = {
  video: { cursor: "never" } as MediaTrackConstraints,
  audio: false
} satisfies DisplayMediaStreamOptions;

async function acquireDisplayStream(
  getDisplayMedia: () => Promise<MediaStream>,
  signal: AbortSignal
): Promise<MediaStream> {
  const stream = await getDisplayMedia();
  if (signal.aborted) {
    stopDisplayStream(stream);
    throw abortReason(signal);
  }
  return stream;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("display media acquisition aborted");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

export function physicalCropRect(
  rect: Rect,
  viewport: { width: number; height: number },
  frame: { width: number; height: number }
): PhysicalCropRect {
  if (viewport.width <= 0 || viewport.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    throw new RangeError("frozen frame and viewport dimensions must be positive");
  }
  const sx = frame.width / viewport.width;
  const sy = frame.height / viewport.height;
  const logicalLeft = Math.max(0, rect.x);
  const logicalTop = Math.max(0, rect.y);
  const logicalRight = Math.min(viewport.width, rect.x + rect.w);
  const logicalBottom = Math.min(viewport.height, rect.y + rect.h);
  if (logicalRight <= logicalLeft || logicalBottom <= logicalTop) {
    throw new RangeError("selection does not intersect the frozen frame");
  }
  // Map both clipped endpoints. Mapping origin + the untrimmed size would
  // accidentally add an off-display overhang back into the committed crop.
  const x = Math.max(0, Math.min(Math.round(logicalLeft * sx), frame.width - 1));
  const y = Math.max(0, Math.min(Math.round(logicalTop * sy), frame.height - 1));
  const right = Math.max(x + 1, Math.min(Math.round(logicalRight * sx), frame.width));
  const bottom = Math.max(y + 1, Math.min(Math.round(logicalBottom * sy), frame.height));
  const width = right - x;
  const height = bottom - y;
  return { x, y, width, height };
}

function waitForVideoFrame(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let frameScheduled = false;
    let videoFrameCallbackId: number | null = null;
    let animationFrameId: number | null = null;
    const cleanup = (): void => {
      video.onloadeddata = null;
      video.onerror = null;
      signal.removeEventListener("abort", onAbort);
      if (
        videoFrameCallbackId !== null &&
        typeof video.cancelVideoFrameCallback === "function"
      ) {
        video.cancelVideoFrameCallback(videoFrameCallbackId);
      }
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      videoFrameCallbackId = null;
      animationFrameId = null;
    };
    const finish = (cause?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (cause === undefined) resolve();
      else reject(cause);
    };
    const onAbort = (): void => finish(abortReason(signal));
    const afterLoaded = (): void => {
      if (settled || frameScheduled) return;
      frameScheduled = true;
      if (typeof video.requestVideoFrameCallback === "function") {
        videoFrameCallbackId = video.requestVideoFrameCallback(() => {
          videoFrameCallbackId = null;
          finish();
        });
      } else {
        animationFrameId = requestAnimationFrame(() => {
          animationFrameId = null;
          finish();
        });
      }
    };
    video.onloadeddata = afterLoaded;
    video.onerror = () => finish(new Error("display media video failed to decode"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) afterLoaded();
  });
}

/**
 * Freeze one display-media frame into renderer-owned storage. The track is
 * stopped in every exit path before the promise settles. The deadline spans
 * source acquisition, playback, first-frame delivery, and ImageBitmap creation.
 * The stable backing store is deliberately a 2D canvas: Chromium can present a
 * bitmaprenderer canvas while failing or stalling when that GPU-backed canvas
 * is later used as the source of the committed crop. This renderer-local draw
 * is the one unavoidable full-frame copy; no full-frame pixels are encoded,
 * written to disk, or transferred to main.
 */
export async function acquireFrozenDisplayFrame(
  canvas: HTMLCanvasElement,
  getDisplayMedia: () => Promise<MediaStream> = () =>
    navigator.mediaDevices.getDisplayMedia(FROZEN_DISPLAY_MEDIA_CONSTRAINTS),
  timeoutMs = FROZEN_FRAME_ACQUISITION_TIMEOUT_MS
): Promise<FrozenFrame> {
  const controller = new AbortController();
  let stream: MediaStream | null = null;
  let streamStopped = false;
  const videoState: { current: HTMLVideoElement | null } = { current: null };
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const stopActiveStream = (): void => {
    if (stream === null || streamStopped) return;
    streamStopped = true;
    stopDisplayStream(stream);
  };
  const produceFrame = async (): Promise<FrozenFrame> => {
    stream = await acquireDisplayStream(getDisplayMedia, controller.signal);
    throwIfAborted(controller.signal);
    const video = document.createElement("video");
    videoState.current = video;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    const play = video.play();
    await Promise.all([play, waitForVideoFrame(video, controller.signal)]);
    throwIfAborted(controller.signal);
    const bitmap = await createImageBitmap(video);
    if (controller.signal.aborted) {
      bitmap.close();
      throw abortReason(controller.signal);
    }
    if (bitmap.width <= 0 || bitmap.height <= 0) {
      bitmap.close();
      throw new Error("display media returned an empty frame");
    }
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) {
      bitmap.close();
      throw new Error("selector canvas context is unavailable");
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return {
      canvas,
      width: canvas.width,
      height: canvas.height,
      transferMode: "2d"
    };
  };
  try {
    return await Promise.race([
      produceFrame(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const cause = new Error("display media acquisition timed out");
          stopActiveStream();
          controller.abort(cause);
          reject(cause);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    stopActiveStream();
    if (!controller.signal.aborted) {
      controller.abort(new Error("display media acquisition ended"));
    }
    const activeVideo = videoState.current;
    if (activeVideo !== null) {
      activeVideo.pause();
      activeVideo.srcObject = null;
    }
  }
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error("committed crop PNG encode failed"));
      else resolve(blob);
    }, "image/png");
  });
}

/** Encode only the selected physical crop; the full frozen canvas is never encoded. */
export async function encodeFrozenCrop(
  frozen: FrozenFrame,
  rect: Rect,
  viewport: { width: number; height: number }
): Promise<EncodedFrozenCrop> {
  const crop = physicalCropRect(rect, viewport, frozen);
  const output = document.createElement("canvas");
  output.width = crop.width;
  output.height = crop.height;
  const context = output.getContext("2d", { alpha: true });
  if (context === null) throw new Error("committed crop canvas context is unavailable");
  context.drawImage(
    frozen.canvas,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height
  );
  const blob = await canvasPng(output);
  output.width = 0;
  output.height = 0;
  return {
    blob,
    width: crop.width,
    height: crop.height,
    mimeType: "image/png"
  };
}

export function disposeFrozenFrame(frozen: FrozenFrame | null): void {
  if (frozen === null) return;
  frozen.canvas.width = 0;
  frozen.canvas.height = 0;
}
