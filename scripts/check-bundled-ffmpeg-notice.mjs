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
 * Runs in jobs with no checkout and no node_modules, so it uses node builtins
 * plus scripts/lib/cli-entrypoint.mjs, and both signing-input tarballs list
 * that helper (release.yml for macOS, archive-windows-signing-input.ps1 for
 * Windows). Do not add a third-party import.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

/**
 * Pull every version the notice attributes to FFmpeg.
 *
 * The generator emits the version in five places (dependency summary index,
 * two License Texts headings, the supplemental record body, and the LGPL-2.1
 * relinking / written source offer). Collecting all of them — rather than
 * grepping for the first — is deliberate: a partial hand-edit that fixes the
 * summary line but leaves the written offer claiming the old release is
 * exactly the kind of half-correct notice this check exists to reject.
 *
 * Each version tail must END on an alphanumeric. Letting it end on `.` or `-`
 * means "…bundled FFmpeg@8.1.1." captures "8.1.1." and the signing job aborts
 * with "claims more than one FFmpeg version (8.1.1, 8.1.1.)" — sending the
 * operator after a version bump for what was a punctuation edit.
 */
export function collectNoticeFfmpegVersions(notice) {
  const versions = new Set();
  for (const match of notice.matchAll(/\bFFmpeg@(\d+\.\d+(?:\.\d+)?(?:[0-9A-Za-z.+-]*[0-9A-Za-z])?)/g)) {
    versions.add(match[1]);
  }
  for (const match of notice.matchAll(
    /\bFFmpeg (\d+\.\d+(?:\.\d+)?(?:[0-9A-Za-z.+-]*[0-9A-Za-z])?) source\b/g,
  )) {
    versions.add(match[1]);
  }
  for (const match of notice.matchAll(
    /https:\/\/ffmpeg\.org\/releases\/ffmpeg-(\d+\.\d+(?:\.\d+)?(?:[0-9A-Za-z.+-]*[0-9A-Za-z])?)\.tar\.xz/g,
  )) {
    versions.add(match[1]);
  }
  return [...versions].sort();
}

const REMEDIATION = [
  "The bundled FFmpeg version is pinned in several places that have no compile-time link.",
  "Every one of these must move together — the agreement test enforces all of them:",
  "  - BUNDLED_FFMPEG_VERSION in scripts/generate-third-party-licenses.mjs",
  "    (then run `pnpm licenses:generate` and commit THIRD_PARTY_LICENSES)",
  "  - FFMPEG_VERSION and FFMPEG_ARTIFACT_NAME in .github/workflows/release.yml (macOS + Windows jobs)",
  "  - FFMPEG_ARTIFACT_NAME in .github/workflows/preview-build.yml",
  "  - the ffmpeg-<version>-*-{manifest.json,SOURCE-OFFER.txt,LGPL-NOTICE.txt} copy targets",
  "    in both workflows (six lines; easy to miss because they are shell literals)",
  "  - the pin tables in docs/ffmpeg-build-reference.md, docs/desktop-release-runbook.md",
  "    and docs/windows/README.md",
  "Repointing at a new build ALSO needs FFMPEG_BUILD_SHA (both release jobs + the",
  "preview job) and FFMPEG_SOURCE_SHA256 (both release jobs); bumping the version",
  "alone leaves CI downloading the previously pinned artifact.",
  "See docs/ffmpeg-build-reference.md § \"Bumping the bundled FFmpeg version\".",
].join("\n");

/** A version disagreement — the operator needs the full list of pins. */
function fail(message) {
  throw new Error(`${message}\n\n${REMEDIATION}`);
}

/** A wiring/IO failure — the pin list is noise pointing at the wrong fix. */
function plainError(message) {
  return new Error(message);
}

/**
 * @param {{ manifestPath: string, noticePath: string, sourceDir?: string }} options
 * @returns {{ version: string }} the agreed version, for logging
 */
