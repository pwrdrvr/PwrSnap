// The app icon's glyph as an SVG string, for the tray PNGs.
//
// The numbers are READ from generate-app-icon.swift rather than copied, so
// the tray cannot drift from the icon: change the icon's rects and the next
// `pnpm --filter @pwrsnap/desktop tray-icon` follows. The in-app
// `PwrSnapMark` (renderer/src/features/shared/BrandMark.tsx) draws the same
// glyph with the same viewBox; design/AGENTS.md §1 lists every rendering.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const swift = readFileSync(resolve(here, "generate-app-icon.swift"), "utf8");

/** `let <name> = <n> * scale` (or `static let <name>: CGFloat = <n>`). */
function swiftConstant(name) {
  const match =
    new RegExp(`let ${name} = ([\\d.]+) \\* scale`).exec(swift) ??
    new RegExp(`static let ${name}: CGFloat = ([\\d.]+)`).exec(swift);
  if (match === null) throw new Error(`generate-app-icon.swift declares no \`${name}\``);
  return Number(match[1]);
}

// The stroke color is per-variant:
//   - macOS template PNG: full-opacity black → pure alpha; macOS tints it
//     for dark / light / accent menubars automatically.
//   - Windows / Linux tray PNG: the tangerine brand accent. There's no
//     template tinting on those platforms (the OS draws the icon as-is in
//     the notification area), so the icon must carry its own color. Tangerine
//     reads on both dark and light taskbars.
export const TRAY_TEMPLATE = "black";
export const TRAY_ACCENT = "#ff8a1f";

const CANVAS = 1024;
const w = swiftConstant("rectWidth");
const h = swiftConstant("rectHeight");
const dx = swiftConstant("offsetX");
const dy = swiftConstant("offsetY");

export const GLYPH = Object.freeze({
  width: w,
  height: h,
  rx: swiftConstant("rx"),
  stroke: swiftConstant("strokeWidth"),
  // Centred in the 1024 canvas. AppKit is y-up, so the icon's back tier
  // (+dx, +dy: top-right) has the SMALLER y in SVG.
  back: { x: CANVAS / 2 - w / 2 + dx, y: CANVAS / 2 - h / 2 - dy, opacity: swiftConstant("backAlpha") },
  mid: { x: CANVAS / 2 - w / 2, y: CANVAS / 2 - h / 2, opacity: swiftConstant("midAlpha") },
  front: { x: CANVAS / 2 - w / 2 - dx, y: CANVAS / 2 - h / 2 + dy, opacity: swiftConstant("frontAlpha") }
});

/** The glyph's ink bounds, stroke included, squared about their centre, so
 *  the mark fills its tile edge to edge with its ink centred. */
function viewBox() {
  const half = GLYPH.stroke / 2;
  const tiers = [GLYPH.back, GLYPH.mid, GLYPH.front];
  const left = Math.min(...tiers.map((t) => t.x)) - half;
  const right = Math.max(...tiers.map((t) => t.x)) + GLYPH.width + half;
  const top = Math.min(...tiers.map((t) => t.y)) - half;
  const bottom = Math.max(...tiers.map((t) => t.y)) + GLYPH.height + half;
  const side = Math.max(right - left, bottom - top);
  return [(left + right) / 2 - side / 2, (top + bottom) / 2 - side / 2, side, side];
}

export const GLYPH_VIEW_BOX = Object.freeze(viewBox());

function rect({ x, y }, attrs) {
  return `<rect x="${x}" y="${y}" width="${GLYPH.width}" height="${GLYPH.height}" rx="${GLYPH.rx}" ${attrs} />`;
}

// A tier's stroke band painted black into a luminance mask: whatever it
// covers is cut out of the tiers behind it.
function cut(at) {
  return rect(at, `fill="none" stroke="#000" stroke-width="${GLYPH.stroke}" stroke-linejoin="round"`);
}

/**
 * The glyph stroked in `stroke`, as a HARD STACK like the icon: each tier is
 * masked by the stroke bands of the tiers in front of it, so the 0.3 back
 * tier never shows through the 0.55 mid one. In the template variant a blend
 * would put extra alpha at every crossing, which macOS then tints brighter.
 */
export function glyphSvg(stroke) {
  const { back, mid, front } = GLYPH;
  const mask = `maskUnits="userSpaceOnUse" x="0" y="0" width="${CANVAS}" height="${CANVAS}"`;
  const plate = `<rect width="${CANVAS}" height="${CANVAS}" fill="#fff" />`;
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${GLYPH_VIEW_BOX.join(" ")}">
  <defs>
    <mask id="ps-behind-front" ${mask}>${plate}${cut(front)}</mask>
    <mask id="ps-behind-mid-front" ${mask}>${plate}${cut(mid)}${cut(front)}</mask>
  </defs>
  <g fill="none" stroke="${stroke}" stroke-width="${GLYPH.stroke}" stroke-linejoin="round">
    ${rect(back, `stroke-opacity="${back.opacity}" mask="url(#ps-behind-mid-front)"`)}
    ${rect(mid, `stroke-opacity="${mid.opacity}" mask="url(#ps-behind-front)"`)}
    ${rect(front, front.opacity === 1 ? "" : `stroke-opacity="${front.opacity}"`)}
  </g>
</svg>
`.trim();
}

/** One tray PNG: the glyph in `stroke`, rasterized square at `px`. The
 *  generator writes these and tray-icon.test.mjs re-renders them to prove the
 *  committed files are current. */
export function renderTrayPng(stroke, px) {
  return sharp(Buffer.from(glyphSvg(stroke)), { density: 72 * (px / 16) })
    .resize(px, px, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
