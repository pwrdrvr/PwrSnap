import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { resolveFfmpegPath } from "../recording/ffmpeg-resolver";

export const DEFAULT_ENRICHMENT_IMAGE_MAX_EDGE_PX = 1024;
export const DEFAULT_ENRICHMENT_IMAGE_QUALITY = 75;
export const DEFAULT_ENRICHMENT_IMAGE_MAX_BYTES = 1_000_000;

export type PreparedEnrichmentImage = {
  path: string;
  sourceWidth: number | null;
  sourceHeight: number | null;
  sourceMimeType: string | null;
  width: number;
  height: number;
  byteSize: number;
  sentMimeType: "image/jpeg";
  format: "jpeg";
  encoder: string;
  quality: number;
  maxEdgePx: number;
  maxBytes: number;
  scaleRatio: number | null;
  cleanup: () => Promise<void>;
};

export type VideoFrameSample = {
  positionPct: number;
  timestampSec: number;
};

export type PreparedEnrichmentVideoFrames = {
  frames: Array<PreparedEnrichmentImage & VideoFrameSample>;
  cleanup: () => Promise<void>;
};

export type PrepareEnrichmentImageOptions = {
  maxEdgePx?: number;
  quality?: number;
  maxBytes?: number;
  sourceWidthPx?: number;
  sourceHeightPx?: number;
  tempRoot?: string;
  abortSignal?: AbortSignal;
};

export type PrepareEnrichmentVideoFramesOptions = PrepareEnrichmentImageOptions & {
  durationSec: number;
};

export const VIDEO_ENRICHMENT_SAMPLE_PERCENTS = [15, 50, 85] as const;

export async function prepareEnrichmentImage(
  sourcePath: string,
  options: PrepareEnrichmentImageOptions = {}
): Promise<PreparedEnrichmentImage> {
  throwIfAborted(options.abortSignal);
  const maxEdgePx = options.maxEdgePx ?? DEFAULT_ENRICHMENT_IMAGE_MAX_EDGE_PX;
  const quality = options.quality ?? DEFAULT_ENRICHMENT_IMAGE_QUALITY;
  const maxBytes = options.maxBytes ?? DEFAULT_ENRICHMENT_IMAGE_MAX_BYTES;
  const tempParent = options.tempRoot ?? tmpdir();

  await mkdir(tempParent, { recursive: true });
  const workDir = await mkdtemp(join(tempParent, "pwrsnap-ai-"));
  const outputPath = join(workDir, "capture.jpg");

  try {
    const image = sharp(sourcePath, { limitInputPixels: 80_000_000 }).rotate();
    const metadata = await image.metadata();
    const width = metadata.width ?? options.sourceWidthPx ?? maxEdgePx;
    const height = metadata.height ?? options.sourceHeightPx ?? maxEdgePx;
    const longestEdge = Math.max(width, height);
    const resize =
      longestEdge > maxEdgePx
        ? {
            width: width >= height ? maxEdgePx : undefined,
            height: height > width ? maxEdgePx : undefined,
            fit: "inside" as const,
            withoutEnlargement: true
          }
        : undefined;

    await image
      .resize(resize)
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true })
      .toFile(outputPath);

    const outputMetadata = await sharp(outputPath).metadata();
    const outputStat = await stat(outputPath);
    if (outputStat.size > maxBytes) {
      throw new Error(
        `prepared enrichment image exceeds ${maxBytes} byte limit (${outputStat.size})`
      );
    }

    return {
      path: outputPath,
      sourceWidth: metadata.width ?? options.sourceWidthPx ?? null,
      sourceHeight: metadata.height ?? options.sourceHeightPx ?? null,
      sourceMimeType: metadata.format ? `image/${metadata.format}` : null,
      width: outputMetadata.width ?? 0,
      height: outputMetadata.height ?? 0,
      byteSize: outputStat.size,
      sentMimeType: "image/jpeg",
      format: "jpeg",
      encoder: "sharp mozjpeg",
      quality,
      maxEdgePx,
      maxBytes,
      scaleRatio: scaleRatio(width, height, outputMetadata.width ?? 0, outputMetadata.height ?? 0),
      cleanup: async () => {
        await rm(workDir, { force: true, recursive: true });
      }
    };
  } catch (error) {
    await rm(workDir, { force: true, recursive: true });
    throw error;
  }
}

export function getVideoFrameSamples(durationSec: number): VideoFrameSample[] {
  const safeDurationSec = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  return VIDEO_ENRICHMENT_SAMPLE_PERCENTS.map((positionPct) => ({
    positionPct,
    timestampSec: Number(((safeDurationSec * positionPct) / 100).toFixed(3))
  }));
}

