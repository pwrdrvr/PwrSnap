// GIF / MP4 quick-output exporter. Reads the original source clip
// produced by the recorder, slices the requested range, applies the
// requested quality preset (LMH), and writes a cache artifact under
// the render cache root. The cache key is (captureId, range, format,
// preset, audio choices); identical re-exports return the cached file
// directly via video-repo.lookupExport.
//
// GIF: always silent. We use ffmpeg's two-pass `palettegen` +
// `paletteuse` pipeline for chat-quality output without bloating the
// encoder dependency. The preset drives target width + fps:
//   LOW : 480p · 15 fps · social-friendly
//   MED : 720p · 24 fps · "film frame rate"
//   HIGH: source resolution · 30 fps · max quality
//
// MP4: copies the relevant audio tracks based on the user's toggles.
// Track selection happens via ffmpeg's `-map` flags; the source
// container places system audio on track 1, microphone on track 2
// when both are present (the recorder writes them in that order).
// The preset drives target width + VideoToolbox bitrate:
//   LOW : 720p  · 2 Mbps · web-friendly
//   MED : 1080p · 5 Mbps · visually-lossless
//   HIGH: source resolution · 6 Mbps · compressed master

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  CaptureRecord,
  VideoCaptureMetadata,
  VideoExportAudio,
  VideoExportRequest,
  VideoExportResult,
  VideoPreset,
  VideoRange
} from "@pwrsnap/shared";
import { getMainLogger } from "../log";
import { getCacheRoot } from "../persistence/paths";
import {
  lookupExport,
  recordExport
} from "../persistence/video-repo";
import { FfmpegProgressParser, type FfmpegProgressRecord } from "./ffmpeg-progress";
import { resolveFfmpegPath } from "./ffmpeg-resolver";

const log = getMainLogger("pwrsnap:recording-exporter");

/** Per-(format, preset) encode profile. Source-resolution presets set
 *  `width: null` to signal "no downscale". MP4 presets all re-encode
 *  through VideoToolbox with a target bitrate and GOP interval.
 *
 *  GIF tiers are picked to land in roughly log-spaced byte sizes for
 *  a typical PwrSnap recording — each tier ~2× the previous, with
 *  MED as the geometric midpoint. The resolution axis carries most
 *  of the weight (byte size scales linearly with pixel count); fps
 *  is the secondary lever. We deliberately do NOT scale GIF HIGH up
 *  to source resolution because GIF byte size scales with
 *  `pixels × fps × duration` and gets unusable fast above ~720p
 *  (a 1080p 30fps GIF for 10 seconds is routinely 80+ MB — over
 *  Slack's 50 MB cap, way past iMessage's practical limit, and
 *  triggers most platforms' auto-convert-to-MP4 paths). MP4 keeps
 *  the resolution axis up to source because VideoToolbox H.264 has
 *  enough codec headroom for high-res screen content. */
export type GifPresetSpec = { readonly width: number | null; readonly fps: number };
export type Mp4PresetSpec = {
  readonly width: number | null;
  readonly bitrate: string;
  readonly keyframeInterval: number;
};

export const GIF_PRESETS: Readonly<Record<VideoPreset, GifPresetSpec>> = {
  low: { width: 480, fps: 15 },
  med: { width: 540, fps: 24 },
  high: { width: 720, fps: 30 }
};

export const MP4_PRESETS: Readonly<Record<VideoPreset, Mp4PresetSpec>> = {
  low: { width: 720, bitrate: "2000k", keyframeInterval: 60 },
  med: { width: 1080, bitrate: "5000k", keyframeInterval: 60 },
  high: { width: null, bitrate: "6000k", keyframeInterval: 60 }
};

const MP4_REENCODE_CACHE_TOKEN = "gop60";

/** Compute output dimensions for a given preset against a source
 *  width × height. LOW / MED scale down (preserving aspect with even
 *  dimensions for codec compatibility). HIGH passes source through.
 *  Used both for the encoder's `-vf scale=…` argument and for the
 *  IPC response's `widthPx` / `heightPx` fields. */
