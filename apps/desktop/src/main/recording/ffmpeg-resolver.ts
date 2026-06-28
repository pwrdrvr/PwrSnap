// ffmpeg binary resolution. The packaged app uses the repo-built
// LGPL ffmpeg binary shipped under Contents/Resources/PwrSnapFFmpeg
// (or PwrSnapFFmpeg.exe on Windows). In dev, macOS builds write
// apps/desktop/build/ffmpeg/ffmpeg; Windows release/QA builds may
// stage apps/desktop/build/ffmpeg/ffmpeg.exe. We additionally honor
// `PWRSNAP_FFMPEG_PATH` for CI / debug overrides.
//
// Kept in its own module so test code can mock the resolution
// without pulling the rest of the exporter stack into the Vitest
// graph.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { app } from "electron";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:ffmpeg");
const PACKAGED_FFMPEG_NAME = process.platform === "win32" ? "PwrSnapFFmpeg.exe" : "PwrSnapFFmpeg";
const DEV_FFMPEG_NAME = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

let cached: string | null | undefined;

export function resolveFfmpegPath(): string | null {
  if (cached !== undefined) return cached;
  const override = process.env.PWRSNAP_FFMPEG_PATH;
  if (override !== undefined && override.length > 0 && existsSync(override)) {
    cached = override;
    return cached;
  }

  const candidates = [
    join(__dirname, "..", "..", "build", "ffmpeg", DEV_FFMPEG_NAME)
  ];
  if (typeof process.resourcesPath === "string") {
    candidates.unshift(join(process.resourcesPath, PACKAGED_FFMPEG_NAME));
  }
  try {
    candidates.push(join(app.getAppPath(), "build", "ffmpeg", DEV_FFMPEG_NAME));
  } catch {
    /* app.getAppPath can be unavailable in narrow test contexts */
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cached = candidate;
      return cached;
    }
  }

  const pathFfmpeg = findOnPath("ffmpeg");
  if (pathFfmpeg !== null) {
    log.warn("using ffmpeg from PATH; packaged builds should resolve PwrSnapFFmpeg", {
      path: pathFfmpeg
    });
    cached = pathFfmpeg;
    return cached;
  }

  cached = null;
  return cached;
}

/** Test-only: reset the memoized resolution. */
export function __resetFfmpegResolverForTests(): void {
  cached = undefined;
}

function findOnPath(bin: string): string | null {
  const pathEnv = process.env.PATH;
  if (pathEnv === undefined || pathEnv.length === 0) return null;
  const names = process.platform === "win32"
    ? ["ffmpeg.exe", "ffmpeg.cmd", "ffmpeg.bat", bin]
    : [bin];
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