export async function prepareEnrichmentVideoFrames(
  sourcePath: string,
  options: PrepareEnrichmentVideoFramesOptions
): Promise<PreparedEnrichmentVideoFrames> {
  throwIfAborted(options.abortSignal);
  const ffmpeg = resolveFfmpegPath();
  if (ffmpeg === null) {
    throw new Error(
      "ffmpeg binary not available; cannot prepare video frames for Codex enrichment"
    );
  }

  const maxEdgePx = options.maxEdgePx ?? DEFAULT_ENRICHMENT_IMAGE_MAX_EDGE_PX;
  const quality = options.quality ?? DEFAULT_ENRICHMENT_IMAGE_QUALITY;
  const maxBytes = options.maxBytes ?? DEFAULT_ENRICHMENT_IMAGE_MAX_BYTES;
  const tempParent = options.tempRoot ?? tmpdir();

  await mkdir(tempParent, { recursive: true });
  const workDir = await mkdtemp(join(tempParent, "pwrsnap-ai-video-"));
  const samples = getVideoFrameSamples(options.durationSec);

  try {
    const frames: PreparedEnrichmentVideoFrames["frames"] = [];
    for (const [index, sample] of samples.entries()) {
      const outputPath = join(workDir, `frame-${index + 1}.jpg`);
      await extractVideoFrame(
        ffmpeg,
        sourcePath,
        outputPath,
        sample.timestampSec,
        options.abortSignal === undefined
          ? { maxEdgePx, quality }
          : { maxEdgePx, quality, abortSignal: options.abortSignal }
      );
      const outputMetadata = await sharp(outputPath).metadata();
      const outputStat = await stat(outputPath);
      if (outputStat.size > maxBytes) {
        throw new Error(
          `prepared enrichment video frame exceeds ${maxBytes} byte limit (${outputStat.size})`
        );
      }
      frames.push({
        ...sample,
        path: outputPath,
        sourceWidth: options.sourceWidthPx ?? null,
        sourceHeight: options.sourceHeightPx ?? null,
        sourceMimeType: null,
        width: outputMetadata.width ?? 0,
        height: outputMetadata.height ?? 0,
        byteSize: outputStat.size,
        sentMimeType: "image/jpeg",
        format: "jpeg",
        encoder: "ffmpeg mjpeg",
        quality,
        maxEdgePx,
        maxBytes,
        scaleRatio:
          options.sourceWidthPx === undefined || options.sourceHeightPx === undefined
            ? null
            : scaleRatio(
                options.sourceWidthPx,
                options.sourceHeightPx,
                outputMetadata.width ?? 0,
                outputMetadata.height ?? 0
              ),
        cleanup: async () => {
          await rm(workDir, { force: true, recursive: true });
        }
      });
    }

    return {
      frames,
      cleanup: async () => {
        await rm(workDir, { force: true, recursive: true });
      }
    };
  } catch (error) {
    await rm(workDir, { force: true, recursive: true });
    throw error;
  }
}

async function extractVideoFrame(
  ffmpeg: string,
  sourcePath: string,
  outputPath: string,
  timestampSec: number,
  options: { maxEdgePx: number; quality: number; abortSignal?: AbortSignal }
): Promise<void> {
  throwIfAborted(options.abortSignal);
  const args = [
    "-y",
    "-ss",
    timestampSec.toFixed(3),
    "-i",
    sourcePath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${options.maxEdgePx}:${options.maxEdgePx}:force_original_aspect_ratio=decrease`,
    "-q:v",
    qualityToFfmpegQscale(options.quality).toString(),
    outputPath
  ];
  await runFfmpeg(ffmpeg, args, options.abortSignal);
}

function qualityToFfmpegQscale(quality: number): number {
  const clamped = Math.max(1, Math.min(100, quality));
  return Math.max(2, Math.min(31, Math.round(31 - (clamped / 100) * 29)));
}

function scaleRatio(
  sourceWidth: number,
  sourceHeight: number,
  sentWidth: number,
  sentHeight: number
): number | null {
  const sourceLongest = Math.max(sourceWidth, sourceHeight);
  const sentLongest = Math.max(sentWidth, sentHeight);
  if (sourceLongest <= 0 || sentLongest <= 0) return null;
  return Number((sentLongest / sourceLongest).toFixed(6));
}

function runFfmpeg(ffmpeg: string, args: string[], abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener("abort", abortHandler);
      if (error) reject(error);
      else resolve();
    };

    const abortHandler = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* process may already have exited */
      }
      settle(new DOMException("video frame extraction aborted", "AbortError"));
    };

    abortSignal?.addEventListener("abort", abortHandler, { once: true });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => settle(error));
    child.on("exit", (code) => {
      if (settled) return;
      if (code === 0) settle();
      else settle(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });

    if (abortSignal?.aborted) {
      abortHandler();
    }
  });
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new DOMException("enrichment image preparation aborted", "AbortError");
  }
}
