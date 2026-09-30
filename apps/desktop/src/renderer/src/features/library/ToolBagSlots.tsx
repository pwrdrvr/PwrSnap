// The nine tool-bag slots in the edit toolbar.
//
//   click          arm the slot (⌥-click: for one annotation)
//   ⇧-click        paste the slot onto the selection
//   empty slot     click saves the current style into it
//   right-click    Save current style here / Clear slot
//
// The keyboard twins (1–9, ⇧1–9) live in the editor's key handler,
// which owns the selection; this component only mirrors them for the
// pointer.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import type { EditorToolBag, ToolBagSlot } from "@pwrsnap/shared";
import { acceleratorToDisplayKeys, type ShortcutPlatform } from "../../lib/format-hotkey";
import { rendererShortcutPlatform } from "../../lib/shortcut-platform";
import { useDismissable } from "../../lib/useDismissable";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { closeWhenFocusLeaves } from "../shared/close-when-focus-leaves";
import { describeBagSlot, ToolBagGlyph } from "./ToolBagGlyph";
import "../editor/LayerContextMenu.css";

export type ToolBagSlotsProps = {
  readonly bag: EditorToolBag;
  readonly armedSlot: number | null;
  readonly armedSlotModified: boolean;
  readonly hasSelection: boolean;
  /** What "save here" would store: the selected layer's style, or the
   *  active tool's working style. Null when there is nothing to save
   *  (pointer tool, nothing selected). */
  readonly currentStyle: ToolBagSlot | null;
  readonly onArm: (index: number, singleShot: boolean) => void;
  readonly onApply: (index: number) => void;
  readonly onSaveSlot: (index: number, slot: ToolBagSlot | null) => void;
  readonly shortcutPlatform?: ShortcutPlatform;
};

type MenuState = { index: number; left: number; bottom: number };

export function ToolBagSlots({
  bag,
  armedSlot,
  armedSlotModified,
  hasSelection,
  currentStyle,
  onArm,
  onApply,
  onSaveSlot,
  shortcutPlatform = rendererShortcutPlatform()
}: ToolBagSlotsProps): ReactElement {
  const shift = acceleratorToDisplayKeys("Shift+1", shortcutPlatform)[0] ?? "Shift";
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <div className="psl__bag" role="group" aria-label="Tool bag">
      {bag.slots.map((slot, index) => {
        const number = index + 1;
        const armed = armedSlot === index && slot !== null;
        const name = slot === null ? null : describeBagSlot(slot);
        const title =
          slot === null
            ? currentStyle === null
              ? `Slot ${number} is empty — pick a tool or select a layer, then click to save its style here`
              : `Slot ${number} is empty — click to save the current style here`
            : `${name} (${number}) · ${shift}${number} or ${shift}-click restyles the selection`;
        return (
          <button
            key={index}
            type="button"
            className={
              "psl__bag-slot" +
              (slot === null ? " is-empty" : "") +
              (armed ? " is-armed" : "") +
              (armed && armedSlotModified ? " is-modified" : "")
            }
            data-testid={`bag-slot-${number}`}
            aria-label={slot === null ? `Empty slot ${number}` : `${name}, slot ${number}`}
            aria-pressed={slot === null ? undefined : armed}
            aria-disabled={slot === null && currentStyle === null ? true : undefined}
            title={title}
            onClick={(event) => {
              if (slot === null) {
                if (currentStyle !== null) onSaveSlot(index, currentStyle);
                return;
              }
              if (event.shiftKey && hasSelection) {
                onApply(index);
                return;
              }
              onArm(index, event.altKey);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({
                index,
                left: rect.left,
                bottom: window.innerHeight - rect.top + 6
              });
            }}
          >
            {slot === null ? (
              <span className="psl__bag-plus" aria-hidden="true">+</span>
            ) : (
              <ToolBagGlyph slot={slot} />
            )}
            <span className="psl__bag-num" aria-hidden="true">{number}</span>
          </button>
        );
      })}
      {menu !== null &&
        createPortal(
          <SlotMenu
            menu={menu}
            filled={bag.slots[menu.index] != null}
            canSave={currentStyle !== null}
            onClose={closeMenu}
            onSave={() => {
              if (currentStyle !== null) onSaveSlot(menu.index, currentStyle);
              closeMenu();
            }}
            onClear={() => {
              onSaveSlot(menu.index, null);
              closeMenu();
            }}
          />,
          document.body
        )}
    </div>
  );
}

function SlotMenu({
  menu,
  filled,
  canSave,
  onClose,
  onSave,
  onClear
}: {
  menu: MenuState;
  filled: boolean;
  canSave: boolean;
  onClose: () => void;
  onSave: () => void;
  onClear: () => void;
}): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useDismissable({ open: true, onDismiss: onClose, surfaceRef: rootRef });
  useMenuNavigation({ open: true, menuRef: rootRef, onClose });

  // Mousedown outside closes, the same way the layer menu does.
  useEffect(() => {
    function onMouseDown(e: MouseEvent): void {
      const root = rootRef.current;
      if (root === null) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);

  const items = [
    {
      id: "save",
      label: filled ? `Replace slot ${menu.index + 1} with current style` : `Save current style to slot ${menu.index + 1}`,
      enabled: canSave,
      run: onSave
    },
    { id: "clear", label: `Clear slot ${menu.index + 1}`, enabled: filled, run: onClear }
  ];

  return (
    <div
      ref={rootRef}
      className="layer-context-menu psl__bag-menu"
      role="menu"
      tabIndex={-1}
      aria-label={`Slot ${menu.index + 1}`}
      style={{ position: "fixed", left: `${menu.left}px`, bottom: `${menu.bottom}px` }}
      onContextMenu={(e) => e.preventDefault()}
      onBlur={closeWhenFocusLeaves(onClose)}
      data-testid="bag-slot-menu"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={"layer-context-menu__row" + (item.enabled ? "" : " is-disabled")}
          aria-disabled={!item.enabled}
          {...(item.enabled ? { onClick: item.run } : {})}
          tabIndex={-1}
          data-testid={`bag-slot-menu-${item.id}`}
        >
          <span className="layer-context-menu__label">{item.label}</span>
          <span className="layer-context-menu__accel" />
        </button>
      ))}
    </div>
  );
}