export function computeOutputDimensions(
  targetWidth: number | null,
  sourceWidth: number,
  sourceHeight: number
): { widthPx: number; heightPx: number } {
  if (targetWidth === null || targetWidth >= sourceWidth) {
    return { widthPx: evenDimension(sourceWidth), heightPx: evenDimension(sourceHeight) };
  }
  // Round to even — H.264 + libvpx + libx265 all require even dims.
  // Also matches `-vf scale=W:-2`'s behavior (which is what ffmpeg
  // emits when we ask for an even-snapped auto-height).
  const w = targetWidth - (targetWidth % 2);
  const h = Math.round((sourceHeight * w) / sourceWidth);
  return { widthPx: w, heightPx: h - (h % 2) };
}

function evenDimension(value: number): number {
  return Math.max(2, value - (value % 2));
}

export type ExportInput = {
  record: CaptureRecord;
  video: VideoCaptureMetadata;
  format: VideoExportRequest["format"];
  preset: VideoPreset;
  range: VideoRange;
  audio: VideoExportAudio;
  signal?: AbortSignal | undefined;
  progress?: VideoExportProgressObserver | undefined;
};

export type VideoExportProgressUpdate =
  | {
      phase: "queued" | "palette" | "encoding" | "finalizing";
      ratio: number | null;
    }
  | { phase: "done"; ratio: 1; outcome: "succeeded" }
  | {
      phase: "done";
      ratio: null;
      outcome: "failed";
      error: { code: string; message: string };
    }
  | { phase: "done"; ratio: null; outcome: "cancelled" };

export type VideoExportProgressObserver = {
  /** One visible renderer attempt. Also de-duplicates duplicate listeners. */
  runId: string;
  emit: (update: VideoExportProgressUpdate) => void;
};

// ── Encode concurrency hygiene ──────────────────────────────────────
//
// Without guards, six fast clicks on the 6-card grid spawn six
// concurrent ffmpeg processes. That saturates CPUs / fans / swap on
// slower machines, and `triggerDrag` would race `triggerCopy` to
// encode the same file twice. Two guards address this:
//
// 1. In-flight de-duplication — a per-cache-key Promise map. If a
//    second request for the same (captureId, format, preset, range,
//    audio) tuple arrives while the first is still running, both
//    await the same Promise. Same ffmpeg run, two callers. This also
//    coalesces requests from concurrent Library / Float-Over windows.
//
// 2. Global concurrency cap — a counting semaphore limits how many
//    ffmpeg processes run simultaneously. MAX_CONCURRENT_ENCODES=2
//    keeps CPU+memory pressure bounded; extra requests queue until
//    a slot opens. This is the "user clicks 6 cards fast" guard.
//
// Both guards apply only to the ENCODE step. Cache lookups stay
// synchronous and parallel — instant cache hits don't queue.

