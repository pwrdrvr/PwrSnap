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
//
// v2 editor refresh (Phase 2, task #14) — coalescing per plan Alt 5:
//
//   • **Mouse-up boundary.** Editor's pointer handlers bracket a drag
//     with `beginInteraction(opKind, layerId)` (pointerdown) /
//     `endInteraction(token)` (pointerup). Every write between those
//     calls collapses into a single undo entry (the FIRST recorded
//     row's "before" state pairs with the LAST recorded row's
//     "after"). A continuous drag emitting N intermediate writes →
//     ONE undo step.
//
//   • **300ms grace window per (layer id, op kind).** For non-drag
//     bursts (e.g. clicking 5 different color swatches in 200ms),
//     consecutive writes against the same (layer, op kind) within
//     300ms collapse into a single entry too. The recorder tracks
//     the last (opKind, layerId, timestamp); a fresh write that
//     matches replaces the latest stack entry's "to" row.
//
//   Both mechanisms are additive — calling `recordCreate` without
//   bracketing keeps the original "every call → one entry" semantics
//   except when the grace window catches a follow-up.

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
/** Coalescing grace window for non-drag bursts (color clicks etc).
 *  Consecutive writes against the SAME (opKind, layerId) inside this
 *  window collapse into the most-recent entry's "to" state. Tuned to
 *  300ms per plan Alt 5 — short enough that two deliberate clicks
 *  don't merge, long enough that a typical "click 5 swatches in a
 *  row" burst lands as ONE undo step. */
const COALESCE_WINDOW_MS = 300;

/** Opaque token returned by `beginInteraction`. Callers stash it in a
 *  ref during pointerdown→pointermove→pointerup; pass back to
 *  `endInteraction` to close the bracket. Tokens are intentionally
 *  opaque so a stale token from a previous interaction doesn't bleed
 *  state across captures. */
export type InteractionToken = { readonly __brand: "InteractionToken" };

export type UseUndoRedoResult = {
  recordCreate: (row: OverlayRow, opts?: RecordOptions) => void;
  recordDelete: (row: OverlayRow, opts?: RecordOptions) => void;
  /** Open a coalescing bracket. Every recordCreate/recordDelete made
   *  between this call and `endInteraction(token)` collapses into one
   *  undo entry. */
  beginInteraction: (opKind: string, layerId: string) => InteractionToken;
  /** Close the bracket. Subsequent writes start a fresh undo entry
   *  (subject to the 300ms grace window). */
  endInteraction: (token: InteractionToken) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
};

/** Hints for the coalescing layer. When provided, two consecutive
 *  records with matching opKind + layerId fold into one undo entry
 *  (within the 300ms grace window OR while an interaction bracket is
 *  open). Omitted = legacy behavior (every record is its own entry). */
