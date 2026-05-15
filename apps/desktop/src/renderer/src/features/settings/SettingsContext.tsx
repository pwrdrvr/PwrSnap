// Context wrapper around `useSettings`. Hoisted to `SettingsApp` so the
// whole Settings shell shares one subscriber to `events:settings:changed`
// and one pair of initial dispatches per window. Pages consume via
// `useSettingsContext()`.
//
// Why a context, not a module-level singleton: lifecycle is bound to
// the Settings window — when the BrowserWindow closes, the React tree
// unmounts and the hook's cleanup tears down the subscriber. A module
// singleton would persist across navigations within the same JS realm
// and re-introduce the per-window cleanup problem the context solves
// in the natural React way.

import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import { useSettings, type UseSettingsValue } from "./useSettings";

// `null` sentinel lets `useSettingsContext` distinguish "outside a
// provider" (programmer error → throw) from "inside a provider whose
// hook hasn't loaded yet" (which is just `settings: null` in the
// value).
export const SettingsContext = createContext<UseSettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }): ReactElement {
  const value = useSettings();
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

/**
 * Read the hoisted `useSettings` value. Throws when invoked outside a
 * `<SettingsProvider>` — the throw is intentional: any settings page
 * mounted without the provider above it would silently get a "never
 * loaded" snapshot otherwise.
 */
export function useSettingsContext(): UseSettingsValue {
  const value = useContext(SettingsContext);
  if (value === null) {
    throw new Error(
      "useSettingsContext must be called within <SettingsProvider>"
    );
  }
  return value;
}
