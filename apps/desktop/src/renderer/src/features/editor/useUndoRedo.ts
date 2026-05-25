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
import type { BundleLayerNode, OverlayRow, PwrSnapError, Result } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import type {
  CropRect,
  EditOpResult,
  GeometryUpdate,
  LayerEditOp,
  OverlayEditOp,
  OverlayPatch
} from "./useCaptureModel";

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
 *
 * v2 captures carry an additional `node` field so the redo of a
 * delete (or undo of a create) can dispatch `layers:upsert` with the
 * original BundleLayerNode shape — not just the v1-shaped row.data.
 * For v1 captures the node is null and the hook falls through to
 * overlays:upsert/delete via the format-aware dispatchEdit callback.
 *
 * `crop` ops carry the previous canvas dimensions (in source pixels)
 * so undo can restore them via bundle:updateCanvasDimensions on v2
 * captures. v1 captures don't actually mutate canvas dims, so the
 * previous values are surfaced uniformly but only acted on for v2.
 */
export type EditOp =
  | { kind: "create"; row: OverlayRow; node: BundleLayerNode | null }
  | { kind: "delete"; row: OverlayRow; node: BundleLayerNode | null }
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
  | {
      kind: "geometry";
      currentIdRef: { current: string };
      previousGeometry: GeometryUpdate;
      nextGeometry: GeometryUpdate;
    }
  | {
      kind: "style";
      currentIdRef: { current: string };
      previousPatch: OverlayPatch;
      nextPatch: OverlayPatch;
    };

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
  /** Record an overlay create. For v2 captures, pass the inserted
   *  BundleLayerNode under `node` — required so the redo path can
   *  re-dispatch `layers:upsert` with the original layer shape. v1
   *  callers pass `node: null`. */
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
   *  post-edit overlay id (typically `result.value.artifact.row.id`
   *  or `.node.id`). The caller is responsible for updating the
   *  selection model to follow `currentIdRef.current` on undo/redo. */
  recordGeometry: (entry: {
    currentIdRef: { current: string };
    previousGeometry: GeometryUpdate;
    nextGeometry: GeometryUpdate;
  }) => void;
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

/** Format-aware dispatcher passed in by the caller (Editor.tsx wires
 *  this from the resolved CaptureModel). The hook never reaches for
 *  the bus directly — it just hands ops to this callback. Same shape
 *  as `CaptureModelV1.dispatchEdit` / `CaptureModelV2.dispatchEdit`,
 *  union-typed because the hook doesn't care which format it's on
 *  (the dispatcher itself does the routing). */
