// The property bar docked above the edit toolbar. It shows ONE style:
//
//   • the selected layer's, when exactly one styled layer is selected —
//     edits restyle that layer (the Properties tab's path, one undo step
//     per change);
//   • otherwise the active drawing tool's working style — edits change
//     what the next drag draws, and "Update slot N" appears once it has
//     drifted from the armed slot.
//
// It replaces the per-tool caret popovers. The controls used to live in
// a popover you had to know to open, and a selected layer's controls
// lived in a sidebar tab nobody found; now whatever the next click would
// affect is on screen above the tools.

import type { ReactElement } from "react";
import type { ToolBagSlot } from "@pwrsnap/shared";
import { acceleratorToDisplayKeys, type ShortcutPlatform } from "../../lib/format-hotkey";
import { rendererShortcutPlatform } from "../../lib/shortcut-platform";
import {
  ToolStyleBody,
  type StyledToolKind,
  type ToolStylePopoverStyle
} from "../editor/ToolStylePopover";

export type PropertyBarTarget =
  | {
      readonly kind: "layer";
      readonly layerId: string;
      readonly tool: StyledToolKind;
      readonly label: string;
      readonly style: ToolStylePopoverStyle;
    }
  | { readonly kind: "multi"; readonly count: number }
  | {
      readonly kind: "tool";
      readonly tool: StyledToolKind;
      readonly label: string;
      readonly style: ToolStylePopoverStyle;
      /** 0-based armed slot, or null. */
      readonly armedSlot: number | null;
      readonly armedSlotModified: boolean;
    };

export type EditPropertyBarProps = {
  readonly target: PropertyBarTarget;
  readonly onFieldChange: (field: string, value: unknown) => void;
  /** Index of the first empty slot, or null when the bag is full. */
  readonly firstEmptySlot: number | null;
  readonly onSaveToSlot: (index: number, slot: ToolBagSlot) => void;
  /** Open a label draft at the selected arrow's tail. Present only when
   *  the editor can do it; the button shows for a selected arrow. */
  readonly onAddLabel?: (layerId: string) => void;
  readonly shortcutPlatform?: ShortcutPlatform;
};

function slotFor(tool: StyledToolKind, style: ToolStylePopoverStyle): ToolBagSlot {
  // The pair came from one discriminated source (a layer projection or
  // the tool state), so the cast only restates what the caller holds.
  return { tool, style } as ToolBagSlot;
}

export function EditPropertyBar({
  target,
  onFieldChange,
  firstEmptySlot,
  onSaveToSlot,
  onAddLabel,
  shortcutPlatform = rendererShortcutPlatform()
}: EditPropertyBarProps): ReactElement {
  const shift = acceleratorToDisplayKeys("Shift+1", shortcutPlatform)[0] ?? "Shift";
  if (target.kind === "multi") {
    return (
      <div className="psl__et-props is-multi" data-testid="edit-property-bar" role="group" aria-label="Selection">
        <span className="psl__et-props-tag is-selected">{target.count} selected</span>
        <span className="psl__et-props-hint">
          <kbd>{shift}</kbd>
          <kbd>1</kbd>–<kbd>9</kbd> or {shift}-click a slot to restyle them
        </span>
      </div>
    );
  }

  const saveTarget = slotFor(target.tool, target.style);
  // The eraser is a way of using the Draw tool, not a style to keep: a
  // slot holds what the next drag DRAWS. Settings refuse an eraser slot
  // too; this keeps the button from offering one.
  const erasing =
    target.tool === "draw" && (target.style as { mode?: unknown }).mode === "eraser";
  const updateIndex =
    !erasing && target.kind === "tool" && target.armedSlot !== null && target.armedSlotModified
      ? target.armedSlot
      : null;
  const saveBlockedTip = erasing
    ? "The eraser can't be saved — pick Pen, Marker or Spray"
    : firstEmptySlot === null
      ? "The bag is full — right-click a slot to replace or clear it"
      : null;

  return (
    <div
      className={"psl__et-props" + (target.kind === "layer" ? " is-layer" : "")}
      data-testid="edit-property-bar"
      data-target={target.kind}
      role="group"
      aria-label={target.kind === "layer" ? `Selected ${target.label} style` : `${target.label} tool style`}
    >
      <span className={"psl__et-props-tag" + (target.kind === "layer" ? " is-selected" : "")}>
        {target.kind === "layer"
          ? `Selected · ${target.label}`
          : target.armedSlot !== null
            ? `Slot ${target.armedSlot + 1}${target.armedSlotModified ? " · edited" : ""}`
            : target.label}
      </span>
      {/* Before the fields: the bar is a flow layout and floats these to
          the right end of row one, and a float cannot rise above the line
          it comes after. Row one is also where they sit on a narrow stage. */}
      <div className="psl__et-props-actions">
        {target.kind === "layer" && target.tool === "arrow" && onAddLabel !== undefined && (
          <button
            type="button"
            className="psl__et-props-btn is-primary"
            data-testid="property-bar-add-label"
            data-tip="Add a label at its tail"
            data-tip-keys={shortcutPlatform === "darwin" ? "↵" : "Enter"}
            data-tip-detail="Type, then Return. Empty is discarded."
            onClick={() => onAddLabel(target.layerId)}
          >
            Add label
          </button>
        )}
        {updateIndex !== null && (
          <button
            type="button"
            className="psl__et-props-btn is-primary"
            data-testid="property-bar-update-slot"
            onClick={() => onSaveToSlot(updateIndex, saveTarget)}
          >
            Update slot {updateIndex + 1}
          </button>
        )}
        <button
          type="button"
          className="psl__et-props-btn"
          data-testid="property-bar-save-to-bag"
          // aria-disabled, not disabled: a disabled button leaves the tab
          // order, and then the reason in its tooltip is unreachable.
          aria-disabled={saveBlockedTip !== null}
          data-tip={saveBlockedTip ?? `Save this style to slot ${(firstEmptySlot ?? 0) + 1}`}
          onClick={() => {
            if (saveBlockedTip === null && firstEmptySlot !== null) {
              onSaveToSlot(firstEmptySlot, saveTarget);
            }
          }}
        >
          + Save to bag
        </button>
      </div>
      <div
        className="psl__et-props-body"
        // On a narrow stage this is a sideways-scrolling strip, and
        // Chromium does not scroll a partly visible target sideways when
        // Tab lands on it. A no-op when the control is already in view.
        onFocus={(event) => {
          const target = event.target;
          // jsdom has no scrollIntoView.
          if (target instanceof HTMLElement && typeof target.scrollIntoView === "function") {
            target.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
        }}
      >
        <ToolStyleBody
          tool={target.tool}
          style={target.style}
          onStyleFieldChange={onFieldChange}
          hintsInTooltips
          {...(target.kind === "layer" ? { styleTargetKey: target.layerId } : {})}
          allowEraser={target.kind === "tool"}
        />
      </div>
      {target.kind === "layer" && (
        <span className="psl__et-props-hint">
          <kbd>{shift}</kbd>
          <kbd>1</kbd>–<kbd>9</kbd> restyles it
        </span>
      )}
    </div>
  );
}
