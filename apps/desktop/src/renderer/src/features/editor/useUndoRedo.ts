// Session-memory undo/redo stack for editor layer edits.
//
// The DB doesn't track an edit history per se — every layer change
// goes through `layers:upsert` / `layers:delete` (via the dispatcher)
// and bumps the capture's `edits_version`. We don't need persistent
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
// The recompose cost per undo is one bake pass (~10-50ms on typical
// captures). For arrow/rect/text layers this is below human-
// perceptible latency — feels instant.
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
import type { BundleLayerNode, OverlayRow, PwrSnapError, Result } from "@pwrsnap/shared";
import { registerEditorUndoRedo } from "../../lib/editMenuBridge";
import type {
  CropRect,
  EditOpResult,
  GeometryUpdate,
  LayerEditOp,
  OverlayPatch
} from "./useCaptureModel";

/**
 * EditOps recorded on the undo stack.
 *
 * create/delete ops carry both an OverlayRow (`row`, for the row.id
 * and coalescing diff) and the original BundleLayerNode (`node`) so
 * the redo of a delete (or undo of a create) can dispatch
 * `layers:upsert` with the structurally-identical layer shape —
 * preserving parent_id / z_index / transform beyond what's in
 * row.data.
 *
 * `crop` ops carry the previous canvas dimensions (in source pixels)
 * so undo can restore them via bundle:updateCanvasDimensions.
 */
/** Single create-or-delete entry — the data the inverse needs to
 *  re-upsert (on delete-undo) or re-delete (on create-undo). Stored
 *  inside the items[] array on create/delete EditOps so a coalesced
 *  burst can carry MULTIPLE distinct layers' state without dropping
 *  any (the pre-fix shape held one row per EditOp and the coalesce
 *  path REPLACED it with the latest push — silently discarding
 *  earlier rows in a multi-delete / multi-paste burst). */
export type CreateDeleteItem = {
  row: OverlayRow;
  node: BundleLayerNode | null;
};

/** Single geometry-change entry — same array discipline as
 *  CreateDeleteItem. Each item tracks ONE logical layer's id chain
 *  via `currentIdRef`; multi-drag bursts carry N such items (one per
 *  layer the user grabbed) in a single coalesced EditOp. */
export type GeometryItem = {
  currentIdRef: { current: string };
  previousGeometry: GeometryUpdate;
  nextGeometry: GeometryUpdate;
};

export type EditOp =
  | { kind: "create"; items: CreateDeleteItem[] }
  | { kind: "delete"; items: CreateDeleteItem[] }
  | {
      kind: "crop";
      /** Normalized rect that produced this crop — re-dispatched on
       *  redo. */
      rect: CropRect;
      /** Canvas dims (in source pixels) BEFORE this crop landed —
       *  re-dispatched on undo as a normalized full-canvas rect. */
      previousWidthPx: number;
      previousHeightPx: number;
      /** Canvas dims AFTER this crop landed — used to compute the
       *  normalized full-canvas rect to send on undo, since
       *  bundle:updateCanvasDimensions interprets the dispatcher's
       *  crop op as `rect.w/h × currentCanvasDims`. */
      newWidthPx: number;
      newHeightPx: number;
    }
  /** Phase 3.5 — drag of an existing overlay's transform handle, or
   *  edit of its style via the popover. The update IPC is implemented
   *  as delete-plus-insert (the overlays/layers surface is INSERT-only
   *  + id-collision-on-upsert respectively), so each undo/redo cycle
   *  also lands a fresh id. We track that via `currentIdRef` — a
   *  mutable id pointer kept inside the EditOp so the next undo/redo
   *  call targets the latest live row in the chain.
   *
   *  `previousGeometry` / `nextGeometry` carry the pre/post-edit
   *  geometry; undo replays the previous, redo replays the next. Same
   *  shape for style edits via `previousPatch` / `nextPatch`.
   *
   *  Both kinds use the format-aware dispatcher's `updateGeometry` /
   *  `updateOverlay` verbs — no direct bus access from this hook. */
  | { kind: "geometry"; items: GeometryItem[] }
  | {
      kind: "style";
      currentIdRef: { current: string };
      previousPatch: OverlayPatch;
      nextPatch: OverlayPatch;
    };

