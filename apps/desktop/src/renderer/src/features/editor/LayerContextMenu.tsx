// Right-click context menu over the editor canvas — exposes layer
// ops (z-order, copy/paste, delete) that the keyboard surface
// already supports, so users who haven't memorized the shortcuts
// can still discover and use them.
//
// Implementation is a renderer-side HTML/CSS popover (NOT
// Electron's native `Menu.popup` — those would require an IPC
// round-trip per item and couldn't easily reflect renderer state
// like selection size / clipboard contents). Mirrors the existing
// `ZoomMenu` pattern: absolutely-positioned div + document-level
// outside-click / Escape listeners.
//
// Item list comes from `buildLayerContextMenuItems` (pure helper,
// tested in isolation). Picking an item calls `onItemClick(id)`;
// the caller routes the id to the same callback the keyboard
// handler would dispatch (copy/paste/duplicate/etc.). This file
// owns ONLY the visual + dismissal contract — no business logic.
//
// Dismissal triggers (any one closes the menu):
//   • Escape keypress (window-level)
//   • mousedown OUTSIDE the menu root
//   • selecting an enabled item (caller's onItemClick should call
//     onClose; this component doesn't auto-close on item-click in
//     case the caller wants a future "stay open after action" mode)
//
// The caller is expected to also close the menu on:
//   • selection-change broadcast (a paste / delete that lands while
//     the menu is open would otherwise leave the menu showing items
//     against stale selection state)
//   • tool change (different tool = different valid menu)
//   • capture switch (the whole editor unmounts; React handles)

import { useEffect, useRef, type ReactElement } from "react";
import type {
  LayerContextMenuItem,
  LayerContextMenuItemId
} from "./buildLayerContextMenuItems";
import "./LayerContextMenu.css";

export interface LayerContextMenuProps {
  /** Items to render. Empty array = nothing to show (the caller
   *  shouldn't open the menu in that case, but the component
   *  tolerates it and renders an empty panel rather than crashing). */
  readonly items: readonly LayerContextMenuItem[];
  /** Anchor position in CSS pixels, relative to the menu's
   *  offsetParent (= the editor canvas wrap). The caller computes
   *  this from the contextmenu event's clientX/clientY minus the
   *  canvas-wrap's getBoundingClientRect(). */
  readonly anchorPx: { readonly x: number; readonly y: number };
  /** Fired when the menu should close (Escape / outside-click /
   *  item picked). The caller clears its open state and tears
   *  down the menu via the resulting re-render. */
  readonly onClose: () => void;
  /** Fired when the user picks an ENABLED item. Disabled items
   *  swallow clicks silently — the caller never sees them. The
   *  caller's handler is responsible for closing the menu after
   *  dispatching (via onClose) — this component doesn't force
   *  auto-close in case a future "multi-pick" mode wants to stay
   *  open. */
  readonly onItemClick: (id: LayerContextMenuItemId) => void;
}

export function LayerContextMenu(props: LayerContextMenuProps): ReactElement {
  const { items, anchorPx, onClose, onItemClick } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Document-level dismissal: Escape OR mousedown outside the menu.
  // Listens at the document level so a click on an UNRELATED part of
  // the editor (the canvas, another popover) closes the menu. Uses
  // `mousedown` (not `click`) so the menu closes BEFORE any
  // selection-mutating handler on the underlying element fires —
  // matches ZoomMenu's dismissal pattern.
  useEffect(() => {
    function onMouseDown(e: MouseEvent): void {
      const root = rootRef.current;
      if (root === null) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        // preventDefault so Escape doesn't ALSO clear the selection
        // — closing the menu is the user's intent; the underlying
        // selection should stay.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey, { capture: true });
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [onClose]);

  // Focus the menu root on open so keyboard nav (Tab, Enter) lands
  // in the menu rather than the underlying canvas. requestAnimationFrame
  // defers the focus call past React's commit phase so the focus
  // sticks reliably (focus during commit gets stolen by layout passes
  // on some browsers).
  useEffect(() => {
    requestAnimationFrame(() => {
      rootRef.current?.focus();
    });
  }, []);

  return (
    <div
      ref={rootRef}
      className="layer-context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: `${anchorPx.x}px`, top: `${anchorPx.y}px` }}
      // Prevent the OS context menu from re-opening if the user
      // right-clicks INSIDE the menu (the editor canvas's
      // onContextMenu would otherwise fire again).
      onContextMenu={(e) => e.preventDefault()}
      data-testid="layer-context-menu"
    >
      {items.map((item, idx) => {
        if (item.isSeparator === true) {
          // eslint-disable-next-line react/no-array-index-key
          return <div key={`sep-${idx}`} className="layer-context-menu__separator" role="separator" />;
        }
        return (
          <button
            // Item id is sufficient as a stable React key — every
            // non-separator item in the list has a unique id by
            // construction in buildLayerContextMenuItems.
            key={item.id}
            type="button"
            role="menuitem"
            className={
              "layer-context-menu__row" +
              (item.enabled ? "" : " is-disabled")
            }
            aria-disabled={!item.enabled}
            // Disabled rows: NO onClick. We don't just check
            // `item.enabled` inside the handler because that
            // would still fire focus + the css :focus-visible
            // ring on disabled items, which looks like the row
            // is interactable.
            {...(item.enabled
              ? {
                  onClick: () => {
                    onItemClick(item.id);
                  }
                }
              : {})}
            tabIndex={item.enabled ? 0 : -1}
            data-testid={`layer-context-menu-item-${item.id}`}
            data-enabled={item.enabled ? "true" : "false"}
          >
            <span className="layer-context-menu__label">{item.label}</span>
            <span className="layer-context-menu__accel">{item.accel}</span>
          </button>
        );
      })}
    </div>
  );
}
