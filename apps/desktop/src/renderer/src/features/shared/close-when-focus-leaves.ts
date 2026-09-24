import type { FocusEvent } from "react";

/**
 * `onBlur` for a popup menu's root: close the menu once keyboard focus
 * moves to something outside it.
 *
 * The context menus close on Escape and on a mousedown outside, but Tab
 * past the last row used to leave them open. Focus then walked into the
 * controls underneath while the menu still covered them: the editor's
 * layer menu hid 50-100% of the edit toolbar's rings that way.
 *
 * React's `onBlur` bubbles like `focusout`, so this sees a row losing
 * focus too, and `relatedTarget` says where focus went. A move between
 * two rows stays inside the root and is ignored. A null target (the
 * window lost focus, or a click landed on something unfocusable) is left
 * to the mousedown and blur listeners the menus already have.
 */
export function closeWhenFocusLeaves(
  onClose: () => void
): (event: FocusEvent<HTMLElement>) => void {
  return (event) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node)) return;
    if (event.currentTarget.contains(next)) return;
    onClose();
  };
}