const MAX_DEPTH = 100;

/** Merge the new op's items into the existing entry's items array
 *  per the requested mergeMode. Each op produced by recordCreate /
 *  recordDelete / recordGeometry carries exactly one item (the
 *  public API is single-row); push()'s coalesce path is where
 *  multiple items accumulate (append) or replace (drag bursts).
 *  Hoisted out of push() because the same shape applies across
 *  create / delete / geometry kinds. */
function mergeItems<T>(
  existing: readonly T[],
  incoming: readonly T[],
  mergeMode: "replace" | "append"
): T[] {
  if (mergeMode === "append") {
    return [...existing, ...incoming];
  }
  // "replace": swap the LAST item only. Preserves items[0..-2]
  // if the caller built up a multi-layer prefix earlier in the
  // bracket and then a same-layer rapid burst follows on the
  // last layer. In practice every same-bracket call uses the
  // same mergeMode so existing.length is usually 1 here and the
  // result is just `incoming` — slice() handles the general
  // case defensively.
  if (existing.length === 0) return [...incoming];
  if (incoming.length === 0) return [...existing];
  return [...existing.slice(0, -1), incoming[incoming.length - 1]!];
}
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
  /** Record a layer create. Pass the inserted BundleLayerNode under
   *  `node` — required so the redo path can re-dispatch `layers:upsert`
   *  with the original layer shape. */
  recordCreate: (
    row: OverlayRow,
    opts?: RecordOptions & { node?: BundleLayerNode | null }
  ) => void;
  recordDelete: (
    row: OverlayRow,
    opts?: RecordOptions & { node?: BundleLayerNode | null }
  ) => void;
  /** Record a crop. `rect` is the normalized rect that was committed.
   *  `previousWidthPx`/`previousHeightPx` come from the dispatchEdit
   *  result's crop artifact (the canvas dims before this crop landed).
   *  `newWidthPx`/`newHeightPx` are the post-crop dims — captured here
   *  because undo needs them to compute the normalized rect that
   *  restores the previous canvas size. */
  recordCrop: (entry: {
    rect: CropRect;
    previousWidthPx: number;
    previousHeightPx: number;
    newWidthPx: number;
    newHeightPx: number;
  }) => void;
  /** Phase 3.5 — record a geometry change (transform-handle drag).
   *  `previousGeometry` is the PRE-DRAG geometry, `nextGeometry` is
   *  the POST-DRAG geometry. `currentIdRef` is a mutable id pointer
   *  the hook updates after each undo/redo cycle (the update IPC mints
   *  a fresh id on every replay). Caller initializes it with the
   *  post-edit layer id (typically `result.value.artifact.node.id`).
   *  The caller is responsible for updating the selection model to
   *  follow `currentIdRef.current` on undo/redo. */
  recordGeometry: (
    entry: {
      currentIdRef: { current: string };
      previousGeometry: GeometryUpdate;
      nextGeometry: GeometryUpdate;
    },
    opts?: RecordOptions
  ) => void;
  /** Phase 3.5 — record a style change from the selected-overlay
   *  popover edit. `previousPatch` reverts to the pre-edit state;
   *  `nextPatch` is the patch the user just applied. Same id-chain
   *  semantics as `recordGeometry`. */
  recordStyle: (entry: {
    currentIdRef: { current: string };
    previousPatch: OverlayPatch;
    nextPatch: OverlayPatch;
  }) => void;
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

/** Dispatcher passed in by the caller (Editor.tsx wires this from the
 *  resolved CaptureModel). The hook never reaches for the bus directly
 *  — it just hands layer ops to this callback. Same shape as
 *  `CaptureModelV2.dispatchEdit`. */
