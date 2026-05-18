// React layer over the pure helpers in `appearance.ts`.
//
// Responsibilities:
//
//   1. Reconcile a starting theme from (settings snapshot ?? cached
//      bootstrap ?? "system") and apply the `data-theme` attribute on
//      `<html>` synchronously on first render.
//   2. Subscribe to OS `prefers-color-scheme` flips while theme ===
//      "system", and re-apply on change.
//   3. When the caller writes a new theme, persist it to Settings
//      (source of truth) AND mirror it to localStorage (first-paint
//      cache the pre-React bootstrap in index.html reads).
//   4. Adopt updates that arrive via the Settings broadcast (cross-
//      window sync — a write in the Settings window propagates to
//      the Library, the tray, the float-over, etc.) without echoing
//      back through the writer.
//
// Call this once at the App root per BrowserWindow. Each window has
// its own React tree and its own document; each needs the OS-sync
// listener wired locally.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppearanceTheme, Settings, SettingsChangedEvent } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared/ipc";
import { dispatch, subscribe } from "./pwrsnap";
import {
  applyResolvedTheme,
  readCachedAppearance,
  resolveTheme,
  writeCachedAppearance,
  type ResolvedTheme
} from "./appearance";

export type AppearanceController = {
  /** Persisted preference. `"system"` resolves dynamically. */
  theme: AppearanceTheme;
  /** What the `data-theme` attribute is currently set to. Light when
   *  this is `"light"`, attribute absent otherwise. */
  resolvedTheme: ResolvedTheme;
  /** Set theme. Persists to Settings and to the localStorage cache,
   *  and applies the DOM attribute immediately. The Settings write
   *  is fire-and-forget — if it rejects, the in-memory state stays
   *  optimistic and a future broadcast reconciles. */
  setTheme: (next: AppearanceTheme) => void;
};

export type UseAppearanceInput = {
  /** Latest known theme from the Settings snapshot, or `undefined`
   *  while Settings is still loading. The hook adopts changes here
   *  whenever they differ from local state (cross-window sync). */
  settingsTheme: AppearanceTheme | undefined;
  /** Persist a theme write to Settings. Wired by the caller because
   *  the hook stays free of Settings IPC details — easier to test. */
  writeTheme: (theme: AppearanceTheme) => Promise<void>;
};

export function useAppearance(input: UseAppearanceInput): AppearanceController {
  // Initial preference: prefer the settings snapshot when present;
  // otherwise fall back to the cached value the bootstrap used;
  // otherwise default. This keeps the very first React render in
  // sync with what the user actually sees on the page.
  const [theme, setThemeState] = useState<AppearanceTheme>(() => {
    if (input.settingsTheme !== undefined) return input.settingsTheme;
    const cached = readCachedAppearance();
    return cached?.theme ?? "system";
  });
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(theme));

  // Stable ref over the writer so the public `setTheme` keeps a
  // constant identity across renders. Callers that memoize on
  // `setTheme` shouldn't churn just because their parent re-rendered.
  const writeThemeRef = useRef(input.writeTheme);
  useEffect(() => {
    writeThemeRef.current = input.writeTheme;
  }, [input.writeTheme]);

  // Adopt Settings snapshot updates (broadcast from another window,
  // or initial load completing). Skip when the values already match
  // to avoid clobbering an in-flight optimistic write.
  useEffect(() => {
    if (input.settingsTheme === undefined) return;
    if (input.settingsTheme === theme) return;
    setThemeState(input.settingsTheme);
  }, [input.settingsTheme, theme]);

  // Apply the DOM attribute + persist the localStorage cache
  // whenever the resolved theme changes. Both writes are idempotent.
  useEffect(() => {
    applyResolvedTheme(resolved);
  }, [resolved]);

  useEffect(() => {
    writeCachedAppearance(theme);
  }, [theme]);

  // Keep `resolved` in sync with `theme`. When theme flips off
  // "system", the matchMedia branch below stops listening; this
  // effect re-evaluates so the resolved state is correct
  // immediately.
  useEffect(() => {
    setResolved(resolveTheme(theme));
  }, [theme]);

  // OS-sync: while theme === "system", listen for the OS appearance
  // flip and re-resolve. The listener is torn down when theme moves
  // off "system" — explicit preferences don't follow the OS.
  useEffect(() => {
    if (theme !== "system") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = (event: MediaQueryListEvent): void => {
      setResolved(event.matches ? "light" : "dark");
    };
    // Always sync once on mount in case the OS flipped while no
    // listener was attached (e.g. between renders).
    setResolved(mq.matches ? "light" : "dark");
    mq.addEventListener("change", handler);
    return () => {
      mq.removeEventListener("change", handler);
    };
  }, [theme]);

  const setTheme = useCallback((next: AppearanceTheme): void => {
    // Optimistic local update so the UI flips immediately. The
    // Settings broadcast that follows the write echoes this back —
    // the snapshot effect skips when the values already match, so
    // no thrash.
    setThemeState(next);
    setResolved(resolveTheme(next));
    void writeThemeRef.current(next).catch(() => {
      // Swallow — the next Settings broadcast (or the next write
      // attempt) reconciles. We don't roll back the optimistic
      // state because a transient IPC failure shouldn't snap the
      // user's UI back; if persistence is genuinely broken, the
      // Settings page surfaces the error.
    });
  }, []);

  return { theme, resolvedTheme: resolved, setTheme };
}

/**
 * Settings-aware wrapper. Call this once at every BrowserWindow's
 * React root (Library, Settings, Tray, Float-over, Region selector,
 * Editor, Document). Internally:
 *
 *   - Reads `settings:read` on mount to seed `settingsTheme`.
 *   - Subscribes to `events:settings:changed` so cross-window writes
 *     (Settings page in window A flipping theme) propagate to every
 *     other window in the same session.
 *   - Wires `writeTheme` to `settings:write`.
 *
 * The returned controller can be threaded to UI that needs to render
 * the current preference (the Appearance settings page reads from it
 * to highlight the active option). Surfaces that only care about the
 * applied theme can ignore the return value — the hook's side-effects
 * keep `<html data-theme>` correct on its own.
 */
export function useAppearanceSync(): AppearanceController {
  const [settingsTheme, setSettingsTheme] = useState<AppearanceTheme | undefined>(undefined);

  // Initial load + broadcast subscription. Mirrors the lifecycle in
  // `useSettings.ts` but only tracks the appearance slice — every
  // window pays this subscription cost, so we deliberately keep it
  // narrow rather than wiring the full settings hook everywhere.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await dispatch("settings:read", {});
      if (cancelled) return;
      if (result.ok) {
        setSettingsTheme((result.value as Settings).appearance.theme);
      }
      // On failure we leave `settingsTheme` undefined and let
      // `useAppearance` fall back to the cached/default value.
      // The error surfaces in the Settings page via its own
      // `useSettings` instance, so we don't double-report here.
    })();

    const unsubscribe = subscribe(EVENT_CHANNELS.settingsChanged, (payload) => {
      const evt = payload as SettingsChangedEvent;
      setSettingsTheme(evt.settings.appearance.theme);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const writeTheme = useCallback(async (theme: AppearanceTheme): Promise<void> => {
    const result = await dispatch("settings:write", { appearance: { theme } });
    if (!result.ok) {
      // Surface as a thrown error so `useAppearance`'s catch-and-
      // swallow doesn't mask a real failure from the surrounding
      // try/await context (if any).
      throw new Error(result.error.message);
    }
  }, []);

  return useAppearance({ settingsTheme, writeTheme });
}
