import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveFfmpegPath } from "../recording/ffmpeg-resolver";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:sizzle-composer");

export type SceneInput = {
  imagePath: string;
  audioPath: string;
  durationSec: number;
};

export type ComposeRequest = {
  scenes: SceneInput[];
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  onProgress?: (ratio: number) => void;
};

export class ComposeError extends Error {
  constructor(
    public readonly code: "ffmpeg_missing" | "no_scenes" | "ffmpeg_failed",
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
 * - Each scene gets its own input as `-i image` — exactly ONE frame
 *   per scene goes in. NOT `-loop 1 ... -i image`: with -loop the
 *   input stream is infinite, and zoompan with `d=N` emits N output
 *   frames PER input frame. Pairing infinite input with zoompan
 *   produces an unbounded output that `-shortest` truncates to audio
 *   length — so only the first scene's zoompan run survives in the
 *   final mux. (This was the "only one image shows" bug in the first
 *   two cuts of the composer.)
 *
 * - Each `[i:v]` is scaled with `force_original_aspect_ratio=decrease`
 *   + `pad` for honest letterboxing on portrait / odd-aspect captures.
 *   We scale to 2× the output canvas so zoompan has headroom to zoom
 *   in/out without hitting a hard edge.
 *
 * - `zoompan` does the ken-burns. With a single input frame, `d=N`
 *   makes zoompan emit exactly N output frames at the configured
 *   `fps`, so each scene's video length is `N / fps` ≡ `durationSec`.
 *   Zoom direction alternates per scene (in / out) for visual variety.
 *   The `on` variable is the output frame index within zoompan's
 *   current input frame, [0..N), which lets us interpolate linearly:
 *   `1.0 + DELTA * on / N`.
 *
 * - The N scene videos go into `concat=n=N:v=1:a=0[vout]`, audio comes
 *   from the concat-demuxer input that follows the scene inputs.
 *
 * - `-shortest` is intentional: rounds total length to the shorter of
 *   (video, audio). Per-scene durations are derived from per-scene
 *   audio durations + a 350ms tail, so total video should be within
 *   ~1.4s of total audio.
 */
export function buildCompositionArgs(
  req: ComposeRequest,
  audioListPath: string
): string[] {
  const args: string[] = ["-y", "-hide_banner"];
  for (const scene of req.scenes) {
    // One frame of input per scene. zoompan's `d=N` does the time-
    // stretching to N output frames; we MUST NOT add `-loop 1` or
    // `-framerate` here or the input becomes a multi-frame stream and
    // zoompan emits N output frames per input frame.
    args.push("-i", scene.imagePath);
  }
  args.push("-f", "concat", "-safe", "0", "-i", audioListPath);

  const filters: string[] = [];
  req.scenes.forEach((scene, i) => {
    const nFrames = Math.max(2, Math.round(scene.durationSec * req.fps));
    const directionIn = i % 2 === 0;
    // Linear zoom across the scene: 1.0 → 1.10 (in) or 1.10 → 1.0 (out).
    // `on` is zoompan's per-input-frame output counter; with one input
    // frame and d=N, on runs [0..N).
    const zoomExpr = directionIn
      ? `1.0+0.10*on/${nFrames}`
      : `1.10-0.10*on/${nFrames}`;
    const w2 = req.width * 2;
    const h2 = req.height * 2;
    filters.push(
      `[${i}:v]` +
        `scale=${w2}:${h2}:force_original_aspect_ratio=decrease,` +
        `pad=${w2}:${h2}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `zoompan=z='${zoomExpr}':` +
        `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
        `d=${nFrames}:s=${req.width}x${req.height}:fps=${req.fps},` +
        `setsar=1,format=yuv420p[v${i}]`
    );
  });

  const concatInputs = req.scenes.map((_, i) => `[v${i}]`).join("");
  filters.push(
    `${concatInputs}concat=n=${req.scenes.length}:v=1:a=0[vout]`
  );

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    `${req.scenes.length}:a:0`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
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

  const args = buildCompositionArgs(req, audioListPath);
  log.info("ffmpeg compose", {
    scenes: req.scenes.length,
    width: req.width,
    height: req.height,
    fps: req.fps,
    totalSec: req.scenes.reduce((acc, s) => acc + s.durationSec, 0).toFixed(2)
  });
  const totalSec = req.scenes.reduce((acc, s) => acc + s.durationSec, 0);
  await runFfmpeg(ffmpeg, args, totalSec, req.onProgress);
}

function runFfmpeg(
  bin: string,
  args: string[],
  totalDurationSec: number,
  onProgress: ((ratio: number) => void) | undefined
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-8192);
      const m = /time=(\d+):(\d+):(\d+\.\d+)/g.exec(text);
      if (m !== null && totalDurationSec > 0 && onProgress) {
        const elapsed = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        onProgress(Math.min(0.99, elapsed / totalDurationSec));
      }
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
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
