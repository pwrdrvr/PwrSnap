// The ONE place a grid-cell interaction is turned into an intent.
//
// The grid-first select/edit split routes a plain single-click → SELECT
// (update the inspector, stay in grid) and the explicit triggers — the
// orange Edit CTA, the Enter key on the selected tile, a double-click,
// and the editor:open IPC — → EDIT (open the takeover). All of those
// paths resolve through THIS pure function so they cannot drift apart.
// A prior incident (docs/solutions/2026-06-07-capture-selector-
// interaction-and-state.md) is exactly the divergence this prevents:
// one physical gesture reaching a handler via two paths with per-path
// logic that disagrees.
//
// Pure logic, no React/DOM. Tests at __tests__/resolve-cell-intent.test.ts.

export type CellTrigger =
  /** plain single-click → SELECT */
  | "click"
  /** double-click → EDIT */
  | "dblclick"
  /** Enter on the selected tile → EDIT */
  | "enter"
  /** the orange hover Edit CTA → EDIT */
  | "edit-cta"
  /** editor:open IPC (Codex / undo-restore / external) → EDIT */
  | "ipc-open";

/** A grid cell narrowed to a closed union BEFORE the resolver sees it, so
 *  the resolver stays exhaustive. The live grid model is a flat `Capture`
 *  where project-ness, fixture-ness, and trashed-ness are separate runtime
 *  checks; `toGridCell` collapses those into this discriminant. */
export type GridCell =
  | { readonly kind: "capture"; readonly recordId: string; readonly isTrashed: boolean }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "fixture" };

export type CellIntent =
  /** Mark the capture selected; update the inspector; stay in grid. */
  | { readonly kind: "select"; readonly recordId: string }
  /** Open the editor takeover (image annotate OR video player). */
  | { readonly kind: "edit"; readonly recordId: string }
  /** Open the Sizzle project window (projects are exempt from the split). */
  | { readonly kind: "open-sizzle"; readonly projectId: string }
  /** Do nothing (fixture/skeleton cell, or an edit attempt on trash). */
  | { readonly kind: "noop" };

const EDIT_TRIGGERS: ReadonlySet<CellTrigger> = new Set<CellTrigger>([
  "dblclick",
  "enter",
  "edit-cta",
  "ipc-open"
]);

export function resolveCellIntent(trigger: CellTrigger, cell: GridCell): CellIntent {
  switch (cell.kind) {
    case "project":
      // Exempt from the select/edit split — any interaction opens the
      // Sizzle window (its natural "edit"), matching today's behavior.
      return { kind: "open-sizzle", projectId: cell.projectId };

    case "fixture":
      // Placeholder/skeleton cells with no backing record do nothing.
      return { kind: "noop" };

    case "capture": {
      if (!EDIT_TRIGGERS.has(trigger)) {
        return { kind: "select", recordId: cell.recordId };
      }
      // Trashed captures can be SELECTED (read metadata / restore via the
      // inspector) but not EDITED — the editor:open handler refuses them
      // server-side, so the client mirrors that to keep parity.
      if (cell.isTrashed) {
        return { kind: "noop" };
      }
      return { kind: "edit", recordId: cell.recordId };
    }
  }
}

/** Narrow the live, flat grid cell into a `GridCell` discriminant. Project
 *  is checked first (matching the existing onSelectCell order), then
 *  fixture (no backing record), then a real capture. */
export function toGridCell(input: {
  readonly recordId: string;
  readonly isProject: boolean;
  readonly projectId: string | null;
  readonly hasBackingRecord: boolean;
  readonly isTrashed: boolean;
}): GridCell {
  if (input.isProject && input.projectId !== null) {
    return { kind: "project", projectId: input.projectId };
  }
  if (!input.hasBackingRecord) {
    return { kind: "fixture" };
  }
  return { kind: "capture", recordId: input.recordId, isTrashed: input.isTrashed };
}
