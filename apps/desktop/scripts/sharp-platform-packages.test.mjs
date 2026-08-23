import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  partitionSharpNativePackages,
  pruneSharpNativePackages,
  sharpNativePackagesForTarget
} from "./sharp-platform-packages.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

function tempStage() {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-sharp-prune-"));
  roots.push(root);
  return { root, nodeModulesDir: join(root, "node_modules") };
}

function writeFixture(root, relative, contents = relative) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

const allPlatformPackages = [
  "colour",
  "sharp-darwin-arm64",
  "sharp-darwin-x64",
  "sharp-libvips-darwin-arm64",
  "sharp-libvips-darwin-x64",
  "sharp-win32-arm64",
  "sharp-win32-x64"
];

describe("Sharp platform package pruning", () => {
  test("selects the win32-x64 slice while retaining platform-independent @img packages", () => {
    expect(sharpNativePackagesForTarget({ platform: "win32", arch: "x64" })).toEqual([
      "sharp-win32-x64"
    ]);
    expect(
      partitionSharpNativePackages(allPlatformPackages, { platform: "win32", arch: "x64" })
    ).toEqual({
      kept: ["colour", "sharp-win32-x64"],
      removed: [
        "sharp-darwin-arm64",
        "sharp-darwin-x64",
        "sharp-libvips-darwin-arm64",
        "sharp-libvips-darwin-x64",
        "sharp-win32-arm64"
      ],
      required: ["sharp-win32-x64"],
      missing: []
    });
  });

  test("selects the win32-arm64 slice without enabling a new release target", () => {
    expect(sharpNativePackagesForTarget({ platform: "win32", arch: "arm64" })).toEqual([
      "sharp-win32-arm64"
    ]);
    expect(
      partitionSharpNativePackages(allPlatformPackages, { platform: "win32", arch: "arm64" })
    ).toMatchObject({
      kept: ["colour", "sharp-win32-arm64"],
      removed: expect.arrayContaining([
        "sharp-darwin-arm64",
        "sharp-darwin-x64",
        "sharp-libvips-darwin-arm64",
        "sharp-libvips-darwin-x64",
        "sharp-win32-x64"
      ]),
      required: ["sharp-win32-arm64"],
      missing: []
    });
  });

  test("removes foreign native slices without touching Sharp glue, licenses, or notices", () => {
    const { root, nodeModulesDir } = tempStage();
    const preserved = new Map([
      ["node_modules/sharp/dist/index.cjs", "sharp-js-glue"],
      ["node_modules/sharp/LICENSE", "sharp-license"],
      ["node_modules/@img/colour/index.cjs", "colour-js-glue"],
      ["node_modules/@img/colour/LICENSE.md", "colour-license"],
      ["node_modules/@img/sharp-win32-x64/index.cjs", "target-loader"],
      ["node_modules/@img/sharp-win32-x64/package.json", "target-manifest"],
      ["node_modules/@img/sharp-win32-x64/LICENSE", "target-license"],
      ["node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node", "target-binding"],
      ["THIRD_PARTY_LICENSES", "external-notices"]
    ]);
    for (const [relative, contents] of preserved) {
      writeFixture(root, relative, contents);
    }
    for (const packageName of [
      "sharp-darwin-arm64",
      "sharp-libvips-darwin-arm64",
      "sharp-darwin-x64",
      "sharp-libvips-darwin-x64",
      "sharp-win32-arm64"
    ]) {
      writeFixture(root, `node_modules/@img/${packageName}/lib/native.bin`);
    }

    const result = pruneSharpNativePackages({
      nodeModulesDir,
      platform: "win32",
      arch: "x64"
    });

    expect(result.removed).toHaveLength(5);
    for (const packageName of result.removed) {
      expect(existsSync(join(nodeModulesDir, "@img", packageName))).toBe(false);
    }
    for (const [relative, contents] of preserved) {
      expect(readFileSync(join(root, relative), "utf8")).toBe(contents);
    }
  });

  test("fails before deleting anything when the target slice is missing", () => {
    const { root, nodeModulesDir } = tempStage();
    const foreign = "node_modules/@img/sharp-darwin-arm64/lib/native.node";
    const colour = "node_modules/@img/colour/index.cjs";
    writeFixture(root, foreign, "foreign-native");
    writeFixture(root, colour, "colour-js-glue");

    expect(() =>
      pruneSharpNativePackages({ nodeModulesDir, platform: "win32", arch: "x64" })
    ).toThrow(/required Sharp target package\(s\) missing.*@img\/sharp-win32-x64/);

    expect(readFileSync(join(root, foreign), "utf8")).toBe("foreign-native");
    expect(readFileSync(join(root, colour), "utf8")).toBe("colour-js-glue");
  });
});
