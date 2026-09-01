import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const WINDOWS_DEV_FFMPEG_PIN = Object.freeze({
  repo: "pwrdrvr/pwrsnap-ffmpeg-builds",
  workflow: "build.yml",
  buildSha: "3d775403a83990a2ad9503d865f5d481d9c0316a",
  artifactName: "ffmpeg-8.1.1-windows-x64",
  version: "8.1.1",
  sourceSha256: "b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3",
  buildProfile: "pwrsnap-lgpl-clean-v1",
  manifestPlatform: "windows",
  manifestArch: "x64",
  artifactBinary: "ffmpeg.exe",
  installedBinary: "PwrSnapFFmpeg.exe",
  requiredEncoders: ["h264_mf", "aac"],
  requiredDecoders: ["png", "mjpeg", "h264", "aac", "mp3"],
  requiredDevices: ["gdigrab"]
});

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireManifestValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyWindowsDevFfmpegDirectory(directory, options = {}) {
  const pin = options.pin ?? WINDOWS_DEV_FFMPEG_PIN;
  const binaryName = options.binaryName ?? pin.artifactBinary;
  const binaryPath = join(directory, binaryName);
  const manifestPath = join(directory, "manifest.json");
  requireManifestValue(existsSync(binaryPath), `FFmpeg artifact is missing ${binaryName}`);
  requireManifestValue(existsSync(manifestPath), "FFmpeg artifact is missing manifest.json");

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    throw new Error(
      `FFmpeg artifact manifest is invalid: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  requireManifestValue(
    manifest.version === pin.version,
    `FFmpeg version mismatch: expected ${pin.version}, got ${String(manifest.version)}`
  );
  requireManifestValue(
    manifest.sourceSha256 === pin.sourceSha256,
    `FFmpeg source SHA-256 mismatch: expected ${pin.sourceSha256}, got ${String(manifest.sourceSha256)}`
  );
  requireManifestValue(
    manifest.buildProfile === pin.buildProfile,
    `FFmpeg build profile mismatch: expected ${pin.buildProfile}, got ${String(manifest.buildProfile)}`
  );
  requireManifestValue(
    manifest.platform === pin.manifestPlatform &&
      manifest.arch === pin.manifestArch &&
      manifest.binary === pin.artifactBinary,
    `FFmpeg target mismatch: expected ${pin.manifestPlatform}/${pin.manifestArch}/${pin.artifactBinary}, got ${String(manifest.platform)}/${String(manifest.arch)}/${String(manifest.binary)}`
  );

  const actualSha256 = sha256(binaryPath);
  requireManifestValue(
    actualSha256 === manifest.sha256,
    `FFmpeg binary SHA-256 mismatch: expected ${String(manifest.sha256)}, got ${actualSha256}`
  );
  for (const flag of manifest.forbiddenConfigFlags ?? []) {
    requireManifestValue(
      !String(manifest.configuration).includes(flag),
      `FFmpeg manifest contains forbidden configure flag: ${flag}`
    );
  }
  for (const encoder of pin.requiredEncoders) {
    requireManifestValue(
      (manifest.requiredEncoders ?? []).includes(encoder),
      `FFmpeg manifest is missing required encoder check: ${encoder}`
    );
  }
  for (const decoder of pin.requiredDecoders) {
    requireManifestValue(
      (manifest.requiredDecoders ?? []).includes(decoder),
      `FFmpeg manifest is missing required decoder check: ${decoder}`
    );
  }
  for (const device of pin.requiredDevices) {
    requireManifestValue(
      (manifest.requiredDevices ?? []).includes(device),
      `FFmpeg manifest is missing required device check: ${device}`
    );
  }
  return { binaryPath, manifestPath, manifest };
}

export function windowsDevFfmpegCacheDirectory(options = {}) {
  const pin = options.pin ?? WINDOWS_DEV_FFMPEG_PIN;
  const home = options.home ?? homedir();
  return join(
    home,
    ".pwrsnap",
    "dev",
    "bin",
    "ffmpeg",
    pin.buildSha,
    "windows-x64"
  );
}

function commandFailure(command, result) {
  if (result.error !== undefined) return `${command} could not start: ${result.error.message}`;
  const detail = String(result.stderr ?? result.stdout ?? "").trim();
  return detail.length > 0
    ? `${command} exited ${String(result.status)}: ${detail}`
    : `${command} exited ${String(result.status)}`;
}

function runGh(argv, options) {
  const runner = options.runner ?? spawnSync;
  const result = runner("gh", argv, {
    encoding: "utf8",
    env: options.env,
    windowsHide: true
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(commandFailure(`gh ${argv.slice(0, 2).join(" ")}`, result));
  }
  return result;
}

function findPinnedRunId(options) {
  const pin = options.pin ?? WINDOWS_DEV_FFMPEG_PIN;
  const result = runGh(
    [
      "run",
      "list",
      "--repo",
      pin.repo,
      "--workflow",
      pin.workflow,
      "--branch",
      "main",
      "--limit",
      "100",
      "--json",
      "databaseId,headSha,conclusion,status"
    ],
    options
  );
  let runs;
  try {
    runs = JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error(
      `gh returned invalid workflow JSON: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  const run = runs.find(
    (candidate) => candidate.headSha === pin.buildSha && candidate.conclusion === "success"
  );
  if (run === undefined) {
    throw new Error(
      `No successful ${pin.workflow} run found for ${pin.repo}@${pin.buildSha}; the pinned artifact may have expired`
    );
  }
  return String(run.databaseId);
}

function installDownloadedArtifact(downloadDir, cacheDir, options) {
  const pin = options.pin ?? WINDOWS_DEV_FFMPEG_PIN;
  verifyWindowsDevFfmpegDirectory(downloadDir, { pin });

  const parent = dirname(cacheDir);
  mkdirSync(parent, { recursive: true });
  const stagingDir = mkdtempSync(join(parent, ".windows-x64-install-"));
  try {
    cpSync(join(downloadDir, pin.artifactBinary), join(stagingDir, pin.installedBinary));
    cpSync(join(downloadDir, "manifest.json"), join(stagingDir, "manifest.json"));
    verifyWindowsDevFfmpegDirectory(stagingDir, {
      pin,
      binaryName: pin.installedBinary
    });

    // The directory is versioned by the immutable build SHA. An invalid or
    // interrupted entry is app-owned dev cache and is safe to replace.
    rmSync(cacheDir, { recursive: true, force: true });
    renameSync(stagingDir, cacheDir);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function ensureWindowsDevFfmpeg(env, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return null;

  const override = env.PWRSNAP_FFMPEG_PATH?.trim();
  if (override) return { path: override, source: "override" };

  const arch = options.arch ?? process.arch;
  if (arch !== "x64") {
    throw new Error(
      `PwrSnap's controlled Windows FFmpeg artifact supports x64, not ${arch}; set PWRSNAP_FFMPEG_PATH to a vetted native executable for this architecture`
    );
  }

  const pin = options.pin ?? WINDOWS_DEV_FFMPEG_PIN;
  const cacheDir = options.cacheDir ?? windowsDevFfmpegCacheDirectory({ pin });
  try {
    const verified = verifyWindowsDevFfmpegDirectory(cacheDir, {
      pin,
      binaryName: pin.installedBinary
    });
    return { path: verified.binaryPath, source: "cache" };
  } catch (cause) {
    if (existsSync(cacheDir)) {
      (options.logger ?? console).warn(
        `[dev] replacing invalid cached PwrSnap FFmpeg: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
  }

  const logger = options.logger ?? console;
  logger.log(`[dev] downloading ${pin.artifactName} to the shared dev cache…`);
  const downloadDir = mkdtempSync(join(options.tempRoot ?? tmpdir(), "pwrsnap-dev-ffmpeg-"));
  try {
    const runId = findPinnedRunId({ ...options, pin, env });
    runGh(
      [
        "run",
        "download",
        runId,
        "--repo",
        pin.repo,
        "--name",
        pin.artifactName,
        "--dir",
        downloadDir
      ],
      { ...options, pin, env }
    );
    installDownloadedArtifact(downloadDir, cacheDir, { ...options, pin });
  } catch (cause) {
    throw new Error(
      "Unable to provision PwrSnapFFmpeg.exe for Windows development. " +
        "Authenticate the GitHub CLI with access to pwrdrvr/pwrsnap-ffmpeg-builds (`gh auth login --hostname github.com`), " +
        "or set PWRSNAP_FFMPEG_PATH to a vetted native ffmpeg.exe. " +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }

  const verified = verifyWindowsDevFfmpegDirectory(cacheDir, {
    pin,
    binaryName: pin.installedBinary
  });
  return { path: verified.binaryPath, source: "download" };
}
