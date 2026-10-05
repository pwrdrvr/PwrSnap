import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AvatarStyleSchema,
  DEFAULT_AVATAR_STYLE,
  type AvatarStyle,
  type CaptureRecord,
  type CameraTrackMetadata,
} from "@pwrsnap/shared";
import { getCacheRoot } from "../persistence/paths";
import { runGatedCacheWrite } from "../persistence/derived-cache-gate";
import { resolveFfmpegPath } from "./ffmpeg-resolver";
import { resolveCameraSource } from "./camera-track-store";
import { CameraWorker } from "./camera-worker";

const MODEL_REVISION = "mediapipe-landscape-490e9ea7-v1";
const FPS = 15;
export type AvatarCanvas = { width: number; height: number };
export function avatarCacheKey(
  record: CaptureRecord,
  style: AvatarStyle = record.video?.avatar ?? DEFAULT_AVATAR_STYLE,
  canvas?: AvatarCanvas,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        MODEL_REVISION,
        record.sha256,
        record.video?.camera,
        style,
        canvas,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
}
const encoder = () =>
  process.platform === "darwin"
    ? "h264_videotoolbox"
    : process.platform === "win32"
      ? "h264_mf"
      : "mpeg4";
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
function ffmpegRun(args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  const binary = resolveFfmpegPath();
  if (!binary) throw new Error("FFmpeg is required to export the presenter.");
  const child = spawn(
    binary,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { stdio: ["pipe", "ignore", "pipe"], windowsHide: true },
  );
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + String(bytes)).slice(-2000);
  });
  const abort = () => child.kill("SIGKILL");
  signal.addEventListener("abort", abort, { once: true });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted)
        reject(new DOMException("Presenter export cancelled", "AbortError"));
      else if (code !== 0)
        reject(new Error(`Presenter video processing failed: ${stderr}`));
      else resolve();
    });
  });
  void done.catch(() => undefined);
  child.stdin.on("error", () => undefined);
  return { child, done };
}

/** RGB and grayscale alpha travel in one opaque H.264 cache file. */
async function prepareMask(
  record: CaptureRecord,
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  const camera = record.video!.camera!;
  const path = join(
    directory,
    `avatar-mask-${MODEL_REVISION}-${camera.sha256.slice(0, 16)}.mp4`,
  );
  return runGatedCacheWrite(
    record.id,
    `mask-${camera.sha256}-${MODEL_REVISION}`,
    async (cacheSignal) => {
      signal = AbortSignal.any([signal, cacheSignal]);
      signal.throwIfAborted();
      if (await exists(path)) return path;
      const worker = new CameraWorker();
      const staging = `${path}.partial.mp4`;
      const width = Math.min(640, Math.floor(camera.width / 2) * 2);
      const height = Math.max(
        2,
        Math.round((width * camera.height) / camera.width / 2) * 2,
      );
      const abort = () => worker.close();
      signal.addEventListener("abort", abort, { once: true });
      let run: ReturnType<typeof ffmpegRun> | undefined;
      try {
        await worker.load();
        await worker.call("open", `pwrsnap-capture://c/${record.id}`);
        run = ffmpegRun(
          [
            "-f",
            "image2pipe",
            "-framerate",
            String(FPS),
            "-i",
            "pipe:0",
            "-an",
            "-c:v",
            encoder(),
            "-b:v",
            "8M",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            staging,
          ],
          signal,
        );
        const frames = Math.max(1, Math.ceil(camera.durationSec * FPS));
        for (let i = 0; i < frames; i++) {
          signal.throwIfAborted();
          const png = await worker.call<string>(
            "frame",
            Math.min(i / FPS, camera.durationSec - 0.001),
            width,
            height,
          );
          const stdin = run.child.stdin;
          await new Promise<void>((resolve, reject) =>
            stdin.write(Buffer.from(png, "base64"), (error) =>
              error ? reject(error) : resolve(),
            ),
          );
        }
        run.child.stdin.end();
        await run.done;
        signal.throwIfAborted();
        await writeFile(
          `${path}.json`,
          JSON.stringify({
            modelId: "mediapipe/selfie_segmenter_landscape",
            revision: MODEL_REVISION,
            licenseId: "Apache-2.0",
            cameraSha256: camera.sha256,
            fps: FPS,
            width,
            height,
            format: "rgb-left-confidence-right",
            confidenceEncoding: "lossy-preview-mask",
          }),
        );
        await rename(staging, path);
        return path;
      } finally {
        signal.removeEventListener("abort", abort);
        worker.close();
        if (run && run.child.exitCode === null) {
          run.child.kill("SIGKILL");
          await run.done.catch(() => undefined);
        }
        await rm(staging, { force: true });
      }
    },
  );
}

