// When the crop layer is HIDDEN, the editor renders the full source image
// (see resolveCropViewport): canvas dims = natural, overlays re-projected
// into source space. The user draws/moves in THAT displayed space — but
// persistence is always in the cropped canvas's coordinate space. This
// module maps a dispatch op's coords from displayed (source) space back
// into stored (cropped) space, so a draw made on the uncropped view lands
// at the right stored coords (and clips correctly when the crop is shown
// again). It's the write-side mirror of the read-side projection in
// resolveCropViewport; both reuse the same shared primitives so they can
// never disagree.
//
// Coord-free ops (delete / reorder) and the crop op pass through
// unchanged — re-cropping while the crop is hidden is a guarded no-op in
// the editor, so a `crop` op never reaches here in the uncropped state.

import {
  forwardCropPoint,
  forwardCropRect,
  forwardLayerToStored,
  type CropRect
} from "@pwrsnap/shared";
import type { LayerEditOp, GeometryUpdate, OverlayPatch } from "./useCaptureModel";

export function forwardGeometry(geometry: GeometryUpdate, rect: CropRect): GeometryUpdate {
  switch (geometry.kind) {
    case "arrow":
      return {
        kind: "arrow",
        from: forwardCropPoint(geometry.from, rect),
        to: forwardCropPoint(geometry.to, rect)
      };
    case "rect":
      // Spread preserves the optional `rotation` field unchanged.
      return { ...geometry, rect: forwardCropRect(geometry.rect, rect) };
    case "text":
      return { ...geometry, point: forwardCropPoint(geometry.point, rect) };
    case "step":
      return { kind: "step", point: forwardCropPoint(geometry.point, rect) };
  }
}

/** updateOverlay patches are usually STYLE-only (color / opacity / body),
 *  but a Partial<Overlay> can carry coords — map any that are present. */
function forwardPatch(patch: OverlayPatch, rect: CropRect): OverlayPatch {
  const p = patch as {
    from?: { x: number; y: number };
    to?: { x: number; y: number };
    rect?: { x: number; y: number; w: number; h: number };
    point?: { x: number; y: number };
  };
  const out: Record<string, unknown> = { ...patch };
  if (p.from !== undefined) out.from = forwardCropPoint(p.from, rect);
  if (p.to !== undefined) out.to = forwardCropPoint(p.to, rect);
  if (p.rect !== undefined) out.rect = forwardCropRect(p.rect, rect);
  if (p.point !== undefined) out.point = forwardCropPoint(p.point, rect);
  return out as OverlayPatch;
}

/** Map an edit op's coordinates from displayed (source) space into stored
 *  (cropped) space. `rect` is the source window the cropped canvas shows;
 *  `naturalW/H` are the source raster's natural dims. */
export function forwardOpToStored(
  op: LayerEditOp,
  rect: CropRect,
  naturalW: number,
  naturalH: number
): LayerEditOp {
  switch (op.kind) {
    case "upsert":
      return { ...op, node: forwardLayerToStored(op.node, rect, naturalW, naturalH) };
    case "upsertBatch":
      return {
        ...op,
        nodes: op.nodes.map((n) => forwardLayerToStored(n, rect, naturalW, naturalH))
      };
    case "updateGeometry":
      return { ...op, geometry: forwardGeometry(op.geometry, rect) };
    case "updateOverlay":
      return { ...op, patch: forwardPatch(op.patch, rect) };
    case "delete":
    case "crop":
    case "reorder":
      return op;
  }
}
