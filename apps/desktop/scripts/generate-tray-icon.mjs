#!/usr/bin/env node
// Generates the tray PNGs from the app icon's glyph. Output:
// apps/desktop/build/tray-icon-template{,@2x,@3x}.png (macOS menubar),
// tray-icon{,@2x,@3x}.png (Windows) and tray-icon-linux.png.
//
// The drawing is tray-icon-glyph.mjs, which reads its numbers from
// generate-app-icon.swift: the same three tiers at 1 / 0.55 / 0.3 as the app
// icon and the in-app `PwrSnapMark`, in the same viewBox. design/AGENTS.md §1
// lists every rendering of the mark. Change the icon's glyph and rerun this;
// the tray has no geometry of its own.
//
// Run via:
//   pnpm --filter @pwrsnap/desktop tray-icon

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTrayPng, TRAY_ACCENT, TRAY_TEMPLATE } from "./tray-icon-glyph.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const buildDir = resolve(repoRoot, "build");
mkdirSync(buildDir, { recursive: true });

async function emit(stroke, baseName, targetPx, suffix) {
  const out = resolve(buildDir, `${baseName}${suffix}.png`);
  writeFileSync(out, await renderTrayPng(stroke, targetPx));
  console.log(`wrote ${out}`);
}

await Promise.all([
  // macOS menubar template (alpha-only; the system handles tinting)
  emit(TRAY_TEMPLATE, "tray-icon-template", 16, ""),
  emit(TRAY_TEMPLATE, "tray-icon-template", 32, "@2x"),
  emit(TRAY_TEMPLATE, "tray-icon-template", 48, "@3x"),
  // Windows colored tray icon (tangerine brand accent). Base is 16px with
  // @2x/@3x siblings, which is how `nativeImage.createFromPath` expects a
  // multi-DPI set: it loads the base and adds the siblings as scale-2 and
  // scale-3 REPRESENTATIONS of one 16pt image.
  emit(TRAY_ACCENT, "tray-icon", 16, ""),
  emit(TRAY_ACCENT, "tray-icon", 32, "@2x"),
  emit(TRAY_ACCENT, "tray-icon", 48, "@3x"),
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
  emit(TRAY_ACCENT, "tray-icon-linux", 48, "")
]);
