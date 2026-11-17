import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";
import { ensureWindowsDevFfmpeg, verifyWindowsDevFfmpegDirectory, windowsDevFfmpegCacheDirectory } from "./dev-ffmpeg.mjs";
const pin = { buildSha: "1".repeat(40), manifestSha256: "2".repeat(64), archives: { "windows-x64": "3".repeat(64), "macos-universal": "4".repeat(64) } };
describe("Windows development durable FFmpeg provisioning", () => {
  test("cache is shared across worktrees and keyed by commit AND reviewed bytes", () => {
    const cache = windowsDevFfmpegCacheDirectory({ home: "/test-home", pin });
    expect(cache).toContain(join(".pwrsnap", "dev", "bin", "ffmpeg", pin.buildSha, pin.archives["windows-x64"], "windows-x64"));
  });
  test("cached manifest cannot replace an independently pinned digest", () => {
    const temp = mkdtempSync(join(tmpdir(), "ffmpeg-cache-"));
    try {
      writeFileSync(join(temp, "release-manifest.json"), JSON.stringify({ sha256: "untrusted", requiredEncoders: ["h264_mf"] }));
      expect(() => verifyWindowsDevFfmpegDirectory(temp, { pin })).toThrow(/cached release manifest digest mismatch/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  test("explicit override and non-Windows execution require no provisioning", () => {
    const runner = vi.fn();
    expect(ensureWindowsDevFfmpeg({}, { platform: "darwin", runner })).toBeNull();
    expect(ensureWindowsDevFfmpeg({ PWRSNAP_FFMPEG_PATH: "C:\\vetted\\ffmpeg.exe" }, { platform: "win32", runner })).toEqual({ path: "C:\\vetted\\ffmpeg.exe", source: "override" });
    expect(runner).not.toHaveBeenCalled();
  });
  test("blocked publication cannot be bypassed by cache or an Actions download", () => {
    const runner = vi.fn();
    expect(() => ensureWindowsDevFfmpeg({}, { platform: "win32", arch: "x64", pin: { blocked: "corrected producer awaits publication" }, runner })).toThrow(/corrected producer awaits publication/);
    expect(runner).not.toHaveBeenCalled();
  });
  test("auth failure is actionable and never falls back to transient artifacts", () => {
    const temp = mkdtempSync(join(tmpdir(), "ffmpeg-dev-"));
    const runner = vi.fn(() => ({ status: 1, stderr: "auth denied" }));
    try {
      expect(() => ensureWindowsDevFfmpeg({}, { platform: "win32", arch: "x64", pin, cacheDir: join(temp, "cache"), runner })).toThrow(/Authenticate gh.*PWRSNAP_FFMPEG_PATH.*auth denied/);
      expect(runner.mock.calls).toHaveLength(1);
      expect(runner.mock.calls[0][1][0]).toBe("api");
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
