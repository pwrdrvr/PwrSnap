// The tray PNGs are the app icon's glyph (tray-icon-glyph.mjs reads it from
// generate-app-icon.swift). Nothing regenerates them on its own, so a change
// to the icon's glyph that skips `pnpm --filter @pwrsnap/desktop tray-icon`
// would leave the menubar drawing the old mark. These tests re-render every
// committed PNG and fail when it is stale.
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { GLYPH, GLYPH_VIEW_BOX, renderTrayPng, TRAY_ACCENT, TRAY_TEMPLATE } from "./tray-icon-glyph.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(here, "../build");
const trayPngs = readdirSync(buildDir).filter((f) => /^tray-icon.*\.png$/.test(f));

async function rgba(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

describe("tray icon", () => {
  it("draws the icon glyph: 450×340 tiers stepped 64 / 80, 1 / 0.55 / 0.3", () => {
    expect(GLYPH).toMatchObject({ width: 450, height: 340, rx: 48, stroke: 56 });
    expect(GLYPH.front).toEqual({ x: 223, y: 422, opacity: 1 });
    expect(GLYPH.mid).toEqual({ x: 287, y: 342, opacity: 0.55 });
    expect(GLYPH.back).toEqual({ x: 351, y: 262, opacity: 0.3 });
    // Same box as PwrSnapMark's VIEW_BOX (BrandMark.tsx).
    expect(GLYPH_VIEW_BOX).toEqual([195, 195, 634, 634]);
  });

  it("finds every tray PNG the generator writes", () => {
    expect(trayPngs.sort()).toEqual([
      "tray-icon-linux.png",
      "tray-icon-template.png",
      "tray-icon-template@2x.png",
      "tray-icon-template@3x.png",
      "tray-icon.png",
      "tray-icon@2x.png",
      "tray-icon@3x.png"
    ]);
  });

  it.each(trayPngs)("%s is current with the glyph", async (file) => {
    const committed = await rgba(join(buildDir, file));
    expect(committed.width).toBe(committed.height);
    const stroke = file.startsWith("tray-icon-template") ? TRAY_TEMPLATE : TRAY_ACCENT;
    const fresh = await rgba(await renderTrayPng(stroke, committed.width));
    // A few levels of slack for rasterizer drift between libvips builds; a
    // stale drawing is off by hundreds on the pixels it moved.
    let worst = 0;
    for (let i = 0; i < fresh.data.length; i++) {
      worst = Math.max(worst, Math.abs(fresh.data[i] - committed.data[i]));
    }
    expect(worst, `${file} differs from a fresh render — run the tray-icon script`).toBeLessThanOrEqual(8);
  });
});
