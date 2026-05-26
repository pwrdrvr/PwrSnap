import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  findForbiddenAsarEntries,
  findMissingPackagedResources,
  findMissingUnpackedNative,
  verifyAsarListing,
  verifyPackagedResources,
  verifyUnpackedNative,
} from "./verify-asar-contents.mjs";

let tempRoots = [];

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

function fakeApp() {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-app-"));
  const appPath = join(root, "PwrSnap.app");
  const resources = join(appPath, "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  tempRoots.push(root);
  return { appPath, resources };
}

function writeResource(resources, name) {
  writeFileSync(join(resources, name), `${name}\n`);
}

// Mirrors the full set of platform binaries the production release
// flow injects into the stage. Tests start from a fully-populated
// fake app and selectively omit / corrupt entries to verify each
// failure mode independently.
const allUnpackedNativeFixtures = [
  "app.asar.unpacked/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node",
  "app.asar.unpacked/node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node",
  "app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib",
  "app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.17.3.dylib",
  "app.asar.unpacked/node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
  "app.asar.unpacked/node_modules/@ffmpeg-installer/darwin-x64/ffmpeg"
];

function writeUnpackedNativeFixtures(resources, fixtures = allUnpackedNativeFixtures) {
  for (const relative of fixtures) {
    const absolute = join(resources, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${relative}\n`);
  }
}

describe("verify-asar-contents", () => {
  test("flags forbidden ASAR entries", () => {
    expect(
      findForbiddenAsarEntries([
        "/out/main/index.js",
        "/node_modules/@pwrsnap/shared/src/index.ts",
        "/docs/readme.md",
      ]),
    ).toEqual([
      { label: "TypeScript source", entry: "/node_modules/@pwrsnap/shared/src/index.ts" },
      { label: "Markdown", entry: "/docs/readme.md" },
    ]);
  });

  test("throws with a grouped message for forbidden ASAR entries", () => {
    expect(() => verifyAsarListing(["/docs/readme.md"])).toThrow(
      /forbidden file\(s\) in app\.asar/,
    );
  });

  test("allows app-owned prompt Markdown in ASAR", () => {
    expect(findForbiddenAsarEntries(["/out/main/prompts/capture-enrichment.md"])).toEqual([]);
    expect(() => verifyAsarListing(["/out/main/prompts/capture-enrichment.md"])).not.toThrow();
  });

  test("passes packaged resource verification when notices and changelog exist", () => {
    const { appPath, resources } = fakeApp();
    writeResource(resources, "THIRD_PARTY_LICENSES");
    writeResource(resources, "CHANGELOG.md");

    expect(findMissingPackagedResources(appPath)).toEqual([]);
    expect(() => verifyPackagedResources(appPath)).not.toThrow();
  });

  test("fails packaged resource verification when third-party notices are missing", () => {
    const { appPath, resources } = fakeApp();
    writeResource(resources, "CHANGELOG.md");

    expect(findMissingPackagedResources(appPath)).toEqual(["THIRD_PARTY_LICENSES"]);
    expect(() => verifyPackagedResources(appPath)).toThrow(
      /missing packaged resource\(s\): THIRD_PARTY_LICENSES/,
    );
  });

  test("fails packaged resource verification when changelog is missing", () => {
    const { appPath, resources } = fakeApp();
    writeResource(resources, "THIRD_PARTY_LICENSES");

    expect(findMissingPackagedResources(appPath)).toEqual(["CHANGELOG.md"]);
    expect(() => verifyPackagedResources(appPath)).toThrow(
      /missing packaged resource\(s\): CHANGELOG\.md/,
    );
  });

  test("passes unpacked-native verification when every platform binary is present", () => {
    const { appPath, resources } = fakeApp();
    writeUnpackedNativeFixtures(resources);

    expect(findMissingUnpackedNative(appPath)).toEqual([]);
    expect(() => verifyUnpackedNative(appPath)).not.toThrow();
  });

  test("fails unpacked-native verification when a platform directory is missing", () => {
    // Drop the entry whose absence reproduces the Beta.3 crash —
    // app.asar.unpacked/.../sharp-darwin-arm64/lib/ — so this test
    // guards the exact regression the parent fix exists to prevent.
    const { appPath, resources } = fakeApp();
    writeUnpackedNativeFixtures(
      resources,
      allUnpackedNativeFixtures.filter(
        (path) => !path.includes("@img/sharp-darwin-arm64/")
      )
    );

    const missing = findMissingUnpackedNative(appPath);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      label: "@img/sharp-darwin-arm64 native binding",
      reason: expect.stringContaining("directory missing")
    });
    expect(() => verifyUnpackedNative(appPath)).toThrow(
      /@img\/sharp-darwin-arm64 native binding.*directory missing/s
    );
  });

  test("fails unpacked-native verification when a directory exists but lacks the required file pattern", () => {
    // Reproduces the asarUnpack-rule-missing case: the @img package
    // was injected (so the directory exists), but the libvips
    // .dylib stayed inside app.asar (so the lib/ directory has no
    // .dylib entry). macOS dyld would fail at runtime.
    const { appPath, resources } = fakeApp();
    writeUnpackedNativeFixtures(
      resources,
      allUnpackedNativeFixtures.filter(
        (path) => !path.includes("sharp-libvips-darwin-x64/")
      )
    );
    // Create the lib/ directory itself so the check has to fall
    // through to the substring assertion instead of bailing on
    // existsSync.
    mkdirSync(
      join(resources, "app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-x64/lib"),
      { recursive: true }
    );

    const missing = findMissingUnpackedNative(appPath);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      label: "@img/sharp-libvips-darwin-x64 dylib",
      reason: expect.stringContaining('no entry matching ".dylib"')
    });
    expect(() => verifyUnpackedNative(appPath)).toThrow(
      /@img\/sharp-libvips-darwin-x64 dylib.*no entry matching/s
    );
  });
});
