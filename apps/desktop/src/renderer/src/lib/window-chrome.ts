// Who paints the window's chrome, per platform.
//
// Three windows' worth of questions used to be answered by inline
// `platform === "..."` checks scattered across Library.tsx, App.tsx and the
// four title-bar components, with a doc comment on the toolbar reserve asking
// the next person to "keep in step with the AppMenuBar mount condition". That
// manual sync is what let Linux grow an in-toolbar menu bar without being
// charged for its width — the tier calculation picked `wide` at 1200px and
// squeezed the search field down to "Se…". One predicate per question instead.

import type { ShortcutPlatform } from "@pwrsnap/shared";

type Platform = ShortcutPlatform | string | undefined;

/**
 * Does this platform render File / Edit / View / … INSIDE our title bar?
 *
 * True wherever the native title bar is hidden and takes the menu bar with it:
 * Windows (the menu lived in that bar) and Linux (a frameless window never
 * builds one — `RootView::SetMenu` returns early on `!has_frame()`). macOS
 * keeps the system menu bar, so its toolbar is all its own.
 *
 * Deliberately `=== `, not `!== "darwin"`: an absent `pwrsnapApi` must fail
 * closed, the same way `paintsOwnCaptionButtons` does. The negative form
 * mounted a second menu bar on macOS whenever the preload bridge was missing.
 */
export function menuBarIsInToolbar(platform: Platform): boolean {
  return platform === "win32" || platform === "linux";
}

/**
 * Does this platform leave minimize / maximize / close to us?
 *
 * macOS insets its traffic lights into our strip and Windows fills the
 * `titleBarOverlay` it reserves at the right edge. A frameless Linux window
 * has neither API, so nothing draws those buttons unless we do.
 */
export function paintsOwnCaptionButtons(platform: Platform): boolean {
  return platform === "linux";
}

/** This renderer's platform, as the preload reports it. */
export function rendererPlatform(): Platform {
  return window.pwrsnapApi?.platform;
}
