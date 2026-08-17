#!/usr/bin/env node
/**
 * Assert the shipping THIRD_PARTY_LICENSES names the FFmpeg version actually
 * being packaged.
 *
 * Every other version in the notice is derived from something in this repo —
 * `pnpm licenses list` for production deps, the installed `sharp` manifest for
 * the macOS arm64 native packages. The bundled ffmpeg has no such anchor: it is
 * built by github.com/pwrdrvr/pwrsnap-ffmpeg-builds, which owns `FFMPEG_VERSION`
 * in its own scripts/lib/config.mjs, and PwrSnap only ever sees the compiled
 * artifact. So the version in the notice is a hand-maintained *claim* about
 * another repository's constant, and nothing in a normal build can contradict
 * it.
 *
 * That is the same defect class that let the hardcoded @img/sharp-darwin-arm64
 * pin drift from 0.34.5 to a shipping 0.35.3 unnoticed (fixed in df421b58 by
 * deriving it from the installed sharp manifest). Deriving is not available
 * here, so we verify instead: the build repo emits a manifest.json alongside
 * every artifact, CI already downloads and validates it, and this script
 * additionally requires it to agree with the notice we are about to put inside
 * the app bundle.
 *
 * Run it in the signing jobs, after the artifact is downloaded and before it is
 * packaged, so a build-repo version bump that nobody mirrored into
 * THIRD_PARTY_LICENSES fails the release instead of shipping a false LGPL-2.1
 * attribution and a written source offer pointing at the wrong tarball.
 *
 * Usage:
 *   node scripts/check-bundled-ffmpeg-notice.mjs \
 *     --manifest <downloaded artifact manifest.json> \
 *     --notice   <THIRD_PARTY_LICENSES about to be packaged> \
 *     [--source-dir <dir holding the staged ffmpeg-<version>.tar.xz>]
 *
 * Intentionally dependency-free (node builtins only) so it can travel in the
 * Windows signing-input tarball, which has no checkout and no node_modules.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

/**
 * Pull every version the notice attributes to FFmpeg.
 *
 * The generator emits the version in five places (dependency summary index,
 * two License Texts headings, the supplemental record body, and the LGPL-2.1
 * relinking / written source offer). Collecting all of them — rather than
 * grepping for the first — is deliberate: a partial hand-edit that fixes the
 * summary line but leaves the written offer claiming the old release is
 * exactly the kind of half-correct notice this check exists to reject.
 */
export function collectNoticeFfmpegVersions(notice) {
  const versions = new Set();
  for (const match of notice.matchAll(/\bFFmpeg@(\d+\.\d+(?:\.\d+)?[0-9A-Za-z.+-]*)/g)) {
    versions.add(match[1]);
  }
  for (const match of notice.matchAll(
    /\bFFmpeg (\d+\.\d+(?:\.\d+)?[0-9A-Za-z.+-]*) source\b/g,
  )) {
    versions.add(match[1]);
  }
  for (const match of notice.matchAll(
    /https:\/\/ffmpeg\.org\/releases\/ffmpeg-(\d+\.\d+(?:\.\d+)?[0-9A-Za-z.+-]*)\.tar\.xz/g,
  )) {
    versions.add(match[1]);
  }
  return [...versions].sort();
}

const REMEDIATION = [
  "The bundled FFmpeg version is pinned in several places that have no compile-time link:",
  "  - BUNDLED_FFMPEG_VERSION in scripts/generate-third-party-licenses.mjs",
  "    (then run `pnpm licenses:generate` and commit THIRD_PARTY_LICENSES)",
  "  - FFMPEG_VERSION and FFMPEG_ARTIFACT_NAME in .github/workflows/release.yml (macOS + Windows jobs)",
  "  - FFMPEG_ARTIFACT_NAME in .github/workflows/preview-build.yml",
  "  - the pin table in docs/ffmpeg-build-reference.md",
  "See docs/ffmpeg-build-reference.md § \"Bumping the bundled FFmpeg version\".",
].join("\n");

function fail(message) {
  throw new Error(`${message}\n\n${REMEDIATION}`);
}

/**
 * @param {{ manifestPath: string, noticePath: string, sourceDir?: string }} options
 * @returns {{ version: string }} the agreed version, for logging
 */
