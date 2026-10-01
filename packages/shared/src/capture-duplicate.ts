// Duplicating a capture — the pure half, shared by main and the renderer.
//
// Two questions both sides must answer identically:
//
//   1. "Does this snap have edits?" — the Duplicate / Edit a Copy menus
//      only ask "With Edits or Base Image Only?" when the answer is yes,
//      and the question names what the edits ARE ("crop · 2 arrows ·
//      blur"). Main answers it for images (it owns the layer tree); the
//      renderer answers it for videos from `record.video`, which it
//      already has. Both go through the formatter below.
//   2. "What is the copy called?" — "Title copy", "Title copy 2", … and
//      the filename stem "stem-copy", "stem-copy-2", …, numbered against
//      the rest of the family so two copies never share a name.

import type { BundleLayerNode } from "./bundle-manifest-schema-v2";
import { selectBaseRaster } from "./base-raster";
import type { VideoRange } from "./protocol";
import { videoExportSpans, isFullClipEdit } from "./video-segments";

/** What a "with edits" copy would carry that a base copy would not. */
export type CaptureEditSummary = {
  hasEdits: boolean;
  /** Image: a crop layer, or a canvas that is not the base raster's size. */
  cropped: boolean;
  /** Video: the kept range does not start at 0 or end at the duration. */
  trimmed: boolean;
  /** Video: interior cuts (gaps between kept spans). */
  cuts: number;
  arrows: number;
  shapes: number;
  highlights: number;
  blurs: number;
  texts: number;
  steps: number;
  /** Pasted rasters. */
  images: number;
  /** The capture-time cursor raster. */
  cursors: number;
};

/** The name `persistCaptureFromTempV2` gives the capture-time cursor raster. */
export const CURSOR_LAYER_NAME = "Cursor";

export function emptyCaptureEditSummary(): CaptureEditSummary {
  return {
    hasEdits: false,
    cropped: false,
    trimmed: false,
    cuts: 0,
    arrows: 0,
    shapes: 0,
    highlights: 0,
    blurs: 0,
    texts: 0,
    steps: 0,
    images: 0,
    cursors: 0
  };
}

/**
 * Summarize an image capture's LIVE layer tree against its base raster.
 *
 * Every live layer other than the groups and the base raster counts,
 * hidden ones included — a hidden arrow still travels with a "with
 * edits" copy, so the question has to mention it. `edits_version` is no
 * use here: a fresh capture already stands at 1.
 */
export function summarizeImageEdits(
  layers: readonly BundleLayerNode[],
  record: { sha256: string; width_px: number; height_px: number }
): CaptureEditSummary {
  const out = emptyCaptureEditSummary();
  const base = selectBaseRaster(layers, record.sha256);
  for (const layer of layers) {
    switch (layer.kind) {
      case "group":
        break;
      case "raster":
        if (layer.id === base?.id) break;
        if (layer.name === CURSOR_LAYER_NAME) out.cursors += 1;
        else out.images += 1;
        break;
      case "vector":
        switch (layer.shape.kind) {
          case "crop":
            out.cropped = true;
            break;
          case "arrow":
            out.arrows += 1;
            break;
          case "shape":
            out.shapes += 1;
            break;
          case "highlight":
            out.highlights += 1;
            break;
          case "blur":
            out.blurs += 1;
            break;
          case "text":
            out.texts += 1;
            break;
          case "step":
            out.steps += 1;
            break;
        }
        break;
      case "effect":
        if (layer.effect.type === "blur") out.blurs += 1;
        else out.highlights += 1;
        break;
    }
  }
  if (
    base !== undefined &&
    (base.natural_width_px !== record.width_px || base.natural_height_px !== record.height_px)
  ) {
    out.cropped = true;
  }
  out.hasEdits = out.cropped || countAnnotations(out) > 0;
  return out;
}

/** Summarize a video's edit: the outer trim plus its interior cuts. */
export function summarizeVideoEdits(video: {
  durationSec: number;
  segments: readonly VideoRange[];
}): CaptureEditSummary {
  const out = emptyCaptureEditSummary();
  const spans = videoExportSpans(video.segments);
  out.cuts = Math.max(0, spans.length - 1);
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (first !== undefined && last !== undefined) {
    out.trimmed = !isFullClipEdit([{ start: first.start, end: last.end }], video.durationSec);
  }
  out.hasEdits = out.trimmed || out.cuts > 0;
  return out;
}

