// The render step every cart export shares (Zip, Copy all, Contact sheet):
// resolve each image at one preset through the cached export pipeline, two at
// a time, keeping only file paths (never image buffers) so a 1000-image cart
// does not hold 1000 PNGs in memory.

import type { CaptureRecord, RenderPreset } from "@pwrsnap/shared";
import { getCaptureById } from "../persistence/captures-repo";
import { resolveImagePresetFile } from "../render/image-presets";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:cart-render");

export type CartRenderProgress = { completed: number; total: number };

export type CartRenderedImage = { record: CaptureRecord; path: string };

export type CartRenderOutcome = {
  /** Rendered images, in input order. */
  rendered: CartRenderedImage[];
  failed: number;
  cancelled: boolean;
};

/** Resolve cart ids to exportable image records, counting the ones filtered
 *  out (soft-deleted, purged, or non-image). Every cart export applies this
 *  same skip rule. */
export function resolveExportableImages(captureIds: readonly string[]): {
  records: CaptureRecord[];
  skipped: number;
} {
  const records: CaptureRecord[] = [];
  let skipped = 0;
  for (const id of captureIds) {
    const rec = getCaptureById(id);
    if (rec === null || rec.deleted_at !== null || rec.kind !== "image") {
      skipped++;
      continue;
    }
    records.push(rec);
  }
  return { records, skipped };
}

/**
 * Render `records` at `preset`. One unrenderable image is counted in
 * `failed`, never fatal. Renders run in batches of two; a slow batch stops
 * admission of the next. Cancellation drains the admitted renders (they are
 * not abortable) and returns what finished with `cancelled: true`. Fires
 * `onProgress` once up front and once per image.
 */
export async function renderCartImages(
  records: readonly CaptureRecord[],
  preset: RenderPreset,
  opts: { signal?: AbortSignal; onProgress?: (p: CartRenderProgress) => void } = {}
): Promise<CartRenderOutcome> {
  const total = records.length;
  const rendered: CartRenderedImage[] = [];
  let failed = 0;
  opts.onProgress?.({ completed: 0, total });
  for (let offset = 0; offset < records.length; offset += 2) {
    if (opts.signal?.aborted) return { rendered, failed, cancelled: true };
    // AllSettled observes every rejection and drains both non-abortable
    // renders before returning to the caller, including after cancellation.
    const batch = records.slice(offset, offset + 2);
    const results = await Promise.allSettled(
      batch.map((rec) => {
        if (opts.signal?.aborted) return Promise.resolve(null);
        return resolveImagePresetFile(rec, preset);
      })
    );
    if (opts.signal?.aborted) return { rendered, failed, cancelled: true };
    for (const [index, rec] of batch.entries()) {
      const result = results[index]!;
      if (result.status === "rejected") {
        // One unrenderable image (corrupt source, etc.) must not sink the
        // whole export — skip it, count it, keep going.
        failed++;
        log.warn("cart export: skipping unrenderable capture", {
          id: rec.id,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      } else if (result.value !== null) {
        rendered.push({ record: rec, path: result.value.path });
      }
      opts.onProgress?.({ completed: rendered.length + failed, total });
    }
  }
  if (opts.signal?.aborted) return { rendered, failed, cancelled: true };
  return { rendered, failed, cancelled: false };
}

/** Give repeated file names a ` (2)`, ` (3)` … before the extension, so a
 *  paste of several files never asks to replace one with another. Compared
 *  case-insensitively (macOS and Windows file systems are). */
export function uniqueFileNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
      candidate = `${stem} (${n})${ext}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
