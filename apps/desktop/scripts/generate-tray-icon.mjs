#!/usr/bin/env node
// Generates the macOS menubar template PNG (and @2x/@3x variants) from the
// PwrSnap brand mark SVG. Output: apps/desktop/build/tray-icon-template{,@2x,@3x}.png
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
// The stroke color is per-variant:
//   - macOS template PNG: full-opacity black → pure alpha; macOS tints it
//     for dark / light / accent menubars automatically.
//   - Windows / Linux tray PNG: the tangerine brand accent. There's no
//     template tinting on those platforms (the OS draws the icon as-is in
//     the notification area), so the icon must carry its own color. Tangerine
//     reads on both dark and light taskbars.
//
// HARD STACK, not a blend: the three tiers must never composite through one
// another. Plain stroke-opacity layering lets the 0.3 back rect show through
// the 0.55 mid rect, and every crossing lights up as a denser patch (in the
// template variant that means extra alpha, which macOS then tints brighter).
// So each tier behind another is masked by the stroke band of the tiers in
// FRONT of it — the front and mid rects stay at exactly their own opacity
// everywhere they are seen, and the back rect is simply behind them.
const ACCENT = "#ff8a1f";
const BACK = { x: 36, y: 6 };
const MID = { x: 22, y: 26 };
const FRONT = { x: 8, y: 46 };
const RECT = 'width="78" height="62" rx="8"';
const SW = 13;

function cutRect({ x, y }) {
  return `<rect x="${x}" y="${y}" ${RECT} fill="none" stroke="#000" stroke-width="${SW}" stroke-linejoin="round" />`;
}

function svgFor(stroke) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <mask id="ps-behind-front" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
      <rect width="128" height="128" fill="#fff" />
      ${cutRect(FRONT)}
    </mask>
    <mask id="ps-behind-mid-front" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
      <rect width="128" height="128" fill="#fff" />
      ${cutRect(MID)}
      ${cutRect(FRONT)}
    </mask>
  </defs>
  <g fill="none" stroke="${stroke}" stroke-width="${SW}" stroke-linejoin="round">
    <rect x="${BACK.x}" y="${BACK.y}" ${RECT} stroke-opacity="0.3" mask="url(#ps-behind-mid-front)" />
    <rect x="${MID.x}" y="${MID.y}" ${RECT} stroke-opacity="0.55" mask="url(#ps-behind-front)" />
    <rect x="${FRONT.x}" y="${FRONT.y}" ${RECT} />
  </g>
</svg>
`.trim();
}

async function emit(svgStr, baseName, targetPx, suffix) {
  const out = resolve(buildDir, `${baseName}${suffix}.png`);
  await sharp(Buffer.from(svgStr), { density: 72 * (targetPx / 16) })
    .resize(targetPx, targetPx, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`wrote ${out}`);
}

const TEMPLATE_SVG = svgFor("black");
const COLORED_SVG = svgFor(ACCENT);

await Promise.all([
  // macOS menubar template (alpha-only; the system handles tinting)
  emit(TEMPLATE_SVG, "tray-icon-template", 16, ""),
  emit(TEMPLATE_SVG, "tray-icon-template", 32, "@2x"),
  emit(TEMPLATE_SVG, "tray-icon-template", 48, "@3x"),
  // Windows / Linux colored tray icon (tangerine brand accent)
  emit(COLORED_SVG, "tray-icon", 16, ""),
  emit(COLORED_SVG, "tray-icon", 32, "@2x"),
  emit(COLORED_SVG, "tray-icon", 48, "@3x")
]);
