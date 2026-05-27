import { spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SIZZLE_CROSSFADE_SEC, type SizzleTransition } from "@pwrsnap/shared";
import { resolveFfmpegPath } from "../recording/ffmpeg-resolver";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:sizzle-composer");

/**
 * Per-scene input descriptor. Discriminated by `kind`:
 *
 *   - "image": single PNG/JPEG frame, rendered with zoompan ken-burns.
 *   - "video": trimmed video clip, no zoompan (the video already
 *      has motion). `startSec` + `durationSec` apply as `-ss start -t
 *      duration` on the input side.
 *
 * Both shapes carry an `audioPath` — the composer treats it as a
 * black-box mp3/m4a that's already the right length for the scene.
 * The handler decides whether it's a TTS voiceover, the video's
 * extracted native audio, or a synthesized silent stretch.
 *
 * `transition` describes the transition INTO this scene from the
 * previous one. Ignored on scene 0 (nothing precedes it).
 */
export type ImageSceneInput = {
  kind: "image";
  imagePath: string;
  audioPath: string;
  durationSec: number;
  transition: SizzleTransition;
};

export type VideoSceneInput = {
  kind: "video";
  videoPath: string;
  /** Trim start in the source file, seconds. Passed to ffmpeg as
   *  `-ss` BEFORE `-i` so seeking is fast. */
  startSec: number;
  /** Trim length in seconds — how much of the source clip plays
   *  before the freeze-frame extension (if any) takes over. Passed
   *  as `-t` BEFORE `-i` so the decoder stops at this duration. */
  trimDurationSec: number;
  /** Total visible duration the scene occupies in the output reel,
   *  i.e. `trimDurationSec + freeze-frame extension`. When this is
   *  > `trimDurationSec` (voiceover longer than the video clip), the
   *  composer appends `tpad=stop_mode=clone` to hold the last frame
   *  for the remainder. When equal, no padding fires. */
  durationSec: number;
  audioPath: string;
  transition: SizzleTransition;
};

export type SceneInput = ImageSceneInput | VideoSceneInput;

export type ComposeRequest = {
  scenes: SceneInput[];
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  onProgress?: (ratio: number) => void;
  /** AbortSignal threaded from the bus's per-dispatch controller. On
   *  abort, the in-flight ffmpeg child gets SIGKILL and the compose
   *  promise rejects with a `cancelled` ComposeError. The temp audio-
   *  list file is cleaned up either way. */
  signal?: AbortSignal;
};

export class ComposeError extends Error {
  constructor(
    public readonly code:
      | "ffmpeg_missing"
      | "no_scenes"
      | "ffmpeg_failed"
      | "cancelled",
    message: string,
    public readonly details?: string
  ) {
    super(message);
    this.name = "ComposeError";
  }
}

export async function probeDurationSec(audioPath: string): Promise<number> {
  const ffmpeg = resolveFfmpegPath();
  if (ffmpeg === null) {
    throw new ComposeError("ffmpeg_missing", "ffmpeg binary not found");
  }
  return new Promise<number>((resolve, reject) => {
    let buf = "";
    const proc = spawn(ffmpeg, ["-hide_banner", "-i", audioPath, "-f", "null", "-"], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", () => {
      const match = buf.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
      if (match === null) {
        resolve(0);
        return;
      }
      const last = match[match.length - 1]!;
      const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(last);
      if (m === null) {
        resolve(0);
        return;
      }
      const h = Number(m[1]);
      const mn = Number(m[2]);
      const s = Number(m[3]);
      resolve(h * 3600 + mn * 60 + s);
    });
  });
}

/**
 * Build the ffmpeg args for a sizzle reel. Exposed for tests so they
 * can assert on the structure without invoking ffmpeg every run.
 *
 * Architecture:
 *
 * - Image scene input: bare `-i image` (single frame). zoompan with
 *   `d=N` time-stretches it to N output frames at fps. MUST NOT use
 *   `-loop 1` or `-framerate` — the input would become multi-frame
 *   and zoompan would emit N outputs PER input, overflowing.
 *
 * - Video scene input: `-ss startSec -t durationSec -i videoPath`.
 *   Input-side seek means ffmpeg fast-decodes only the trim range.
 *   No zoompan — the video has its own motion.
 *
 * - Each `[i:v]` is normalized into a fixed-shape stream — same
 *   resolution (output W×H), same pixfmt (yuv420p), same SAR (1:1),
 *   same framerate (fps). This is the precondition for `concat` and
 *   `xfade` chaining: they require homogeneous inputs.
 *
 * - **Image branch** scales to 4× output before zoompan so a 1-pixel
 *   crop step becomes a 1/4-pixel output step (invisible). Trunc-
 *   to-even forces deterministic rounding so the ken-burns motion is
 *   smooth and yuv420p chroma stays clean.
 *
 * - **Video branch** scales to output W×H with letterbox padding,
 *   forces fps + SAR + yuv420p. Cheap — the video already has motion
 *   and pixel detail, no need to round-trip through a higher canvas.
 *
 * - Boundaries between scenes are built as a left-fold over the
 *   scene list. For each pair (chain-so-far, next scene):
 *     • `transition: "crossfade"` → splice an `xfade` filter with
 *       SIZZLE_CROSSFADE_SEC overlap; the resulting chain duration
 *       shrinks by SIZZLE_CROSSFADE_SEC.
 *     • `transition: "cut"` → a 2-input `concat` (drops to a hard
 *       cut, no audio drift, chain duration is the sum).
 *
 * - Audio comes from the concat-demuxer input that follows the scene
 *   inputs. Audio sees only cuts — every scene's `audioPath` is
 *   stitched end-to-end. With crossfades the audio is ~SIZZLE_CROSSFADE_SEC
 *   per crossfade longer than video; `-shortest` truncates to the
 *   shorter, so the trailing silence at the end of the last audio
 *   gets clipped. Acceptable for narration-paced content; audio-side
 *   crossfade (`acrossfade`) is a future enhancement.
 *
 * - `-shortest` rounds total length to min(video, audio). Per-scene
 *   audio durations are tuned to match per-scene video durations
 *   (`measured + 0.35s` tail) so the trim is small.
 */