export function checkBundledFfmpegNotice({ manifestPath, noticePath, sourceDir }) {
  if (!existsSync(manifestPath)) {
    throw plainError(`FFmpeg artifact manifest not found at ${manifestPath}`);
  }
  if (!existsSync(noticePath)) {
    throw plainError(`THIRD_PARTY_LICENSES not found at ${noticePath}`);
  }

  // Read outside the try: a directory, a permissions error, or a truncated
  // download is not a JSON problem, and reporting it as one points the on-call
  // operator at version pins for what is a download failure.
  let manifestText;
  try {
    manifestText = readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw plainError(`Cannot read the FFmpeg artifact manifest at ${manifestPath}: ${error.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw plainError(`FFmpeg artifact manifest at ${manifestPath} is not valid JSON: ${error.message}`);
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

  const version = artifactVersion.trim();
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
  if (noticeVersion !== version) {
    fail(
      `Bundled FFmpeg version mismatch: the artifact about to be packaged is ` +
        `${version} (per ${manifestPath}), but ${noticePath} claims ` +
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
  //
  // Supplying --source-dir asserts that source WAS staged. Absent, not a
  // directory, or holding no ffmpeg tarball are all failures — silently
  // skipping is how this arm would rot into a no-op that still prints
  // "passed". Callers with no staged source must omit the flag.
  let sourceTarballs = 0;
  if (sourceDir !== undefined) {
    if (!statSync(sourceDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw plainError(
        `--source-dir ${sourceDir} is not a directory. Pass it only for platforms that ` +
          "stage the FFmpeg source tarball; omit it otherwise, so a missing directory " +
          "cannot be mistaken for a passing check.",
      );
    }
    // Match the version anywhere in the name rather than pinning the exact
    // filename: every other consumer of this directory globs
    // (`cp "$dir"/source/ffmpeg-*.tar.xz`), so a build-repo naming variant like
    // ffmpeg-<v>-lgpl.tar.xz must not hard-fail a release it did not break.
    const tarballs = readdirSync(sourceDir).filter((entry) => /^ffmpeg-.*\.tar\.xz$/.test(entry));
    const matching = tarballs.filter((entry) => entry.includes(version));
    if (tarballs.length === 0) {
      throw plainError(
        `--source-dir ${sourceDir} contains no ffmpeg-*.tar.xz. The LGPL-2.1 written ` +
          "source offer would resolve to source this release never staged.",
      );
    }
    if (matching.length === 0) {
      fail(
        `Staged FFmpeg source tarball(s) ${tarballs.join(", ")} do not name the packaged ` +
          `binary's version ${version}. The written source offer in ${noticePath} would ` +
          "resolve to the wrong release.",
      );
    }
    sourceTarballs = matching.length;
  }

  return { version: noticeVersion, sourceTarballs };
}

const FLAGS = Object.freeze({
  "--manifest": "manifestPath",
  "--notice": "noticePath",
  "--source-dir": "sourceDir",
});

/**
 * Strict flag parsing: unknown flags and missing values are errors.
 *
 * Silently dropping an unrecognized argument is how a release gate rots — a
 * single mistyped `--sourcedir` would turn the staged-source reconciliation off
 * and still exit 0. `Object.hasOwn` (not `FLAGS[arg]`) keeps prototype keys
 * like "toString" from reading back a function and swallowing the next argument.
 */
export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const inlineAt = arg.indexOf("=");
    const name = inlineAt === -1 ? arg : arg.slice(0, inlineAt);
    if (!Object.hasOwn(FLAGS, name)) {
      throw plainError(`Unknown argument: ${arg}`);
    }
    const value = inlineAt === -1 ? argv[(index += 1)] : arg.slice(inlineAt + 1);
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw plainError(`${name} needs a value (got ${value === undefined ? "nothing" : `"${value}"`})`);
    }
    options[FLAGS[name]] = value;
  }
  return options;
}

// Guarded so the exported helpers stay unit-testable. A suffix test on
// process.argv[1] looks equivalent and fails OPEN: it is case-sensitive while
// Windows paths are not, and it misses a symlinked or wrapper invocation, so
// the gate exits 0 having checked nothing and both `set -e` and
// `if ($LASTEXITCODE -ne 0)` read that as success. isCliEntrypoint normalizes
// both sides; see docs/third-party-license-notices.md § "How the check can fail
// open" #2, which is the post-mortem for exactly that mistake.
if (isCliEntrypoint(import.meta.url)) {
  try {
    const { manifestPath, noticePath, sourceDir } = parseArgs(process.argv.slice(2));
    if (manifestPath === undefined || noticePath === undefined) {
      console.error(
        "Usage: node scripts/check-bundled-ffmpeg-notice.mjs --manifest <manifest.json> " +
          "--notice <THIRD_PARTY_LICENSES> [--source-dir <dir>]",
      );
      process.exit(2);
    }
    const { version, sourceTarballs } = checkBundledFfmpegNotice({
      manifestPath,
      noticePath,
      sourceDir,
    });
    // Report what was actually reconciled: an identical success line whether it
    // checked three tarballs or zero leaves no audit trail.
    const staged =
      sourceDir === undefined ? "no source dir checked" : `${sourceTarballs} source tarball(s)`;
    console.log(`bundled FFmpeg notice check passed (FFmpeg@${version}, ${staged})`);
  } catch (error) {
    console.error(`bundled FFmpeg notice check failed: ${error.message}`);
    process.exit(1);
  }
}
