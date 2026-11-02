// ffmpeg binary resolution. The packaged app uses the repo-built
// LGPL ffmpeg binary shipped under Contents/Resources/PwrSnapFFmpeg
// (or PwrSnapFFmpeg.exe on Windows). In dev, macOS builds write
// apps/desktop/build/ffmpeg/ffmpeg; Windows release/QA builds may
// stage apps/desktop/build/ffmpeg/ffmpeg.exe. We additionally honor
// `PWRSNAP_FFMPEG_PATH` for CI / debug overrides.
//
// The last-resort ffmpeg-on-PATH fallback scans the app's INHERITED
// PATH only — PwrSnap never spawns the user's login shell to hydrate
// PATH. A GUI-launched app therefore sees launchd's sparse PATH; if
// ffmpeg lives elsewhere, set PWRSNAP_FFMPEG_PATH.
//
// Kept in its own module so test code can mock the resolution
// without pulling the rest of the exporter stack into the Vitest
// graph.

import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { app } from "electron";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:ffmpeg");

let cached: string | null | undefined;

type FfmpegLayout = {
  platform: NodeJS.Platform;
  moduleDir: string;
  resourcesPath: string | null;
  appPath: string | null;
};

/**
 * Pure filesystem candidates for packaged and development layouts.
 * Selecting `win32` / `posix` explicitly matters in tests: changing
 * `process.platform` on a POSIX host does not change `node:path.join`.
 */
export function ffmpegLayoutCandidates(layout: FfmpegLayout): string[] {
  const path = layout.platform === "win32" ? win32 : posix;
  const packagedName = layout.platform === "win32" ? "PwrSnapFFmpeg.exe" : "PwrSnapFFmpeg";
  const devName = layout.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates: string[] = [];
  if (layout.resourcesPath !== null) {
    candidates.push(path.join(layout.resourcesPath, packagedName));
  }
  candidates.push(path.join(layout.moduleDir, "..", "..", "build", "ffmpeg", devName));
  if (layout.appPath !== null) {
    candidates.push(path.join(layout.appPath, "build", "ffmpeg", devName));
  }
  return [...new Set(candidates)];
}

/** Pure PATH expansion, including Windows' semicolon delimiter. */
export function ffmpegPathCandidates(
  platform: NodeJS.Platform,
  pathEnv: string | undefined,
  bin = "ffmpeg"
): string[] {
  if (pathEnv === undefined || pathEnv.length === 0) return [];
  const path = platform === "win32" ? win32 : posix;
  // `.cmd` / `.bat` shims require cmd.exe or `shell: true`; every
  // consumer intentionally spawns argv directly with no shell. Only
  // discover the real executable so a successful resolution is runnable.
  const names = platform === "win32" ? [`${bin}.exe`, `${bin}.com`] : [bin];
  return pathEnv
    .split(path.delimiter)
    .filter((dir) => dir.length > 0)
    .flatMap((dir) => names.map((name) => path.join(dir, name)));
}

export function isRunnableFfmpegPath(platform: NodeJS.Platform, candidate: string): boolean {
  if (platform !== "win32") return true;
  const extension = win32.extname(candidate).toLowerCase();
  return extension === ".exe" || extension === ".com";
}

function invalidWindowsOverrideError(override: string): Error {
  const extension = win32.extname(override).toLowerCase() || "an extensionless file";
  return new Error(
    `PWRSNAP_FFMPEG_PATH points to ${extension} path "${override}", but PwrSnap on Windows requires a native .exe or .com FFmpeg binary. ` +
      "Script shims such as .cmd and .bat require a command shell; PwrSnap intentionally starts FFmpeg with shell disabled. " +
      "Set PWRSNAP_FFMPEG_PATH to the underlying ffmpeg.exe or ffmpeg.com file."
  );
}

export function resolveFfmpegPath(): string | null {
  if (cached !== undefined) return cached;
  const override = process.env.PWRSNAP_FFMPEG_PATH;
  if (override !== undefined && override.length > 0) {
    const overrideExtension = win32.extname(override).toLowerCase();
    // A stale shim is still an actionable configuration error: checking the
    // filesystem first would silently fall through to another binary and hide
    // that PWRSNAP_FFMPEG_PATH can never be launched with shell:false.
    if (
      process.platform === "win32" &&
      (overrideExtension === ".cmd" || overrideExtension === ".bat")
    ) {
      throw invalidWindowsOverrideError(override);
    }
    if (existsSync(override)) {
      if (!isRunnableFfmpegPath(process.platform, override)) {
        throw invalidWindowsOverrideError(override);
      }
      cached = override;
      return cached;
    }
  }

  let appPath: string | null = null;
  try {
    appPath = app.getAppPath();
  } catch {
    /* app.getAppPath can be unavailable in narrow test contexts */
  }
  const candidates = ffmpegLayoutCandidates({
    platform: process.platform,
    moduleDir: __dirname,
    resourcesPath: typeof process.resourcesPath === "string" ? process.resourcesPath : null,
    appPath
  });
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
  for (const candidate of ffmpegPathCandidates(process.platform, process.env.PATH, bin)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
