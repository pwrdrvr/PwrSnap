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
 * two rows stays inside the root and is ignored.
 *
 * A null `relatedTarget` does not mean focus stayed. A menu that is the
 * last focusable thing in the document (the Sizzle project menu is the
 * app root's last child) loses focus to nothing when Tab passes its last
 * row, and the next Tab brings focus back in at the top of the page. So
 * the decision waits for wherever focus lands next: one `focusin`, which
 * closes the menu only if it landed outside and the menu is still
 * mounted. Returning to the window, or clicking back onto a row, lands
 * inside and keeps it open. A detached root means the menu already
 * closed, so a late `focusin` cannot close its successor.
 */
export function closeWhenFocusLeaves(
  onClose: () => void
): (event: FocusEvent<HTMLElement>) => void {
  return (event) => {
    const root = event.currentTarget;
    const next = event.relatedTarget;
    if (next instanceof Node) {
      if (!root.contains(next)) onClose();
      return;
    }
    root.ownerDocument.addEventListener(
      "focusin",
      (landed) => {
        if (!root.isConnected) return;
        if (landed.target instanceof Node && root.contains(landed.target)) return;
        onClose();
      },
      { capture: true, once: true }
    );
  };
}
