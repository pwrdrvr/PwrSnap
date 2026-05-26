// Renderer-side keyboard helpers shared across the chrome surfaces.
//
// We have three (now four) keyboard handlers across the renderer that
// implement the "primary modifier" idiom — Cmd on macOS, Ctrl
// everywhere else — for chords like ⌘B, ⌘\, ⌘1..⌘N. Each handler
// used to define its own copy of `isPrimaryAccel`; that duplication
// rots (one would silently get a platform tweak the others didn't).
// One canonical helper here. Mirror `isEditableTarget` for the
// matching "don't steal a chord from a focused input" check.

/** True when the event's modifier key matches the platform's primary
 *  accelerator: Meta (⌘) on macOS, Ctrl on Linux / Windows. Uses
 *  `navigator.platform` rather than user-agent sniffing — same shape
 *  the editor's keyboard handler used before this lift. */
export function isPrimaryAccel(event: KeyboardEvent): boolean {
  if (typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform)) {
    return event.metaKey === true;
  }
  return event.ctrlKey === true;
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
