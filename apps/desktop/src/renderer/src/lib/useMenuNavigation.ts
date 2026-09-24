// The WAI-ARIA menu keyboard contract, for any surface already marked up as
// `role="menu"` with `menuitem`-ish children.
//
// A role is a promise to assistive tech: a screen-reader user told "menu"
// reaches for the arrow keys. PwrSnap had four right-click menus wearing the
// role (the editor's layer menu, the Library's capture and reel menus, the
// Sizzle rail's reel menu) and none of them implemented it. Measured in
// headless Chromium: the arrows did nothing, every item was its own Tab stop,
// and Tab walked off the last one and left the menu open with focus behind it.
//
// Ported from PwrGit's `useMenuNavigation` (pwrdrvr/PwrGit#307). Two
// additions: focus goes back where it came from when the menu closes, however
// it closes (`useFocusReturn`), and the first focus is `preventScroll` — the
// Library's menus close on any scroll, so a focus that nudged a scroller would
// dismiss the menu as it opened.

import { useEffect, useRef, type RefObject } from "react";
import { useFocusReturn } from "./useFocusReturn";

/** Anything `role="menu"` is allowed to own as a focusable child. */
const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

/** Typeahead resets once the user stops typing — same idle window as a native menu. */
const TYPEAHEAD_IDLE_MS = 500;

function items(menu: HTMLElement | null): HTMLElement[] {
  if (menu === null) return [];
  return [...menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)].filter(
    (el) => el.getAttribute("aria-disabled") !== "true" && !el.hasAttribute("disabled")
  );
}

/**
 * Arrow keys, Home/End and typeahead move between the menu's enabled items;
 * Tab closes the menu (APG — it does not walk through it); focus moves into
 * the menu on open and back out on close.
 *
 * Roving tabindex keeps the menu ONE Tab stop, which is the other half of the
 * promise. Items must not set `tabIndex` in JSX to anything but -1: the hook
 * owns which one is 0, and a JSX value that changes on re-render would put
 * every item back in the Tab order.
 *
 * Escape is `useDismissable`, not this hook — menus and dialogs share one
 * owner rule for it.
 */
export function useMenuNavigation({
  open,
  menuRef,
  onClose
}: {
  open: boolean;
  menuRef: RefObject<HTMLElement | null>;
  /** Called for Tab, which per APG closes the menu and lets focus move on. */
  onClose: () => void;
}): void {
  useFocusReturn({ open, containerRef: menuRef });

  // Callers routinely pass an inline arrow. Holding it in a ref keeps the
  // keydown subscription from being torn down and rebuilt every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Roving tabindex + initial focus. Runs on every open so a menu whose items
  // changed while closed starts from a valid one — and again whenever the
  // items change WHILE open (the capture menu's "Add to Cart" label follows
  // the cart). When the node holding the tab stop unmounts, nothing is left
  // in the tab order and focus drops to <body>.
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (menu === null) return;

    /** Put the tab stop on `preferred`, else the checked item, else the first. */
    const seed = (preferred: HTMLElement | null, moveFocus: boolean): void => {
      const list = items(menu);
      if (list.length === 0) {
        // Every row disabled. A right-click menu has no trigger button to
        // leave focus on, so the menu itself (tabIndex=-1) takes it — or
        // Escape would find focus back on the canvas, owned by nobody.
        if (moveFocus && menu.hasAttribute("tabindex")) menu.focus({ preventScroll: true });
        return;
      }
      for (const el of list) el.tabIndex = -1;
      // Re-opening a menu that records a choice should land on that choice.
      const checked = list.find((el) => el.getAttribute("aria-checked") === "true");
      const target = preferred ?? checked ?? list[0]!;
      target.tabIndex = 0;
      if (moveFocus) target.focus({ preventScroll: true });
    };

    seed(null, true);

    // Re-seed only once the menu has actually lost its tab stop. If the user
    // is still standing on an item the stop follows them rather than snapping
    // back to the top.
    const observer = new MutationObserver(() => {
      const list = items(menu);
      if (list.length === 0) return;
      if (list.some((el) => el.tabIndex === 0 && el.isConnected)) return;
      const active = document.activeElement as HTMLElement | null;
      const held = active !== null && list.includes(active) ? active : null;
      seed(held, held === null && !menu.contains(active));
    });
    observer.observe(menu, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open, menuRef]);

  useEffect(() => {
    if (!open) return;
    let typed = "";
    let typedAt = 0;

    const moveTo = (next: HTMLElement, list: HTMLElement[]): void => {
      for (const el of list) el.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    };

    const onKey = (e: KeyboardEvent): void => {
      const menu = menuRef.current;
      if (menu === null) return;
      const list = items(menu);
      // Only steer while focus is actually in the menu; a global listener
      // must not hijack arrows meant for the grid behind an open menu.
      const active = document.activeElement as HTMLElement | null;
      if (active === null || !menu.contains(active)) return;
      if (e.key === "Tab") {
        // APG: Tab closes the menu and moves on. Not default-prevented: the
        // browser's own step, taken from wherever useFocusReturn put focus
        // back, is the "moves on". (Inside a focus trap the trap claims the
        // key first and takes that step itself — see useFocusTrap.)
        onCloseRef.current();
        return;
      }
      if (list.length === 0) return;
      const at = list.indexOf(active);

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          moveTo(list[(at + 1) % list.length]!, list);
          return;
        case "ArrowUp":
          e.preventDefault();
          // `at` is -1 when focus is in the menu but not on an item (the menu
          // root, or an item disabled since it was focused). Without the
          // guard the modulo lands on the second-to-last entry.
          moveTo(
            at === -1 ? list[list.length - 1]! : list[(at - 1 + list.length) % list.length]!,
            list
          );
          return;
        case "Home":
          e.preventDefault();
          moveTo(list[0]!, list);
          return;
        case "End":
          e.preventDefault();
          moveTo(list[list.length - 1]!, list);
          return;
        default:
          break;
      }

      // Typeahead: printable single characters only, so modifier chords and
      // named keys ("Enter", "F5") fall through. Space is excluded explicitly
      // — it is one character long, but it activates the focused item.
      if (e.key.length !== 1 || e.key === " " || e.altKey || e.ctrlKey || e.metaKey) return;
      const now = Date.now();
      typed = now - typedAt > TYPEAHEAD_IDLE_MS ? e.key : typed + e.key;
      typedAt = now;
      const prefix = typed.toLowerCase();
      // Search from the item after the current one so repeating a letter
      // walks through every match rather than sticking on the first.
      const ordered = [...list.slice(at + 1), ...list.slice(0, at + 1)];
      const hit = ordered.find((el) =>
        (el.textContent ?? "").trim().toLowerCase().startsWith(prefix)
      );
      if (hit !== undefined) {
        e.preventDefault();
        moveTo(hit, list);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, menuRef]);
}
