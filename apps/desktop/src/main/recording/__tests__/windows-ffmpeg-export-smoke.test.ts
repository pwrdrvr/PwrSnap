import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// The smoke needs only recording-exporter's pure production argument builders.
// Keep its unrelated persistence and Electron resolver graph out of this
// artifact test so a native SQLite rebuild cannot mask an FFmpeg failure.
vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));
vi.mock("../../persistence/paths", () => ({ getCacheRoot: () => "unused" }));
vi.mock("../../persistence/video-repo", () => ({
  lookupExport: () => null,
  recordExport: () => undefined
}));
vi.mock("../ffmpeg-resolver", () => ({ resolveFfmpegPath: () => null }));

const {
  buildGifEncodeArgs,
  buildMp4VideoEncoderArgs,
  GIF_PRESETS,
  MP4_PRESETS
} = await import("../recording-exporter");

const SMOKE_ENABLED =
  process.platform === "win32" && process.env.PWRSNAP_WINDOWS_FFMPEG_SMOKE === "1";
const PROCESS_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTIC_CHARS = 32_000;

type ProcessResult = {
  stdout: string;
  stderr: string;
};

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length <= MAX_DIAGNOSTIC_CHARS
    ? next
    : next.slice(next.length - MAX_DIAGNOSTIC_CHARS);
}

function runControlledFfmpeg(ffmpeg: string, args: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`controlled FFmpeg timed out after ${PROCESS_TIMEOUT_MS}ms`));
    }, PROCESS_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(cause);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `controlled FFmpeg exited ${String(code)}\n` +
            `argv: ${JSON.stringify(args)}\n` +
            `stdout: ${stdout}\nstderr: ${stderr}`
        )
      );
    });
  });
}

async function expectNonemptyFile(path: string): Promise<void> {
  const info = await stat(path);
  expect(info.isFile()).toBe(true);
  expect(info.size).toBeGreaterThan(0);
}

async function decodedVideoFrameCount(ffmpeg: string, path: string): Promise<number> {
  const result = await runControlledFfmpeg(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-progress",
    "pipe:1",
    "-nostats",
    "-i",
    path,
    "-map",
    "0:v:0",
    "-f",
    "null",
    "-"
  ]);
  return [...result.stdout.matchAll(/^frame=(\d+)\r?$/gm)].reduce(
    (max, match) => Math.max(max, Number(match[1])),
    0
  );
}

describe.skipIf(!SMOKE_ENABLED)("controlled Windows FFmpeg export artifact", () => {
  let ffmpeg = "";
  let workDir = "";

  beforeAll(async () => {
    ffmpeg = process.env.PWRSNAP_WINDOWS_FFMPEG_PATH ?? "";
    if (ffmpeg.length === 0) {
      throw new Error(
        "PWRSNAP_WINDOWS_FFMPEG_PATH must point to the controlled artifact when the smoke is enabled"
      );
    }
    await expectNonemptyFile(ffmpeg);
    // Keep a space in every media path to prove argv spawning does not depend
    // on PowerShell/cmd quoting behavior.
    workDir = await mkdtemp(join(tmpdir(), "PwrSnap FFmpeg smoke-"));
  });

  afterAll(async () => {
    if (workDir.length > 0) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test(
    "encodes and decodes a production-args MP4 and animated palette GIF",
    async () => {
      const mp4Path = join(workDir, "tiny-production-export.mp4");
      const gifPath = join(workDir, "tiny-production-export.gif");

      // testsrc2 is bounded to ten small frames. The encoder tail is the exact
      // production win32 contract; argv is passed directly with no shell.
      await runControlledFfmpeg(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=10:duration=1",
        "-map",
        "0:v:0",
        ...buildMp4VideoEncoderArgs("win32", MP4_PRESETS.low),
        "-an",
        "-movflags",
        "+faststart",
        mp4Path
      ]);
      await expectNonemptyFile(mp4Path);
      expect(await decodedVideoFrameCount(ffmpeg, mp4Path)).toBeGreaterThanOrEqual(2);

      // This is the complete production GIF argv, including the shared
      // fps/scale/split/palettegen/paletteuse chain.
      await runControlledFfmpeg(
        ffmpeg,
        buildGifEncodeArgs(
          mp4Path,
          { start: 0, end: 1 },
          GIF_PRESETS.low,
          gifPath
        )
      );
      await expectNonemptyFile(gifPath);
      expect(await decodedVideoFrameCount(ffmpeg, gifPath)).toBeGreaterThanOrEqual(2);
    },
    90_000
  );
});
