import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  findForbiddenAsarEntries,
  findForeignSharpAsarPackages,
  findForeignUnpackedNative,
  findMissingPackagedResources,
  findMissingSharpAsarRuntime,
  findMissingUnpackedNative,
  verifyAsarListing,
  verifyPackagedResources,
  verifySharpAsarRuntime,
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

function fakeWindowsApp() {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-win-app-"));
  const appPath = join(root, "win-unpacked");
  const resources = join(appPath, "resources");
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
  "app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.17.3.dylib"
];

function writeUnpackedNativeFixtures(resources, fixtures = allUnpackedNativeFixtures) {
  for (const relative of fixtures) {
    const absolute = join(resources, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${relative}\n`);
  }
}

function windowsUnpackedRuntimeFixtures(arch) {
  const packageRoot = `app.asar.unpacked/node_modules/@img/sharp-win32-${arch}`;
  return [
    `${packageRoot}/index.cjs`,
    `${packageRoot}/package.json`,
    `${packageRoot}/LICENSE`,
    `${packageRoot}/lib/sharp-win32-${arch}-0.35.3.node`,
    `${packageRoot}/lib/libvips-42.dll`,
    `${packageRoot}/lib/libvips-cpp-8.18.3.dll`,
    "app.asar.unpacked/node_modules/@img/colour/index.cjs",
    "app.asar.unpacked/node_modules/better-sqlite3/electron-native/better_sqlite3.node"
  ];
}

function windowsSharpAsarListing(arch) {
  const packageRoot = `/node_modules/@img/sharp-win32-${arch}`;
  return [
    "/node_modules/sharp/dist/index.cjs",
    "/node_modules/sharp/LICENSE",
    "/node_modules/@img/colour/index.cjs",
    `${packageRoot}/index.cjs`,
    `${packageRoot}/package.json`,
    `${packageRoot}/LICENSE`,
    `${packageRoot}/lib/sharp-win32-${arch}-0.35.3.node`
  ];
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

  test("allows app-owned prompt Markdown reported with Windows separators", () => {
    expect(findForbiddenAsarEntries(["\\out\\main\\prompts\\capture-enrichment.md"])).toEqual([]);
    expect(() => verifyAsarListing(["\\out\\main\\prompts\\capture-enrichment.md"])).not.toThrow();
  });

  test("passes packaged resource verification when notices and changelog exist", () => {
    const { appPath, resources } = fakeApp();
    writeResource(resources, "THIRD_PARTY_LICENSES");
    writeResource(resources, "CHANGELOG.md");
    writeResource(resources, "PwrSnapFFmpeg");

    expect(findMissingPackagedResources(appPath)).toEqual([]);
    expect(() => verifyPackagedResources(appPath)).not.toThrow();
  });

  test("fails packaged resource verification when third-party notices are missing", () => {
    const { appPath, resources } = fakeApp();
    writeResource(resources, "CHANGELOG.md");
    writeResource(resources, "PwrSnapFFmpeg");

    expect(findMissingPackagedResources(appPath)).toEqual(["THIRD_PARTY_LICENSES"]);
    expect(() => verifyPackagedResources(appPath)).toThrow(
      /missing packaged resource\(s\): THIRD_PARTY_LICENSES/,
    );
  });

  test("fails packaged resource verification when changelog is missing", () => {
    const { appPath, resources } = fakeApp();
    writeResource(resources, "THIRD_PARTY_LICENSES");
    writeResource(resources, "PwrSnapFFmpeg");

    expect(findMissingPackagedResources(appPath)).toEqual(["CHANGELOG.md"]);
    expect(() => verifyPackagedResources(appPath)).toThrow(
      /missing packaged resource\(s\): CHANGELOG\.md/,
    );
  });

  test("verifies Windows resources and native runtime sidecars", () => {
    const { appPath, resources } = fakeWindowsApp();
    for (const name of ["THIRD_PARTY_LICENSES", "CHANGELOG.md", "PwrSnapWindowList.exe"]) {
      writeResource(resources, name);
    }
    writeUnpackedNativeFixtures(resources, windowsUnpackedRuntimeFixtures("x64"));

    expect(findMissingPackagedResources(appPath, "win32")).toEqual([]);
    expect(findMissingUnpackedNative(appPath, "win32")).toEqual([]);
    expect(() => verifyPackagedResources(appPath, "win32")).not.toThrow();
    expect(() => verifyUnpackedNative(appPath, "win32")).not.toThrow();
  });

  test.each(["x64", "arm64"])(
    "selects and verifies the win32-%s Sharp runtime",
    (arch) => {
      const { appPath, resources } = fakeWindowsApp();
      writeUnpackedNativeFixtures(resources, windowsUnpackedRuntimeFixtures(arch));
      const listing = windowsSharpAsarListing(arch);

      expect(findMissingSharpAsarRuntime(listing, "win32", arch)).toEqual([]);
      expect(findForeignSharpAsarPackages(listing, "win32", arch)).toEqual([]);
      expect(findMissingUnpackedNative(appPath, "win32", arch)).toEqual([]);
      expect(findForeignUnpackedNative(appPath, "win32", arch)).toEqual([]);
      expect(() => verifySharpAsarRuntime(listing, "win32", arch)).not.toThrow();
      expect(() => verifyUnpackedNative(appPath, "win32", arch)).not.toThrow();
    }
  );

  test("rejects foreign Sharp native slices in both ASAR metadata and unpacked payload", () => {
    const { appPath, resources } = fakeWindowsApp();
    writeUnpackedNativeFixtures(resources, [
      ...windowsUnpackedRuntimeFixtures("x64"),
      "app.asar.unpacked/node_modules/@img/sharp-win32-arm64/lib/sharp-win32-arm64.node",
      "app.asar.unpacked/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node"
    ]);
    const listing = [
      ...windowsSharpAsarListing("x64"),
      "/node_modules/@img/sharp-win32-arm64/index.cjs",
      "/node_modules/@img/sharp-darwin-arm64/index.cjs"
    ];

    expect(findForeignSharpAsarPackages(listing, "win32", "x64")).toEqual([
      "sharp-darwin-arm64",
      "sharp-win32-arm64"
    ]);
    expect(findForeignUnpackedNative(appPath, "win32", "x64")).toEqual([
      "sharp-darwin-arm64",
      "sharp-win32-arm64"
    ]);
    expect(() => verifySharpAsarRuntime(listing, "win32", "x64")).toThrow(
      /foreign Sharp native slice\(s\).*@img\/sharp-darwin-arm64.*@img\/sharp-win32-arm64/s
    );
    expect(() => verifyUnpackedNative(appPath, "win32", "x64")).toThrow(
      /foreign Sharp native slice\(s\).*@img\/sharp-darwin-arm64.*@img\/sharp-win32-arm64/s
    );
  });

  test("fails arm64 verification when the staged target slice is x64", () => {
    const { appPath, resources } = fakeWindowsApp();
    writeUnpackedNativeFixtures(resources, windowsUnpackedRuntimeFixtures("x64"));
    const listing = windowsSharpAsarListing("x64");

    expect(findMissingSharpAsarRuntime(listing, "win32", "arm64")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/node_modules/@img/sharp-win32-arm64/index.cjs"
        })
      ])
    );
    expect(findMissingUnpackedNative(appPath, "win32", "arm64")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "@img/sharp-win32-arm64 JavaScript loader",
          reason: expect.stringContaining("directory missing")
        })
      ])
    );
    expect(() => verifySharpAsarRuntime(listing, "win32", "arm64")).toThrow(
      /missing @img\/sharp-win32-arm64 JavaScript loader/
    );
    expect(() => verifyUnpackedNative(appPath, "win32", "arm64")).toThrow(
      /@img\/sharp-win32-arm64 JavaScript loader.*directory missing/s
    );
  });

  test("requires Sharp JS glue and licenses at their exact ASAR paths", () => {
    const listing = windowsSharpAsarListing("x64").filter(
      (entry) =>
        ![
          "/node_modules/sharp/dist/index.cjs",
          "/node_modules/sharp/LICENSE",
          "/node_modules/@img/colour/index.cjs",
          "/node_modules/@img/sharp-win32-x64/LICENSE"
        ].includes(entry)
    );

    expect(findMissingSharpAsarRuntime(listing, "win32", "x64")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "sharp JavaScript runtime" }),
        expect.objectContaining({ label: "sharp license" }),
        expect.objectContaining({ label: "@img/colour JavaScript runtime" }),
        expect.objectContaining({ label: "@img/sharp-win32-x64 license" })
      ])
    );
    expect(() => verifySharpAsarRuntime(listing, "win32", "x64")).toThrow(
      /missing sharp JavaScript runtime.*missing sharp license.*missing @img\/colour JavaScript runtime.*missing @img\/sharp-win32-x64 license/s
    );
  });

  test("rejects lookalike files in place of Windows native libraries", () => {
    const { appPath, resources } = fakeWindowsApp();
    writeUnpackedNativeFixtures(resources, [
      ...windowsUnpackedRuntimeFixtures("x64").filter((path) => !path.includes("/lib/")),
      "app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-fake.node.txt",
      "app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll.bak",
      "app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/libvips-cpp-fake.dll.txt"
    ]);

    expect(findMissingUnpackedNative(appPath, "win32", "x64")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "@img/sharp-win32-x64 native binding" }),
        expect.objectContaining({ label: "@img/sharp-win32-x64 libvips runtime" }),
        expect.objectContaining({ label: "@img/sharp-win32-x64 libvips C++ runtime" })
      ])
    );
    expect(() => verifyUnpackedNative(appPath, "win32", "x64")).toThrow(
      /native binding.*libvips runtime.*libvips C\+\+ runtime/s
    );
  });

  test("requires the bundled Windows FFmpeg resource for release verification", () => {
    const { appPath, resources } = fakeWindowsApp();
    for (const name of ["THIRD_PARTY_LICENSES", "CHANGELOG.md", "PwrSnapWindowList.exe"]) {
      writeResource(resources, name);
    }
    const previous = process.env.PWRSNAP_REQUIRE_FFMPEG;
    process.env.PWRSNAP_REQUIRE_FFMPEG = "1";
    try {
      expect(findMissingPackagedResources(appPath, "win32")).toContain("PwrSnapFFmpeg.exe");
      writeResource(resources, "PwrSnapFFmpeg.exe");
      expect(findMissingPackagedResources(appPath, "win32")).toEqual([]);
    } finally {
      if (previous === undefined) {
        delete process.env.PWRSNAP_REQUIRE_FFMPEG;
      } else {
        process.env.PWRSNAP_REQUIRE_FFMPEG = previous;
      }
    }
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
      reason: expect.stringContaining("no entry matching /\\.dylib$/")
    });
    expect(() => verifyUnpackedNative(appPath)).toThrow(
      /@img\/sharp-libvips-darwin-x64 dylib.*no entry matching/s
    );
  });
});
