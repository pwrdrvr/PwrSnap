#!/usr/bin/env node
/**
 * Build the ffmpeg binary PwrSnap bundles in release artifacts.
 *
 * We intentionally build from upstream FFmpeg source with no GPL or
 * nonfree configure flags instead of depending on opaque prebuilt npm
 * binaries. Issue #127 tracks the compliance reason: the previous
 * @ffmpeg-installer binary was built with --enable-gpl and
 * --enable-nonfree, so redistributing it was not acceptable for an
 * MIT-licensed app.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";

const FFMPEG_VERSION = "8.1.1";
const FFMPEG_SHA256 = "b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3";
const FFMPEG_URL = `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`;
const PKG_CONFIG_MANIFEST = "disabled-shim-v2";
const FORBIDDEN_CONFIG_FLAGS = [
  "--enable-gpl",
  "--enable-nonfree",
  "--enable-libx264",
  "--enable-libx265",
  "--enable-libvidstab",
  "--enable-libfdk-aac"
];
const REQUIRED_ENCODERS = ["h264_videotoolbox", "aac"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopRoot = resolve(__dirname, "..");
const buildRoot = join(desktopRoot, "build", "ffmpeg");
const cacheRoot = join(desktopRoot, "build", "ffmpeg-cache");
const disabledPkgConfigPath = join(cacheRoot, "pkg-config-disabled");
const outputPath = join(buildRoot, "ffmpeg");
const manifestPath = join(buildRoot, "manifest.json");

if (process.platform !== "darwin") {
  console.log("[build-ffmpeg] non-darwin platform - skipping");
  process.exit(0);
}

mkdirSync(buildRoot, { recursive: true });
mkdirSync(cacheRoot, { recursive: true });
ensureDisabledPkgConfig();

const universal = process.env.PWRSNAP_FFMPEG_UNIVERSAL === "1";
const targetArchs = universal ? ["arm64", "x86_64"] : [process.arch === "x64" ? "x86_64" : process.arch];

if (isUpToDate()) {
  console.log("[build-ffmpeg] ffmpeg up to date");
  process.exit(0);
}

const tarballPath = downloadSource();
const slicePaths = [];

for (const arch of targetArchs) {
  slicePaths.push(buildSlice(tarballPath, arch));
}

if (slicePaths.length === 1) {
  rmSync(outputPath, { force: true });
  execFileSync("cp", [slicePaths[0], outputPath], { stdio: "inherit" });
} else {
  run("lipo", ["-create", ...slicePaths, "-output", outputPath], { cwd: cacheRoot });
}

chmodSync(outputPath, 0o755);
run("codesign", ["-s", "-", "--force", outputPath], { cwd: desktopRoot });
verifyBinary(outputPath);
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      version: FFMPEG_VERSION,
      sourceUrl: FFMPEG_URL,
      sourceSha256: FFMPEG_SHA256,
      pkgConfig: PKG_CONFIG_MANIFEST,
      archs: targetArchs,
      forbiddenConfigFlags: FORBIDDEN_CONFIG_FLAGS,
      requiredEncoders: REQUIRED_ENCODERS
    },
    null,
    2
  )}\n`
);
console.log(`[build-ffmpeg] ffmpeg -> ${outputPath}`);

function isUpToDate() {
  if (!existsSync(outputPath) || !existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.version !== FFMPEG_VERSION) return false;
    if (manifest.sourceSha256 !== FFMPEG_SHA256) return false;
    if (manifest.pkgConfig !== PKG_CONFIG_MANIFEST) return false;
    if (JSON.stringify(manifest.archs) !== JSON.stringify(targetArchs)) return false;
    verifyBinary(outputPath);
    return true;
  } catch {
    return false;
  }
}

function downloadSource() {
  const tarballPath = join(cacheRoot, `ffmpeg-${FFMPEG_VERSION}.tar.xz`);
  if (existsSync(tarballPath) && sha256(tarballPath) === FFMPEG_SHA256) {
    return tarballPath;
  }
  rmSync(tarballPath, { force: true });
  run("curl", ["-L", FFMPEG_URL, "-o", tarballPath], { cwd: cacheRoot });
  const actual = sha256(tarballPath);
  if (actual !== FFMPEG_SHA256) {
    rmSync(tarballPath, { force: true });
    throw new Error(
      `ffmpeg source checksum mismatch: expected ${FFMPEG_SHA256}, got ${actual}`
    );
  }
  return tarballPath;
}

function buildSlice(tarballPath, arch) {
  const workRoot = join(cacheRoot, `work-${arch}`);
  const sourceRoot = join(workRoot, `ffmpeg-${FFMPEG_VERSION}`);
  const prefix = join(workRoot, "prefix");
  const slicePath = join(cacheRoot, `ffmpeg-${arch}`);
  rmSync(workRoot, { recursive: true, force: true });
  rmSync(slicePath, { force: true });
  mkdirSync(workRoot, { recursive: true });
  run("tar", ["-xf", tarballPath, "-C", workRoot], { cwd: cacheRoot });

  const minVersion = "14.0";
  const hostArch = process.arch === "x64" ? "x86_64" : process.arch;
  const configureArgs = [
    `--prefix=${prefix}`,
    "--cc=clang",
    `--pkg-config=${disabledPkgConfigPath}`,
    "--disable-doc",
    "--disable-debug",
    "--disable-ffplay",
    "--disable-ffprobe",
    "--disable-network",
    "--enable-audiotoolbox",
    "--enable-videotoolbox",
    `--arch=${arch}`,
    "--target-os=darwin",
    `--extra-cflags=-arch ${arch} -mmacosx-version-min=${minVersion}`,
    `--extra-ldflags=-arch ${arch} -mmacosx-version-min=${minVersion}`
  ];
  if (arch !== hostArch) {
    configureArgs.push("--enable-cross-compile");
  }
  run("./configure", configureArgs, { cwd: sourceRoot });
  run("make", [`-j${Math.max(1, cpus().length)}`], { cwd: sourceRoot });
  run("make", ["install"], { cwd: sourceRoot });
  execFileSync("cp", [join(prefix, "bin", "ffmpeg"), slicePath], { stdio: "inherit" });
  verifyBinary(slicePath);
  return slicePath;
}

function ensureDisabledPkgConfig() {
  const script = `#!/bin/sh
case "$1" in
  --version)
    echo "0.0.0"
    exit 0
    ;;
esac
exit 1
`;
  if (!existsSync(disabledPkgConfigPath) || readFileSync(disabledPkgConfigPath, "utf8") !== script) {
    writeFileSync(disabledPkgConfigPath, script, { mode: 0o755 });
  }
  chmodSync(disabledPkgConfigPath, 0o755);
}

function verifyBinary(path) {
  const version = execFileSync(path, ["-version"], { encoding: "utf8" });
  const configLine = version
    .split(/\r?\n/)
    .find((line) => line.startsWith("configuration:")) ?? "";
  for (const flag of FORBIDDEN_CONFIG_FLAGS) {
    if (configLine.includes(flag)) {
      throw new Error(`bundled ffmpeg contains forbidden configure flag ${flag}`);
    }
  }
  const encoders = execFileSync(path, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  for (const encoder of REQUIRED_ENCODERS) {
    if (!encoders.includes(encoder)) {
      throw new Error(`bundled ffmpeg is missing required encoder ${encoder}`);
    }
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(file, argv, options) {
  console.log(`  $ ${file} ${argv.join(" ")}`);
  const result = spawnSync(file, argv, {
    cwd: options.cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      PKG_CONFIG_PATH: "",
      PKG_CONFIG_LIBDIR: ""
    }
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
