#!/usr/bin/env node
// Generates the macOS menubar template PNG (and @2x variant) from the
// PwrSnap brand mark SVG. Output: apps/desktop/build/tray-icon-template{,@2x}.png
//
// Template PNGs on macOS are alpha-only; the system inverts them to
// match dark / light / accent menubars. We generate from the same
// layered-rect SVG used in the design system (product-marks.html /
// BrandMark.tsx) — keeps brand consistency from the menubar all the
// way to the float-over header.
//
// Run via:
//   pnpm --filter @pwrsnap/desktop tray-icon

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const buildDir = resolve(repoRoot, "build");
mkdirSync(buildDir, { recursive: true });

// Layered-rect mark from design/preview/product-marks.html (PwrSnap
// card), scaled up to fill the menubar tile. The original design-system
// SVG used ~58% of the 128px viewBox; that read tiny next to other
// menubar icons (Codex, etc.). Bumped rects to span ~88% with a
// proportionally thicker stroke so the mark stays bold-and-balanced.
//
// currentColor is replaced with full-opacity black so the template
// PNG carries pure alpha — macOS handles dark / light / accent
// menubar tinting automatically.
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <g fill="none" stroke="black" stroke-width="13" stroke-linejoin="round">
    <rect x="36" y="6" width="78" height="62" rx="8" stroke-opacity="0.3" />
    <rect x="22" y="26" width="78" height="62" rx="8" stroke-opacity="0.55" />
    <rect x="8" y="46" width="78" height="62" rx="8" />
  </g>
</svg>
`.trim();

async function emit(targetPx, suffix) {
  const out = resolve(buildDir, `tray-icon-template${suffix}.png`);
  await sharp(Buffer.from(SVG), { density: 72 * (targetPx / 16) })
    .resize(targetPx, targetPx, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`wrote ${out}`);
}

await Promise.all([emit(16, ""), emit(32, "@2x"), emit(48, "@3x")]);
