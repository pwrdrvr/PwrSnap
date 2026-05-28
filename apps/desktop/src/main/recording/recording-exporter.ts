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
// The preset drives target width + CRF:
//   LOW : 720p  · CRF 28 · web-friendly
//   MED : 1080p · CRF 23 · visually-lossless
//   HIGH: source resolution · stream-copy (no re-encode)

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

/** Per-(format, preset) encode profile. Source-resolution presets
 *  (HIGH for MP4) set `width: null` to signal "no downscale". MP4
 *  HIGH also sets `crf: null` to signal "stream-copy" (no
 *  re-encode).
 *
 *  GIF HIGH does NOT use source resolution. GIFs are palette-frame
 *  encoded; byte size scales with `pixels × fps × duration` and gets
 *  unusable fast above ~720p (a 1080p 30fps GIF for 10 seconds is
 *  routinely 80+ MB — over Slack's 50 MB cap, way past iMessage's
 *  practical limit, and triggers most platforms' auto-convert-to-
 *  MP4 paths). The three GIF tiers vary fps within a hard 720p
 *  resolution cap: HIGH means "smoother", not "bigger". MP4 keeps
 *  the resolution axis because it has the codec headroom (CRF +
 *  H.264 motion compensation) to handle high-res screen content
 *  without exploding. */
export type GifPresetSpec = { readonly width: number | null; readonly fps: number };
export type Mp4PresetSpec = { readonly width: number | null; readonly crf: number | null };

export const GIF_PRESETS: Readonly<Record<VideoPreset, GifPresetSpec>> = {
  low: { width: 480, fps: 15 },
  med: { width: 720, fps: 24 },
  high: { width: 720, fps: 30 }
};

export const MP4_PRESETS: Readonly<Record<VideoPreset, Mp4PresetSpec>> = {
  low: { width: 720, crf: 28 },
  med: { width: 1080, crf: 23 },
  high: { width: null, crf: null }
};

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
    return { widthPx: sourceWidth, heightPx: sourceHeight };
  }
  // Round to even — H.264 + libvpx + libx265 all require even dims.
  // Also matches `-vf scale=W:-2`'s behavior (which is what ffmpeg
  // emits when we ask for an even-snapped auto-height).
  const w = targetWidth - (targetWidth % 2);
  const h = Math.round((sourceHeight * w) / sourceWidth);
  return { widthPx: w, heightPx: h - (h % 2) };
}

export type ExportInput = {
  record: CaptureRecord;
  video: VideoCaptureMetadata;
  format: VideoExportRequest["format"];
  preset: VideoPreset;
  range: VideoRange;
  audio: VideoExportAudio;
};

/**
 * Resolve a cache hit or encode fresh. Caller is responsible for
 * validating the audio toggles against `video.hasSystemAudio` /
 * `video.hasMicrophoneAudio` — the exporter trusts its inputs.
 */
export async function exportVideoRange(input: ExportInput): Promise<VideoExportResult> {
  const { widthPx, heightPx } = computeOutputDimensions(
    (input.format === "gif" ? GIF_PRESETS : MP4_PRESETS)[input.preset].width,
    input.record.width_px,
    input.record.height_px
  );

  const cached = lookupExport({
    captureId: input.record.id,
    range: input.range,
    format: input.format,
    preset: input.preset,
    audio: input.audio
  });
  if (cached !== null && existsSync(cached.path)) {
    return { ...cached, widthPx, heightPx };
  }

  const ffmpeg = resolveFfmpegPath();
  if (ffmpeg === null) {
    throw new Error(
      "ffmpeg binary not available — install @ffmpeg-installer/ffmpeg or set PWRSNAP_FFMPEG_PATH"
    );
  }

  const outputDir = join(getCacheRoot(), "video", input.record.id);
  await mkdir(outputDir, { recursive: true });
  const audioTag =
    input.format === "gif"
      ? "silent"
      : `s${input.audio.includeSystemAudio ? 1 : 0}m${input.audio.includeMicrophone ? 1 : 0}`;
  const ext = input.format === "gif" ? "gif" : "mp4";
  // Filename layout matches the cache key shape: range, then preset,
  // then audio tag, then extension. Visible-on-disk grouping makes
  // debugging cache hits / orphans trivial (`ls -lh <captureId>/`
  // shows all six format/preset combinations for a given range).
  const outputPath = join(
    outputDir,
    `r${input.range.start.toFixed(3)}-${input.range.end.toFixed(3)}.${input.preset}.${audioTag}.${ext}`
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
      outputPath
    );
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
  log.info("video export encoded", {
    captureId: input.record.id,
    format: input.format,
    preset: input.preset,
    widthPx,
    heightPx,
    byteSize: sizeInfo.size,
    durationSec: input.range.end - input.range.start
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

  // Video track. HIGH preset = stream-copy (`-c:v copy`) — no
  // re-encode, no downscale, instant. LOW / MED preset = re-encode
  // via libx264 with a per-preset CRF + downscale-to-target-width.
  args.push("-map", "0:v:0");
  if (spec.width === null || spec.crf === null) {
    // HIGH: stream-copy. The source is already H.264 (per the
    // recorder config) so this is a trim + remux, ~instant on disk.
    args.push("-c:v", "copy");
  } else {
    // LOW / MED: scale + re-encode. `-vf scale=W:-2` produces an
    // even-snapped height; `-preset veryfast` is the sweet-spot
    // tradeoff between encode CPU and file size at the same CRF
    // for screen content. `-crf` is the rate-distortion knob (lower
    // = higher quality + larger file; CRF 23 is x264's "visually
    // lossless" default, CRF 28 is web-friendly).
    args.push(
      "-vf",
      `scale=${spec.width}:-2:flags=lanczos`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      String(spec.crf),
      "-pix_fmt",
      "yuv420p"
    );
  }

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
