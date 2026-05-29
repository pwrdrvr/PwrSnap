// Pure decision function for the right-click context menu's item
// list. Takes the current selection + overlay list and returns the
// items to render with correct enable/disable per the matrix in
// issue #134. Extracted so the matrix is testable in isolation
// without mounting the editor.
//
// The menu items map 1:1 onto verbs the keyboard surface already
// dispatches (copy / paste / duplicate / delete / z-order /
// requestEdit). The context menu is a UI shell over the same code
// path — picking an item from this list just invokes the same
// callback the keyboard handler would. No new IPC verbs.
//
// Enable/disable rules per issue #134 §"Selection-state-aware":
//   • z-order ops: disabled when nothing selected; otherwise enabled
//     (boundary checks like "top layer can't move forward" live in
//     `computeNewOrder` itself — picking a no-op item there is a
//     silent no-op, which is acceptable UX. v1 of the menu doesn't
//     pre-disable at the boundary because computing it requires the
//     full overlay list and order; the keyboard surface doesn't
//     pre-disable either, so this matches existing behavior.)
//   • Cut / Copy / Duplicate / Delete: enabled when ≥1 selected
//   • Paste: always enabled — handler falls back through OS clipboard
//     then in-memory then no-op. Disabling would require an extra
//     "is paste available" IPC probe (we don't have one), and
//     always-on matches Figma's UX
//   • Edit Text: enabled only on single text selection
//
// Accelerator labels are the strings users see on the right side of
// each row. They're informational — clicking the row dispatches the
// item's verb directly, the kbd accel still works independently.

import type { OverlayRow } from "@pwrsnap/shared";

/** Identifiers used both to label the action AND to route the click
 *  back to the right callback in the caller. Kept as a string-union
 *  rather than an enum so JSON-style test inputs stay readable. */
export type LayerContextMenuItemId =
  | "edit-text"
  | "cut"
  | "copy"
  | "paste"
  | "duplicate"
  | "delete"
  | "bring-to-front"
  | "bring-forward"
  | "send-backward"
  | "send-to-back";

export interface LayerContextMenuItem {
  /** Discriminator used both for routing and for testing. */
  readonly id: LayerContextMenuItemId;
  /** Human-readable row label. */
  readonly label: string;
  /** Right-side keyboard hint. Empty string = no accelerator (no
   *  current keyboard binding for the action; not the same as a
   *  bound action with no hint — every item in this menu has a
   *  binding today). */
  readonly accel: string;
  /** When false, the row renders greyed and ignores clicks. */
  readonly enabled: boolean;
  /** True for the divider that separates the clipboard group from
   *  the z-order group from the destructive group. The menu renders
   *  a thin separator row for these and skips them in keyboard
   *  navigation. */
  readonly isSeparator?: boolean;
}

export interface BuildLayerContextMenuItemsArgs {
  /** Current multi-select state. */
  readonly selectedLayerIds: readonly string[];
  /** All overlay rows for the current capture — needed to look up
   *  the kind of the selected row (to gate "Edit Text" on
   *  text-kind single selection). */
  readonly overlays: readonly OverlayRow[];
}

/** Built-in accelerator strings — match the bindings in
 *  Editor.tsx's global keyboard handler. Cmd is rendered as ⌘ to
 *  match macOS convention; on the renderer side we use bare key
 *  glyphs because PwrSnap is macOS-first. Cross-platform variants
 *  ship in Phase 8 (per CLAUDE.md). */
const ACCEL = {
  editText: "↵",
  cut: "⌘X",
  copy: "⌘C",
  paste: "⌘V",
  duplicate: "⌘D",
  delete: "⌫",
  bringToFront: "⌘⇧]",
  bringForward: "⌘]",
  sendBackward: "⌘[",
  sendToBack: "⌘⇧["
} as const;

/** Sentinel for the separator entry. Renderer detects via
 *  `item.isSeparator === true`. */
const SEPARATOR: LayerContextMenuItem = {
  id: "delete", // unused for separators; satisfies the type
  label: "",
  accel: "",
  enabled: false,
  isSeparator: true
};

export function buildLayerContextMenuItems(
  args: BuildLayerContextMenuItemsArgs
): LayerContextMenuItem[] {
  const { selectedLayerIds, overlays } = args;
  const hasSelection = selectedLayerIds.length > 0;
  const isSingleSelection = selectedLayerIds.length === 1;
  // Look up the single selected layer's kind to gate "Edit Text".
  // Multi-selection or non-text → disabled.
  const singleSelectedKind: OverlayRow["data"]["kind"] | null =
    isSingleSelection
      ? (overlays.find((o) => o.id === selectedLayerIds[0])?.data.kind ?? null)
      : null;
  const isSingleTextSelection = singleSelectedKind === "text";

  const items: LayerContextMenuItem[] = [];

  // Edit Text — only on single-text. Appears at the TOP because
  // it's the most contextually-specific action; if it's enabled
  // (you right-clicked a single text overlay) it's probably what
  // you meant.
  if (isSingleTextSelection) {
    items.push({
      id: "edit-text",
      label: "Edit Text",
      accel: ACCEL.editText,
      enabled: true
    });
    items.push(SEPARATOR);
  }

  // Clipboard group: Cut / Copy / Paste / Duplicate.
  items.push({
    id: "cut",
    label: "Cut",
    accel: ACCEL.cut,
    enabled: hasSelection
  });
  items.push({
    id: "copy",
    label: "Copy",
    accel: ACCEL.copy,
    enabled: hasSelection
  });
  items.push({
    id: "paste",
    label: "Paste",
    accel: ACCEL.paste,
    // Always-on per the issue's "no new IPC verbs" constraint —
    // we don't have a cheap "is OS clipboard non-empty for our UTI"
    // probe, and disabling based on in-memory alone would miss the
    // cross-window paste case. Click falls through to the existing
    // pasteFromClipboard handler which silently no-ops on empty.
    enabled: true
  });
  items.push({
    id: "duplicate",
    label: "Duplicate",
    accel: ACCEL.duplicate,
    enabled: hasSelection
  });

  items.push(SEPARATOR);

  // Z-order group. Disabled when nothing is selected; boundary
  // checks (top layer can't move forward) are deferred to the
  // dispatch — `computeNewOrder` handles the boundary by emitting
  // no changes, which results in a silent no-op. Matches the
  // keyboard surface's behavior.
  items.push({
    id: "bring-to-front",
    label: "Bring to Front",
    accel: ACCEL.bringToFront,
    enabled: hasSelection
  });
  items.push({
    id: "bring-forward",
    label: "Bring Forward",
    accel: ACCEL.bringForward,
    enabled: hasSelection
  });
  items.push({
    id: "send-backward",
    label: "Send Backward",
    accel: ACCEL.sendBackward,
    enabled: hasSelection
  });
  items.push({
    id: "send-to-back",
    label: "Send to Back",
    accel: ACCEL.sendToBack,
    enabled: hasSelection
  });

  items.push(SEPARATOR);

  // Destructive group: Delete only (Cut is in the clipboard group
  // above per macOS Edit-menu convention; some apps put it down
  // here too but the clipboard-group placement is more familiar).
  items.push({
    id: "delete",
    label: "Delete",
    accel: ACCEL.delete,
    enabled: hasSelection
  });

  return items;
}
