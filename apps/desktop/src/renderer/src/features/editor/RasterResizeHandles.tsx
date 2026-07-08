// Resize handles for a single selected non-base raster (pasted image /
// cursor). The parallel of the overlay `TransformHandles`, but for a
// raster's affine transform: 8 corner/edge handles on the raster's box,
// each dragging through the pure `resizeRasterTransform` math. Move / undo
// / group-drag already ship in Editor.tsx's raster gesture; this adds the
// SCALE gesture, reusing the same live-preview channel (`onResizeDrag` →
// rasterDrafts) and undo-integrated commit (`onResizeCommit` →
// commitRasterDragRef → dispatchEdit `{ kind: "transform" }`).
//
// Rendered in the same absolute, inset:0, pointer-events:none chrome layer
// as TransformHandles — the container maps normalized [0,1] onto the canvas
// (so `left: xn*100%` lands the handle on the box), and each handle is a
// constant-screen-size square that opts back into pointer events. Handle
// pointerdowns stopPropagation so the canvas doesn't treat them as a
// deselect / new drag.

import { useRef, type PointerEvent, type ReactElement } from "react";

import type { AffineTransform } from "@pwrsnap/shared";

import { Z_INDEX_CHROME } from "./OverlaySvg";
import { resizeRasterTransform, type ResizeHandle } from "./raster-resize";

/** Screen-constant handle square, matching TransformHandles. */
const HANDLE_SIZE_PX = 10;

interface HandleSpec {
  kind: ResizeHandle;
  xn: number;
  yn: number;
  cursor: string;
}

/** The 8 handle positions for a normalized box `{ x, y, w, h }`. */
function handleSpecs(x: number, y: number, w: number, h: number): HandleSpec[] {
  return [
    { kind: "nw", xn: x, yn: y, cursor: "nwse-resize" },
    { kind: "n", xn: x + w / 2, yn: y, cursor: "ns-resize" },
    { kind: "ne", xn: x + w, yn: y, cursor: "nesw-resize" },
    { kind: "e", xn: x + w, yn: y + h / 2, cursor: "ew-resize" },
    { kind: "se", xn: x + w, yn: y + h, cursor: "nwse-resize" },
    { kind: "s", xn: x + w / 2, yn: y + h, cursor: "ns-resize" },
    { kind: "sw", xn: x, yn: y + h, cursor: "nesw-resize" },
    { kind: "w", xn: x, yn: y + h / 2, cursor: "ew-resize" }
  ];
}

export function RasterResizeHandles({
  layerId,
  transform,
  naturalWidthPx,
  naturalHeightPx,
  imageWidthPx,
  imageHeightPx,
  onResizeDrag,
  onResizeCommit
}: {
  layerId: string;
  /** The raster's CURRENT transform (draft-aware — the editor passes the
   *  live override during a resize so the handles track the preview). */
  transform: AffineTransform;
  naturalWidthPx: number;
  naturalHeightPx: number;
  /** Canvas (cropped) dims in px — the box's normalized space. */
  imageWidthPx: number;
  imageHeightPx: number;
  /** Live preview on every pointermove (→ rasterDrafts). */
  onResizeDrag: (transform: AffineTransform) => void;
  /** Persist on pointerup (→ dispatchEdit transform geometry, undo-integrated). */
  onResizeCommit: (startTransform: AffineTransform, transform: AffineTransform) => void;
}): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Pointermove fires faster than React state; keep the gesture in a ref.
  const gestureRef = useRef<{
    handle: ResizeHandle;
    startClientX: number;
    startClientY: number;
    startTransform: AffineTransform;
    // Container screen size at drag start — client delta ÷ this = the
    // normalized delta, ×canvas dims = the canvas-pixel delta the math wants.
    rectW: number;
    rectH: number;
    current: AffineTransform;
  } | null>(null);

  // Normalized box from the (possibly draft) transform.
  const sx = transform[0];
  const sy = transform[3];
  const x = transform[4] / imageWidthPx;
  const y = transform[5] / imageHeightPx;
  const w = (naturalWidthPx * sx) / imageWidthPx;
  const h = (naturalHeightPx * sy) / imageHeightPx;

  function onHandleDown(handle: ResizeHandle, e: PointerEvent<HTMLDivElement>): void {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || rect.height === 0) return;
    e.preventDefault();
    // Don't let the canvas pointerdown fire (would deselect / start a draw).
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gestureRef.current = {
      handle,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startTransform: transform,
      rectW: rect.width,
      rectH: rect.height,
      current: transform
    };
  }

  function onHandleMove(e: PointerEvent<HTMLDivElement>): void {
    const g = gestureRef.current;
    if (g === null) return;
    const dxPx = ((e.clientX - g.startClientX) / g.rectW) * imageWidthPx;
    const dyPx = ((e.clientY - g.startClientY) / g.rectH) * imageHeightPx;
    const next = resizeRasterTransform({
      handle: g.handle,
      dxPx,
      dyPx,
      startTransform: g.startTransform,
      naturalWidthPx,
      naturalHeightPx,
      lockAspect: e.shiftKey
    });
    g.current = next;
    onResizeDrag(next);
  }

  function onHandleUp(e: PointerEvent<HTMLDivElement>): void {
    const g = gestureRef.current;
    gestureRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already gone */
    }
    // `current === startTransform` (same ref) means no move happened —
    // a click on a handle without a drag is a no-op, not a commit.
    if (g !== null && g.current !== g.startTransform) {
      onResizeCommit(g.startTransform, g.current);
    }
  }

  function onHandleCancel(): void {
    const g = gestureRef.current;
    gestureRef.current = null;
    // OS-cancelled mid-resize — revert the preview to the pre-drag box.
    if (g !== null) onResizeDrag(g.startTransform);
  }

  return (
    <div
      ref={containerRef}
      className="editor-raster-resize-handles"
      data-testid="raster-resize-handles"
      style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: Z_INDEX_CHROME }}
    >
      {handleSpecs(x, y, w, h).map((spec) => (
        <div
          key={spec.kind}
          className="editor-transform-handle"
          data-testid={`raster-resize-handle-${spec.kind}`}
          data-handle-kind={spec.kind}
          data-layer-id={layerId}
          onPointerDown={(e) => onHandleDown(spec.kind, e)}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleCancel}
          style={{
            position: "absolute",
            left: `${spec.xn * 100}%`,
            top: `${spec.yn * 100}%`,
            width: HANDLE_SIZE_PX,
            height: HANDLE_SIZE_PX,
            transform: "translate(-50%, -50%)",
            cursor: spec.cursor,
            pointerEvents: "auto"
          }}
        />
      ))}
    </div>
  );
}
