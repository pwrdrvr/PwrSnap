// Synchronous reader for the persisted theme, used at BrowserWindow
// construction time to pick the right `backgroundColor`.
//
// Why this exists: BrowserWindow.backgroundColor paints the window
// frame from the moment the OS shows it until the renderer's first
// HTML paint lands (~50–150ms in practice). If we hardcoded #000000,
// every light-theme launch would flash pure black before the inline
// bootstrap in index.html could flip <html data-theme="light">. By
// reading the persisted theme synchronously and seeding the
// constructor with the matching surface color, the frame already
// reads the right way from the very first OS-level paint.
//
// We deliberately keep this module narrow — sync I/O on a tiny JSON
// file, no DesktopSettingsService dependency, no Logger. Reading
// happens on every window construction (handful per session, cheap)
// rather than caching, so a theme change in the Settings page
// propagates to the next opened window without invalidation tracking.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app, nativeTheme } from "electron";
import type { AppearanceTheme } from "@pwrsnap/shared";
import { isAppearanceTheme } from "@pwrsnap/shared";
import { serializeAppearanceArg } from "@pwrsnap/shared/appearance-arg";

/** Surface color when the user is in dark mode. Matches
 *  `--bg-app` in `apps/desktop/src/renderer/src/styles/tokens.css`
 *  under the bare `:root` block. */
export const STARTUP_BG_DARK = "#000000";

/** Surface color when the user is in light mode. Matches
 *  `--bg-app` in the `:root[data-theme="light"]` override block. */
export const STARTUP_BG_LIGHT = "#ffffff";

function settingsFilePath(): string {
  // `app.getPath("userData")` is only valid after `app` is ready. Every
  // call site (window factories) is reached inside `app.whenReady()`,
  // so this is safe.
  return join(app.getPath("userData"), "pwrsnap-settings.json");
}

function readPersistedTheme(): AppearanceTheme {
  const filePath = settingsFilePath();
  if (!existsSync(filePath)) return "system";
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return "system";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "system";
  }
  if (typeof parsed !== "object" || parsed === null) return "system";
  const appearance = (parsed as { appearance?: unknown }).appearance;
  if (typeof appearance !== "object" || appearance === null) return "system";
  const theme = (appearance as { theme?: unknown }).theme;
  return isAppearanceTheme(theme) ? theme : "system";
}

/**
 * Read the persisted theme + resolve `"system"` to dark/light using
 * Electron's `nativeTheme.shouldUseDarkColors`. Returns the hex
 * background color that matches `--bg-app` for the resolved theme.
 *
 * Safe to call from any window factory after `app.whenReady()`.
 */
export function getStartupBackgroundColor(): string {
  const theme = readPersistedTheme();
  if (theme === "dark") return STARTUP_BG_DARK;
  if (theme === "light") return STARTUP_BG_LIGHT;
  // "system" — defer to Electron's native theme query. This matches
  // what the inline bootstrap in index.html does via matchMedia,
  // keeping the OS-paint frame and the first React paint visually
  // aligned.
  return nativeTheme.shouldUseDarkColors ? STARTUP_BG_DARK : STARTUP_BG_LIGHT;
}

/**
 * Build the `webPreferences.additionalArguments` payload that pipes
 * the persisted theme through to the preload's appearance bridge.
 *
 * Without this, a cold launch in light theme has to wait for
 * `main.tsx` to import the CSS module + run the React hook before
 * the renderer learns the user's preference — and the gap shows up
 * as a brief flash of the dark default. Threading the theme through
 * `additionalArguments` makes the value available synchronously to
 * the preload, which sets it on `window` before the page script ever
 * runs. The inline bootstrap reads from there in `<head>`, well
 * before any CSS loads.
 *
 * The wire format lives in `@pwrsnap/shared/appearance-arg` so main +
 * preload agree on the prefix and envelope without either side
 * duplicating the literal. Returned as a single-element array ready
 * to spread into `webPreferences.additionalArguments`.
 */
export function getStartupAppearanceArgs(): readonly string[] {
  const theme = readPersistedTheme();
  return [serializeAppearanceArg({ theme })];
}
