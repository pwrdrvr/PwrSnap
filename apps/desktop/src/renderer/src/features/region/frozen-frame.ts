import type { Rect } from "./region-math";

export type FrozenFrame = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  transferMode: "bitmaprenderer" | "2d";
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

const DISPLAY_MEDIA_ACQUISITION_TIMEOUT_MS = 10_000;
export const FROZEN_DISPLAY_MEDIA_CONSTRAINTS = {
  video: { cursor: "never" } as MediaTrackConstraints,
  audio: false
} satisfies DisplayMediaStreamOptions;

async function acquireDisplayStream(
  getDisplayMedia: () => Promise<MediaStream>,
  timeoutMs: number
): Promise<MediaStream> {
  let timedOut = false;
  const pending = getDisplayMedia().then((stream) => {
    if (timedOut) stopDisplayStream(stream);
    return stream;
  });
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      pending,
      new Promise<MediaStream>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(new Error("display media acquisition timed out"));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
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

function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (cause?: unknown): void => {
      if (settled) return;
      settled = true;
      video.onloadeddata = null;
      video.onerror = null;
      if (cause === undefined) resolve();
      else reject(cause);
    };
    const afterLoaded = (): void => {
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(() => finish());
      } else {
        requestAnimationFrame(() => finish());
      }
    };
    video.onloadeddata = afterLoaded;
    video.onerror = () => finish(new Error("display media video failed to decode"));
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) afterLoaded();
  });
}

/**
 * Freeze one display-media frame into renderer-owned storage. The track is
 * stopped in every exit path before the promise settles. bitmaprenderer keeps
 * the ImageBitmap as the canvas backing store without a second full-frame draw.
 */
export async function acquireFrozenDisplayFrame(
  canvas: HTMLCanvasElement,
  getDisplayMedia: () => Promise<MediaStream> = () =>
    navigator.mediaDevices.getDisplayMedia(FROZEN_DISPLAY_MEDIA_CONSTRAINTS),
  timeoutMs = DISPLAY_MEDIA_ACQUISITION_TIMEOUT_MS
): Promise<FrozenFrame> {
  const stream = await acquireDisplayStream(getDisplayMedia, timeoutMs);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;
  try {
    const play = video.play();
    await Promise.all([play, waitForVideoFrame(video)]);
    const bitmap = await createImageBitmap(video);
    if (bitmap.width <= 0 || bitmap.height <= 0) {
      bitmap.close();
      throw new Error("display media returned an empty frame");
    }
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const bitmapContext = canvas.getContext("bitmaprenderer");
    if (bitmapContext !== null) {
      bitmapContext.transferFromImageBitmap(bitmap);
      return {
        canvas,
        width: canvas.width,
        height: canvas.height,
        transferMode: "bitmaprenderer"
      };
    }
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
  } finally {
    stopDisplayStream(stream);
    video.pause();
    video.srcObject = null;
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
