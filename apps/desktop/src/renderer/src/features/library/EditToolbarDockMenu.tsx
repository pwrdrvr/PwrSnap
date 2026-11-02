// The dock control beside the edit toolbar's grip, and its position menu.
//
// The button's glyph is where the toolbar is NOW: a frame with the docked
// edge filled, or a small bar inside it while floating. The menu is a
// `role="menu"` of radio rows (one per position) plus "Float at default
// position", which does what double-clicking the grip does.
//
// Focus behaviour comes from the renderer's focus hooks (lib/AGENTS.md):
// useDismissable owns Escape, useMenuNavigation owns the arrow keys and the
// roving tab stop, and focus that leaves the menu closes it.

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { EDIT_TOOLBAR_DOCKS, type EditToolbarDock } from "@pwrsnap/shared";
import { useDismissable } from "../../lib/useDismissable";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { closeWhenFocusLeaves } from "../shared/close-when-focus-leaves";

/** What choosing each position does: the menu's rows, and the drop zones a
 *  grip drag lights up. */
export const DOCK_ACTION_LABELS: Readonly<Record<EditToolbarDock, string>> = {
  float: "Floating",
  top: "Dock top",
  bottom: "Dock bottom",
  left: "Dock left",
  right: "Dock right"
};

const POSITIONS = EDIT_TOOLBAR_DOCKS.map((dock) => ({ dock, label: DOCK_ACTION_LABELS[dock] }));

const DOCK_LABELS: Readonly<Record<EditToolbarDock, string>> = {
  float: "Floating",
  top: "Docked top",
  bottom: "Docked bottom",
  left: "Docked left",
  right: "Docked right"
};

/** A frame with the docked edge filled; a short bar inside it when floating. */
export function DockGlyph({ dock }: { readonly dock: EditToolbarDock }): ReactElement {
  const bar =
    dock === "top" ? { x: 1, y: 1, w: 14, h: 3.5 }
    : dock === "bottom" ? { x: 1, y: 8.5, w: 14, h: 3.5 }
    : dock === "left" ? { x: 1, y: 1, w: 3.5, h: 11 }
    : dock === "right" ? { x: 11.5, y: 1, w: 3.5, h: 11 }
    : { x: 4, y: 8, w: 8, h: 2 };
  return (
    <svg width="16" height="13" viewBox="0 0 16 13" fill="none" aria-hidden="true">
      <rect x="0.75" y="0.75" width="14.5" height="11.5" rx="2.25" stroke="currentColor" strokeWidth="1.5" />
      <rect x={bar.x} y={bar.y} width={bar.w} height={bar.h} rx={dock === "float" ? 1 : 0.5} fill="currentColor" />
    </svg>
  );
}

/** Which side of the button the menu opens on: away from the docked edge,
 *  and for a floating toolbar, toward whichever half of the stage has room. */
function menuSide(dock: EditToolbarDock, trigger: HTMLElement | null): "up" | "down" | "right" | "left" {
  if (dock === "top") return "down";
  if (dock === "left") return "right";
  if (dock === "right") return "left";
  if (dock === "bottom" || trigger === null) return "up";
  const stage = trigger.closest(".psl__stage-wrap");
  if (stage === null) return "up";
  const t = trigger.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  return t.top - s.top > s.bottom - t.bottom ? "up" : "down";
}

export function EditToolbarDockMenu({
  dock,
  onPick,
  onFloatAtDefault
}: {
  readonly dock: EditToolbarDock;
  readonly onPick: (dock: EditToolbarDock) => void;
  readonly onFloatAtDefault: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"up" | "down" | "right" | "left">("up");
  const [hot, setHot] = useState<EditToolbarDock | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = (): void => {
    setOpen(false);
    setHot(null);
  };

  useDismissable({ open, onDismiss: close, surfaceRef: menuRef, triggerRef });
  useMenuNavigation({ open, menuRef, onClose: close, returnFocusRef: triggerRef });

  useLayoutEffect(() => {
    if (open) setSide(menuSide(dock, triggerRef.current));
  }, [open, dock]);

  // Mousedown outside closes it, before anything under the pointer acts.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      const root = rootRef.current;
      if (root !== null && e.target instanceof Node && root.contains(e.target)) return;
      close();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (next: EditToolbarDock): void => {
    close();
    onPick(next);
  };

  return (
    <div className="psl__et-dockctl" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={"psl__et-dockbtn" + (open ? " is-open" : "")}
        data-testid="edit-toolbar-dock-button"
        aria-label={`Toolbar position: ${DOCK_LABELS[dock]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip="Toolbar position"
        data-tip-detail="Float it, or dock it to an edge of the stage"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <DockGlyph dock={dock} />
      </button>
      {open && (
        <div
          ref={menuRef}
          className={"psl__et-dockmenu is-" + side}
          role="menu"
          aria-label="Toolbar position"
          tabIndex={-1}
          data-testid="edit-toolbar-dock-menu"
          onBlur={closeWhenFocusLeaves(close)}
          onMouseLeave={() => setHot(null)}
        >
          <div className="psl__et-dockmenu-head" aria-hidden="true">Toolbar position</div>
          <div className="psl__et-dockmap" aria-hidden="true">
            <i />
            {POSITIONS.map(({ dock: d }) => (
              <b
                key={d}
                className={"is-" + d + (d === dock ? " is-on" : "") + (d === hot && d !== dock ? " is-hot" : "")}
                onMouseEnter={() => setHot(d)}
                onClick={() => pick(d)}
              />
            ))}
          </div>
          {POSITIONS.map(({ dock: d, label }) => (
            <button
              key={d}
              type="button"
              role="menuitemradio"
              aria-checked={d === dock}
              tabIndex={-1}
              className="psl__et-dockmenu-row"
              data-testid={`edit-toolbar-dock-${d}`}
              onMouseEnter={() => setHot(d)}
              onFocus={() => setHot(d)}
              onClick={() => pick(d)}
            >
              <span className="psl__et-dockmenu-check" aria-hidden="true">{d === dock ? "✓" : ""}</span>
              <DockGlyph dock={d} />
              <span>{label}</span>
            </button>
          ))}
          <div className="psl__et-dockmenu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="psl__et-dockmenu-row"
            data-testid="edit-toolbar-dock-reset"
            onClick={() => {
              close();
              onFloatAtDefault();
            }}
          >
            <span className="psl__et-dockmenu-check" aria-hidden="true" />
            <span className="psl__et-dockmenu-spacer" aria-hidden="true" />
            <span>Float at default position</span>
            <span className="psl__et-dockmenu-meta">double-click grip</span>
          </button>
        </div>
      )}
    </div>
  );
}
