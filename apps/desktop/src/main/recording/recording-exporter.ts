// GIF / MP4 quick-output exporter. Reads the original source clip
// produced by the recorder, slices the requested range, and writes a
// cache artifact under the render cache root. The cache key is
// (captureId, range, format, audio choices); identical re-exports
// return the cached file directly via video-repo.lookupExport.
//
// GIF: always silent. We use ffmpeg's two-pass `palettegen` +
// `paletteuse` pipeline for chat-quality output without bloating
// the encoder dependency.
//
// MP4: copies the relevant audio tracks based on the user's toggles.
// Track selection happens via ffmpeg's `-map` flags; the source
// container places system audio on track 1, microphone on track 2
// when both are present (the recorder writes them in that order).

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

export type ExportInput = {
  record: CaptureRecord;
  video: VideoCaptureMetadata;
  format: VideoExportRequest["format"];
  range: VideoRange;
  audio: VideoExportAudio;
};

/**
 * Resolve a cache hit or encode fresh. Caller is responsible for
 * validating the audio toggles against `video.hasSystemAudio` /
 * `video.hasMicrophoneAudio` — the exporter trusts its inputs.
 */
export async function exportVideoRange(input: ExportInput): Promise<VideoExportResult> {
  const cached = lookupExport({
    captureId: input.record.id,
    range: input.range,
    format: input.format,
    audio: input.audio
  });
  if (cached !== null && existsSync(cached.path)) {
    return cached;
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
  const outputPath = join(
    outputDir,
    `r${input.range.start.toFixed(3)}-${input.range.end.toFixed(3)}.${audioTag}.${ext}`
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
    await encodeGif(ffmpeg, input.record.legacy_src_path, input.range, outputPath);
  } else {
    await encodeMp4(ffmpeg, input.record.legacy_src_path, input.video, input.range, input.audio, outputPath);
  }

  const sizeInfo = await stat(outputPath);
  recordExport({
    captureId: input.record.id,
    range: input.range,
    format: input.format,
    audio: input.audio,
    path: outputPath,
    byteSize: sizeInfo.size
  });
  log.info("video export encoded", {
    captureId: input.record.id,
    format: input.format,
    byteSize: sizeInfo.size,
    durationSec: input.range.end - input.range.start
  });
  return {
    path: outputPath,
    byteSize: sizeInfo.size,
    durationSec: input.range.end - input.range.start,
    fromCache: false
  };
}

async function encodeGif(
  ffmpeg: string,
  src: string,
  range: VideoRange,
  outPath: string
): Promise<void> {
  // Two-pass palette pipeline through a single ffmpeg invocation
  // using `split` + `palettegen` + `paletteuse`. Output FPS is
  // capped at 15 — anything faster bloats GIFs without perceptual
  // win for screen content.
  const duration = (range.end - range.start).toFixed(3);
  const args = [
    "-y",
    "-ss",
    range.start.toFixed(3),
    "-t",
    duration,
    "-i",
    src,
    "-filter_complex",
    "[0:v] fps=15,scale=720:-2:flags=lanczos,split [a][b];[a] palettegen [p];[b][p] paletteuse",
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
  // Always copy the video track. The source is already H.264/AAC
  // (per the recorder config) so a stream copy avoids a re-encode.
  args.push("-map", "0:v:0", "-c:v", "copy");

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
