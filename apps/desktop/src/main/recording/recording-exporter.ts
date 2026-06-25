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
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
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
//    await the same Promise. Same ffmpeg run, two callers. This is
//    how `triggerDrag`'s parallel `video:export` dispatch on the
//    renderer side avoids paying twice for the encode.
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
const encodeWaitQueue: Array<() => void> = [];

function acquireEncodeSlot(): Promise<void> {
  if (activeEncodeCount < MAX_CONCURRENT_ENCODES) {
    activeEncodeCount++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    encodeWaitQueue.push(() => {
      activeEncodeCount++;
      resolve();
    });
  });
}

function releaseEncodeSlot(): void {
  activeEncodeCount--;
  const next = encodeWaitQueue.shift();
  if (next !== undefined) next();
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

const inFlightEncodes = new Map<string, Promise<VideoExportResult>>();

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
    return { ...cached, widthPx, heightPx };
  }

  // In-flight de-dup: two callers for the same key share one ffmpeg.
  // Critical for the `triggerDrag` parallel-dispatch pattern on the
  // renderer side — the drag's `video:prepareDrag` and the visible-
  // state `video:export` would otherwise encode the same file twice.
  const key = encodeKey(input);
  const existing = inFlightEncodes.get(key);
  if (existing !== undefined) {
    const result = await existing;
    // The first caller returns `fromCache: false`; subsequent callers
    // get a result that's effectively cached (the file is on disk now,
    // they didn't pay for the encode). Mark as cache hit so log spans
    // distinguish "actually encoded" from "rode the in-flight wave".
    return { ...result, fromCache: true };
  }

  const promise = encodeAndRecord(input, widthPx, heightPx);
  inFlightEncodes.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightEncodes.delete(key);
  }
}

async function encodeAndRecord(
  input: ExportInput,
  widthPx: number,
  heightPx: number
): Promise<VideoExportResult> {
  const ffmpeg = resolveFfmpegPath();
  if (ffmpeg === null) {
    throw new Error(
      "ffmpeg binary not available — run build:ffmpeg or set PWRSNAP_FFMPEG_PATH"
    );
  }

  const outputDir = join(getCacheRoot(), "video", input.record.id);
  await mkdir(outputDir, { recursive: true });
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

  await acquireEncodeSlot();
  const startMs = Date.now();
  try {
    if (input.format === "gif") {
      await encodeGif(
        ffmpeg,
        input.record.legacy_src_path,
        input.range,
        GIF_PRESETS[input.preset],
        outputPath
      );
    } else {
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
        outputPath
      );
    }
  } finally {
    releaseEncodeSlot();
  }

  const sizeInfo = await stat(outputPath);
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
}

async function encodeGif(
  ffmpeg: string,
  src: string,
  range: VideoRange,
  spec: GifPresetSpec,
  outPath: string
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
  await runFfmpeg(ffmpeg, args);
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
  outPath: string
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
      args.push("-map", m);
    }
    args.push("-c:a", "aac", "-b:a", "192k");
  }
  args.push("-movflags", "+faststart", outPath);

  await runFfmpeg(ffmpeg, args);
}

function cacheEncoderTag(input: ExportInput): string | null {
  if (input.format !== "mp4") return null;
  return MP4_REENCODE_CACHE_TOKEN;
}

function cacheEntryMatchesEncoder(input: ExportInput, path: string): boolean {
  const encoderTag = cacheEncoderTag(input);
  return encoderTag === null || path.includes(`.${encoderTag}.`);
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
