import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ensureWindowsDevFfmpeg,
  verifyWindowsDevFfmpegDirectory,
  WINDOWS_DEV_FFMPEG_PIN,
  windowsDevFfmpegCacheDirectory
} from "./dev-ffmpeg.mjs";

const tempDirs = [];

function tempDir(prefix = "pwrsnap-dev-ffmpeg-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeArtifact(directory, options = {}) {
  mkdirSync(directory, { recursive: true });
  const binaryName = options.binaryName ?? WINDOWS_DEV_FFMPEG_PIN.artifactBinary;
  const binary = options.binary ?? Buffer.from("controlled ffmpeg test binary");
  writeFileSync(join(directory, binaryName), binary);
  const manifest = {
    version: WINDOWS_DEV_FFMPEG_PIN.version,
    sourceSha256: WINDOWS_DEV_FFMPEG_PIN.sourceSha256,
    buildProfile: WINDOWS_DEV_FFMPEG_PIN.buildProfile,
    platform: WINDOWS_DEV_FFMPEG_PIN.manifestPlatform,
    arch: WINDOWS_DEV_FFMPEG_PIN.manifestArch,
    binary: WINDOWS_DEV_FFMPEG_PIN.artifactBinary,
    sha256: createHash("sha256").update(binary).digest("hex"),
    configuration: "--disable-autodetect --enable-zlib --enable-mediafoundation",
    forbiddenConfigFlags: ["--enable-gpl", "--enable-nonfree", "--enable-libx264"],
    requiredEncoders: [...WINDOWS_DEV_FFMPEG_PIN.requiredEncoders],
    requiredDecoders: [...WINDOWS_DEV_FFMPEG_PIN.requiredDecoders],
    requiredDevices: [...WINDOWS_DEV_FFMPEG_PIN.requiredDevices],
    ...options.manifest
  };
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  return { binary, manifest };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Windows development FFmpeg provisioning", () => {
  test("uses one build-SHA-versioned cache shared by worktrees", () => {
    const home = join("C:\\Users", "developer");
    const cache = windowsDevFfmpegCacheDirectory({ home });
    expect(cache).toContain(join(".pwrsnap", "dev", "bin", "ffmpeg"));
    expect(cache).toContain(WINDOWS_DEV_FFMPEG_PIN.buildSha);
    expect(cache).toMatch(/windows-x64$/);
  });

  test("accepts only the pinned target and complete codec contract", () => {
    const artifact = tempDir();
    const { manifest } = writeArtifact(artifact);

    expect(verifyWindowsDevFfmpegDirectory(artifact)).toMatchObject({ manifest });
  });

  test("rejects a hash mismatch and a manifest missing h264_mf", () => {
    const badHash = tempDir();
    writeArtifact(badHash);
    writeFileSync(join(badHash, "ffmpeg.exe"), "tampered");
    expect(() => verifyWindowsDevFfmpegDirectory(badHash)).toThrow(
      /binary SHA-256 mismatch/
    );

    const missingEncoder = tempDir();
    writeArtifact(missingEncoder, {
      manifest: { requiredEncoders: ["aac"] }
    });
    expect(() => verifyWindowsDevFfmpegDirectory(missingEncoder)).toThrow(
      /missing required encoder check: h264_mf/
    );
  });

  test("reuses a verified cached PwrSnapFFmpeg.exe without invoking gh", () => {
    const cacheDir = tempDir();
    writeArtifact(cacheDir, { binaryName: WINDOWS_DEV_FFMPEG_PIN.installedBinary });
    const runner = vi.fn();

    const result = ensureWindowsDevFfmpeg(
      {},
      { platform: "win32", arch: "x64", cacheDir, runner }
    );

    expect(result).toEqual({
      path: join(cacheDir, WINDOWS_DEV_FFMPEG_PIN.installedBinary),
      source: "cache"
    });
    expect(runner).not.toHaveBeenCalled();
  });

  test("downloads the exact successful pinned run and installs it atomically", () => {
    const root = tempDir();
    const cacheDir = join(root, "cache", "windows-x64");
    const commands = [];
    const runner = vi.fn((_command, argv) => {
      commands.push(argv);
      if (argv[0] === "run" && argv[1] === "list") {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              databaseId: 123,
              headSha: "0000000000000000000000000000000000000000",
              conclusion: "success",
              status: "completed"
            },
            {
              databaseId: 8675309,
              headSha: WINDOWS_DEV_FFMPEG_PIN.buildSha,
              conclusion: "success",
              status: "completed"
            }
          ]),
          stderr: ""
        };
      }
      if (argv[0] === "run" && argv[1] === "download") {
        const outputDir = argv[argv.indexOf("--dir") + 1];
        writeArtifact(outputDir);
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected gh call: ${argv.join(" ")}`);
    });

    const result = ensureWindowsDevFfmpeg(
      { PATH: "C:\\Program Files\\GitHub CLI" },
      {
        platform: "win32",
        arch: "x64",
        cacheDir,
        tempRoot: root,
        runner,
        logger: { log: vi.fn(), warn: vi.fn() }
      }
    );

    expect(result).toEqual({
      path: join(cacheDir, WINDOWS_DEV_FFMPEG_PIN.installedBinary),
      source: "download"
    });
    expect(commands[0]).toContain(WINDOWS_DEV_FFMPEG_PIN.repo);
    expect(commands[1]).toContain("8675309");
    expect(commands[1]).toContain(WINDOWS_DEV_FFMPEG_PIN.artifactName);
    expect(
      verifyWindowsDevFfmpegDirectory(cacheDir, {
        binaryName: WINDOWS_DEV_FFMPEG_PIN.installedBinary
      }).binaryPath
    ).toBe(result.path);
  });

  test("honors an explicit override and gives an actionable auth failure", () => {
    expect(
      ensureWindowsDevFfmpeg(
        { PWRSNAP_FFMPEG_PATH: "C:\\tools\\ffmpeg.exe" },
        { platform: "win32", arch: "x64", runner: vi.fn() }
      )
    ).toEqual({ path: "C:\\tools\\ffmpeg.exe", source: "override" });

    const root = tempDir();
    expect(() =>
      ensureWindowsDevFfmpeg(
        {},
        {
          platform: "win32",
          arch: "x64",
          cacheDir: join(root, "missing-cache"),
          tempRoot: root,
          runner: () => ({
            status: null,
            stdout: "",
            stderr: "",
            error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" })
          }),
          logger: { log: vi.fn(), warn: vi.fn() }
        }
      )
    ).toThrow(/gh auth login[\s\S]*PWRSNAP_FFMPEG_PATH[\s\S]*gh run list could not start/);
  });

  test("is a no-op outside Windows", () => {
    expect(ensureWindowsDevFfmpeg({}, { platform: "darwin" })).toBeNull();
  });
});
