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
// card). currentColor is replaced with full opacity black so the
// template PNG carries pure alpha — macOS handles tinting.
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <g fill="none" stroke="black" stroke-width="9" stroke-linejoin="round">
    <rect x="42" y="22" width="58" height="46" rx="6" stroke-opacity="0.3" />
    <rect x="34" y="36" width="58" height="46" rx="6" stroke-opacity="0.55" />
    <rect x="26" y="50" width="58" height="46" rx="6" />
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
