// Renderer-side keyboard helpers shared across the chrome surfaces.
//
// We have three (now four) keyboard handlers across the renderer that
// implement the "primary modifier" idiom — Command on macOS, Ctrl
// everywhere else — for chords like ⌘B, ⌘\, ⌘1..⌘N. Each handler
// used to define its own copy of `isPrimaryAccel`; that duplication
// rots (one would silently get a platform tweak the others didn't).
// One canonical helper here. Mirror `isEditableTarget` for the
// matching "don't steal a chord from a focused input" check.

import type { ShortcutPlatform } from "@pwrsnap/shared";

/** True when the event's modifier matches an explicit host platform.
 *  Callers obtain this value from the typed preload bridge and tests can
 *  supply either platform without mutating browser identity globals. */
export function isPrimaryAccel(
  event: KeyboardEvent,
  platform: ShortcutPlatform
): boolean {
  try {
    if (event.getModifierState("AltGraph")) return false;
  } catch {
    // Synthetic events in older browser/test environments may omit it.
  }
  return platform === "darwin"
    ? event.metaKey === true && event.ctrlKey === false
    : event.ctrlKey === true && event.metaKey === false;
}

/** True when the event was dispatched against an `<input>` /
 *  `<textarea>` / `contentEditable` element. Global keydown handlers
 *  bail when this returns true so the user's typing doesn't get
 *  eaten by a chord that happens to share a letter. */
export function isEditableTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (target === null) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable === true
  );
}
