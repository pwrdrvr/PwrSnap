import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  checkBundledFfmpegNotice,
  collectNoticeFfmpegVersions,
} from "../check-bundled-ffmpeg-notice.mjs";
import { BUNDLED_FFMPEG_VERSION } from "../generate-third-party-licenses.mjs";

// Deliberately not the shipping version. These tests assert the reconciliation
// logic, and pinning them to whatever ships today would make them pass for the
// wrong reason after a bump.
const ARTIFACT_VERSION = "9.9.9";

const roots = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true });
  }
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-ffmpeg-notice-"));
  roots.push(root);
  return root;
}

/** A notice shaped like the generator's output for a given version. */
function noticeFor(version) {
  return [
    `- FFmpeg@${version} | https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz`,
    "",
    `FFmpeg@${version} (LGPL-2.1-or-later)`,
    `PwrSnap bundles an FFmpeg executable built from the official FFmpeg ${version} source release`,
    `Source: https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz`,
    `this repository at docs/ffmpeg-build-reference.md, alongside the FFmpeg ${version} source`,
  ].join("\n");
}

function fixture({ artifactVersion = ARTIFACT_VERSION, notice, manifest, sourceTarball } = {}) {
  const root = tempRoot();
  const manifestPath = join(root, "manifest.json");
  const noticePath = join(root, "THIRD_PARTY_LICENSES");
  writeFileSync(
    manifestPath,
    JSON.stringify(manifest ?? { version: artifactVersion, platform: "macos", arch: "universal" }),
  );
  writeFileSync(noticePath, notice ?? noticeFor(artifactVersion));

  let sourceDir;
  if (sourceTarball !== undefined) {
    sourceDir = join(root, "source");
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, `ffmpeg-${sourceTarball}.tar.xz`), "");
  }
  return { manifestPath, noticePath, sourceDir };
}

describe("collectNoticeFfmpegVersions", () => {
  test("collects the version from every shape the generator emits", () => {
    expect(collectNoticeFfmpegVersions(noticeFor("8.1.1"))).toEqual(["8.1.1"]);
  });

  test("reports each distinct version so a partial hand-edit is visible", () => {
    // The failure this guards: someone bumps the dependency-summary line and
    // leaves the written source offer naming the previous release. Returning
    // only the first match would call that notice consistent.
    const partial = noticeFor("8.1.1").replace(
      "- FFmpeg@8.1.1 | https://ffmpeg.org/releases/ffmpeg-8.1.1.tar.xz",
      "- FFmpeg@8.2.0 | https://ffmpeg.org/releases/ffmpeg-8.2.0.tar.xz",
    );

    expect(collectNoticeFfmpegVersions(partial)).toEqual(["8.1.1", "8.2.0"]);
  });

  test("finds nothing in a notice with no FFmpeg record", () => {
    expect(collectNoticeFfmpegVersions("sharp@0.35.3 (Apache-2.0)\n")).toEqual([]);
  });
});

