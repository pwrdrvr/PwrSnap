// A strip of camera thumbnails for the timeline's camera lane, plus one
// larger still for the framing menu's previews. Seeks a hidden <video> of
// the camera file once per cell and paints into one canvas, the same
// one-image-many-cells shape as the screen filmstrip.
//
// Cached per capture for the life of the window: the Library remounts the
// stage on every capture switch and the camera file never changes.

import { useEffect, useState } from "react";
import type { CameraTrackMetadata } from "@pwrsnap/shared";

export type CameraStrip = {
  /** `cells` thumbnails side by side, or null while loading. */
  readonly url: string | null;
  /** A single 16:9-ish still from the middle of the take. */
  readonly posterUrl: string | null;
  readonly missing: boolean;
};

const CELL_H = 48;
const POSTER_W = 160;
const cache = new Map<string, CameraStrip>();

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
      resolve();
    };
    const fail = (): void => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
      reject(new Error("seek failed"));
    };
    video.addEventListener("seeked", done);
    video.addEventListener("error", fail);
    video.currentTime = time;
  });
}

async function buildStrip(
  captureId: string,
  camera: CameraTrackMetadata,
  cells: number,
  isRetired: () => boolean
): Promise<CameraStrip> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = `pwrsnap-capture://c/${captureId}`;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("camera file unavailable"));
    });
    const aspect = camera.width / camera.height;
    const cellW = Math.max(8, Math.round(CELL_H * aspect));
    const strip = document.createElement("canvas");
    strip.width = cellW * cells;
    strip.height = CELL_H;
    const ctx = strip.getContext("2d")!;
    const poster = document.createElement("canvas");
    poster.width = POSTER_W;
    poster.height = Math.round(POSTER_W / aspect);
    for (let i = 0; i < cells; i++) {
      if (isRetired()) break;
      await seek(video, Math.min(camera.durationSec - 0.05, ((i + 0.5) / cells) * camera.durationSec));
      ctx.drawImage(video, i * cellW, 0, cellW, CELL_H);
      if (i === Math.floor(cells / 2)) poster.getContext("2d")!.drawImage(video, 0, 0, poster.width, poster.height);
    }
    return {
      url: strip.toDataURL("image/jpeg", 0.7),
      posterUrl: poster.toDataURL("image/jpeg", 0.8),
      missing: false
    };
  } catch {
    return { url: null, posterUrl: null, missing: true };
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

export function useCameraStrip(
  captureId: string,
  camera: CameraTrackMetadata | null | undefined,
  cells = 16
): CameraStrip {
  const key = camera ? `${captureId}:${camera.sha256}:${cells}` : "";
  const [strip, setStrip] = useState<CameraStrip>(
    () => cache.get(key) ?? { url: null, posterUrl: null, missing: false }
  );
  useEffect(() => {
    if (!camera) return;
    const hit = cache.get(key);
    if (hit) {
      setStrip(hit);
      return;
    }
    setStrip({ url: null, posterUrl: null, missing: false });
    let retired = false;
    void buildStrip(captureId, camera, cells, () => retired).then((built) => {
      if (retired) return;
      if (built.url !== null || built.missing) cache.set(key, built);
      setStrip(built);
    });
    return () => {
      retired = true;
    };
  }, [captureId, camera, cells, key]);
  return strip;
}
