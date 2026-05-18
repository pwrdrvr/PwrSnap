// Pure helpers for the renderer's appearance (theme) system. No React,
// no Settings IPC, no localStorage side effects beyond what's called
// out below — the React layer in `useAppearance.ts` composes these
// into the live hook.
//
// Source of truth lives in Settings (DesktopSettingsService). The
// localStorage cache here is a first-paint optimization for the
// pre-React bootstrap in `index.html`: the bootstrap reads it
// synchronously before any JS module loads. The hook mirrors every
// Settings change into the cache so the next launch's bootstrap
// stays current.

import type { AppearanceTheme } from "@pwrsnap/shared";
import { isAppearanceTheme } from "@pwrsnap/shared";

/** What the theme resolves to after `"system"` is collapsed via
 *  `matchMedia`. Used to drive the `data-theme` attribute on `<html>`. */
export type ResolvedTheme = "dark" | "light";

/** Cache key the pre-React bootstrap (`index.html`) reads. Versioned
 *  so a future shape bump can ignore an older payload without
 *  collision. */
export const APPEARANCE_CACHE_KEY = "pwrsnap.appearance.v1";

/** Shape persisted in localStorage. Kept narrow on purpose — the
 *  bootstrap only needs `theme`. */
export type CachedAppearance = {
  theme: AppearanceTheme;
};

/** Resolve `"system"` to dark/light via `matchMedia`. Defaults to
 *  `"dark"` when no DOM is present (SSR / unit tests) — every
 *  PwrSnap window is dark by default, so the safe fallback matches
 *  the unattributed `:root` block in `tokens.css`. */
export function resolveTheme(theme: AppearanceTheme): ResolvedTheme {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Set or remove the `data-theme` attribute on `<html>`. Dark = no
 *  attribute (the bare `:root` block paints), light = `data-theme=
 *  "light"`. Keeping the attribute absent for the default theme
 *  keeps the cascade shallow and matches the bootstrap script.
 *
 *  Safe to call before React mounts — operates directly on
 *  `document.documentElement`. */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  if (resolved === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

/** Read the bootstrap cache. Returns `null` when localStorage is
 *  unavailable, missing, or holds a shape that doesn't validate.
 *  The hook's first paint should prefer the Settings snapshot when
 *  it's available; this is the fallback for the moments before
 *  Settings has loaded. */
export function readCachedAppearance(): CachedAppearance | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(APPEARANCE_CACHE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const theme = (parsed as { theme?: unknown }).theme;
    if (!isAppearanceTheme(theme)) return null;
    return { theme };
  } catch {
    return null;
  }
}

/** Mirror the current theme into localStorage so the next launch's
 *  pre-React bootstrap paints correctly. Best-effort: a quota error
 *  or disabled storage doesn't propagate — the in-memory state is
 *  always authoritative within a session. */
export function writeCachedAppearance(theme: AppearanceTheme): void {
  if (typeof window === "undefined") return;
  try {
    const payload: CachedAppearance = { theme };
    window.localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore — see docstring */
  }
}
