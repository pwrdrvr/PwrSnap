// Hands focus back to whatever held it before an overlay opened, on every
// way the overlay can close — Escape, an item or button that closes it, a
// busy dialog finishing — not only the Escape path.
//
// Every overlay in the renderer dropped focus to <body> when it closed
// (measured in headless Chromium: HotkeyResetModal, DeleteConfirm, the editor's
// context and zoom menus). The element holding focus unmounts, Chromium parks
// focus on <body>, and the next Tab starts from the top of the document.

import { useEffect, useRef, type RefObject } from "react";

/**
 * Remember the opener while `open` is true, and on close return focus to it —
 * or to `returnFocusRef` when the caller knows better.
 *
 * **The opener is captured during RENDER, not in an effect.** React applies
 * `autoFocus`, and runs layout effects, while committing — before passive
 * effects. A dialog that moves focus in either of those (HotkeyResetModal's
 * Cancel, ChatApprovalModal's Deny) has already taken focus by the time an
 * effect could look, so an effect records the dialog's own button and, on
 * close, finds it disconnected and restores nothing.
 *
 * **Only if the overlay still owns focus.** Focus inside the container, or
 * lost to <body> because the container just unmounted, goes back. Focus the
 * user or the caller moved somewhere else on purpose — a click on another
 * control, a field the caller wants corrected — stays where it is.
 */
export function useFocusReturn({
  open,
  containerRef,
  returnFocusRef
}: {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  /** Overrides the captured opener, e.g. the trigger of a popover whose
   *  open does not move focus off the page. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}): void {
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  // `typeof document` keeps this render-safe under renderToStaticMarkup.
  if (open && !wasOpen.current && typeof document !== "undefined") {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const opener = openerRef.current;
    return () => {
      const target = returnFocusRef?.current ?? opener;
      if (target === null || !target.isConnected) return;
      const active = document.activeElement;
      const lost = active === null || active === document.body;
      if (lost || containerRef.current?.contains(active) === true) target.focus();
    };
  }, [open, containerRef, returnFocusRef]);
}
