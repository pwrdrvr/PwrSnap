import {
  shortcutPlatformFromString,
  type ShortcutPlatform
} from "@pwrsnap/shared";

/** The renderer's single bridge from preload state to pure shortcut semantics. */
export function rendererShortcutPlatform(): ShortcutPlatform {
  return shortcutPlatformFromString(window.pwrsnapApi?.platform);
}
