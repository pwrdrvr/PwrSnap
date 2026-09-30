#!/usr/bin/env node
// Generates the macOS menubar template PNG (and @2x/@3x variants) from the
// PwrSnap brand mark SVG. Output: apps/desktop/build/tray-icon-template{,@2x,@3x}.png
//
// Template PNGs on macOS are alpha-only; the system inverts them to
// match dark / light / accent menubars. The mark is the same stacked-
// screenshots idea as the app icon and the in-app `PwrSnapMark`
// (renderer/src/features/shared/BrandMark.tsx) — three tiers at 1 / 0.55 /
// 0.3 — drawn to its own proportions for the menubar tile. design/AGENTS.md
// §1 lists every rendering of the mark and which geometry each one uses.
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

// The tray keeps the in-app mark's ORIGINAL proportions (58×46 rects
// stepped 8 across and 14 up, in a 128 box), scaled up to fill the
// menubar tile. That drawing's ink spanned about 65% of its viewBox,
// which read tiny next to other menubar icons (Codex, etc.), so the rects
// here span about 90% with a proportionally thicker stroke. The in-app
// mark has since been redrawn from the app icon's glyph (wider 450×340
// rects stepped 64 / 80); this template has not, and changing it means
// regenerating and committing the PNGs (`pnpm --filter @pwrsnap/desktop
// tray-icon`).
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
  // Windows colored tray icon (tangerine brand accent). Base is 16px with
  // @2x/@3x siblings, which is how `nativeImage.createFromPath` expects a
  // multi-DPI set: it loads the base and adds the siblings as scale-2 and
  // scale-3 REPRESENTATIONS of one 16pt image.
  emit(COLORED_SVG, "tray-icon", 16, ""),
  emit(COLORED_SVG, "tray-icon", 32, "@2x"),
  emit(COLORED_SVG, "tray-icon", 48, "@3x"),
  // Linux gets its OWN 48px file, deliberately with no @Nx siblings.
  //
  // Electron's Linux tray is `StatusIconLinuxDbus`, which serializes the
  // image's scale-1 bitmap into the StatusNotifierItem `IconPixmap` property
  // and lets the panel scale from there. The @2x/@3x siblings above are
  // representations of ONE 16pt image, so they never become that bitmap:
  // measured on Electron 41.10.7, `createFromPath(...).toBitmap()` is 1024
  // bytes (16×16×4) for the `tray-icon.png` set and 9216 (48×48×4) for this
  // file. Publishing the 16px one means every HiDPI GNOME/KDE panel upscales
  // it and the mark turns to mush; 48px downscales cleanly at any panel
  // height. Do NOT rename this to `tray-icon-linux@3x.png` — the suffix is
  // exactly what would demote it back to a representation of a 16pt image.
  emit(COLORED_SVG, "tray-icon-linux", 48, "")
]);
