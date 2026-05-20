// Session-memory undo/redo stack for editor overlay edits.
//
// The DB doesn't track an edit history per se — every overlay change
// goes through `overlays:upsert` or `overlays:delete` and bumps the
// capture's `edits_version`. For v1 undo/redo we don't need persistent
// time-travel; we just need the user to be able to walk back the
// operations they did in *this* editor session.
//
// Two stacks (past + future), standard semantics:
//   • Every user-initiated edit pushes to `past`, clears `future`.
//   • ⌘Z pops `past`, applies the INVERSE of that op, pushes the
//     ORIGINAL onto `future`.
//   • ⌘⇧Z (or ⌘Y) pops `future`, RE-applies the original op, pushes
//     it back onto `past`.
//
// Caveats:
//   • Overlays that arrive via Codex / AI broadcast are NOT recorded.
//     Only ops the user initiated from the editor UI go on the stack.
//     Otherwise ⌘Z could undo an AI suggestion and produce confusing
//     state.
//   • Capacity-bounded at MAX_DEPTH=100. Older ops drop off the back.
//
// The recompose cost per undo is one v1-bake pass (~10-50ms on
// typical captures). For arrow/rect/text overlays this is below
// human-perceptible latency — feels instant.

import { useCallback, useEffect, useRef, useState } from "react";
import type { OverlayRow } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

/**
 * EditOps recorded on the undo stack. v1 only has `create` and
 * `delete` because the overlays IPC is INSERT-only — `overlays:upsert`
 * always produces a new row id, and there is no `overlays:update`.
 *
 * When the editor grows drag-existing-overlay (edit-after-place), an
 * "edit" will be recorded as TWO independent ops: a `delete` of the
 * existing row + a `create` of the replacement. Undoing once reverts
 * the most-recent half (the create), undoing twice reverts the
 * other half (the delete). That keeps the IPC contract honest — the
 * hook never has to fabricate an id round-trip.
 */
export type EditOp =
  | { kind: "create"; row: OverlayRow }
  | { kind: "delete"; row: OverlayRow };

const MAX_DEPTH = 100;

export type UseUndoRedoResult = {
  recordCreate: (row: OverlayRow) => void;
  recordDelete: (row: OverlayRow) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
};

export function useUndoRedo(opts: {
  captureId: string;
  /** True while a programmatic undo/redo is in flight — caller
   *  uses this to suppress recording of the resulting IPC roundtrip,
   *  which would otherwise re-enter the stack. */
  applyingRef?: React.RefObject<boolean>;
}): UseUndoRedoResult {
  const { captureId } = opts;
  const [past, setPast] = useState<EditOp[]>([]);
  const [future, setFuture] = useState<EditOp[]>([]);
  // Internal ref used to suppress recording when WE are the ones
  // re-issuing an op via undo/redo. If the caller passed an
  // `applyingRef`, we expose ours through that one too — but the
  // canonical source of truth lives here.
  const applying = useRef(false);

  const wrapApplying = useCallback(
    async (fn: () => Promise<void>): Promise<void> => {
      applying.current = true;
      if (opts.applyingRef !== undefined) {
        (opts.applyingRef as React.RefObject<boolean>).current = true;
      }
      try {
        await fn();
      } finally {
        applying.current = false;
        if (opts.applyingRef !== undefined) {
          (opts.applyingRef as React.RefObject<boolean>).current = false;
        }
      }
    },
    [opts.applyingRef]
  );

  const push = useCallback((op: EditOp) => {
    if (applying.current) return;
    setPast((prev) => {
      const next = prev.length >= MAX_DEPTH ? prev.slice(1) : prev;
      return [...next, op];
    });
    setFuture([]);
  }, []);

  const recordCreate = useCallback(
    (row: OverlayRow) => push({ kind: "create", row }),
    [push]
  );
  const recordDelete = useCallback(
    (row: OverlayRow) => push({ kind: "delete", row }),
    [push]
  );

  const undo = useCallback(async () => {
    const op = past[past.length - 1];
    if (op === undefined) return;
    await wrapApplying(async () => {
      if (op.kind === "create") {
        await dispatch("overlays:delete", { id: op.row.id });
      } else {
        // Re-create the row with its original data. The new row gets
        // a fresh id from `insertOverlay` — that's fine for session-
        // only undo because the user observes via screen-space, not
        // by id.
        await dispatch("overlays:upsert", {
          captureId,
          overlay: op.row.data
        });
      }
    });
    setPast((prev) => prev.slice(0, -1));
    setFuture((prev) => [...prev, op]);
  }, [past, captureId, wrapApplying]);

  const redo = useCallback(async () => {
    const op = future[future.length - 1];
    if (op === undefined) return;
    await wrapApplying(async () => {
      if (op.kind === "create") {
        await dispatch("overlays:upsert", {
          captureId,
          overlay: op.row.data
        });
      } else {
        await dispatch("overlays:delete", { id: op.row.id });
      }
    });
    setFuture((prev) => prev.slice(0, -1));
    setPast((prev) => [...prev, op]);
  }, [future, captureId, wrapApplying]);

  // Cmd+Z / Cmd+Shift+Z / Cmd+Y keyboard bindings. Skipped when a
  // text field has focus (the user is typing — Cmd+Z should be
  // browser-default text-undo).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true
      ) {
        return;
      }
      if (e.key === "z" || e.key === "Z") {
        e.preventDefault();
        if (e.shiftKey) {
          void redo();
        } else {
          void undo();
        }
      } else if (e.key === "y") {
        e.preventDefault();
        void redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  return {
    recordCreate,
    recordDelete,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0
  };
}
