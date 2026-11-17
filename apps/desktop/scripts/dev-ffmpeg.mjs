import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONTRACT, TARGETS, check, digest, verifyPayload, verifyReleaseManifest } from "../../../scripts/ffmpeg/contract.mjs";
import { RELEASE_PIN, downloadControlledFfmpeg, validatePin } from "../../../scripts/ffmpeg/download.mjs";

export const WINDOWS_DEV_FFMPEG_PIN = Object.freeze({
  ...RELEASE_PIN,
  repo: CONTRACT.repo,
  artifactName: "ffmpeg-8.1.1-windows-x64",
  version: CONTRACT.version,
  sourceSha256: CONTRACT.sourceSha256,
  buildProfile: CONTRACT.buildProfile,
  manifestPlatform: "windows",
  manifestArch: "x64",
  artifactBinary: "ffmpeg.exe",
  installedBinary: "ffmpeg.exe",
  requiredEncoders: TARGETS["windows-x64"].encoders,
  requiredDecoders: ["png", "mjpeg", "h264", "aac", "mp3"],
  requiredDevices: TARGETS["windows-x64"].devices
});
export function verifyWindowsDevFfmpegDirectory(directory, options = {}) {
  const pin = options.pin ?? WINDOWS_DEV_FFMPEG_PIN;
  validatePin(pin);
  const bytes = readFileSync(join(directory, "release-manifest.json"));
  check(digest(bytes) === pin.manifestSha256, "cached release manifest digest mismatch");
  const release = verifyReleaseManifest(JSON.parse(bytes), pin.buildSha);
  for (const t of Object.keys(TARGETS)) check(release.platforms[t].sha256 === pin.archives[t], "cached independent archive digest mismatch");
  const payload = join(directory, "payload");
  const files = verifyPayload(payload, "windows-x64");
  check(JSON.stringify(files) === JSON.stringify(release.platforms["windows-x64"].files), "cached payload differs from pinned release manifest");
  return { binaryPath: join(payload, "ffmpeg.exe"), manifestPath: join(payload, "manifest.json"), manifest: JSON.parse(readFileSync(join(payload, "manifest.json"))) };
}
export function windowsDevFfmpegCacheDirectory(options = {}) {
  const pin = options.pin ?? WINDOWS_DEV_FFMPEG_PIN;
  validatePin(pin);
  return join(options.home ?? homedir(), ".pwrsnap", "dev", "bin", "ffmpeg", pin.buildSha, pin.archives["windows-x64"], "windows-x64");
}
export function ensureWindowsDevFfmpeg(env, options = {}) {
  if ((options.platform ?? process.platform) !== "win32") return null;
  const override = env.PWRSNAP_FFMPEG_PATH?.trim();
  if (override) return { path: override, source: "override" };
  const arch = options.arch ?? process.arch;
  check(arch === "x64", `controlled Windows FFmpeg supports x64, not ${arch}; set PWRSNAP_FFMPEG_PATH to a vetted native executable`);
  const pin = options.pin ?? WINDOWS_DEV_FFMPEG_PIN;
  validatePin(pin);
  const cacheDir = options.cacheDir ?? windowsDevFfmpegCacheDirectory({ pin });
  try {
    return { path: verifyWindowsDevFfmpegDirectory(cacheDir, { pin }).binaryPath, source: "cache" };
  } catch (cause) {
    if (existsSync(cacheDir)) (options.logger ?? console).warn(`[dev] replacing invalid controlled FFmpeg cache: ${cause.message}`);
  }
  mkdirSync(dirname(cacheDir), { recursive: true });
  const staging = mkdtempSync(join(dirname(cacheDir), ".windows-x64-install-"));
  try {
    const result = downloadControlledFfmpeg("windows-x64", join(staging, "payload"), { ...options, pin, env });
    writeFileSync(join(staging, "release-manifest.json"), result.manifestBytes);
    verifyWindowsDevFfmpegDirectory(staging, { pin });
    rmSync(cacheDir, { recursive: true, force: true });
    renameSync(staging, cacheDir);
  } catch (cause) {
    throw new Error(`Unable to provision controlled FFmpeg. Authenticate gh with access to ${CONTRACT.repo}, or set PWRSNAP_FFMPEG_PATH to a vetted native ffmpeg.exe. Cause: ${cause.message}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { path: verifyWindowsDevFfmpegDirectory(cacheDir, { pin }).binaryPath, source: "download" };
}