export type UndoRedoDispatchEdit = (
  op: OverlayEditOp | LayerEditOp
) => Promise<Result<EditOpResult, PwrSnapError>>;

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
  /** Format-aware dispatcher from the resolved CaptureModel. The
   *  hook never reaches for the bus directly — every undo/redo IPC
   *  goes through this callback, which picks the right verb based
   *  on `bundle_format_version`. When omitted (rare; legacy code
   *  paths and tests), the hook falls back to direct overlays:*
   *  dispatch via the renderer's dispatch shim. */
  dispatchEdit?: UndoRedoDispatchEdit;
}): UseUndoRedoResult {
  const { captureId } = opts;
  const [past, setPast] = useState<EditOp[]>([]);
  const [future, setFuture] = useState<EditOp[]>([]);
  // Stash the dispatchEdit in a ref so the undo/redo callbacks don't
  // re-create on every render (it changes identity whenever the model
  // refetches, which is every overlay write). Tests + legacy callers
  // that don't pass one fall through to the direct-dispatch path.
  const dispatchEditRef = useRef<UndoRedoDispatchEdit | null>(null);
  dispatchEditRef.current = opts.dispatchEdit ?? null;
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
        // then target the latest IPC artifact. crop ops don't
        // coalesce — there's no meaningful "swap rect" semantics
        // mid-burst, and the coalescing keys for ops are pointer
        // drags which don't fire on crop commit.
        let merged: EditOp = lastEntry;
        if (lastEntry.kind === "create" && op.kind === "create") {
          merged = { kind: "create", row: op.row, node: op.node };
        } else if (lastEntry.kind === "delete" && op.kind === "delete") {
          merged = { kind: "delete", row: op.row, node: op.node };
        }
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
    ) => push({ kind: "create", row, node: opts?.node ?? null }, opts),
    [push]
  );
  const recordDelete = useCallback(
    (
      row: OverlayRow,
      opts?: RecordOptions & { node?: BundleLayerNode | null }
    ) => push({ kind: "delete", row, node: opts?.node ?? null }, opts),
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
    (entry: {
      currentIdRef: { current: string };
      previousGeometry: GeometryUpdate;
      nextGeometry: GeometryUpdate;
    }) =>
      push({
        kind: "geometry",
        currentIdRef: entry.currentIdRef,
        previousGeometry: entry.previousGeometry,
        nextGeometry: entry.nextGeometry
      }),
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

  // Apply a single EditOp's INVERSE through the format-aware
  // dispatcher (or the legacy direct-dispatch fallback). Shared between
  // undo (inverse of the latest past op) and redo (re-apply the
  // future op = inverse of what undo just did).
  //
  // The hook never knows the capture's bundle_format_version directly
  // — that's the dispatchEdit's job. We just describe the op shape and
  // let the dispatcher pick the right verb.
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
        if (isInverse) {
          // Delete the just-created row/layer.
          if (dispatchEdit !== null) {
            await dispatchEdit({ kind: "delete", id: op.row.id });
            return;
          }
          // Legacy fallback: direct v1 dispatch.
          await dispatch("overlays:delete", { id: op.row.id });
          return;
        }
        // redo of create — re-upsert. On v2 we need the original
        // layer node so layers:upsert lands a structurally-identical
        // layer. On v1 we re-upsert the overlay data; insertOverlay
        // mints a fresh id, fine for session-only undo.
        if (dispatchEdit !== null) {
          if (op.node !== null) {
            await dispatchEdit({ kind: "upsert", node: op.node });
          } else {
            await dispatchEdit({ kind: "upsert", row: op.row });
          }
          return;
        }
        await dispatch("overlays:upsert", {
          captureId,
          overlay: op.row.data
        });
        return;
      }
      if (op.kind === "delete") {
        const isInverse = direction === "undo";
        if (isInverse) {
          // Undo of delete — re-create. Same shape rules as the
          // create→redo branch above.
          if (dispatchEdit !== null) {
            if (op.node !== null) {
              await dispatchEdit({ kind: "upsert", node: op.node });
            } else {
              await dispatchEdit({ kind: "upsert", row: op.row });
            }
            return;
          }
          await dispatch("overlays:upsert", {
            captureId,
            overlay: op.row.data
          });
          return;
        }
        // redo of delete — re-delete.
        if (dispatchEdit !== null) {
          await dispatchEdit({ kind: "delete", id: op.row.id });
          return;
        }
        await dispatch("overlays:delete", { id: op.row.id });
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
        if (dispatchEdit === null) {
          // v1 fallback can't crop a v2 capture — and the legacy code
          // path was overlays:upsert with a CropOverlay which doesn't
          // change canvas dims anyway. Best we can do is replay the
          // original rect as a v1 CropOverlay; on undo that's a no-op
          // for canvas, on redo we re-insert the crop overlay.
          if (direction === "undo") return;
          await dispatch("overlays:upsert", {
            captureId,
            overlay: { kind: "crop", rect: op.rect }
          });
          return;
        }
        if (direction === "undo") {
          // The dispatcher interprets `rect.w * currentCanvasWidth` as
          // the new width. Currently the canvas is `newWidthPx` wide;
          // we want to restore `previousWidthPx`. So rect.w =
          // previousWidthPx / newWidthPx. Same for height. (Same model
          // for v1 crop overlay — re-storing as a normalized rect of
          // the previous dims.)
          const rectW =
            op.newWidthPx > 0 ? op.previousWidthPx / op.newWidthPx : 1;
          const rectH =
            op.newHeightPx > 0 ? op.previousHeightPx / op.newHeightPx : 1;
          await dispatchEdit({
            kind: "crop",
            rect: { x: 0, y: 0, w: rectW, h: rectH }
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
        if (dispatchEdit === null) return;
        const targetGeometry =
          direction === "undo" ? op.previousGeometry : op.nextGeometry;
        const result = await dispatchEdit({
          kind: "updateGeometry",
          layerId: op.currentIdRef.current,
          geometry: targetGeometry
        });
        if (
          result.ok &&
          result.value.kind === "update" &&
          result.value.artifact.format === 1
        ) {
          op.currentIdRef.current = result.value.artifact.row.id;
        } else if (
          result.ok &&
          result.value.kind === "update" &&
          result.value.artifact.format === 2
        ) {
          op.currentIdRef.current = result.value.artifact.node.id;
        }
        return;
      }
      if (op.kind === "style") {
        // Phase 3.5 — same chain-id semantics as geometry above; verb
        // is updateOverlay.
        if (dispatchEdit === null) return;
        const targetPatch =
          direction === "undo" ? op.previousPatch : op.nextPatch;
        const result = await dispatchEdit({
          kind: "updateOverlay",
          layerId: op.currentIdRef.current,
          patch: targetPatch
        });
        if (
          result.ok &&
          result.value.kind === "update" &&
          result.value.artifact.format === 1
        ) {
          op.currentIdRef.current = result.value.artifact.row.id;
        } else if (
          result.ok &&
          result.value.kind === "update" &&
          result.value.artifact.format === 2
        ) {
          op.currentIdRef.current = result.value.artifact.node.id;
        }
        return;
      }
      // Exhaustiveness check — any new EditOp kind without a branch
      // here surfaces at compile time.
      const _exhaustive: never = op;
      void _exhaustive;
    },
    [captureId]
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
