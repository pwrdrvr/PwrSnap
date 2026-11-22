// Shared dismissal for the Library's fixed-position right-click menus.
import { useEffect, type RefObject } from "react";
import { useDismissable } from "../../lib/useDismissable";
import { useMenuNavigation } from "../../lib/useMenuNavigation";

/**
 * Shared dismiss + keyboard mechanism for the grid's context menus:
 * click-outside closes; Esc closes (`useDismissable`, whose claim stops
 * the event before the window-level Esc handlers that collapse the rail /
 * leave Focus); and the role="menu" keys — arrows, Home/End, typeahead,
 * Tab closes — with focus into the first row on open and back to the tile
 * on close (`useMenuNavigation`). Both the project menu and the capture
 * menu use this so the two can't drift.
 *
 * Scroll / resize / blur also close, for the same reason `DeleteConfirm`
 * closes on them: `.psl__context-menu` is `position: fixed` at the
 * coordinates of the right-click, so it does NOT travel with the tile it
 * was opened on. One wheel notch and the menu is pinned over a DIFFERENT
 * capture while its rows still act on the original one — and in Trash
 * view one of those rows is the irreversible "Delete Permanently". The
 * scroll listener is capture-phase because the grid scrolls in an inner
 * element, and scroll events don't bubble to window.
 */
export function useContextMenuDismiss(
  rootRef: RefObject<HTMLDivElement | null>,
  onClose: () => void
): void {
  useEffect(() => {
    function onMouseDown(event: MouseEvent): void {
      const root = rootRef.current;
      if (root === null) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      onClose();
    }
    function onDetach(): void {
      onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("scroll", onDetach, true);
    window.addEventListener("resize", onDetach);
    window.addEventListener("blur", onDetach);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("scroll", onDetach, true);
      window.removeEventListener("resize", onDetach);
      window.removeEventListener("blur", onDetach);
    };
  }, [onClose, rootRef]);

  useDismissable({ open: true, onDismiss: onClose, surfaceRef: rootRef });
  // Focuses the first row with preventScroll, so taking focus never nudges
  // a scroller — the close-on-scroll listener above would otherwise dismiss
  // the menu the instant it opens (same reason DeleteConfirm does this).
  useMenuNavigation({ open: true, menuRef: rootRef, onClose });
}