export type UndoRedoDispatchEdit = (
  op: LayerEditOp
) => Promise<Result<EditOpResult, PwrSnapError>>;

/** Hints for the coalescing layer. When provided, two consecutive
 *  records with matching opKind + layerId fold into one undo entry
 *  (within the 300ms grace window OR while an interaction bracket is
 *  open). Omitted = legacy behavior (every record is its own entry). */
export type RecordOptions = {
  /** A string identifier for the operation kind (e.g. "drag",
   *  "setColor", "resize"). Used as half of the coalescing key. */
  readonly opKind?: string;
  /** The layer being edited. Used as the other half of the coalescing
   *  key — pass `row.id` for edits to the same layer. */
  readonly layerId?: string;
  /** How to coalesce when this push matches an open bracket's key:
   *   - `"replace"` (default): the NEW row/geometry REPLACES the last
   *     item in the entry's items[] array. This is the correct mode
   *     for SAME-LAYER bursts where each push is an intermediate
   *     state of the same logical edit (pointermove during a drag,
   *     rapid color clicks on one layer) — undo should restore the
   *     pre-burst state and the items[] keeps a single most-recent
   *     "after" for redo.
   *   - `"append"`: the NEW item is APPENDED to the entry's items[]
   *     array. This is the correct mode for DIFFERENT-LAYER bursts
   *     where each push describes a distinct layer's state
   *     (multi-delete, multi-drag, multi-paste). Undo loops over
   *     every item and dispatches the inverse for each.
   *
   *  Pre-fix, push() only had the replace shape, which silently
   *  DROPPED earlier rows in a different-layer burst — the user
   *  reported "I selected two text items, hit delete, only ONE
   *  came back on undo and the other was unrecoverable." That's
   *  the bug `mergeMode: "append"` exists to prevent. */
  readonly mergeMode?: "replace" | "append";
};

