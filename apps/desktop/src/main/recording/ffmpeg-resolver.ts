// ffmpeg binary resolution. The packaged app uses
// `@ffmpeg-installer/ffmpeg`'s prebuilt static binary; in dev the
// same module resolves to a binary under node_modules. We additionally
// honor `PWRSNAP_FFMPEG_PATH` for CI / debug overrides.
//
// Kept in its own module so test code can mock the resolution
// without pulling the rest of the exporter stack into the Vitest
// graph.

import { existsSync } from "node:fs";
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
  try {
    // Lazy require — `@ffmpeg-installer/ffmpeg` exports `{ path }`
    // pointing at a static binary it ships per platform. We accept
    // ESM/CJS dual exports.
    const mod = require("@ffmpeg-installer/ffmpeg") as { path: string } | undefined;
    if (mod !== undefined && existsSync(mod.path)) {
      cached = mod.path;
      return cached;
    }
  } catch (cause) {
    log.warn("ffmpeg-installer not resolvable; checking PATH", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
  // Last-ditch: the user's system ffmpeg. We don't shell out to
  // `which ffmpeg` at module load — the caller path is async and
  // can pay that cost when it actually needs to encode.
  cached = null;
  return cached;
}

/** Test-only: reset the memoized resolution. */
export function __resetFfmpegResolverForTests(): void {
  cached = undefined;
}