describe("checkBundledFfmpegNotice", () => {
  test("passes when the artifact, the notice, and the staged source agree", () => {
    const paths = fixture({ sourceTarball: ARTIFACT_VERSION });

    expect(checkBundledFfmpegNotice(paths)).toEqual({ version: ARTIFACT_VERSION });
  });

  test("fails when the build repo bumped but the notice was not regenerated", () => {
    // The whole point: pwrsnap-ffmpeg-builds owns FFMPEG_VERSION, PwrSnap's
    // notice restates it, and nothing else can observe the disagreement.
    const paths = fixture({ artifactVersion: "9.9.9", notice: noticeFor("8.1.1") });

    expect(() => checkBundledFfmpegNotice(paths)).toThrow(
      /Bundled FFmpeg version mismatch.*9\.9\.9.*claims FFmpeg@8\.1\.1/s,
    );
  });

  test("names every pin that has to move, so the failure is actionable at 2am", () => {
    const paths = fixture({ artifactVersion: "9.9.9", notice: noticeFor("8.1.1") });

    expect(() => checkBundledFfmpegNotice(paths)).toThrow(/BUNDLED_FFMPEG_VERSION/);
    expect(() => checkBundledFfmpegNotice(paths)).toThrow(/FFMPEG_ARTIFACT_NAME/);
  });

  test("rejects a notice that claims two different FFmpeg versions", () => {
    const paths = fixture({
      notice: `${noticeFor(ARTIFACT_VERSION)}\nFFmpeg@1.2.3 (LGPL-2.1-or-later)`,
    });

    expect(() => checkBundledFfmpegNotice(paths)).toThrow(/more than one FFmpeg version/);
  });

  test("rejects a notice with no FFmpeg attribution at all", () => {
    const paths = fixture({ notice: "sharp@0.35.3 (Apache-2.0)\n" });

    expect(() => checkBundledFfmpegNotice(paths)).toThrow(/does not attribute any version to FFmpeg/);
  });

  test("fails closed when the manifest carries no version", () => {
    // Skipping here would restore the exact hole this script closes, so an
    // unusable manifest must be an error rather than a pass.
    const paths = fixture({ manifest: { platform: "macos", arch: "universal" } });

    expect(() => checkBundledFfmpegNotice(paths)).toThrow(/no usable "version" field/);
  });

  test("fails closed on an unreadable manifest", () => {
    const root = tempRoot();
    const manifestPath = join(root, "manifest.json");
    const noticePath = join(root, "THIRD_PARTY_LICENSES");
    writeFileSync(manifestPath, "{ not json");
    writeFileSync(noticePath, noticeFor(ARTIFACT_VERSION));

    expect(() => checkBundledFfmpegNotice({ manifestPath, noticePath })).toThrow(/not valid JSON/);
  });

  test("fails closed when the manifest is missing entirely", () => {
    const { noticePath } = fixture();

    expect(() =>
      checkBundledFfmpegNotice({ manifestPath: join(tempRoot(), "absent.json"), noticePath }),
    ).toThrow(/manifest not found/);
  });

  test("catches a staged source tarball that is not the release we linked against", () => {
    // The written offer resolves to ffmpeg-<version>.tar.xz. If the staged
    // tarball is a different release, the offer points at source we did not
    // build from — an LGPL-2.1 compliance failure, not a naming nit.
    const paths = fixture({ artifactVersion: ARTIFACT_VERSION, sourceTarball: "8.1.1" });

    expect(() => checkBundledFfmpegNotice(paths)).toThrow(
      /Staged FFmpeg source tarball ffmpeg-8\.1\.1\.tar\.xz/,
    );
  });

  test("skips the source check when no source directory is staged", () => {
    const paths = fixture();

    expect(checkBundledFfmpegNotice({ ...paths, sourceDir: join(tempRoot(), "absent") })).toEqual({
      version: ARTIFACT_VERSION,
    });
  });

  test("accepts the real committed notice against a manifest for the shipping version", () => {
    // End-to-end over the actual THIRD_PARTY_LICENSES: proves the parser still
    // matches the generator's real output, not just the fixture's shape.
    const root = tempRoot();
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ version: BUNDLED_FFMPEG_VERSION }));

    // `new URL(...).pathname` would be the obvious way to reach the repo root
    // and is wrong on Windows: it yields "/D:/a/…", which readFileSync cannot
    // open. That is the same file-URL-vs-path confusion that made
    // licenses:check silently pass on Windows for months (see
    // docs/third-party-license-notices.md § "How the check can fail open" #2).
    const repoRoot = resolve(import.meta.dirname, "..", "..");

    expect(
      checkBundledFfmpegNotice({
        manifestPath,
        noticePath: join(repoRoot, "THIRD_PARTY_LICENSES"),
      }),
    ).toEqual({ version: BUNDLED_FFMPEG_VERSION });
  });
});
