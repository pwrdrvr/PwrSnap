// Filmstrip thumbnails for Burst Review.
//
// The review window shows up to BURST_MAX_FRAMES stills side by side. Each
// still is a full-resolution PNG (a Retina display region can be 5K wide),
// and Chromium decodes an <img> at its intrinsic size whatever box it is
// drawn into — so a strip of full stills would hold gigabytes of decoded
// pixels. The strip asks for `…/thumb` instead, made here on first request
// and kept beside the stills in the session's directory, which the session
// deletes when it ends.

import { mkdir, rename, rm, stat } from "node:fs/promises";
import { nanoid } from "nanoid";
import sharp from "sharp";

export const BURST_THUMB_MAX_PX = 360;

const inflight = new Map<string, Promise<string>>();

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The thumbnail for `framePath` at `thumbPath`, made once. Concurrent asks
 * for one thumbnail share one encode. `thumbsDir` is created without
 * `recursive`: if the session's directory is already gone, this fails
 * instead of quietly re-creating a directory nobody owns.
 */
export function ensureBurstThumb(paths: {
  framePath: string;
  thumbsDir: string;
  thumbPath: string;
}): Promise<string> {
  const pending = inflight.get(paths.thumbPath);
  if (pending !== undefined) return pending;
  const work = (async () => {
    if (await exists(paths.thumbPath)) return paths.thumbPath;
    try {
      await mkdir(paths.thumbsDir);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    const staging = `${paths.thumbPath}.${nanoid(6)}.partial`;
    try {
      await sharp(paths.framePath)
        .resize({ width: BURST_THUMB_MAX_PX, height: BURST_THUMB_MAX_PX, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toFile(staging);
      await rename(staging, paths.thumbPath);
    } catch (cause) {
      await rm(staging, { force: true }).catch(() => undefined);
      throw cause;
    }
    return paths.thumbPath;
  })().finally(() => inflight.delete(paths.thumbPath));
  inflight.set(paths.thumbPath, work);
  return work;
}
