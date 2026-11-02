// A submenu row for the Library's right-click menus ("Duplicate ▸").
//
// The submenu renders INSIDE its parent menu's root, so the parent's
// outside-click and focus-leave checks treat it as part of the menu, and
// `useMenuNavigation` filters each menu to its own rows. Keyboard follows
// the APG: ArrowRight / Enter / Space on the row opens it and focuses its
// first item, ArrowLeft or Escape closes it and puts focus back on the row.
// Pointer: hovering the row opens it WITHOUT moving focus into it, as a
// native submenu does — the row keeps focus, and ArrowRight enters. The parent
// closes it when the pointer moves onto another of its rows (`onMouseOver`
// there); a keyboard move off the row closes it here.

import { useRef, type ReactNode, type RefObject } from "react";

import { useDismissable } from "../../lib/useDismissable";
import { lastMenuInput, useMenuNavigation } from "../../lib/useMenuNavigation";

export function ContextSubmenuRow({
  label,
  open,
  onOpen,
  onClose,
  flip,
  children
}: {
  label: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Open to the left — the parent sits too near the right edge. */
  flip: boolean;
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div
      className="psl__context-menu-sub"
      onBlur={(event) => {
        // The pointer crossing another row is the parent's call, after its
        // hover-intent delay; only a key that takes focus off the row and
        // its submenu closes it straight away.
        if (!open || lastMenuInput() !== "keyboard") return;
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        onClose();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className="psl__context-menu-row psl__context-menu-row--sub"
        onClick={(event) => {
          if (!open) {
            onOpen();
            return;
          }
          // Open already (hover opened it). A pointer click leaves it open —
          // it used to toggle it shut under the cursor. Enter or Space
          // (`detail === 0`) goes in, as ArrowRight does.
          if (event.detail !== 0) return;
          event.currentTarget.parentElement
            ?.querySelector<HTMLElement>('[role="menu"] [role="menuitem"]')
            ?.focus();
        }}
        onMouseEnter={() => {
          if (!open) onOpen();
        }}
      >
        <span>{label}</span>
        <span className="psl__context-menu-chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {open ? (
        <ContextSubmenu label={label} triggerRef={triggerRef} onClose={onClose} flip={flip}>
          {children}
        </ContextSubmenu>
      ) : null}
    </div>
  );
}

function ContextSubmenu({
  label,
  triggerRef,
  onClose,
  flip,
  children
}: {
  label: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  flip: boolean;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  useDismissable({ open: true, onDismiss: onClose, surfaceRef: menuRef, triggerRef });
  useMenuNavigation({
    open: true,
    menuRef,
    onClose,
    onBack: onClose,
    keepFocusOnPointerOpen: true,
    returnFocusRef: triggerRef
  });
  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-label={label}
      className={`psl__context-menu psl__context-menu--sub${flip ? " is-flipped" : ""}`}
    >
      {children}
    </div>
  );
}

/** A submenu row with an optional second line ("crop · 2 arrows"). */
export function ContextMenuChoiceRow({
  label,
  hint,
  onSelect
}: {
  label: string;
  hint?: string | undefined;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`psl__context-menu-row${hint ? " psl__context-menu-row--hint" : ""}`}
      onClick={onSelect}
    >
      <span>{label}</span>
      {hint ? <span className="psl__context-menu-hint">{hint}</span> : null}
    </button>
  );
}
