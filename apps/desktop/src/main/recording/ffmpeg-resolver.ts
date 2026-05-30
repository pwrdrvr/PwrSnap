// ffmpeg binary resolution. The packaged app uses the repo-built
// LGPL ffmpeg binary shipped under Contents/Resources/PwrSnapFFmpeg.
// In dev, `pnpm --filter @pwrsnap/desktop build:ffmpeg` writes the
// same binary under apps/desktop/build/ffmpeg/ffmpeg. We additionally
// honor `PWRSNAP_FFMPEG_PATH` for CI / debug overrides.
//
// Kept in its own module so test code can mock the resolution
// without pulling the rest of the exporter stack into the Vitest
// graph.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { app } from "electron";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:ffmpeg");

let cached: string | null | undefined;

export function resolveFfmpegPath(): string | null {
  if (cached !== undefined) return cached;
  const override = process.env.PWRSNAP_FFMPEG_PATH;
  if (override !== undefined && override.length > 0 && existsSync(override)) {
    cached = override;
    return cached;
  }

  const candidates = [
    join(__dirname, "..", "..", "build", "ffmpeg", "ffmpeg")
  ];
  if (typeof process.resourcesPath === "string") {
    candidates.unshift(join(process.resourcesPath, "PwrSnapFFmpeg"));
  }
  try {
    candidates.push(join(app.getAppPath(), "build", "ffmpeg", "ffmpeg"));
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
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
