import "../sharp-wasm-steer";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  stat,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import {
  resolveSizzleScene,
  sizzleSceneSvg,
  sizzleTimelineFrames,
  type SizzleTimeline,
  type SizzleAsset,
} from "@pwrsnap/shared";
import { timelineAssetPath, timelineImageData } from "./timeline-assets";
import { timelineProcess } from "./timeline-process";

export const TIMELINE_RENDER_VERSION = 1;
export type TimelineRenderRequest = {
  timeline: SizzleTimeline;
  assets: SizzleAsset[];
  assetsRoot: string;
  cacheRoot: string;
  ffmpeg: string;
  platform: "darwin" | "win32";
  width: number;
  height: number;
  outputPath: string;
  audioPath?: string;
  frames?: number[];
};
export type TimelineRenderResult = {
  outputPath: string;
  widthPx: number;
  heightPx: number;
  frames: number;
  cachedScenes: number;
  renderedScenes: number;
};

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exists = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => null))?.isFile() ?? false;

export function timelineSceneCacheKey(
  request: Pick<
    TimelineRenderRequest,
    "timeline" | "width" | "height" | "platform"
  >,
  scene: SizzleTimeline["scenes"][number],
): string {
  return hash({
    version: TIMELINE_RENDER_VERSION,
    scene: resolveSizzleScene(scene, request.timeline.bindings),
    width: request.width,
    height: request.height,
    canvasWidth: request.timeline.width,
    canvasHeight: request.timeline.height,
    fps: request.timeline.fps,
    platform: request.platform,
  });
}

/** Vetted OS encoders, matching the existing reel export's license boundary. */
export function timelineEncoder(platform: "darwin" | "win32"): string[] {
  return platform === "darwin"
    ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1"]
    : ["-c:v", "h264_mf"];
}

type SceneMedia = {
  images: Map<string, string>;
  videos: Map<
    string,
    { directory: string; count: number; loop: boolean; startFrame: number }
  >;
};

async function prepareSceneMedia(
  request: TimelineRenderRequest,
  scene: SizzleTimeline["scenes"][number],
  scratch: string,
  signal?: AbortSignal,
): Promise<SceneMedia> {
  const images = new Map<string, string>();
  const videos = new Map<
    string,
    { directory: string; count: number; loop: boolean; startFrame: number }
  >();
  const byId = new Map(request.assets.map((asset) => [asset.id, asset]));
  for (const layer of scene.layers) {
    signal?.throwIfAborted();
    if (layer.kind !== "image" && layer.kind !== "video") continue;
    const asset = byId.get(layer.assetId);
    if (!asset || asset.kind !== layer.kind)
      throw new Error(`Missing ${layer.kind} asset for ${layer.id}`);
    if (layer.kind === "image")
      images.set(layer.id, await timelineImageData(request.assetsRoot, asset));
    else {
      if (layer.sourceStartSec >= asset.durationSec)
        throw new Error(`Video starts past source end: ${layer.id}`);
      const directory = join(scratch, layer.id);
      await mkdir(directory, { recursive: true });
      const count = Math.max(
        1,
        Math.min(
          (layer.endFrame ?? scene.durationFrames) - layer.startFrame,
          Math.ceil(
            ((asset.durationSec - layer.sourceStartSec) / layer.playbackRate) *
              request.timeline.fps,
          ),
        ),
      );
      const maxWidth = Math.max(
        2,
        Math.min(
          request.width,
          Math.ceil(
            ((layer.width * request.width) / request.timeline.width) *
              Math.max(layer.zoomFrom, layer.zoomTo),
          ),
        ),
      );
      const maxHeight = Math.max(
        2,
        Math.min(
          request.height,
          Math.ceil(
            ((layer.height * request.height) / request.timeline.height) *
              Math.max(layer.zoomFrom, layer.zoomTo),
          ),
        ),
      );
      await timelineProcess(
        request.ffmpeg,
        [
          "-hide_banner",
          "-y",
          "-protocol_whitelist",
          "file,pipe",
          "-ss",
          String(layer.sourceStartSec),
          "-i",
          timelineAssetPath(request.assetsRoot, asset),
          "-an",
          "-vf",
          `setpts=(PTS-STARTPTS)/${layer.playbackRate},fps=${request.timeline.fps},scale=${maxWidth}:${maxHeight}:force_original_aspect_ratio=decrease`,
          "-frames:v",
          String(count),
          "-q:v",
          "2",
          join(directory, "%06d.jpg"),
        ],
        signal,
      );
      const files = (await readdir(directory)).filter((file) =>
        /^\d{6}\.jpg$/.test(file),
      );
      if (!files.length)
        throw new Error(`Video yielded no frames: ${layer.id}`);
      videos.set(layer.id, {
        directory,
        count: files.length,
        loop: layer.endBehavior === "loop",
        startFrame: layer.startFrame,
      });
    }
  }
  return { images, videos };
}