export type RecordOptions = {
  /** A string identifier for the operation kind (e.g. "drag",
   *  "setColor", "resize"). Used as half of the coalescing key. */
  readonly opKind?: string;
  /** The layer (or future v2 layer) being edited. Used as the other
   *  half of the coalescing key. v1 row ids work — pass `row.id` for
   *  edits to the same overlay. */
  readonly layerId?: string;
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

  // Coalescing state — refs so it doesn't trigger renders.
  //
  //   • `openInteractionRef`: { opKind, layerId } while a bracket is
  //     open (pointerdown→pointerup). Any record inside the bracket
  //     matching the same key collapses into the latest entry. We
  //     store the actual key object so a fresh `beginInteraction`
  //     creates a brand-new identity (don't accidentally merge two
  //     drags of the same layer).
  //   • `lastCoalesceRef`: { opKind, layerId, timestamp } from the
  //     most recent push. For non-bracketed writes, a follow-up
  //     within COALESCE_WINDOW_MS that matches the key collapses too.
  const openInteractionRef = useRef<{
    token: InteractionToken;
    opKind: string;
    layerId: string;
    /** Becomes true on the FIRST push made inside this bracket. Only
     *  subsequent pushes coalesce — otherwise the first write of a
     *  fresh interaction would accidentally merge with whatever the
     *  previous interaction left on top of the stack (different
     *  layer, same opKind, etc.). */
    hasPushed: boolean;
  } | null>(null);
  const lastCoalesceRef = useRef<{
    opKind: string;
    layerId: string;
    timestamp: number;
  } | null>(null);

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

  const push = useCallback((op: EditOp, recordOpts?: RecordOptions) => {
    if (applying.current) return;
    const opKind = recordOpts?.opKind;
    const layerId = recordOpts?.layerId;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();

    // Decide whether to coalesce with the most recent past entry.
    // Two conditions trigger a merge:
    //   (a) we're inside an open interaction bracket whose key matches,
    //   (b) the previous push was within COALESCE_WINDOW_MS AND its
    //       key matches.
    // Both require opKind + layerId to be provided; legacy calls with
    // neither always start a fresh entry.
    const insideInteraction =
      openInteractionRef.current !== null &&
      openInteractionRef.current.hasPushed &&
      opKind !== undefined &&
      layerId !== undefined &&
      openInteractionRef.current.opKind === opKind &&
      openInteractionRef.current.layerId === layerId;
    const insideGraceWindow =
      lastCoalesceRef.current !== null &&
      opKind !== undefined &&
      layerId !== undefined &&
      lastCoalesceRef.current.opKind === opKind &&
      lastCoalesceRef.current.layerId === layerId &&
      now - lastCoalesceRef.current.timestamp <= COALESCE_WINDOW_MS;

    const shouldCoalesce = insideInteraction || insideGraceWindow;

    setPast((prev) => {
      if (shouldCoalesce && prev.length > 0) {
        // Replace the latest entry's "after" state with the new op's
        // row, preserving the original "before" (the first push of
        // the run). For a create-followed-by-create this means: keep
        // the FIRST entry's op kind/structure, swap its row. So the
        // undo replays the inverse of the LATEST state — exactly
        // what the user expects ("undo the whole burst").
        const next = prev.slice(0, -1);
        const lastEntry = prev[prev.length - 1]!;
        // Preserve the entry's kind (create vs delete) and just swap
        // the row to the newest one — the inverse op on undo will
        // then target the latest IPC artifact.
        const merged: EditOp =
          lastEntry.kind === "create"
            ? { kind: "create", row: op.kind === "create" ? op.row : lastEntry.row }
            : { kind: "delete", row: op.kind === "delete" ? op.row : lastEntry.row };
        return [...next, merged];
      }
      const trimmed = prev.length >= MAX_DEPTH ? prev.slice(1) : prev;
      return [...trimmed, op];
    });
    setFuture([]);

    // Update coalescing trackers. Only meaningful when the caller
    // gave us a key.
    if (opKind !== undefined && layerId !== undefined) {
      lastCoalesceRef.current = { opKind, layerId, timestamp: now };
    } else {
      // Untagged write — clear the grace window so a subsequent
      // tagged write doesn't accidentally fold into it.
      lastCoalesceRef.current = null;
    }
    // Mark the open bracket (if any) as having pushed at least
    // once — subsequent pushes inside it can now coalesce.
    if (openInteractionRef.current !== null) {
      openInteractionRef.current = {
        ...openInteractionRef.current,
        hasPushed: true
      };
    }
  }, []);

  const recordCreate = useCallback(
    (row: OverlayRow, opts?: RecordOptions) =>
      push({ kind: "create", row }, opts),
    [push]
  );
  const recordDelete = useCallback(
    (row: OverlayRow, opts?: RecordOptions) =>
      push({ kind: "delete", row }, opts),
    [push]
  );

  const beginInteraction = useCallback(
    (opKind: string, layerId: string): InteractionToken => {
      // Fresh object identity per call so an interaction can't be
      // accidentally re-entered or merged across pointer cycles.
      const token = {} as InteractionToken;
      openInteractionRef.current = { token, opKind, layerId, hasPushed: false };
      // pointerdown is a hard boundary — clear any lingering grace
      // window from the previous burst so the first push inside this
      // bracket can't fold into an unrelated stack entry.
      lastCoalesceRef.current = null;
      return token;
    },
    []
  );

  const endInteraction = useCallback((token: InteractionToken): void => {
    if (
      openInteractionRef.current !== null &&
      openInteractionRef.current.token === token
    ) {
      openInteractionRef.current = null;
      // Also clear the grace window so a fresh click 50ms after
      // pointerup starts a brand-new entry — pointerup is a hard
      // boundary even when the grace window would otherwise apply.
      lastCoalesceRef.current = null;
    }
    // Mismatched token (e.g. caller forgot to end the previous one)
    // is silently ignored — better than throwing inside a pointer
    // handler.
  }, []);

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
    // After an undo, drop the grace window — a fresh edit shouldn't
    // be coalesced into an entry that's no longer on the past stack.
    lastCoalesceRef.current = null;
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
    lastCoalesceRef.current = null;
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
    beginInteraction,
    endInteraction,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0
  };
}
