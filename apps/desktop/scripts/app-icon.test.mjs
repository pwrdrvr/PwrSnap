// Pins the app-icon assets that generate-app-icon.swift writes and, on a
// Mac with Xcode 26, that actool compiles the Icon Composer package the
// same way electron-builder will at release time.
//
// Why these assertions exist: 1.1.0-alpha.6 shipped a hand-built legacy
// .icns padded to Apple's 824-in-1024 safe area. macOS 15 needs that
// padding, but macOS 26.6.2, handed ONLY a legacy .icns, composited the
// padded tile onto a light plate. The fix is to ship the .icon package
// (what macOS 26 reads) and let actool derive the padded legacy .icns
// (what macOS 15 reads). See docs/solutions/2026-09-05-macos-26-legacy-icon-light-plate.md.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(here, "../build");
const iconPackage = join(buildDir, "icon.icon");
const glyphPng = join(iconPackage, "Assets", "glyph.png");
const windowsMaster = join(buildDir, "icon.png");
const developmentDockIcon = join(buildDir, "icon-macos.png");

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

describe("Icon Composer package (build/icon.icon)", () => {
  const manifest = JSON.parse(readFileSync(join(iconPackage, "icon.json"), "utf8"));

  it("paints the tile with a two-stop sRGB gradient from the generator's palette", () => {
    const stops = manifest.fill["linear-gradient"];
    expect(stops).toHaveLength(2);
    for (const stop of stops) {
      expect(stop).toMatch(/^srgb:\d\.\d{5},\d\.\d{5},\d\.\d{5},1\.00000$/);
    }
    expect(manifest["supported-platforms"].squares).toBe("shared");
  });

  it("references only layer images that exist in Assets/", () => {
    const imageNames = manifest.groups.flatMap((group) =>
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
 * Major version of the selected Xcode's actool, or 0 when unavailable.
 * electron-builder refuses to compile a .icon with anything below 26.
 */
function actoolMajorVersion() {
  if (process.platform !== "darwin") return 0;
  try {
    const plist = execFileSync("xcrun", ["actool", "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const json = execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], {
      input: plist,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"]
    });
    const short = JSON.parse(json)["com.apple.actool.version"]["short-bundle-version"];
    return Number.parseInt(String(short).split(".")[0], 10) || 0;
  } catch {
    return 0;
  }
}

const actoolMajor = actoolMajorVersion();

describe.skipIf(actoolMajor < 26)("actool compile (macOS with Xcode 26+)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pwrsnap-icon-compile-"));
  // electron-builder copies the package to `Icon.icon` before compiling:
  // actool resolves `--app-icon Icon` by the package's basename, so the
  // repo's `icon.icon` must be staged under that name. It also does not
  // create its --compile directory. Mirror both so a package that passes
  // here is exactly what packages at release time.
  const stagedPackage = join(tempDir, "Icon.icon");
  const outputDir = join(tempDir, "out");
  const partialPlist = join(outputDir, "assetcatalog_generated_info.plist");
  cpSync(iconPackage, stagedPackage, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    "compiles to Assets.car plus a legacy icns padded to the safe area",
    () => {
      // The exact invocation app-builder-lib/out/util/macosIconComposer.js
      // uses, so a package that passes here packages at release time. The
      // "Accent color 'AccentColor' is not present" notice is expected.
      execFileSync(
        "actool",
        [
          stagedPackage,
          "--compile",
          outputDir,
          "--output-format",
          "human-readable-text",
          "--notices",
          "--warnings",
          "--output-partial-info-plist",
          partialPlist,
          "--app-icon",
          "Icon",
          "--include-all-app-icons",
          "--accent-color",
          "AccentColor",
          "--enable-on-demand-resources",
          "NO",
          "--development-region",
          "en",
          "--target-device",
          "mac",
          "--minimum-deployment-target",
          "26.0",
          "--platform",
          "macosx"
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      );

      expect(existsSync(join(outputDir, "Assets.car"))).toBe(true);
      expect(existsSync(join(outputDir, "Icon.icns"))).toBe(true);

      // Both keys: CFBundleIconName is what macOS 26 reads, CFBundleIconFile
      // is what macOS 15 falls back to. electron-builder writes the same pair.
      const plistJson = execFileSync("plutil", ["-convert", "json", "-o", "-", partialPlist], {
        encoding: "utf8"
      });
      expect(JSON.parse(plistJson)).toMatchObject({
        CFBundleIconName: "Icon",
        CFBundleIconFile: "Icon"
      });
    },
    120_000
  );

  it("pads the generated legacy icns the way macOS 15 expects", async () => {
    // actool, not this repo, decides the legacy inset now. Pin that it
    // still lands on Apple's 824-in-1024 template (~80.5% fill) — the
    // reason the hand-built, padded .icns could be deleted at all.
    // actool writes a handful of reps (16, 16@2x, 128, 256@2x today) and
    // iconutil's slot names for them are its own business — measure the
    // largest PNG it extracts rather than guessing a filename.
    const iconset = join(tempDir, "Icon.iconset");
    execFileSync("iconutil", ["-c", "iconset", join(outputDir, "Icon.icns"), "-o", iconset], {
      stdio: "ignore"
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