function countAnnotations(s: CaptureEditSummary): number {
  return (
    s.arrows + s.shapes + s.highlights + s.blurs + s.texts + s.steps + s.images + s.cursors
  );
}

function counted(n: number, one: string, many: string): string | null {
  if (n <= 0) return null;
  return n === 1 ? one : `${n} ${many}`;
}

/**
 * "crop · 2 arrows · blur" — the line under "With Edits". Empty string
 * when there is nothing to say (the caller should not be asking then).
 */
export function formatCaptureEditSummary(s: CaptureEditSummary): string {
  const parts = [
    s.cropped ? "crop" : null,
    s.trimmed ? "trim" : null,
    counted(s.cuts, "1 cut", "cuts"),
    counted(s.arrows, "arrow", "arrows"),
    counted(s.shapes, "shape", "shapes"),
    counted(s.highlights, "highlight", "highlights"),
    counted(s.blurs, "blur", "blurs"),
    counted(s.texts, "text", "texts"),
    counted(s.steps, "step", "steps"),
    counted(s.images, "image", "images"),
    counted(s.cursors, "cursor", "cursors")
  ].filter((p): p is string => p !== null);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Copy naming
// ---------------------------------------------------------------------------

const TITLE_COPY_SUFFIX = / copy(?: (\d+))?$/i;
const STEM_COPY_SUFFIX = /-copy(?:-(\d+))?$/i;

/** "Title copy 3" → "Title". A copy of a copy is numbered from the root. */
export function stripTitleCopySuffix(title: string): string {
  return title.replace(TITLE_COPY_SUFFIX, "");
}

export function stripStemCopySuffix(stem: string): string {
  return stem.replace(STEM_COPY_SUFFIX, "");
}

/**
 * The lowest copy number (1 = plain "copy") not already used by a
 * family title or filename stem that shares `base`.
 */
export function nextCopyNumber(args: {
  titleBase: string | null;
  stemBase: string | null;
  familyTitles: readonly (string | null)[];
  familyStems: readonly (string | null)[];
}): number {
  const used = new Set<number>();
  const collect = (
    values: readonly (string | null)[],
    base: string | null,
    re: RegExp,
    strip: (v: string) => string
  ): void => {
    if (base === null) return;
    const baseKey = base.toLowerCase();
    for (const value of values) {
      if (value === null) continue;
      const m = re.exec(value);
      if (m === null || strip(value).toLowerCase() !== baseKey) continue;
      used.add(m[1] === undefined ? 1 : Number(m[1]));
    }
  };
  collect(args.familyTitles, args.titleBase, TITLE_COPY_SUFFIX, stripTitleCopySuffix);
  collect(args.familyStems, args.stemBase, STEM_COPY_SUFFIX, stripStemCopySuffix);
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

export function copyTitle(base: string, n: number): string {
  return n === 1 ? `${base} copy` : `${base} copy ${n}`;
}

export function copyStem(base: string, n: number): string {
  return n === 1 ? `${base}-copy` : `${base}-copy-${n}`;
}

// ---------------------------------------------------------------------------
// Background video copies
// ---------------------------------------------------------------------------

/**
 * A video duplicate that could not be cloned and is being byte-copied in
 * main (see `capture:duplicate`). The copy has NO capture row until the
 * job reaches `done`: `captureId` is the id it will be committed under,
 * never something to look up or open before then.
 *
 * Broadcast on `events:capture-duplicate:job` as `{ job }` — once when
 * the copy starts, then throttled while bytes move, then exactly once in
 * a terminal state (`done`, `failed`, `cancelled`), after which main
 * forgets the job. `capture:duplicateJobs` lists the ones still copying
 * for a window that mounts mid-copy.
 */
export type CaptureDuplicateJob = {
  jobId: string;
  sourceId: string;
  captureId: string;
  withEdits: boolean;
  state: CaptureDuplicateJobState;
  bytesCopied: number;
  totalBytes: number;
  /** User-facing reason, set only when `state === "failed"`. */
  error: string | null;
};

export type CaptureDuplicateJobState = "copying" | "done" | "failed" | "cancelled";

export function isTerminalDuplicateJob(job: Pick<CaptureDuplicateJob, "state">): boolean {
  return job.state !== "copying";
}

/** 0..1, for a progress bar. A zero-byte source reads as complete. */
export function duplicateJobFraction(
  job: Pick<CaptureDuplicateJob, "bytesCopied" | "totalBytes">
): number {
  if (job.totalBytes <= 0) return 1;
  return Math.min(1, Math.max(0, job.bytesCopied / job.totalBytes));
}
