import { spawn } from "node:child_process";

/** Never surface ffmpeg's raw stderr: it contains source paths and metadata. */
export async function timelineProcess(
  binary: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let tail = "";
    const abort = (): void => {
      child.kill("SIGKILL");
    };
    const timer = setTimeout(abort, 15 * 60_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-64_000);
    });
    child.on("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Media processor could not start"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Render cancelled"));
      else if (code !== 0) reject(new Error("Media processing failed"));
      else resolve(tail);
    });
  });
}

export async function probeTimelineMedia(
  binary: string,
  path: string,
  signal?: AbortSignal,
): Promise<{
  durationSec: number;
  width: number;
  height: number;
  video: boolean;
  audio: boolean;
}> {
  const result = await timelineProcess(
    binary,
    [
      "-hide_banner",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      path,
      "-t",
      "0",
      "-f",
      "null",
      "-",
    ],
    signal,
  );
  const duration = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(result);
  const videoLine = result
    .split("\n")
    .find((line) => /Stream.*Video:/.test(line));
  const dims = videoLine ? /\b(\d{2,5})x(\d{2,5})\b/.exec(videoLine) : null;
  return {
    durationSec: duration
      ? Number(duration[1]) * 3600 +
        Number(duration[2]) * 60 +
        Number(duration[3])
      : 0,
    width: Number(dims?.[1] ?? 0),
    height: Number(dims?.[2] ?? 0),
    video: !!videoLine,
    audio: /Stream.*Audio:/.test(result),
  };
}