export function avatarCompositionFilter(input: {
  camera: CameraTrackMetadata;
  style: AvatarStyle;
  width: number;
  height: number;
  normalizeScreen?: boolean;
}): string {
  const { camera, style, width, height } = input;
  const crop = style.crop;
  const targetWidth = Math.max(2, Math.round((width * style.width) / 2) * 2);
  const offsetSec = camera.offsetSec + (style.syncOffsetSec ?? 0);
  const timing = `trim=start=${Math.max(0, -offsetSec).toFixed(6)},setpts=PTS-STARTPTS+${Math.max(0, offsetSec).toFixed(6)}/TB`;
  const layers =
    style.background === "remove"
      ? `[1:v]split=2[color][mask];[color]crop=iw/2:ih:0:0[rgb];[mask]crop=iw/2:ih:iw/2:0,format=gray[alpha];[rgb][alpha]alphamerge[person];`
      : `[1:v]format=rgba[person];`;
  const screen = input.normalizeScreen
    ? `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[screen];`
    : "";
  return (
    screen +
    layers +
    `[person]${timing},crop=iw*${crop.width}:ih*${crop.height}:iw*${crop.x}:ih*${crop.y},` +
    `${style.mirror ? "hflip," : ""}scale=${targetWidth}:-2[avatar];` +
    `${input.normalizeScreen ? "[screen]" : "[0:v]"}[avatar]overlay=x=${Math.round(width * style.x)}:y=${Math.round(height * style.y)}:eof_action=pass:repeatlast=0:shortest=0,format=yuv420p[out]`
  );
}

/** Compose in source time, before the existing trim/cut/speed machinery. */
export async function prepareAvatarVideo(
  record: CaptureRecord,
  override?: AvatarStyle,
  callerSignal?: AbortSignal,
  canvas?: AvatarCanvas,
): Promise<string> {
  const source = record.legacy_src_path;
  if (!source) throw new Error("Recording source missing");
  const camera = record.video?.camera;
  const style = AvatarStyleSchema.parse(
    override ?? record.video?.avatar ?? DEFAULT_AVATAR_STYLE,
  );
  if (!camera || !style.visible) return source;
  const offset = camera.offsetSec + (style.syncOffsetSec ?? 0);
  if (offset + camera.durationSec <= 0 || offset >= record.video!.durationSec)
    return source;
  const key = avatarCacheKey(record, style, canvas);
  return runGatedCacheWrite(record.id, `avatar-${key}`, async (cacheSignal) => {
    const signal = callerSignal
      ? AbortSignal.any([cacheSignal, callerSignal])
      : cacheSignal;
    const directory = join(getCacheRoot(), "video", record.id);
    const path = join(directory, `avatar-${key}.mp4`);
    if (await exists(path)) return path;
    await mkdir(directory, { recursive: true });
    const cameraSource =
      style.background === "remove"
        ? await prepareMask(record, directory, signal)
        : await resolveCameraSource(source, record.id);
    if (!cameraSource) throw new Error("The original camera track is missing.");
    const staging = `${path}.partial.mp4`;
    try {
      const run = ffmpegRun(
        [
          "-i",
          source,
          "-i",
          cameraSource,
          "-filter_complex",
          avatarCompositionFilter({
            camera,
            style,
            width: canvas?.width ?? record.width_px,
            height: canvas?.height ?? record.height_px,
            normalizeScreen: canvas !== undefined,
          }),
          "-map",
          "[out]",
          "-map",
          "0:a?",
          "-c:a",
          "copy",
          "-c:v",
          encoder(),
          "-b:v",
          "12M",
          "-t",
          String(record.video!.durationSec),
          "-movflags",
          "+faststart",
          staging,
        ],
        signal,
      );
      run.child.stdin.end();
      await run.done;
      signal.throwIfAborted();
      await rename(staging, path);
      return path;
    } finally {
      await rm(staging, { force: true });
    }
  });
}
