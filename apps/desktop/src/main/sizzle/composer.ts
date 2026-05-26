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

  const args: string[] = ["-y", "-hide_banner"];
  for (const scene of req.scenes) {
    args.push(
      "-loop",
      "1",
      "-t",
      scene.durationSec.toFixed(3),
      "-i",
      scene.imagePath
    );
  }
  args.push("-f", "concat", "-safe", "0", "-i", audioListPath);

  const filters: string[] = [];
  const kenBurnsFrames = Math.max(2, Math.round(req.fps * Math.max(...req.scenes.map((s) => s.durationSec))));
  req.scenes.forEach((scene, i) => {
    const frames = Math.max(2, Math.round(scene.durationSec * req.fps));
    const direction = i % 2 === 0 ? "in" : "out";
    const zoomExpr =
      direction === "in"
        ? `min(1.10,1.00+0.001*on)`
        : `max(1.00,1.10-0.001*on)`;
    filters.push(
      `[${i}:v]scale=${req.width * 2}:${req.height * 2}:force_original_aspect_ratio=increase,` +
        `crop=${req.width * 2}:${req.height * 2},` +
        `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
        `d=${frames}:s=${req.width}x${req.height}:fps=${req.fps},` +
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

  log.info("ffmpeg compose", { args: args.slice(0, 4), scenes: req.scenes.length });
  const totalSec = req.scenes.reduce((acc, s) => acc + s.durationSec, 0);
  await runFfmpeg(ffmpeg, args, totalSec, req.onProgress);
  void kenBurnsFrames;
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