const MAX_CONCURRENT_ENCODES = 2;
let activeEncodeCount = 0;
type EncodeWaiter = {
  resolve: () => void;
  reject: (cause: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
};
const encodeWaitQueue: EncodeWaiter[] = [];

function abortError(): DOMException {
  return new DOMException("Video export cancelled", "AbortError");
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function acquireEncodeSlot(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  if (activeEncodeCount < MAX_CONCURRENT_ENCODES) {
    activeEncodeCount++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: EncodeWaiter = {
      resolve: () => {
        signal.removeEventListener("abort", waiter.onAbort);
        activeEncodeCount++;
        resolve();
      },
      reject,
      signal,
      onAbort: () => {
        const index = encodeWaitQueue.indexOf(waiter);
        if (index >= 0) encodeWaitQueue.splice(index, 1);
        reject(abortError());
      }
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    encodeWaitQueue.push(waiter);
  });
}

function releaseEncodeSlot(): void {
  activeEncodeCount--;
  for (;;) {
    const next = encodeWaitQueue.shift();
    if (next === undefined) return;
    if (next.signal.aborted) {
      next.signal.removeEventListener("abort", next.onAbort);
      continue;
    }
    next.resolve();
    return;
  }
}

/** Cache-key string for in-flight de-dup. Same fields the
 *  `video_export_cache` PRIMARY KEY uses — two callers asking for
 *  the same key get the same Promise. */
function encodeKey(input: ExportInput): string {
  return [
    input.record.id,
    input.format,
    input.preset,
    input.range.start.toFixed(3),
    input.range.end.toFixed(3),
    input.audio.includeSystemAudio ? 1 : 0,
    input.audio.includeMicrophone ? 1 : 0
  ].join("|");
}

type ProgressListener = {
  refs: number;
  emit: VideoExportProgressObserver["emit"];
};

type InFlightEncode = {
  promise: Promise<VideoExportResult>;
  controller: AbortController;
  acceptingConsumers: boolean;
  consumers: number;
  listeners: Map<string, ProgressListener>;
  lastProgress: VideoExportProgressUpdate;
};

const inFlightEncodes = new Map<string, InFlightEncode>();

function emitProgressSafely(
  emit: VideoExportProgressObserver["emit"],
  update: VideoExportProgressUpdate
): void {
  try {
    emit(update);
  } catch (cause) {
    log.warn("video export progress observer threw", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}

function publishProgress(job: InFlightEncode, update: VideoExportProgressUpdate): void {
  job.lastProgress = update;
  for (const listener of job.listeners.values()) {
    emitProgressSafely(listener.emit, update);
  }
}

function attachProgressObserver(
  job: InFlightEncode,
  observer: VideoExportProgressObserver | undefined
): void {
  if (observer === undefined) return;
  const existing = job.listeners.get(observer.runId);
  if (existing !== undefined) {
    existing.refs++;
    return;
  }
  job.listeners.set(observer.runId, { refs: 1, emit: observer.emit });
  emitProgressSafely(observer.emit, job.lastProgress);
}

function detachProgressObserver(
  job: InFlightEncode,
  observer: VideoExportProgressObserver | undefined
): void {
  if (observer === undefined) return;
  const existing = job.listeners.get(observer.runId);
  if (existing === undefined) return;
  existing.refs--;
  if (existing.refs === 0) job.listeners.delete(observer.runId);
}

async function waitForEncode(
  job: InFlightEncode,
  input: ExportInput,
  joined: boolean
): Promise<VideoExportResult> {
  const signal = input.signal ?? new AbortController().signal;
  if (signal.aborted) {
    if (input.progress !== undefined) {
      emitProgressSafely(input.progress.emit, {
        phase: "done",
        ratio: null,
        outcome: "cancelled"
      });
    }
    if (job.consumers === 0) {
      job.acceptingConsumers = false;
      job.controller.abort();
    }
    throw abortError();
  }

  job.consumers++;
  attachProgressObserver(job, input.progress);

  let didAbort = false;
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      didAbort = true;
      const listener =
        input.progress === undefined
          ? undefined
          : job.listeners.get(input.progress.runId);
      if (input.progress !== undefined && (listener === undefined || listener.refs === 1)) {
        emitProgressSafely(input.progress.emit, {
          phase: "done",
          ratio: null,
          outcome: "cancelled"
        });
      }
      detachProgressObserver(job, input.progress);
      job.consumers--;
      if (job.consumers === 0) {
        job.acceptingConsumers = false;
        job.controller.abort();
      }
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const result = await Promise.race([job.promise, aborted]);
    return joined ? { ...result, fromCache: true } : result;
  } finally {
    if (onAbort !== null) signal.removeEventListener("abort", onAbort);
    if (!didAbort) {
      detachProgressObserver(job, input.progress);
      job.consumers--;
    }
  }
}

async function waitForRetiringEncode(
  job: InFlightEncode,
  input: ExportInput
): Promise<void> {
  const settled = job.promise.then(
    () => undefined,
    () => undefined
  );
  const signal = input.signal;
  if (signal === undefined) {
    await settled;
    return;
  }
  if (signal.aborted) {
    if (input.progress !== undefined) {
      emitProgressSafely(input.progress.emit, {
        phase: "done",
        ratio: null,
        outcome: "cancelled"
      });
    }
    throw abortError();
  }

  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      if (input.progress !== undefined) {
        emitProgressSafely(input.progress.emit, {
          phase: "done",
          ratio: null,
          outcome: "cancelled"
        });
      }
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([settled, aborted]);
  } finally {
    if (onAbort !== null) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Resolve a cache hit or encode fresh. Caller is responsible for
 * validating the audio toggles against `video.hasSystemAudio` /
 * `video.hasMicrophoneAudio` — the exporter trusts its inputs.
 *
 * Concurrent requests for the same cache key share one ffmpeg run
 * (in-flight de-dup); cross-key requests are bounded by a global
 * semaphore (concurrency cap). See the header above for rationale.
 */
export async function exportVideoRange(input: ExportInput): Promise<VideoExportResult> {
  if (input.signal?.aborted === true) {
    if (input.progress !== undefined) {
      emitProgressSafely(input.progress.emit, {
        phase: "done",
        ratio: null,
        outcome: "cancelled"
      });
    }
    throw abortError();
  }
  const { widthPx, heightPx } = computeOutputDimensions(
    (input.format === "gif" ? GIF_PRESETS : MP4_PRESETS)[input.preset].width,
    input.record.width_px,
    input.record.height_px
  );

  // Cache lookup is always fast (synchronous SQLite point query).
  // No need to queue it behind the semaphore — instant cache hits
  // should stay instant.
  const cached = lookupExport({
    captureId: input.record.id,
    range: input.range,
    format: input.format,
    preset: input.preset,
    audio: input.audio
  });
  if (
    cached !== null &&
    existsSync(cached.path) &&
    cacheEntryMatchesEncoder(input, cached.path)
  ) {
    if (input.progress !== undefined) {
      emitProgressSafely(input.progress.emit, { phase: "queued", ratio: null });
      emitProgressSafely(input.progress.emit, { phase: "finalizing", ratio: 0.99 });
      emitProgressSafely(input.progress.emit, {
        phase: "done",
        ratio: 1,
        outcome: "succeeded"
      });
    }
    return { ...cached, widthPx, heightPx };
  }

  // In-flight de-dup: two callers for the same key share one ffmpeg,
  // including requests from separate renderer windows.
  const key = encodeKey(input);
  const existing = inFlightEncodes.get(key);
  if (existing !== undefined) {
    if (existing.acceptingConsumers && !existing.controller.signal.aborted) {
      return waitForEncode(existing, input, true);
    }
    // A last consumer cancelled this shared job. Do not attach a retry to
    // the doomed promise or open the same output while FFmpeg is closing.
    await waitForRetiringEncode(existing, input);
    return exportVideoRange(input);
  }

  const controller = new AbortController();
  const job: InFlightEncode = {
    promise: Promise.resolve(null as never),
    controller,
    acceptingConsumers: true,
    consumers: 0,
    listeners: new Map<string, ProgressListener>(),
    lastProgress: { phase: "queued", ratio: null }
  };
  job.promise = encodeAndRecord(input, widthPx, heightPx, controller.signal, (update) => {
    publishProgress(job, update);
  }).then(
    (result) => {
      publishProgress(job, { phase: "done", ratio: 1, outcome: "succeeded" });
      return result;
    },
    (cause: unknown) => {
      job.acceptingConsumers = false;
      if (isAbortError(cause)) {
        publishProgress(job, {
          phase: "done",
          ratio: null,
          outcome: "cancelled"
        });
      } else {
        const message = cause instanceof Error ? cause.message : String(cause);
        publishProgress(job, {
          phase: "done",
          ratio: null,
          outcome: "failed",
          error: { code: "video_export_failed", message }
        });
      }
      throw cause;
    }
  );
  inFlightEncodes.set(key, job);
  const removeJob = (): void => {
    if (inFlightEncodes.get(key) === job) inFlightEncodes.delete(key);
  };
  void job.promise.then(removeJob, removeJob);
  return waitForEncode(job, input, false);
}

async function encodeAndRecord(
  input: ExportInput,
  widthPx: number,
  heightPx: number,
  signal: AbortSignal,
  onProgress: (update: VideoExportProgressUpdate) => void
): Promise<VideoExportResult> {
  throwIfAborted(signal);
  const ffmpeg = resolveFfmpegPath();
  if (ffmpeg === null) {
    throw new Error(
      "ffmpeg not found: bundled PwrSnapFFmpeg is missing and no ffmpeg was found on PATH — set PWRSNAP_FFMPEG_PATH (see docs/ffmpeg-build-reference.md)"
    );
  }

  const outputDir = join(getCacheRoot(), "video", input.record.id);
  await mkdir(outputDir, { recursive: true });
  throwIfAborted(signal);
  const audioTag =
    input.format === "gif"
      ? "silent"
      : `s${input.audio.includeSystemAudio ? 1 : 0}m${input.audio.includeMicrophone ? 1 : 0}`;
  const encoderTag = cacheEncoderTag(input);
  const ext = input.format === "gif" ? "gif" : "mp4";
  // Filename layout matches the cache key shape: range, preset,
  // optional encoder token, audio tag, then extension. Visible-on-
  // disk grouping makes debugging cache hits / orphans trivial
  // (`ls -lh <captureId>/` shows all six format/preset combinations
  // for a given range).
  const outputPath = join(
    outputDir,
    [
      `r${input.range.start.toFixed(3)}-${input.range.end.toFixed(3)}`,
      input.preset,
      ...(encoderTag === null ? [] : [encoderTag]),
      audioTag,
      ext
    ].join(".")
  );
  // FFmpeg must never write directly to the cache pathname. A cancelled or
  // failed child can leave a non-empty, truncated artifact behind, and a
  // pre-existing cache row would then accept it on the next lookup. Keep the
  // real extension last so FFmpeg can infer the muxer from the staging name.
  const stagingPath = `${outputPath}.${process.pid}.${randomUUID()}.partial.${ext}`;

  // Video captures always carry a legacy_src_path (the recorded .mp4
  // lives at ~/Documents/PwrSnap/<id>.mp4 — the bundle-flow rewire
  // doesn't touch the video path yet). Null here is a programming
  // error: the caller fetched a video capture record with no source
  // file, which the recording-service shouldn't ever produce.
  if (input.record.legacy_src_path === null) {
    throw new Error(
      `recording-exporter: capture ${input.record.id} has no legacy_src_path`
    );
  }

  try {
    await acquireEncodeSlot(signal);
    const startMs = Date.now();
    try {
      if (input.format === "gif") {
        // palettegen must consume the selected range before paletteuse can
        // produce output timestamps. Keep that work honestly indeterminate.
        onProgress({ phase: "palette", ratio: null });
        await encodeGif(
          ffmpeg,
          input.record.legacy_src_path,
          input.range,
          GIF_PRESETS[input.preset],
          stagingPath,
          signal,
          onProgress
        );
      } else {
        // Stay indeterminate until FFmpeg reports its first usable output
        // timestamp. A known duration alone cannot prove forward movement.
        onProgress({ phase: "encoding", ratio: null });
        await encodeMp4(
          ffmpeg,
          input.record.legacy_src_path,
          input.video,
          input.range,
          input.audio,
          MP4_PRESETS[input.preset],
          {
            sourceWidthPx: input.record.width_px,
            sourceHeightPx: input.record.height_px,
            outputWidthPx: widthPx,
            outputHeightPx: heightPx
          },
          stagingPath,
          signal,
          onProgress
        );
      }
    } finally {
      releaseEncodeSlot();
    }

    throwIfAborted(signal);
    onProgress({ phase: "finalizing", ratio: 0.99 });
    const sizeInfo = await stat(stagingPath);
    throwIfAborted(signal);
    await publishCompletedExport(stagingPath, outputPath);
    if (signal.aborted) {
      await rm(outputPath, { force: true }).catch(() => undefined);
      throw abortError();
    }
    recordExport({
      captureId: input.record.id,
      range: input.range,
      format: input.format,
      preset: input.preset,
      audio: input.audio,
      path: outputPath,
      byteSize: sizeInfo.size
    });
    // Capture actual encode duration + byte size for offline estimator
    // tuning. The renderer's pre-click size labels come from
    // `estimateVideoByteSize` in recording-handlers.ts — those numbers
    // were calibrated by hand and want a feedback loop once we have
    // real data. Grep `video export encoded` in logs to compare.
    log.info("video export encoded", {
      captureId: input.record.id,
      format: input.format,
      preset: input.preset,
      widthPx,
      heightPx,
      byteSize: sizeInfo.size,
      durationSec: input.range.end - input.range.start,
      encodeMs: Date.now() - startMs
    });
    return {
      path: outputPath,
      byteSize: sizeInfo.size,
      durationSec: input.range.end - input.range.start,
      widthPx,
      heightPx,
      fromCache: false
    };
  } finally {
    await rm(stagingPath, { force: true }).catch(() => undefined);
  }
}

async function publishCompletedExport(
  stagingPath: string,
  outputPath: string
): Promise<void> {
  try {
    await rename(stagingPath, outputPath);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    if (code !== "EEXIST" && code !== "EPERM") throw cause;
    // POSIX rename replaces atomically. Windows rejects an existing target,
    // so remove only the old final artifact and retry with the completed
    // staging file. FFmpeg never observes or writes the final pathname.
    await rm(outputPath, { force: true });
    await rename(stagingPath, outputPath);
  }
}

async function encodeGif(
  ffmpeg: string,
  src: string,
  range: VideoRange,
  spec: GifPresetSpec,
  outPath: string,
  signal: AbortSignal,
  onProgress: (update: VideoExportProgressUpdate) => void
): Promise<void> {
  // Two-pass palette pipeline through a single ffmpeg invocation
  // using `split` + `palettegen` + `paletteuse`. The preset drives
  // target width + fps:
  //   LOW : 480p @ 15 fps  · social-friendly file sizes
  //   MED : 720p @ 24 fps  · "film frame rate" smoothness
  //   HIGH: source @ 30 fps · max-quality (`scale` omitted)
  // `scale=W:-2:flags=lanczos` snaps height to an even value for
  // codec compatibility; `flags=lanczos` is a high-quality kernel
  // that costs negligible CPU vs the default bilinear.
  const duration = (range.end - range.start).toFixed(3);
  const scaleStep = spec.width === null ? "" : `scale=${spec.width}:-2:flags=lanczos,`;
  const filterComplex =
    `[0:v] fps=${spec.fps},${scaleStep}split [a][b];` +
    `[a] palettegen=stats_mode=diff [p];` +
    `[b][p] paletteuse=dither=bayer:bayer_scale=5`;
  const args = [
    "-y",
    "-ss",
    range.start.toFixed(3),
    "-t",
    duration,
    "-i",
    src,
    "-filter_complex",
    filterComplex,
    outPath
  ];
  const durationSec = range.end - range.start;
  await runFfmpeg(ffmpeg, args, {
    durationSec,
    signal,
    onProgress: (record) => {
      if (record.outTimeSec === null || record.outTimeSec <= 0) return;
      // The graph performs two full-range logical stages in one process.
      // FFmpeg exposes no clock for palettegen, so stage one stays
      // indeterminate. Once mux timestamps begin, palettegen is complete;
      // the determinate second half is weighted by its full-range clock.
      const encodeRatio = record.ratio ?? null;
      onProgress({
        phase: "encoding",
        ratio: encodeRatio === null ? null : Math.min(0.99, 0.5 + encodeRatio * 0.49)
      });
    }
  });
}

async function encodeMp4(
  ffmpeg: string,
  src: string,
  video: VideoCaptureMetadata,
  range: VideoRange,
  audio: VideoExportAudio,
  spec: Mp4PresetSpec,
  dims: {
    sourceWidthPx: number;
    sourceHeightPx: number;
    outputWidthPx: number;
    outputHeightPx: number;
  },
  outPath: string,
  signal: AbortSignal,
  onProgress: (update: VideoExportProgressUpdate) => void
): Promise<void> {
  const duration = (range.end - range.start).toFixed(3);
  const args: string[] = [
    "-y",
    "-ss",
    range.start.toFixed(3),
    "-t",
    duration,
    "-i",
    src
  ];

  // Video track. All MP4 presets re-encode via VideoToolbox with
  // per-preset bitrate + GOP settings. HIGH keeps source resolution
  // by omitting the scale filter.
  args.push("-map", "0:v:0");
  // Scale when the preset asks for a target width, then re-encode
  // through Apple's VideoToolbox H.264 encoder. Do not use libx264;
  // the bundled ffmpeg is an LGPL build and this path must stay
  // GPL-clean.
  if (
    dims.outputWidthPx !== dims.sourceWidthPx ||
    dims.outputHeightPx !== dims.sourceHeightPx
  ) {
    args.push(
      "-vf",
      `scale=${dims.outputWidthPx}:${dims.outputHeightPx}:flags=lanczos`
    );
  }
  args.push(
    "-c:v",
    "h264_videotoolbox",
    "-allow_sw",
    "1",
    "-b:v",
    spec.bitrate,
    "-g",
    String(spec.keyframeInterval),
    "-keyint_min",
    String(spec.keyframeInterval),
    "-pix_fmt",
    "yuv420p"
  );

  // Audio track mapping. The recorder writes system audio as the
  // first audio stream and microphone as the second when both are
  // recorded. We map zero, one, or both based on the user's toggles
  // and the source's actual track availability.
  const mappings: string[] = [];
  if (audio.includeSystemAudio && video.hasSystemAudio) {
    mappings.push("0:a:0");
  }
  if (audio.includeMicrophone && video.hasMicrophoneAudio) {
    // If system audio is present but excluded, mic is still source
    // index 1. If system audio is absent, mic is index 0.
    const micIndex = video.hasSystemAudio ? 1 : 0;
    mappings.push(`0:a:${micIndex}`);
  }
  if (mappings.length === 0) {
    args.push("-an");
  } else {
    for (const m of mappings) {
      // `hasSystemAudio` / `hasMicrophoneAudio` is persisted recorder
      // metadata. Older macOS recordings could claim a microphone
      // track even when AVCapture delivered no samples, so make each
      // audio map optional at the ffmpeg boundary. The requested
      // tracks are still mapped when present; a stale missing track
      // no longer aborts the entire video export.
      args.push("-map", `${m}?`);
    }
    args.push("-c:a", "aac", "-b:a", "192k");
  }
  args.push("-movflags", "+faststart", outPath);

  await runFfmpeg(ffmpeg, args, {
    durationSec: range.end - range.start,
    signal,
    onProgress: (record) => {
      onProgress({
        phase: "encoding",
        ratio: record.ratio === null ? null : Math.min(0.99, record.ratio * 0.99)
      });
    }
  });
}

function cacheEncoderTag(input: ExportInput): string | null {
  if (input.format !== "mp4") return null;
  return MP4_REENCODE_CACHE_TOKEN;
}

function cacheEntryMatchesEncoder(input: ExportInput, path: string): boolean {
  const encoderTag = cacheEncoderTag(input);
  return encoderTag === null || path.includes(`.${encoderTag}.`);
}

type RunFfmpegOptions = {
  durationSec: number;
  signal: AbortSignal;
  onProgress: (record: FfmpegProgressRecord) => void;
};

const FFMPEG_KILL_CLOSE_TIMEOUT_MS = 5_000;

function createProgressThrottle(
  emit: (record: FfmpegProgressRecord) => void,
  intervalMs = 250
): { report: (record: FfmpegProgressRecord) => void; cancel: () => void } {
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let pending: FfmpegProgressRecord | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    timer = null;
    if (pending === null) return;
    const next = pending;
    pending = null;
    lastEmitAt = Date.now();
    emit(next);
  };

  return {
    report: (record) => {
      const elapsed = Date.now() - lastEmitAt;
      if (elapsed >= intervalMs) {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        pending = null;
        lastEmitAt = Date.now();
        emit(record);
        return;
      }
      pending = record;
      if (timer === null) timer = setTimeout(flush, Math.max(0, intervalMs - elapsed));
    },
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    }
  };
}

function runFfmpeg(
  ffmpeg: string,
  args: string[],
  options: RunFfmpegOptions
): Promise<void> {
  throwIfAborted(options.signal);
  return new Promise((resolve, reject) => {
    const progressArgs = [
      "-nostdin",
      "-hide_banner",
      "-nostats",
      "-stats_period",
      "0.25",
      "-progress",
      "pipe:1",
      ...args
    ];
    const child = spawn(ffmpeg, progressArgs, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const parser = new FfmpegProgressParser(options.durationSec);
    const throttled = createProgressThrottle(options.onProgress);
    let stderrTail = "";
    let settled = false;
    let aborted = false;
    let killCloseTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      options.signal.removeEventListener("abort", onAbort);
      throttled.cancel();
      if (killCloseTimer !== null) clearTimeout(killCloseTimer);
      killCloseTimer = null;
    };
    const settle = (cause?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (cause === undefined) resolve();
      else reject(cause);
    };
    const onAbort = (): void => {
      aborted = true;
      throttled.cancel();
      try {
        child.kill("SIGKILL");
        killCloseTimer = setTimeout(() => {
          settle(abortError());
        }, FFMPEG_KILL_CLOSE_TIMEOUT_MS);
      } catch {
        settle(abortError());
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled || aborted) return;
      for (const record of parser.push(chunk)) throttled.report(record);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8_192);
    });
    child.once("error", (cause) => {
      // A spawn failure has no live process and can settle immediately.
      // An error raised while killing an aborted child is different: keep
      // the encode slot until `close` (or the bounded fallback) so a retry
      // cannot overlap the same output writer.
      if (aborted || options.signal.aborted) return;
      settle(cause);
    });
    child.once("close", (code) => {
      if (settled) return;
      if (!aborted) {
        for (const record of parser.finish()) throttled.report(record);
      }
      if (aborted || options.signal.aborted) {
        settle(abortError());
      } else if (code === 0) {
        settle();
      } else {
        settle(
          new Error(
            `ffmpeg exited ${String(code)}: ${ffmpegFailureSummary(stderrTail)}`
          )
        );
      }
    });
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  });
}