async function sceneFrame(
  request: TimelineRenderRequest,
  scene: SizzleTimeline["scenes"][number],
  frame: number,
  media: SceneMedia,
): Promise<Buffer> {
  const images = new Map(media.images);
  for (const [id, video] of media.videos) {
    const local = Math.max(0, frame - video.startFrame);
    const index =
      (video.loop ? local % video.count : Math.min(local, video.count - 1)) + 1;
    images.set(
      id,
      `data:image/jpeg;base64,${(await readFile(join(video.directory, `${String(index).padStart(6, "0")}.jpg`))).toString("base64")}`,
    );
  }
  const svg = sizzleSceneSvg({
    scene,
    frame,
    width: request.timeline.width,
    height: request.timeline.height,
    outputWidth: request.width,
    outputHeight: request.height,
    media: images,
  });
  return sharp(Buffer.from(svg), { limitInputPixels: 40_000_000 })
    .png()
    .toBuffer();
}

export async function renderSizzleTimeline(
  request: TimelineRenderRequest,
  signal?: AbortSignal,
  progress?: (ratio: number) => void,
): Promise<TimelineRenderResult> {
  const totalFrames = sizzleTimelineFrames(request.timeline);
  const scratch = join(request.cacheRoot, `.render-${randomUUID()}`);
  await mkdir(scratch, { recursive: true });
  let cachedScenes = 0,
    renderedScenes = 0;
  try {
    if (request.frames) {
      if (
        !request.frames.length ||
        request.frames.length > 12 ||
        request.frames.some(
          (f) => !Number.isInteger(f) || f < 0 || f >= totalFrames,
        )
      )
        throw new Error(
          "Inspection frames must lie within the timeline (maximum 12)",
        );
      const thumbs: Buffer[] = [];
      const prepared = new Map<string, SceneMedia>();
      for (const frame of request.frames) {
        signal?.throwIfAborted();
        let start = 0;
        const raw = request.timeline.scenes.find((scene) => {
          if (frame < start + scene.durationFrames) return true;
          start += scene.durationFrames;
          return false;
        })!;
        const scene = resolveSizzleScene(raw, request.timeline.bindings);
        let media = prepared.get(scene.id);
        if (!media) {
          media = await prepareSceneMedia(
            request,
            scene,
            join(scratch, scene.id),
            signal,
          );
          prepared.set(scene.id, media);
        }
        thumbs.push(await sceneFrame(request, scene, frame - start, media));
      }
      const columns = Math.min(3, thumbs.length),
        rows = Math.ceil(thumbs.length / columns);
      const png = await sharp({
        create: {
          width: request.width * columns,
          height: request.height * rows,
          channels: 4,
          background: "#000000",
        },
      })
        .composite(
          thumbs.map((input, i) => ({
            input,
            left: (i % columns) * request.width,
            top: Math.floor(i / columns) * request.height,
          })),
        )
        .png()
        .toBuffer();
      const temporary = join(scratch, "inspection.png");
      await writeFile(temporary, png);
      await rename(temporary, request.outputPath);
      return {
        outputPath: request.outputPath,
        widthPx: request.width * columns,
        heightPx: request.height * rows,
        frames: thumbs.length,
        cachedScenes,
        renderedScenes,
      };
    }

    const segments: string[] = [];
    let completedFrames = 0;
    for (const raw of request.timeline.scenes) {
      signal?.throwIfAborted();
      const key = timelineSceneCacheKey(request, raw);
      const segment = join(request.cacheRoot, `${key}.mp4`);
      segments.push(segment);
      if (await exists(segment)) cachedScenes++;
      else {
        const scene = resolveSizzleScene(raw, request.timeline.bindings);
        const directory = join(scratch, scene.id);
        await mkdir(directory, { recursive: true });
        const media = await prepareSceneMedia(
          request,
          scene,
          directory,
          signal,
        );
        for (let frame = 0; frame < scene.durationFrames; frame++) {
          signal?.throwIfAborted();
          await writeFile(
            join(directory, `f${String(frame).padStart(6, "0")}.png`),
            await sceneFrame(request, scene, frame, media),
          );
          progress?.(((completedFrames + frame + 1) / totalFrames) * 0.9);
        }
        const pending = join(directory, "segment.mp4");
        await timelineProcess(
          request.ffmpeg,
          [
            "-hide_banner",
            "-y",
            "-framerate",
            String(request.timeline.fps),
            "-i",
            join(directory, "f%06d.png"),
            "-frames:v",
            String(scene.durationFrames),
            ...timelineEncoder(request.platform),
            "-b:v",
            String(
              Math.max(
                2_000_000,
                request.width * request.height * request.timeline.fps * 0.12,
              ),
            ),
            "-pix_fmt",
            "yuv420p",
            "-g",
            String(request.timeline.fps * 2),
            "-video_track_timescale",
            "60000",
            "-movflags",
            "+faststart",
            pending,
          ],
          signal,
        );
        await rename(pending, segment);
        renderedScenes++;
        await rm(directory, { recursive: true, force: true });
      }
      completedFrames += raw.durationFrames;
      progress?.((completedFrames / totalFrames) * 0.9);
    }
    // The list uses generated local names and FFmpeg's safe concat parser.
    // Copy into scratch as ordinal aliases, so neither paths nor quote escaping
    // enter the concat grammar (Windows drive paths included).
    const { copyFile } = await import("node:fs/promises");
    for (let i = 0; i < segments.length; i++)
      await copyFile(segments[i]!, join(scratch, `${i}.mp4`));
    await writeFile(
      join(scratch, "segments.txt"),
      segments.map((_, i) => `file '${i}.mp4'`).join("\n"),
    );
    const pending = join(scratch, "final.mp4");
    const args = [
      "-hide_banner",
      "-y",
      "-f",
      "concat",
      "-safe",
      "1",
      "-i",
      join(scratch, "segments.txt"),
    ];
    if (request.audioPath) args.push("-i", request.audioPath);
    else args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
    args.push(
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-t",
      String(totalFrames / request.timeline.fps),
      "-movflags",
      "+faststart",
      pending,
    );
    await timelineProcess(request.ffmpeg, args, signal);
    // Export paths can be on another volume. A unique adjacent staging file
    // keeps the previous successful movie intact until the new one is whole.
    const adjacent = `${request.outputPath}.${randomUUID()}.partial`;
    try {
      await copyFile(pending, adjacent);
      signal?.throwIfAborted();
      await rename(adjacent, request.outputPath);
    } finally {
      await rm(adjacent, { force: true });
    }
    progress?.(1);
    return {
      outputPath: request.outputPath,
      widthPx: request.width,
      heightPx: request.height,
      frames: totalFrames,
      cachedScenes,
      renderedScenes,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