export function buildCompositionArgs(
  req: ComposeRequest,
  audioListPath: string
): string[] {
  const args: string[] = ["-y", "-hide_banner"];
  for (const scene of req.scenes) {
    if (scene.kind === "image") {
      // Single-frame input. zoompan time-stretches in the filter graph.
      args.push("-i", scene.imagePath);
    } else {
      // Input-side -ss + -t for fast trim. -ss must come BEFORE -i.
      // -t uses TRIM duration (not the final scene duration) so the
      // decoder stops at the source's natural end; freeze-frame
      // extension happens in the filter graph via tpad.
      args.push(
        "-ss",
        scene.startSec.toFixed(3),
        "-t",
        scene.trimDurationSec.toFixed(3),
        "-i",
        scene.videoPath
      );
    }
  }
  args.push("-f", "concat", "-safe", "0", "-i", audioListPath);

  const filters: string[] = [];

  // === Per-scene normalization filters ===
  req.scenes.forEach((scene, i) => {
    if (scene.kind === "image") {
      const nFrames = Math.max(2, Math.round(scene.durationSec * req.fps));
      const directionIn = i % 2 === 0;
      // Linear zoom across the scene: 1.0 → 1.10 (in) or 1.10 → 1.0 (out).
      const zoomExpr = directionIn
        ? `1.0+0.10*on/${nFrames}`
        : `1.10-0.10*on/${nFrames}`;
      const wScale = req.width * 4;
      const hScale = req.height * 4;
      // trunc((...)/4)*2 rounds the crop origin DOWN to the nearest
      // even pixel — deterministic rounding direction (no oscillation
      // across the .5 boundary) + yuv420p chroma alignment.
      const xExpr = `trunc((iw-iw/zoom)/4)*2`;
      const yExpr = `trunc((ih-ih/zoom)/4)*2`;
      filters.push(
        `[${i}:v]` +
          `scale=${wScale}:${hScale}:force_original_aspect_ratio=decrease,` +
          `pad=${wScale}:${hScale}:(ow-iw)/2:(oh-ih)/2:color=black,` +
          `zoompan=z='${zoomExpr}':` +
          `x='${xExpr}':y='${yExpr}':` +
          `d=${nFrames}:s=${req.width}x${req.height}:fps=${req.fps},` +
          `setsar=1,format=yuv420p[v${i}]`
      );
    } else {
      // Video: scale to fit, letterbox, force uniform fps + SAR +
      // pixfmt. If the scene's voiceover runs longer than the trim
      // (a common documentary-style situation), pad the tail by
      // cloning the last frame via `tpad`. The video freezes; the
      // voiceover keeps going underneath until the scene ends.
      const padSec = Math.max(0, scene.durationSec - scene.trimDurationSec);
      const tpadFilter =
        padSec > 0.05
          ? `,tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}`
          : "";
      filters.push(
        `[${i}:v]` +
          `scale=${req.width}:${req.height}:force_original_aspect_ratio=decrease,` +
          `pad=${req.width}:${req.height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
          `fps=${req.fps},setsar=1,format=yuv420p` +
          tpadFilter +
          `[v${i}]`
      );
    }
  });

  // === Build the transition chain ===
  // Left-fold over scenes: chain[0] = v0; for each next scene apply
  // its transition (xfade for crossfade, concat for cut). Final label
  // is `chainOut`.
  const finalLabel = buildTransitionChain(req.scenes, filters);
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    `[${finalLabel}]`,
    "-map",
    `${req.scenes.length}:a:0`,
    // h264_videotoolbox: macOS-native hardware H.264 encoder. NOT
    // libx264 (GPL — issue #127 tracks switching the bundled binary).
    "-c:v",
    "h264_videotoolbox",
    "-q:v",
    "45",
    "-pix_fmt",
    "yuv420p",
    // ffmpeg's native AAC (LGPL), NOT nonfree libfdk_aac.
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    req.outputPath
  );
  return args;
}

/**
 * Walk the scene list, splicing xfade / concat filters into `filters`
 * for each scene→scene boundary. Returns the final output label name
 * (`v0` for a single-scene reel; `xN_M` or `cN_M` for multi-scene).
 *
 * The chain's running duration is tracked in `chainEndSec` so each
 * subsequent xfade can compute its `offset=` correctly. Crossfade
 * shrinks the chain by SIZZLE_CROSSFADE_SEC per fade; cut keeps it
 * the sum of inputs.
 */
function buildTransitionChain(
  scenes: SceneInput[],
  filters: string[]
): string {
  if (scenes.length === 1) return "v0";

  let chainLabel = "v0";
  let chainEndSec = scenes[0]!.durationSec;

  for (let i = 1; i < scenes.length; i++) {
    const next = scenes[i]!;
    const nextLabel = `chain${i}`;
    if (next.transition === "crossfade") {
      // xfade overlaps the last SIZZLE_CROSSFADE_SEC of the chain
      // with the first SIZZLE_CROSSFADE_SEC of the next scene.
      // `offset` is when the crossfade begins in the chain's
      // timeline, so chainEndSec - SIZZLE_CROSSFADE_SEC.
      const offsetSec = Math.max(0, chainEndSec - SIZZLE_CROSSFADE_SEC);
      filters.push(
        `[${chainLabel}][v${i}]xfade=transition=fade:` +
          `duration=${SIZZLE_CROSSFADE_SEC}:offset=${offsetSec.toFixed(3)}` +
          `[${nextLabel}]`
      );
      // Chain duration grows by next.durationSec but loses the overlap.
      chainEndSec = chainEndSec + next.durationSec - SIZZLE_CROSSFADE_SEC;
    } else {
      // Hard cut — concat with n=2.
      filters.push(
        `[${chainLabel}][v${i}]concat=n=2:v=1:a=0[${nextLabel}]`
      );
      chainEndSec = chainEndSec + next.durationSec;
    }
    chainLabel = nextLabel;
  }
  return chainLabel;
}

export async function compose(req: ComposeRequest): Promise<void> {
  const ffmpeg = resolveFfmpegPath();
  if (ffmpeg === null) {
    throw new ComposeError("ffmpeg_missing", "ffmpeg binary not found");
  }
  if (req.scenes.length === 0) {
    throw new ComposeError("no_scenes", "Sizzle reel must have at least one scene");
  }

  await mkdir(dirname(req.outputPath), { recursive: true });

  const audioListPath = `${req.outputPath}.audio-list.txt`;
  const audioConcat = req.scenes
    .map((s) => `file '${s.audioPath.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await writeFile(audioListPath, audioConcat, "utf8");

  try {
    const args = buildCompositionArgs(req, audioListPath);
    log.info("ffmpeg compose", {
      scenes: req.scenes.length,
      kinds: req.scenes.map((s) => s.kind),
      transitions: req.scenes.slice(1).map((s) => s.transition),
      width: req.width,
      height: req.height,
      fps: req.fps,
      totalSec: req.scenes.reduce((acc, s) => acc + s.durationSec, 0).toFixed(2)
    });
    const totalSec = req.scenes.reduce((acc, s) => acc + s.durationSec, 0);
    await runFfmpeg(ffmpeg, args, totalSec, req.onProgress, req.signal);
  } finally {
    // Clean up the audio concat list whether ffmpeg succeeded, failed,
    // or was aborted. Don't leak temp files into ~/Movies/PwrSnap/.
    await unlink(audioListPath).catch(() => undefined);
  }
}

function runFfmpeg(
  bin: string,
  args: string[],
  totalDurationSec: number,
  onProgress: ((ratio: number) => void) | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new ComposeError("cancelled", "Render was cancelled before start"));
      return;
    }
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      proc.kill("SIGKILL");
    };
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-8192);
      const matches = text.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
      if (matches !== null && totalDurationSec > 0 && onProgress) {
        const last = matches[matches.length - 1]!;
        const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(last);
        if (m !== null) {
          const elapsed = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
          onProgress(Math.min(0.99, elapsed / totalDurationSec));
        }
      }
    });
    proc.on("error", (cause) => {
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      reject(cause);
    });
    proc.on("close", (code) => {
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(new ComposeError("cancelled", "Render was cancelled"));
        return;
      }
      if (code === 0) {
        if (onProgress) onProgress(1);
        resolve();
        return;
      }
      reject(
        new ComposeError(
          "ffmpeg_failed",
          `ffmpeg exited with code ${code}`,
          tail.slice(-1024)
        )
      );
    });
  });
}