const FFMPEG_FAILURE_TAIL_LINES = 8;
const FFMPEG_FAILURE_MAX_CHARS = 900;

/** Keep user-facing export errors focused on ffmpeg's diagnosis.
 *  ffmpeg writes its version, compiler, configure flags, input probe,
 *  progress, and actual error to the same stderr stream. Passing a raw
 *  byte tail to the renderer can therefore turn a one-line failure into
 *  a screen-sized tooltip headed by an irrelevant build banner. Keep a
 *  bounded diagnostic tail rather than only the final lines: corrupt-input
 *  and encoder/filter failures often put their root cause before generic
 *  "Nothing was written" / "Conversion failed" teardown messages. */
export function ffmpegFailureSummary(stderr: string): string {
  const lines = stderr
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .trim()
    )
    .filter((line) => line.length > 0)
    .filter((line) => !isFfmpegPreambleOrProgress(line));

  if (lines.length === 0) return "unknown ffmpeg error";

  const tail = lines.slice(-FFMPEG_FAILURE_TAIL_LINES).join(" ");
  return tail.length <= FFMPEG_FAILURE_MAX_CHARS
    ? tail
    : `${tail.slice(0, FFMPEG_FAILURE_MAX_CHARS - 3)}...`;
}

function isFfmpegPreambleOrProgress(line: string): boolean {
  return (
    /^ffmpeg version\b/i.test(line) ||
    /^built with\b/i.test(line) ||
    /^configuration:/i.test(line) ||
    /^lib(?:av|sw|postproc)\w*\s+\d/i.test(line) ||
    /^Input #\d+,/i.test(line) ||
    /^Metadata:$/i.test(line) ||
    /^(?:major_brand|minor_version|compatible_brands|creation_time|handler_name)\s*:/i.test(
      line
    ) ||
    /^Duration:/i.test(line) ||
    /^Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]*\))?:/i.test(line) ||
    /^Stream mapping:$/i.test(line) ||
    /^Press \[q\] to stop/i.test(line) ||
    /^frame=\s*\d+/i.test(line)
  );
}