export function useUndoRedo(opts: {
  captureId: string;
  /** True while a programmatic undo/redo is in flight — caller
   *  uses this to suppress recording of the resulting IPC roundtrip,
   *  which would otherwise re-enter the stack. */
  applyingRef?: React.RefObject<boolean>;
  /** Dispatcher from the resolved CaptureModel. The hook never reaches
   *  for the bus directly — every undo/redo IPC goes through this
   *  callback, which emits the right `layers:*` verb. */
  dispatchEdit: UndoRedoDispatchEdit;
}): UseUndoRedoResult {
  const [past, setPast] = useState<EditOp[]>([]);
  const [future, setFuture] = useState<EditOp[]>([]);
  // Stash the dispatchEdit in a ref so the undo/redo callbacks don't
  // re-create on every render (it changes identity whenever the model
  // refetches, which is every layer write).
  const dispatchEditRef = useRef<UndoRedoDispatchEdit>(opts.dispatchEdit);
  dispatchEditRef.current = opts.dispatchEdit;
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

    const mergeMode = recordOpts?.mergeMode ?? "replace";
    setPast((prev) => {
      if (shouldCoalesce && prev.length > 0) {
        const next = prev.slice(0, -1);
        const lastEntry = prev[prev.length - 1]!;
        // Coalesce only when both entries are the SAME op kind
        // (mixing create/delete/geometry inside one bracket would
        // be a programming bug — push standalone for safety).
        // Within the matching-kind branches the merge SHAPE depends
        // on mergeMode:
        //
        //   "replace" (default): swap the LAST item in the entry's
        //     items[] with the new op's first item. The "before"
        //     stored at items[0..-2] (if any) is preserved. For a
        //     pure same-layer burst (e.g. a drag with 5 intermediate
        //     writes), items[] stays length 1 — first push sets
        //     it, subsequent pushes replace it. Undo restores the
        //     pre-burst state via the entry's previousGeometry /
        //     row data; redo replays the LATEST.
        //
        //   "append": append the new op's first item to items[].
        //     Multi-delete / multi-drag / multi-paste all use this
        //     so the undo loop can dispatch one inverse per layer
        //     rather than restoring only the most-recent and
        //     dropping the rest (the user-reported "one of two
        //     deleted layers cannot be recovered" bug).
        let merged: EditOp = lastEntry;
        if (lastEntry.kind === "create" && op.kind === "create") {
          merged = {
            kind: "create",
            items: mergeItems(lastEntry.items, op.items, mergeMode)
          };
        } else if (lastEntry.kind === "delete" && op.kind === "delete") {
          merged = {
            kind: "delete",
            items: mergeItems(lastEntry.items, op.items, mergeMode)
          };
        } else if (lastEntry.kind === "geometry" && op.kind === "geometry") {
          merged = {
            kind: "geometry",
            items: mergeItems(lastEntry.items, op.items, mergeMode)
          };
        }
        // style + crop never coalesce — there's no meaningful
        // multi-X bracket for them in the editor today, and
        // crop's inverse depends on previous canvas dims which
        // can't be merged.
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
    (
      row: OverlayRow,
      opts?: RecordOptions & { node?: BundleLayerNode | null }
    ) =>
      push(
        {
          kind: "create",
          items: [{ row, node: opts?.node ?? null }]
        },
        opts
      ),
    [push]
  );
  const recordDelete = useCallback(
    (
      row: OverlayRow,
      opts?: RecordOptions & { node?: BundleLayerNode | null }
    ) =>
      push(
        {
          kind: "delete",
          items: [{ row, node: opts?.node ?? null }]
        },
        opts
      ),
    [push]
  );
  const recordCrop = useCallback(
    (entry: {
      rect: CropRect;
      previousWidthPx: number;
      previousHeightPx: number;
      newWidthPx: number;
      newHeightPx: number;
    }) =>
      push({
        kind: "crop",
        rect: entry.rect,
        previousWidthPx: entry.previousWidthPx,
        previousHeightPx: entry.previousHeightPx,
        newWidthPx: entry.newWidthPx,
        newHeightPx: entry.newHeightPx
      }),
    [push]
  );

  const recordGeometry = useCallback(
    (
      entry: {
        currentIdRef: { current: string };
        previousGeometry: GeometryUpdate;
        nextGeometry: GeometryUpdate;
      },
      opts?: RecordOptions
    ) =>
      push(
        {
          kind: "geometry",
          items: [
            {
              currentIdRef: entry.currentIdRef,
              previousGeometry: entry.previousGeometry,
              nextGeometry: entry.nextGeometry
            }
          ]
        },
        opts
      ),
    [push]
  );

  const recordStyle = useCallback(
    (entry: {
      currentIdRef: { current: string };
      previousPatch: OverlayPatch;
      nextPatch: OverlayPatch;
    }) =>
      push({
        kind: "style",
        currentIdRef: entry.currentIdRef,
        previousPatch: entry.previousPatch,
        nextPatch: entry.nextPatch
      }),
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

  // Apply a single EditOp's INVERSE through the dispatcher. Shared
  // between undo (inverse of the latest past op) and redo (re-apply the
  // future op = inverse of what undo just did).
  const applyInverse = useCallback(
    async (op: EditOp, direction: "undo" | "redo"): Promise<void> => {
      const dispatchEdit = dispatchEditRef.current;
      // What "do" means depends on direction:
      //   undo: apply the inverse of `op`
      //   redo: re-apply `op`
      // We unify by computing the op to dispatch as "if undo, inverse;
      // if redo, op". For create+delete this is a clean inversion; for
      // crop, the inverse is restoring the previous canvas dims.
      if (op.kind === "create") {
        const isInverse = direction === "undo";
        // Loop over every recorded item so multi-create bursts
        // (paste, duplicate, etc.) restore/redo EVERY layer, not
        // just the most recent. Pre-fix the EditOp held a single
        // row and the coalesce path swapped it on each push —
        // earlier rows in a burst were silently lost.
        for (const item of op.items) {
          if (isInverse) {
            // Delete the just-created layer.
            // eslint-disable-next-line no-await-in-loop
            await dispatchEdit({ kind: "delete", id: item.row.id });
            continue;
          }
          // redo of create — re-upsert. The node carries its z_index;
          // layers:upsert defaults to preserving it (no
          // bumpZIndexToMax), so the redone layer lands at its original
          // logical position. `item.node` is always set for v2 creates;
          // the `null` fallback is dead but kept for the recorder's
          // optional-node shape.
          if (item.node !== null) {
            // eslint-disable-next-line no-await-in-loop
            await dispatchEdit({ kind: "upsert", node: item.node });
          }
        }
        return;
      }
      if (op.kind === "delete") {
        const isInverse = direction === "undo";
        // Same loop discipline as create above. The user-reported
        // bug ("I selected two text items, hit delete, only ONE
        // came back on undo and the other CANNOT BE RECOVERED")
        // was the pre-fix shape losing earlier items when push()
        // coalesced — fixed by accumulating into items[] and
        // looping here.
        for (const item of op.items) {
          if (isInverse) {
            // Undo of delete — re-create the layer. The node carries
            // its original z_index so the restored layer comes back
            // where it was, not on top (layers:upsert preserves
            // node.z_index when bumpZIndexToMax isn't set).
            if (item.node !== null) {
              // eslint-disable-next-line no-await-in-loop
              await dispatchEdit({ kind: "upsert", node: item.node });
            }
            continue;
          }
          // redo of delete — re-delete.
          // eslint-disable-next-line no-await-in-loop
          await dispatchEdit({ kind: "delete", id: item.row.id });
        }
        return;
      }
      if (op.kind === "crop") {
        // direction === "undo" → restore previousWidth/Height by
        // dispatching a crop op whose normalized rect, when multiplied
        // by the CURRENT (post-crop) canvas dims, lands on the previous
        // canvas dims.
        // direction === "redo" → re-apply the original normalized rect
        // against the (currently restored) previous canvas — produces
        // newWidth/newHeight again.
        if (direction === "undo") {
          // The inverse of crop(cx, cy, cw, ch) is the rect
          //   (-cx/cw, -cy/ch, 1/cw, 1/ch)
          // applied against the CURRENT (post-crop) canvas. Why:
          //
          //   forward: new = (old - cx) / cw            (Step 0 transform)
          //   inverse: old = new × cw + cx
          //
          // For "old" to come out of the same dispatcher (which does
          // `n' = (n - c'x) / c'w`) we need c'w = 1/cw and c'x such
          // that `n × cw + cx = (n - c'x) × cw`, i.e. c'x = -cx/cw.
          //
          // Pre-fix this branch dispatched `{ x: 0, y: 0, ... }`
          // regardless of the forward crop's offset — fine for edge-
          // aligned crops, but a CENTER crop's forward translates the
          // raster by (-cx × oldW, -cy × oldH); the undo must
          // translate by +cx × oldW to restore the identity. With
          // c'x = -cx/cw and the new canvas at newW = cw × oldW:
          //   undo offset = c'x × newW = (-cx/cw) × (cw × oldW) = -cx × oldW
          //   transform delta = -(undo offset) = +cx × oldW   ✓
          //
          // The user-visible symptom of the old code was: undo of a
          // center crop restored the canvas DIMS but the image +
          // overlays ended up at a different position than the
          // original. (Pwrdrvr/PwrSnap#110 review screenshots.)
          const rectW =
            op.newWidthPx > 0 ? op.previousWidthPx / op.newWidthPx : 1;
          const rectH =
            op.newHeightPx > 0 ? op.previousHeightPx / op.newHeightPx : 1;
          const cw = op.rect.w;
          const ch = op.rect.h;
          const rectX = cw > 0 ? -op.rect.x / cw : 0;
          const rectY = ch > 0 ? -op.rect.y / ch : 0;
          await dispatchEdit({
            kind: "crop",
            rect: { x: rectX, y: rectY, w: rectW, h: rectH }
          });
          return;
        }
        // redo — current canvas is back at previousWidthPx/Height after
        // the prior undo. Re-apply the original normalized rect.
        await dispatchEdit({ kind: "crop", rect: op.rect });
        return;
      }
      if (op.kind === "geometry") {
        // Phase 3.5 — dispatch updateGeometry against the chain's
        // CURRENT id (the post-edit id from the last cycle). The
        // dispatcher delete-plus-inserts a new row; we capture the
        // fresh id and write it back onto currentIdRef so the next
        // undo/redo targets the latest live row.
        //
        // Loop over EVERY item so multi-drag undo restores every
        // layer's geometry, not just the first. Same items[]
        // discipline as create/delete above.
        for (const item of op.items) {
          const targetGeometry =
            direction === "undo" ? item.previousGeometry : item.nextGeometry;
          // eslint-disable-next-line no-await-in-loop
          const result = await dispatchEdit({
            kind: "updateGeometry",
            layerId: item.currentIdRef.current,
            geometry: targetGeometry
          });
          if (result.ok && result.value.kind === "update") {
            item.currentIdRef.current = result.value.artifact.node.id;
          }
        }
        return;
      }
      if (op.kind === "style") {
        // Phase 3.5 — same chain-id semantics as geometry above; verb
        // is updateOverlay.
        const targetPatch =
          direction === "undo" ? op.previousPatch : op.nextPatch;
        const result = await dispatchEdit({
          kind: "updateOverlay",
          layerId: op.currentIdRef.current,
          patch: targetPatch
        });
        if (result.ok && result.value.kind === "update") {
          op.currentIdRef.current = result.value.artifact.node.id;
        }
        return;
      }
      // Exhaustiveness check — any new EditOp kind without a branch
      // here surfaces at compile time.
      const _exhaustive: never = op;
      void _exhaustive;
    },
    []
  );

  const undo = useCallback(async () => {
    const op = past[past.length - 1];
    if (op === undefined) return;
    await wrapApplying(async () => {
      await applyInverse(op, "undo");
    });
    setPast((prev) => prev.slice(0, -1));
    setFuture((prev) => [...prev, op]);
    // After an undo, drop the grace window — a fresh edit shouldn't
    // be coalesced into an entry that's no longer on the past stack.
    lastCoalesceRef.current = null;
  }, [past, applyInverse, wrapApplying]);

  const redo = useCallback(async () => {
    const op = future[future.length - 1];
    if (op === undefined) return;
    await wrapApplying(async () => {
      await applyInverse(op, "redo");
    });
    setFuture((prev) => prev.slice(0, -1));
    setPast((prev) => [...prev, op]);
    lastCoalesceRef.current = null;
  }, [future, applyInverse, wrapApplying]);

  // Register this stack with the app-wide Edit-menu bridge so the native
  // Edit ▸ Undo / Edit ▸ Redo items and the ⌘Z / ⌘⇧Z accelerators reach
  // it when the canvas — not a text field — is focused.
  //
  // This replaces a former window-keydown listener that handled
  // ⌘Z / ⌘⇧Z / Ctrl+Y directly. Those combos are now REGISTERED MENU
  // ACCELERATORS (see apps/desktop/src/main/index.ts). An Electron menu
  // accelerator and a renderer `keydown` listener BOTH fire for the same
  // keystroke (the accelerator doesn't consume the JS event), so keeping
  // the listener would undo/redo twice. The menu is therefore the single
  // keyboard source for ⌘Z / ⌘⇧Z; Ctrl+Y (Windows/Linux) is handled once
  // in the bridge. Text-field-focus awareness lives in the bridge too.
  // See docs/solutions/2026-06-13-edit-menu-undo-redo-bridge.md.
  useEffect(() => {
    return registerEditorUndoRedo({
      undo: () => {
        void undo();
      },
      redo: () => {
        void redo();
      }
    });
  }, [undo, redo]);

  return {
    recordCreate,
    recordDelete,
    recordCrop,
    recordGeometry,
    recordStyle,
    beginInteraction,
    endInteraction,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0
  };
}
