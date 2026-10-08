import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AvatarStyleSchema,
  DEFAULT_AVATAR_STYLE,
  geometryFor,
  presenterCornerRadius,
  presenterMaskRamp,
  resolvePresenterStyle,
  type AvatarStyle,
  type CaptureRecord,
  type CameraTrackMetadata,
} from "@pwrsnap/shared";
import { getCacheRoot } from "../persistence/paths";
import { runGatedCacheWrite } from "../persistence/derived-cache-gate";
import { resolveFfmpegPath } from "./ffmpeg-resolver";
import { resolveCameraSource } from "./camera-track-store";
import { CameraWorker } from "./camera-worker";
import { getRuntimeProcessRole } from "../process-role";

const MODEL_REVISION = "mediapipe-landscape-490e9ea7-v1";
const FPS = 15;
export type AvatarCanvas = { width: number; height: number };

/** The presenter a recording renders with on `canvas` (the recording's own
 *  frame when omitted): the stored style, or the default for this camera. */
export function resolveRecordPresenter(
  record: CaptureRecord,
  override?: AvatarStyle | null,
  canvas?: AvatarCanvas,
): AvatarStyle {
  const camera = record.video?.camera;
  const stored = override ?? record.video?.avatar;
  if (!camera) return stored ?? DEFAULT_AVATAR_STYLE;
  return resolvePresenterStyle(
    stored,
    geometryFor(camera, canvas ?? { width: record.width_px, height: record.height_px }),
  );
}

/** One presenter over a window of SOURCE time; no window = everywhere
 *  the spans do not cover. */
export type PresenterLayerSpan = { start: number; end: number; style: AvatarStyle };
export type PresenterLayers = { base: AvatarStyle; spans: PresenterLayerSpan[] };

/**
 * Everything a recording's presenter does over the take: the recording's
 * own presenter and each span's. A reel scene's `override` replaces the
 * lot — a scene with its own presenter shows it throughout.
 */
export function presenterLayersFor(
  record: CaptureRecord,
  override?: AvatarStyle | null,
  canvas?: AvatarCanvas,
): PresenterLayers {
  const base = resolveRecordPresenter(record, override, canvas);
  if (override) return { base, spans: [] };
  const camera = record.video?.camera;
  const spans = (record.video?.avatarSpans ?? []).map((span) => ({
    start: span.start,
    end: span.end,
    style: camera
      ? resolvePresenterStyle(
          span.avatar,
          geometryFor(camera, canvas ?? { width: record.width_px, height: record.height_px }),
        )
      : span.avatar,
  }));
  return { base, spans };
}

