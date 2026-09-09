// Pins the app-icon assets that generate-app-icon.swift writes and, on a Mac
// with Xcode 26, compiles the Icon Composer package through electron-builder's
// own helper so a package that passes here is what packages at release time.
// Why the package exists at all: AGENTS.md "macOS app icon" and
// docs/solutions/2026-09-05-macos-26-legacy-icon-light-plate.md.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(here, "../build");
const iconPackage = join(buildDir, "icon.icon");
const glyphPng = join(iconPackage, "Assets", "glyph.png");
const windowsMaster = join(buildDir, "icon.png");
const developmentDockIcon = join(buildDir, "icon-macos.png");

/**
 * Read inside each test, not at describe scope: a missing or malformed
 * icon.json should fail the tests written to report it, not turn the whole
 * file into a collection error that registers no tests at all.
 */
function readManifest() {
  return JSON.parse(readFileSync(join(iconPackage, "icon.json"), "utf8"));
}

async function loadAlpha(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function alphaAt(image, x, y) {
  return image.data[(y * image.width + x) * image.channels + 3];
}

/** Bounding box of pixels with alpha >= 128, or null when fully transparent. */
function opaqueBounds(image) {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (alphaAt(image, x, y) < 128) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * The tile gradient, top then bottom, as `Color.bgTop` / `Color.bgBottom` in
 * generate-app-icon.swift. macOS 26 paints the package fill as the tile, so
 * the stops are pinned to the palette, not just to the `srgb:` shape.
 */
const TILE_GRADIENT_RGB = [
  [30, 26, 20],
  [10, 9, 8]
];

/** `srgb:r,g,b,1.00000` → 8-bit `[r, g, b]`, or null when malformed. */
function parseSrgbStop(stop) {
  const match = /^srgb:(\d\.\d{5}),(\d\.\d{5}),(\d\.\d{5}),1\.00000$/.exec(stop);
  if (match === null) return null;
  return match.slice(1, 4).map((channel) => Math.round(Number(channel) * 255));
}

describe("Icon Composer package (build/icon.icon)", () => {
  it("paints the tile with the generator's two-stop sRGB gradient", () => {
    const manifest = readManifest();
    expect(manifest.fill["linear-gradient"].map(parseSrgbStop)).toEqual(TILE_GRADIENT_RGB);
    expect(manifest["supported-platforms"].squares).toBe("shared");
  });

  it("references only layer images that exist in Assets/", () => {
    const imageNames = readManifest().groups.flatMap((group) =>
      group.layers.map((layer) => layer["image-name"])
    );
    expect(imageNames.length).toBeGreaterThan(0);
    for (const name of imageNames) {
      expect(existsSync(join(iconPackage, "Assets", name)), `missing Assets/${name}`).toBe(true);
    }
  });

  it("ships the mark alone, on a transparent 1024px canvas, inside the safe area", async () => {
    const glyph = await loadAlpha(glyphPng);
    expect({ width: glyph.width, height: glyph.height }).toEqual({ width: 1024, height: 1024 });

    // No baked tile: every corner and edge midpoint is fully transparent.
    for (const [x, y] of [
      [0, 0],
      [1023, 0],
      [0, 1023],
      [1023, 1023],
      [512, 0],
      [512, 1023],
      [0, 512],
      [1023, 512]
    ]) {
      expect(alphaAt(glyph, x, y), `alpha at ${x},${y}`).toBe(0);
    }

    // The mark stays inside Apple's 824-in-1024 safe area so nothing is
    // clipped by the icon shape on any platform.
    const bounds = opaqueBounds(glyph);
    expect(bounds).not.toBeNull();
    expect(bounds.x).toBeGreaterThanOrEqual(100);
    expect(bounds.y).toBeGreaterThanOrEqual(100);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(924);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(924);
  });
});

describe("flat PNG masters", () => {
  it("keeps the development Dock icon's tile inside Apple's legacy safe area", async () => {
    // app.dock.setIcon() paints this literally; see development-dock-icon.ts.
    expect(opaqueBounds(await loadAlpha(developmentDockIcon))).toEqual({
      x: 100,
      y: 100,
      width: 824,
      height: 824
    });
  });

  it("keeps the Windows master full-bleed", async () => {
    // electron-builder derives the .ico from this; Windows wants no margin.
    expect(opaqueBounds(await loadAlpha(windowsMaster))).toEqual({
      x: 0,
      y: 0,
      width: 1024,
      height: 1024
    });
  });
});

/**
 * Major version of the selected Xcode's actool (0 when unavailable) and why,
 * so a lane that requires it can report the probe failure instead of a bare
 * 0. electron-builder refuses to compile a .icon with anything below 26.
 */
function probeActool() {
  if (process.platform !== "darwin") return { major: 0, reason: `no actool on ${process.platform}` };
  try {
    const plist = execFileSync("xcrun", ["actool", "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const json = execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], {
      input: plist,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const short = String(JSON.parse(json)["com.apple.actool.version"]["short-bundle-version"]);
    return { major: Number.parseInt(short.split(".")[0], 10) || 0, reason: `actool ${short}` };
  } catch (error) {
    return { major: 0, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * electron-builder's own compile step, reached through its dependency graph
 * so this test cannot drift from what packages at release time. app-builder-lib
 * copies the package to `Icon.icon` (actool resolves `--app-icon Icon` by the
 * basename and silently writes no icns otherwise), creates the --compile
 * directory, runs its actool invocation, refuses actool < 26, and returns
 * Assets.car plus the derived legacy icns. The Info.plist keys are set by its
 * macPackager at package time (CFBundleIconName = Icon, CFBundleIconFile =
 * icon.icns), not by actool's partial plist, so they are not asserted here.
 */
function loadIconComposer() {
  const fromHere = createRequire(import.meta.url);
  const fromElectronBuilder = createRequire(fromHere.resolve("electron-builder"));
  return fromElectronBuilder("app-builder-lib/out/util/macosIconComposer");
}

const actool = probeActool();
const requireActool = process.env.PWRSNAP_REQUIRE_ACTOOL === "1";

// The skip below is a convenience for Linux, Windows, and Macs without Xcode
// 26 — not for the release lane, which exists to compile the package.
// release.yml sets PWRSNAP_REQUIRE_ACTOOL=1 on its unit-test step so a probe
// failure or a wrong Xcode selection fails here, with the reason, instead of
// surfacing as the first actool error inside the sign job.
it.runIf(requireActool)("finds actool 26+ when PWRSNAP_REQUIRE_ACTOOL=1", () => {
  expect(actool.major, actool.reason).toBeGreaterThanOrEqual(26);
});

describe.skipIf(actool.major < 26)("actool compile (macOS with Xcode 26+)", () => {
  let tempDir;
  let compiled;

  // Staged in beforeAll, not the describe body: vitest runs a skipped suite's
  // body at collection but never its hooks, so work there leaks a temp dir on
  // every platform that skips.
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pwrsnap-icon-compile-"));
    compiled = await loadIconComposer().generateAssetCatalogForIcon(iconPackage);
    writeFileSync(join(tempDir, "Icon.icns"), compiled.icnsFile);
  }, 120_000);

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("compiles to Assets.car plus a legacy icns", () => {
    expect(compiled.assetCatalog.byteLength).toBeGreaterThan(0);
    expect(compiled.icnsFile.subarray(0, 4).toString("latin1")).toBe("icns");
  });

  it("pads the generated legacy icns the way macOS 15 expects", async () => {
    // actool, not this repo, decides the legacy inset now. Pin that it
    // still lands on Apple's 824-in-1024 template (~80.5% fill) — the
    // reason the hand-built, padded .icns could be deleted at all.
    // actool writes four reps (16, 16@2x, 128, 128@2x; 256px is its
    // ceiling — see AGENTS.md) and iconutil's slot names for them are its
    // own business, so measure the largest PNG it extracts.
    const iconset = join(tempDir, "Icon.iconset");
    execFileSync("iconutil", ["-c", "iconset", join(tempDir, "Icon.icns"), "-o", iconset], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    const reps = await Promise.all(
      readdirSync(iconset)
        .filter((name) => name.endsWith(".png"))
        .map(async (name) => ({ file: join(iconset, name), image: await loadAlpha(join(iconset, name)) }))
    );
    expect(reps.length, "iconutil extracted no PNG reps from the actool icns").toBeGreaterThan(0);
    const largest = reps.reduce((best, rep) => (rep.image.width > best.image.width ? rep : best));
    expect(largest.image.width, "actool icns lost its large rep").toBeGreaterThanOrEqual(256);
    const bounds = opaqueBounds(largest.image);
    expect(bounds).not.toBeNull();
    const fill = bounds.width / largest.image.width;
    expect(fill).toBeGreaterThan(0.78);
    expect(fill).toBeLessThan(0.83);
  });
});