export function checkBundledFfmpegNotice({ manifestPath, noticePath, sourceDir }) {
  if (!existsSync(manifestPath)) {
    fail(`FFmpeg artifact manifest not found at ${manifestPath}`);
  }
  if (!existsSync(noticePath)) {
    fail(`THIRD_PARTY_LICENSES not found at ${noticePath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`FFmpeg artifact manifest at ${manifestPath} is not valid JSON: ${error.message}`);
  }

  const artifactVersion = manifest?.version;
  if (typeof artifactVersion !== "string" || artifactVersion.trim().length === 0) {
    // A manifest without a version cannot be checked against, and silently
    // skipping would restore exactly the hole this script closes.
    fail(
      `FFmpeg artifact manifest at ${manifestPath} has no usable "version" field ` +
        `(got ${JSON.stringify(artifactVersion)}). The build repo emits it in ` +
        "build-ffmpeg.mjs / verify-ffmpeg.mjs; a manifest without it cannot be " +
        "reconciled against the shipped notice.",
    );
  }

  const notice = readFileSync(noticePath, "utf8");
  const claimed = collectNoticeFfmpegVersions(notice);

  if (claimed.length === 0) {
    fail(
      `${noticePath} does not attribute any version to FFmpeg. PwrSnap ships an ` +
        "LGPL-2.1 binary, so the notice must carry the FFmpeg record — an empty " +
        "one is a licence-compliance failure, not a formatting nit.",
    );
  }
  if (claimed.length > 1) {
    fail(
      `${noticePath} claims more than one FFmpeg version (${claimed.join(", ")}). ` +
        "The notice was probably hand-edited in one place and not the others; " +
        "regenerate it rather than patching individual lines.",
    );
  }

  const noticeVersion = claimed[0];
  if (noticeVersion !== artifactVersion.trim()) {
    fail(
      `Bundled FFmpeg version mismatch: the artifact about to be packaged is ` +
        `${artifactVersion} (per ${manifestPath}), but ${noticePath} claims ` +
        `FFmpeg@${noticeVersion}.\n` +
        "Shipping this would attribute the wrong upstream release and point the " +
        "LGPL-2.1 written source offer at a tarball that is not the one linked " +
        "against.",
    );
  }

  // The written source offer names https://ffmpeg.org/releases/ffmpeg-<v>.tar.xz,
  // and CI stages that tarball next to the binary. Its filename carries the
  // version independently of the manifest, so it is worth reconciling too: a
  // mismatch here means the offer resolves to source we did not build from.
  if (sourceDir !== undefined && existsSync(sourceDir) && statSync(sourceDir).isDirectory()) {
    const tarballs = readdirSync(sourceDir).filter(
      (entry) => entry.startsWith("ffmpeg-") && entry.endsWith(".tar.xz"),
    );
    for (const tarball of tarballs) {
      const match = /^ffmpeg-(.+)\.tar\.xz$/.exec(basename(tarball));
      if (match !== null && match[1] !== artifactVersion.trim()) {
        fail(
          `Staged FFmpeg source tarball ${tarball} does not match the packaged ` +
            `binary's version ${artifactVersion}. The written source offer in ` +
            "THIRD_PARTY_LICENSES would resolve to the wrong release.",
        );
      }
    }
  }

  return { version: noticeVersion };
}

function parseArgs(argv) {
  const options = {};
  const keys = { "--manifest": "manifestPath", "--notice": "noticePath", "--source-dir": "sourceDir" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = keys[argv[index]];
    if (key !== undefined) {
      options[key] = argv[index + 1];
      index += 1;
      continue;
    }
    const inline = Object.entries(keys).find(([flag]) => argv[index].startsWith(`${flag}=`));
    if (inline !== undefined) {
      options[inline[1]] = argv[index].slice(inline[0].length + 1);
    }
  }
  return options;
}

// Guarded so the exported helpers stay unit-testable. Deliberately not using
// scripts/lib/cli-entrypoint.mjs: this file must stay importable from the
// Windows signing job, which unpacks a tarball with no scripts/lib in it.
const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("check-bundled-ffmpeg-notice.mjs")) {
  const { manifestPath, noticePath, sourceDir } = parseArgs(process.argv.slice(2));
  if (manifestPath === undefined || noticePath === undefined) {
    console.error(
      "Usage: node scripts/check-bundled-ffmpeg-notice.mjs --manifest <manifest.json> " +
        "--notice <THIRD_PARTY_LICENSES> [--source-dir <dir>]",
    );
    process.exit(2);
  }
  try {
    const { version } = checkBundledFfmpegNotice({ manifestPath, noticePath, sourceDir });
    console.log(`bundled FFmpeg notice check passed (FFmpeg@${version})`);
  } catch (error) {
    console.error(`bundled FFmpeg notice check failed: ${error.message}`);
    process.exit(1);
  }
}