export function avatarCacheKey(
  record: CaptureRecord,
  layers: PresenterLayers = presenterLayersFor(record),
  canvas?: AvatarCanvas,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        MODEL_REVISION,
        record.sha256,
        record.video?.camera,
        // A recording with no spans hashes exactly as before spans existed,
        // so its cached composition is still found.
        layers.spans.length === 0 ? layers.base : layers,
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
  callerSignal: AbortSignal,
): Promise<string> {
  const camera = record.video!.camera!;
  const path = join(
    directory,
    `avatar-mask-${MODEL_REVISION}-${camera.sha256.slice(0, 16)}.mp4`,
  );
  return runGatedCacheWrite(
    record.id,
    `mask-${camera.sha256}-${MODEL_REVISION}`,
    async (signal) => {
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
    callerSignal,
  );
}

export function avatarCompositionFilter(input: {
  camera: CameraTrackMetadata;
  style: AvatarStyle;
  width: number;
  height: number;
  normalizeScreen?: boolean;
  /** Stretches with their own presenter; `style` shows everywhere else. */
  spans?: readonly PresenterLayerSpan[];
  /** Input indexes of the cut-out mask video and the original camera.
   *  Default: input 1 for whichever the presenters need, then input 2. */
  inputs?: { mask?: number; camera?: number };
}): string {
  const { camera, width, height } = input;
  const spans = input.spans ?? [];
  const window = (span: PresenterLayerSpan): string =>
    `gte(t,${span.start.toFixed(3)})*lt(t,${span.end.toFixed(3)})`;
  const layers = [
    {
      style: input.style,
      trim: null as PresenterLayerSpan | null,
      enable: spans.length === 0 ? null : `not(${spans.map(window).join("+")})`,
    },
    ...spans.map((span) => ({ style: span.style, trim: span, enable: window(span) })),
  ].filter((layer) => layer.style.visible);
  const screenIn = input.normalizeScreen ? "[screen]" : "[0:v]";
  const screen = input.normalizeScreen
    ? `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[screen];`
    : "";
  if (layers.length === 0) return `${screen}${screenIn}format=yuv420p[out]`;

  const needsMask = layers.some((layer) => layer.style.background === "remove");
  const maskIn = input.inputs?.mask ?? 1;
  const cameraIn = input.inputs?.camera ?? (needsMask ? 2 : 1);
  const sourceOf = (style: AvatarStyle): number => (style.background === "remove" ? maskIn : cameraIn);
  const users = new Map<number, number>();
  for (const layer of layers) users.set(sourceOf(layer.style), (users.get(sourceOf(layer.style)) ?? 0) + 1);
  const taken = new Map<number, number>();
  let graph = screen;
  for (const [index, count] of users) {
    graph +=
      count === 1
        ? `[${index}:v]null[src${index}_0];`
        : `[${index}:v]split=${count}${Array.from({ length: count }, (_, k) => `[src${index}_${k}]`).join("")};`;
  }

  let current = screenIn;
  layers.forEach((layer, k) => {
    const { style } = layer;
    const index = sourceOf(style);
    const n = taken.get(index) ?? 0;
    taken.set(index, n + 1);
    const src = `[src${index}_${n}]`;
    const crop = style.crop;
    const targetWidth = Math.max(2, Math.round((width * style.width) / 2) * 2);
    const offsetSec = camera.offsetSec + (style.syncOffsetSec ?? 0);
    const timing =
      `trim=start=${Math.max(0, -offsetSec).toFixed(6)},setpts=PTS-STARTPTS+${Math.max(0, offsetSec).toFixed(6)}/TB` +
      // A span's presenter is only ever shown inside its window, so it
      // need not be scaled and masked for the rest of the take.
      (layer.trim === null ? "" : `,trim=start=${layer.trim.start.toFixed(3)}:end=${layer.trim.end.toFixed(3)}`);
    graph +=
      style.background === "remove"
        ? `${src}split=2[color${k}][mask${k}];[color${k}]crop=iw/2:ih:0:0[rgb${k}];[mask${k}]crop=iw/2:ih:iw/2:0,format=gray${presenterEdgeFilter(style)}[alpha${k}];[rgb${k}][alpha${k}]alphamerge[person${k}];`
        : `${src}format=rgba[person${k}];`;
    const shape = style.background === "remove" ? "" : presenterShapeFilter(style);
    graph +=
      `[person${k}]${timing},crop=iw*${crop.width}:ih*${crop.height}:iw*${crop.x}:ih*${crop.y},` +
      `${style.mirror ? "hflip," : ""}scale=${targetWidth}:-2${shape}[avatar${k}];`;
    const next = `[stage${k}]`;
    graph +=
      `${current}[avatar${k}]overlay=x=${Math.round(width * style.x)}:y=${Math.round(height * style.y)}:eof_action=pass:repeatlast=0:shortest=0` +
      `${layer.enable === null ? "" : `:enable='${layer.enable}'`}${next};`;
    current = next;
  });
  return `${graph}${current}format=yuv420p[out]`;
}

/**
 * The cut-out's edge ramp (`presenterMaskRamp`) over the confidence mask,
 * the curve the stage applies per pixel. Empty at edge 0, where the mask
 * is used as the model wrote it.
 */
export function presenterEdgeFilter(style: AvatarStyle): string {
  const { low, high } = presenterMaskRamp(style);
  if (low <= 0 && high >= 1) return "";
  const l = (low * 255).toFixed(2);
  const span = ((high - low) * 255).toFixed(2);
  return `,lut=c0='clip((val-${l})*255/${span},0,255)'`;
}

/**
 * The outline of a presenter that keeps its background, as an alpha
 * mask over the scaled frame. Anti-aliased over one pixel so the export's
 * edge matches the stage's CSS `border-radius`. The radius comes from
 * `presenterCornerRadius`, the same number the stage uses.
 */
export function presenterShapeFilter(style: AvatarStyle): string {
  if (style.shape !== "circle" && style.shape !== "rounded") return "";
  const ratio = style.shape === "circle" ? 0.5 : presenterCornerRadius("rounded");
  const r = `(${ratio}*min(W,H))`;
  const dx = `max(abs(X+0.5-W/2)-(W/2-${r}),0)`;
  const dy = `max(abs(Y+0.5-H/2)-(H/2-${r}),0)`;
  const alpha = `255*clip(${r}-hypot(${dx},${dy})+0.5,0,1)`;
  return `,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'`;
}

/** Compose in source time, before the existing trim/cut/speed machinery. */
export async function prepareAvatarVideo(
  record: CaptureRecord,
  override?: AvatarStyle,
  callerSignal?: AbortSignal,
  canvas?: AvatarCanvas,
): Promise<string> {
  if (getRuntimeProcessRole() === "library") {
    throw new Error("Presenter preparation must run in the video cache owner.");
  }
  callerSignal?.throwIfAborted();
  const source = record.legacy_src_path;
  if (!source) throw new Error("Recording source missing");
  const camera = record.video?.camera;
  const layers = presenterLayersFor(record, override, canvas);
  const base = AvatarStyleSchema.parse(layers.base);
  const shown = [base, ...layers.spans.map((span) => span.style)].filter((style) => style.visible);
  if (!camera || shown.length === 0) return source;
  // Nothing to draw when no visible presenter's camera overlaps the take.
  const overlaps = shown.some((style) => {
    const offset = camera.offsetSec + (style.syncOffsetSec ?? 0);
    return offset + camera.durationSec > 0 && offset < record.video!.durationSec;
  });
  if (!overlaps) return source;
  const key = avatarCacheKey(record, layers, canvas);
  return runGatedCacheWrite(record.id, `avatar-${key}`, async (signal) => {
    const directory = join(getCacheRoot(), "video", record.id);
    const path = join(directory, `avatar-${key}.mp4`);
    if (await exists(path)) return path;
    await mkdir(directory, { recursive: true });
    const needsMask = shown.some((style) => style.background === "remove");
    const needsCamera = shown.some((style) => style.background !== "remove");
    const maskSource = needsMask ? await prepareMask(record, directory, signal) : null;
    const cameraSource = needsCamera ? await resolveCameraSource(source, record.id) : null;
    if (needsCamera && !cameraSource) throw new Error("The original camera track is missing.");
    const inputs = [source, ...(maskSource ? [maskSource] : []), ...(cameraSource ? [cameraSource] : [])];
    const staging = `${path}.partial.mp4`;
    try {
      const run = ffmpegRun(
        [
          ...inputs.flatMap((file) => ["-i", file]),
          "-filter_complex",
          avatarCompositionFilter({
            camera,
            style: base,
            spans: layers.spans,
            width: canvas?.width ?? record.width_px,
            height: canvas?.height ?? record.height_px,
            normalizeScreen: canvas !== undefined,
            inputs: {
              ...(maskSource ? { mask: 1 } : {}),
              ...(cameraSource ? { camera: maskSource ? 2 : 1 } : {}),
            },
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
  }, callerSignal);
}
