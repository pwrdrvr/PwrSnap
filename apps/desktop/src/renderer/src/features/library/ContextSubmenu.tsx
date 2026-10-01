// A submenu row for the Library's right-click menus ("Duplicate ▸").
//
// The submenu renders INSIDE its parent menu's root, so the parent's
// outside-click and focus-leave checks treat it as part of the menu, and
// `useMenuNavigation` filters each menu to its own rows. Keyboard follows
// the APG: ArrowRight / Enter / Space on the row opens it and focuses its
// first item, ArrowLeft or Escape closes it and puts focus back on the row.
// Pointer: hovering the row opens it; the parent closes it when the pointer
// moves onto another of its rows (`onMouseOver` there).

import { useRef, type ReactNode, type RefObject } from "react";

import { useDismissable } from "../../lib/useDismissable";
import { useMenuNavigation } from "../../lib/useMenuNavigation";

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
    <div className="psl__context-menu-sub">
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className="psl__context-menu-row psl__context-menu-row--sub"
        onClick={() => (open ? onClose() : onOpen())}
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
  useMenuNavigation({ open: true, menuRef, onClose, onBack: onClose });
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
