// Sharp-based render pipeline. Phase 1: source PNG → resize → encode
// (no overlays yet; Phase 2 adds the composite step).
//
// Pipeline ordering matters — libvips builds a demand-driven graph
// from a single composite() chain. Chaining .toBuffer().pipeline()
// would force full materialization at every hop.
//
// Cache key is `(capture_id, target_width, format)` for Phase 1 since
// there are no overlays. Phase 2's render_inputs_hash subsumes this
// when the editor lands.

import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { getCacheRoot } from "../persistence/db";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:render");

export type RenderRequest = {
  captureId: string;
  srcPath: string;
  /** Target width in pixels. Source-equal width = no resize. */
  width: number;
  format: "png" | "webp";
};

export type RenderResult = {
  cachePath: string;
  byteSize: number;
  fromCache: boolean;
};

/**
 * Compose-on-demand. Idempotent; concurrent calls for the same key
 * coalesce via the RenderCoordinator (see ./coordinator.ts).
 */
export async function compose(req: RenderRequest): Promise<RenderResult> {
  const cacheDir = join(getCacheRoot(), req.captureId);
  const fileName = `${req.width}w.${req.format}`;
  const cachePath = join(cacheDir, fileName);

  if (existsSync(cachePath)) {
    const stats = await stat(cachePath);
    return { cachePath, byteSize: stats.size, fromCache: true };
  }

  await mkdir(cacheDir, { recursive: true });

  const pipeline = sharp(req.srcPath).resize({ width: req.width, withoutEnlargement: true });
  const buf =
    req.format === "png"
      ? await pipeline.png({ compressionLevel: 6, effort: 4 }).toBuffer()
      : await pipeline.webp({ lossless: true, effort: 4 }).toBuffer();

  // Atomic write — produce a tmp file then rename so concurrent readers
  // never see a half-written file.
  const tmpPath = `${cachePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, buf);
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, cachePath);

  log.info("rendered", {
    captureId: req.captureId,
    width: req.width,
    format: req.format,
    byteSize: buf.length
  });

  return { cachePath, byteSize: buf.length, fromCache: false };
}
