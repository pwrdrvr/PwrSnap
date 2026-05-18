// Wire format for the main → preload appearance hand-off.
//
// Main writes the persisted theme into every BrowserWindow's
// `webPreferences.additionalArguments` so the preload can surface it
// on `window.__pwrsnapAppearance` BEFORE the inline bootstrap script
// in `apps/desktop/src/renderer/index.html` runs. That eliminates the
// flash-of-wrong-theme that would otherwise occur on a cold launch
// in light theme (the bootstrap can't reach back to main, and
// localStorage may not be populated on first launch).
//
// Lives in `@pwrsnap/shared` so both sides agree on the prefix +
// envelope shape, and so the parser is testable from a Node-only
// vitest suite without spinning up Electron.

import type { AppearanceTheme } from "./protocol";
import { isAppearanceTheme } from "./protocol";

/** Argv token prefix. The full token looks like
 *  `--pwrsnap-appearance={"theme":"light"}`. Picked to be unique
 *  enough that no other CLI library will collide on it. */
export const APPEARANCE_ARG_PREFIX = "--pwrsnap-appearance=";

/** Envelope shape carried in the argv token. Narrow on purpose — the
 *  bootstrap only needs `theme`; everything else stays in the full
 *  Settings shape and reaches the renderer via the regular IPC. */
export type AppearanceArgPayload = {
  theme: AppearanceTheme;
};

/** Serialize a payload into the argv token string. */
export function serializeAppearanceArg(payload: AppearanceArgPayload): string {
  return `${APPEARANCE_ARG_PREFIX}${JSON.stringify(payload)}`;
}

/**
 * Find and parse the appearance argv token, if any.
 *
 * Returns the validated payload, or `null` when:
 *   - no argv element starts with the prefix
 *   - the JSON after the prefix doesn't parse
 *   - the parsed value isn't an object
 *   - `theme` isn't one of the known `AppearanceTheme` literals
 *
 * Designed to never throw: the preload calls this at module load
 * time, and an exception there would prevent
 * `contextBridge.exposeInMainWorld` from running and break the
 * renderer's main IPC bridge entirely. A `null` return falls through
 * to the bootstrap's localStorage / matchMedia path, which is the
 * intended degraded mode.
 */
export function parseAppearanceArg(
  argv: readonly string[]
): AppearanceArgPayload | null {
  for (const arg of argv) {
    if (typeof arg !== "string") continue;
    if (!arg.startsWith(APPEARANCE_ARG_PREFIX)) continue;
    const json = arg.slice(APPEARANCE_ARG_PREFIX.length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const theme = (parsed as { theme?: unknown }).theme;
    if (!isAppearanceTheme(theme)) return null;
    return { theme };
  }
  return null;
}
