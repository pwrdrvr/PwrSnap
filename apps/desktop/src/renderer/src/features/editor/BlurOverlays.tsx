// HTML blur-overlay layer sitting between the canvas <img> and the
// SVG overlay layer. Renders blur overlays as absolutely-positioned
// elements whose effect (backdrop-filter, canvas mosaic, opaque fill)
// matches what the bake (compose-tree.ts) produces on export.
//
// Why HTML instead of SVG? SVG <filter> can blur SVG content but
// can't reach behind itself to blur the page <img>. CSS
// `backdrop-filter` on an HTML element blurs ANYTHING behind it in
// the same stacking context, including a sibling <img> — that's the
// unrotated gaussian fast path. Rotated blurs go through a canvas
// element that mirrors the bake's algorithm exactly.
//
// Per-style WYSIWYG strategy:
//
//   • gaussian — unrotated: CSS `backdrop-filter: blur(...)`.
//                rotated:   canvas with `ctx.filter = "blur(σpx)"`,
//                           σ derived from canvas short-side, clip-path
//                           polygon clipping to the rotated rect.
//
//   • pixelate — unrotated: canvas with the bake's coarse-grid formula
//                           (issue #137).
//                rotated:   canvas with the SAME coarse-grid formula
//                           sized over the rotated rect's AABB, clip-
//                           path polygon clipping to the rotated rect.
//
//   • redact   — unrotated: solid opaque black `<div>`. Pixel-identical
//                           to the bake.
//                rotated:   same `<div>` with a CSS `transform: rotate`.
//                           Pixel-identical to the bake (a rotated
//                           black square IS a rotated black square).
//
// Issue #147 closed the rotation-WYSIWYG gap for gaussian + pixelate.
// At rotation === 0 the existing fast paths still drive the preview,
// so the load-bearing unrotated baseline is unchanged.

import {
  useEffect,
  useMemo,
  useRef,
  type ReactElement,
  type RefObject
} from "react";
import type { BlurStyle, OverlayRow } from "@pwrsnap/shared";
import { readBlurStyle, readOverlayRotation } from "@pwrsnap/shared";
import { rectFromDrag, type Draft } from "./editor-types";
import type { GeometryUpdate } from "./useCaptureModel";
import "./BlurOverlays.css";

export function BlurOverlays({
  overlays,
  draft,
  blurStyle,
  liveOverride = null,
  editorImageRef,
  canvasWidthPx,
  canvasHeightPx
}: {
  overlays: OverlayRow[];
  draft: Draft | null;
  /** The user's currently-staged style — applied to the live-drag
   *  preview so the in-progress rect looks like what will be
   *  committed. Committed overlays read their own style off
   *  `row.data.style`. */
  blurStyle: BlurStyle;
  /** Live-drag geometry override — Map of layer id → in-progress
   *  geometry. Same shape OverlaySvg / TextHtmlOverlays consume.
   *  When the matching row is a blur and the override's geometry
   *  is `kind: "rect"`, the blur item renders at the overridden
   *  rect so a TransformHandles drag (single-select) OR a multi-
   *  drag (group translation) visually moves / resizes the blur in
   *  real time. Single-select passes a 1-entry map; multi-drag
   *  passes one entry per selected blur layer. */
  liveOverride?: ReadonlyMap<string, GeometryUpdate> | null;
  /** Ref to the editor's `<img>` element. Canvas-based blur paths
   *  read pixels from it via `drawImage` to produce real mosaic /
   *  blurred output. The static-div paths ignore this prop. */
  editorImageRef: RefObject<HTMLImageElement | null>;
  /** Canvas dims in canvas pixels — the unit `compose-tree.ts`'s
   *  effect-blur paths use for AABB + sigma + block-size math. Passed
   *  in rather than measured off the DOM so the editor and bake stay
   *  in lockstep even if the renderer's display transform changes. */
  canvasWidthPx: number;
  canvasHeightPx: number;
}): ReactElement {
  const effectiveOverlays = useMemo(() => {
    if (liveOverride === null || liveOverride.size === 0) return overlays;
    return overlays.map((row) => {
      const geom = liveOverride.get(row.id);
      if (geom === undefined) return row;
      // Blur is rect-shaped, so a non-rect geometry update (text /
      // arrow / step) for the same id can't apply here. Pass through
      // unchanged in that case — the row is probably a non-blur kind
      // that the override is meant for elsewhere (OverlaySvg /
      // TextHtmlOverlays handle it).
      if (geom.kind !== "rect") return row;
      if (row.data.kind !== "blur") return row;
      // Carry through the rotation from the live override so the
      // in-progress rotation-handle drag updates the CSS transform
      // (or the canvas's clip-path) in real time.
      return {
        ...row,
        data: {
          ...row.data,
          rect: geom.rect,
          ...(geom.rotation !== undefined ? { rotation: geom.rotation } : {})
        }
      };
    });
  }, [liveOverride, overlays]);
  const blurs = effectiveOverlays.flatMap((row) =>
    row.data.kind === "blur" ? [{ row, data: row.data }] : []
  );
  const liveRect =
    draft !== null && draft.kind === "rect-drag" && draft.tool === "blur"
      ? rectFromDrag(draft)
      : null;

  return (
    <div className="ed-blur-layer">
      {blurs.map(({ row, data }) => {
        const style = readBlurStyle(data);
        const rotation = readOverlayRotation(data);
        return renderBlur({
          key: row.id,
          rect: data.rect,
          rotation,
          style,
          editorImageRef,
          canvasWidthPx,
          canvasHeightPx
        });
      })}
      {liveRect !== null &&
        renderBlur({
          rect: liveRect,
          // Live-drag draft can't yet have a rotation handle interaction
          // (rotation is applied AFTER commit via TransformHandles).
          // So the draft is always rotation === 0.
          rotation: 0,
          style: blurStyle,
          editorImageRef,
          canvasWidthPx,
          canvasHeightPx,
          isDraft: true
        })}
    </div>
  );
}

/** Pick the right preview element for a single blur. The decision
 *  tree is intentionally explicit (rather than a discriminated union
 *  inside the components) so callers reading this file see every
 *  rotation × style combo at a glance. */
function renderBlur(args: {
  key?: string;
  rect: { x: number; y: number; w: number; h: number };
  rotation: number;
  style: BlurStyle;
  editorImageRef: RefObject<HTMLImageElement | null>;
  canvasWidthPx: number;
  canvasHeightPx: number;
  isDraft?: boolean;
}): ReactElement {
  const { key, rect, rotation, style, isDraft = false } = args;
  // ROTATED gaussian + pixelate: the bake samples the rotated rect's
  // AABB, applies the effect, masks to the rotated rect interior. CSS
  // backdrop-filter and the un-rotated canvas mosaic can't replicate
  // that. Route through the canvas component, which does the AABB
  // sample + clip-path mask explicitly.
  if (rotation !== 0 && (style === "gaussian" || style === "pixelate")) {
    return (
      <RotatedEffectCanvas
        key={key}
        rect={rect}
        rotation={rotation}
        style={style}
        editorImageRef={args.editorImageRef}
        canvasWidthPx={args.canvasWidthPx}
        canvasHeightPx={args.canvasHeightPx}
        isDraft={isDraft}
      />
    );
  }
  // UNROTATED pixelate: the canvas-mosaic fast path that issue #137
  // landed. Bake matches at rotation === 0 by construction.
  if (style === "pixelate") {
    return (
      <PixelateMosaicCanvas
        key={key}
        rect={rect}
        editorImageRef={args.editorImageRef}
        canvasWidthPx={args.canvasWidthPx}
        canvasHeightPx={args.canvasHeightPx}
        isDraft={isDraft}
      />
    );
  }
  // gaussian (unrotated) + redact (any rotation): styled div. Redact
  // is pixel-identical to the bake at any rotation because a rotated
  // black square IS a rotated black square; gaussian unrotated reads
  // its sigma from a backdrop-filter blur(N) tuned by the existing CSS.
  return (
    <BlurOverlayItem
      key={key}
      rect={rect}
      rotation={rotation}
      style={style}
      isDraft={isDraft}
    />
  );
}

function BlurOverlayItem({
  rect,
  rotation,
  style,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  /** Clockwise rotation in radians around the rect's geometric center.
   *  CSS `transform: rotate(deg)` defaults to rotating around the
   *  element's center, which matches the SelectionOutline / SVG
   *  glyph rotation pivot for rect/highlight kinds.
   *
   *  At non-zero rotation this path is only used for `redact` (solid
   *  black — pixel-identical to bake at any rotation) and for the v1
   *  bake fallback. For gaussian + pixelate the rotated case routes
   *  through `RotatedEffectCanvas` which mirrors the bake's algorithm.
   *
   *  NOTE: v1 export (`compose.ts` blur path) currently ignores
   *  rotation — sharp's extract+blur pipeline doesn't support rotated
   *  clip regions on v1. v2 (default since PR #129) honors rotation. */
  rotation: number;
  style: BlurStyle;
  isDraft?: boolean;
}): ReactElement {
  const rotateDeg = (rotation * 180) / Math.PI;
  return (
    <div
      className={
        `ed-blur-item ed-blur-item--${style}` + (isDraft ? " is-draft" : "")
      }
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.w * 100}%`,
        height: `${rect.h * 100}%`,
        ...(rotation !== 0 ? { transform: `rotate(${rotateDeg}deg)` } : {})
      }}
    />
  );
}

/** 1.5% of the canvas short-side, with an 8px floor. Mirrors
 *  `deriveBlurRadiusPx` in `overlayToLayer.ts` + the v1→v2 doctor.
 *  Used by the rotated-gaussian canvas path so the editor preview
 *  uses the SAME σ the bake will. Inlining the formula avoids reaching
 *  across the source-of-truth boundary (overlayToLayer.ts is concerned
 *  with persistence; the renderer just needs to pick a sigma). */
function deriveBlurSigmaPx(canvasWidthPx: number, canvasHeightPx: number): number {
  const shortSide = Math.min(canvasWidthPx, canvasHeightPx);
  return Math.max(1, Math.min(200, Math.max(8, Math.round(shortSide * 0.015))));
}

/** Compute the rotated rect's AABB + corner coordinates in canvas-
 *  pixel space. Mirrors the bake's rotation math in
 *  `compose-tree.ts applyEffectOntoAccumulator`:
 *
 *    cx, cy = rect's geometric center
 *    each corner (±w/2, ±h/2) rotated by θ around (cx, cy)
 *    AABB = bounding box of those rotated corners
 *
 *  Returns AABB AND the rotated corners in BOTH canvas-pixel coords
 *  AND canvas-element-local coords (subtract AABB origin) so the
 *  caller can position the canvas (parent-relative) and the clip-path
 *  (canvas-relative) without recomputing.
 */
function computeRotatedAabb(args: {
  rect: { x: number; y: number; w: number; h: number };
  rotation: number;
  canvasWidthPx: number;
  canvasHeightPx: number;
}): {
  aabbX: number;
  aabbY: number;
  aabbW: number;
  aabbH: number;
  /** Rotated rect corners in canvas-pixel coords (parent-relative). */
  cornersParent: Array<{ x: number; y: number }>;
  /** Same corners shifted to canvas-element-local coords (subtract
   *  AABB origin). For use in CSS clip-path: polygon(...). */
  cornersLocal: Array<{ x: number; y: number }>;
} {
  const { rect, rotation, canvasWidthPx, canvasHeightPx } = args;
  const rectXPx = rect.x * canvasWidthPx;
  const rectYPx = rect.y * canvasHeightPx;
  const rectWPx = Math.max(1, rect.w * canvasWidthPx);
  const rectHPx = Math.max(1, rect.h * canvasHeightPx);
  const cx = rectXPx + rectWPx / 2;
  const cy = rectYPx + rectHPx / 2;
  const hw = rectWPx / 2;
  const hh = rectHPx / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const cornersParent = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh }
  ].map(({ x: lx, y: ly }) => ({
    x: cx + lx * cos - ly * sin,
    y: cy + lx * sin + ly * cos
  }));
  const xs = cornersParent.map((c) => c.x);
  const ys = cornersParent.map((c) => c.y);
  const aabbX = Math.min(...xs);
  const aabbY = Math.min(...ys);
  const aabbW = Math.max(...xs) - aabbX;
  const aabbH = Math.max(...ys) - aabbY;
  const cornersLocal = cornersParent.map(({ x, y }) => ({
    x: x - aabbX,
    y: y - aabbY
  }));
  return { aabbX, aabbY, aabbW, aabbH, cornersParent, cornersLocal };
}

/** Canvas-backed rotated-blur preview. Mirrors the bake's
 *  `compose-tree.ts applyEffectOntoAccumulator` rotation pipeline:
 *
 *    1. Compute rotated rect's AABB in canvas-pixel space.
 *    2. Position a `<canvas>` element at the AABB, sized to its dims.
 *    3. drawImage the source raster at the AABB region into the canvas.
 *    4. Apply the effect IN-PLACE in the canvas
 *       (gaussian: `ctx.filter = "blur(Npx)"`;
 *        pixelate: down/up resample with `image-rendering: pixelated`).
 *    5. CSS `clip-path: polygon(corner1, corner2, corner3, corner4)`
 *       with the rotated rect corners in canvas-element-local coords
 *       — only the rotated-rect interior shows the effect, AABB
 *       corners outside the rect get clipped to transparent.
 *
 *  Step 5 is the mirror of the bake's SVG rotation mask (`dest-in`
 *  composite with a white rotated rect): both keep only the rotated-
 *  rect interior pixels and drop the rest. The editor and bake now
 *  produce visually matching rotated blur output. */
function RotatedEffectCanvas({
  rect,
  rotation,
  style,
  editorImageRef,
  canvasWidthPx,
  canvasHeightPx,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  rotation: number;
  /** "gaussian" | "pixelate". Redact at non-zero rotation is handled
   *  by `BlurOverlayItem` (a rotated black square IS a rotated black
   *  square — no algorithmic mismatch to fix). */
  style: "gaussian" | "pixelate";
  editorImageRef: RefObject<HTMLImageElement | null>;
  canvasWidthPx: number;
  canvasHeightPx: number;
  isDraft?: boolean;
}): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const aabb = useMemo(
    () =>
      computeRotatedAabb({
        rect,
        rotation,
        canvasWidthPx,
        canvasHeightPx
      }),
    [rect.x, rect.y, rect.w, rect.h, rotation, canvasWidthPx, canvasHeightPx]
  );
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = editorImageRef.current;
    if (canvas === null || img === null) return;

    const draw = (): void => {
      // Both styles use a canvas at FULL AABB resolution so the
      // canvas's internal grid matches its CSS display grid 1:1.
      // Earlier draft sized the pixelate canvas to the coarse-grid
      // dims (15×15ish) and relied on `image-rendering: pixelated`
      // for the upscale — but that interacted badly with
      // `clip-path: polygon(...)` in Chromium (user report on PR
      // #148: rotated pixelate showed un-rotated content rotated,
      // while same-pipeline rotated gaussian worked fine).
      //
      // New approach mirrors `compose-tree.ts`'s pixelate path
      // EXACTLY: downsample to a coarse grid in an off-screen
      // canvas, then NEAREST-NEIGHBOR stamp back up to the full
      // resolution canvas. The MAIN canvas is always at full AABB
      // res so clip-path always sees a proper-sized pixel grid.
      const aabbW = Math.max(1, Math.round(aabb.aabbW));
      const aabbH = Math.max(1, Math.round(aabb.aabbH));
      canvas.width = aabbW;
      canvas.height = aabbH;
      const ctx = canvas.getContext("2d");
      if (ctx === null) return;
      ctx.clearRect(0, 0, aabbW, aabbH);

      // Source coords → image NATURAL pixels. Editor's <img> is sized
      // so source-raster coords map 1:1 to canvas-pixel coords AT
      // DISPLAY. For sampling we want CANVAS-px → image NATURAL-px,
      // so multiply by `naturalWidth / canvasWidthPx`. Uncropped
      // captures have natural == canvas; cropped captures get a slight
      // offset (deferred follow-up; see issue #147 doc-block).
      const scaleX = img.naturalWidth / canvasWidthPx;
      const scaleY = img.naturalHeight / canvasHeightPx;

      if (style === "gaussian") {
        // ctx.filter applies to the NEXT drawImage. σ matches the
        // bake's blur radius (compose-tree.ts calls sharp.blur(σ)
        // with the same effect.radius_px value).
        const sigma = deriveBlurSigmaPx(canvasWidthPx, canvasHeightPx);
        ctx.filter = `blur(${sigma}px)`;
        ctx.drawImage(
          img,
          aabb.aabbX * scaleX,
          aabb.aabbY * scaleY,
          aabb.aabbW * scaleX,
          aabb.aabbH * scaleY,
          0,
          0,
          aabbW,
          aabbH
        );
        ctx.filter = "none";
      } else {
        // pixelate: bake's algorithm exactly.
        //   1. Off-screen canvas at coarse-grid dims (downW × downH).
        //   2. drawImage source AABB → off-screen canvas with bicubic
        //      smoothing (averages within each block).
        //   3. drawImage off-screen → main canvas at AABB dims with
        //      smoothing DISABLED (= nearest-neighbor stamp).
        //
        // Block-size formula matches `compose-tree.ts`'s pixelate
        // (sharp uses min(w, h) of the extracted AABB).
        const shortSide = Math.min(aabbW, aabbH);
        const blockSizePx = Math.max(4, Math.round(shortSide / 16));
        const downW = Math.max(1, Math.floor(aabbW / blockSizePx));
        const downH = Math.max(1, Math.floor(aabbH / blockSizePx));
        const tiny = document.createElement("canvas");
        tiny.width = downW;
        tiny.height = downH;
        const tinyCtx = tiny.getContext("2d");
        if (tinyCtx === null) return;
        tinyCtx.imageSmoothingEnabled = true;
        tinyCtx.imageSmoothingQuality = "high";
        tinyCtx.drawImage(
          img,
          aabb.aabbX * scaleX,
          aabb.aabbY * scaleY,
          aabb.aabbW * scaleX,
          aabb.aabbH * scaleY,
          0,
          0,
          downW,
          downH
        );
        // Nearest-neighbor stamp the coarse grid back to full size on
        // the main canvas. Disabling imageSmoothing on a canvas2d
        // context tells the browser to use NEAREST for subsequent
        // drawImage scaling — exactly what `kernel: "nearest"` does
        // in the bake's sharp.resize() upscale.
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tiny, 0, 0, downW, downH, 0, 0, aabbW, aabbH);
      }
    };

    if (img.complete && img.naturalWidth > 0) {
      draw();
      return;
    }
    img.addEventListener("load", draw, { once: true });
    return () => {
      img.removeEventListener("load", draw);
    };
  }, [
    aabb.aabbX,
    aabb.aabbY,
    aabb.aabbW,
    aabb.aabbH,
    style,
    canvasWidthPx,
    canvasHeightPx,
    editorImageRef
  ]);

  // Position the canvas at AABB in parent-relative %; clip-path
  // expressed in canvas-element-local %s (corner / AABB dim). The
  // browser interprets the polygon corners as percent of the
  // canvas's CSS box, which is sized to AABB in display-px.
  const polygonPoints = aabb.cornersLocal
    .map(({ x, y }) => `${(x / aabb.aabbW) * 100}% ${(y / aabb.aabbH) * 100}%`)
    .join(", ");
  return (
    <canvas
      ref={canvasRef}
      className={
        `ed-blur-item ed-blur-item--rotated-${style}` + (isDraft ? " is-draft" : "")
      }
      // Debug-attributes for #147 review. Lets a user inspect the
      // canvas in DevTools and confirm (a) this code path is what's
      // rendering (not `BlurOverlayItem` falling back to the old CSS
      // backdrop-filter + transform: rotate), and (b) the AABB +
      // sampling region match the rotated rect's screen position.
      data-pwrsnap-rotated-blur={style}
      data-pwrsnap-rotation-rad={rotation.toFixed(6)}
      data-pwrsnap-aabb={`${aabb.aabbX.toFixed(2)},${aabb.aabbY.toFixed(2)},${aabb.aabbW.toFixed(2)},${aabb.aabbH.toFixed(2)}`}
      style={{
        position: "absolute",
        left: `${(aabb.aabbX / canvasWidthPx) * 100}%`,
        top: `${(aabb.aabbY / canvasHeightPx) * 100}%`,
        width: `${(aabb.aabbW / canvasWidthPx) * 100}%`,
        height: `${(aabb.aabbH / canvasHeightPx) * 100}%`,
        // The mask: only the rotated-rect interior survives. AABB
        // corners outside the rotated rect get clipped to transparent.
        clipPath: `polygon(${polygonPoints})`
      }}
    />
  );
}

/** Canvas-backed pixelate preview for the UN-ROTATED case (issue
 *  #137). Same algorithm as the bake's pixelate path: sample the
 *  source at the rect, downsample to a coarse grid, display with
 *  `image-rendering: pixelated` for nearest-neighbor upscale.
 *
 *  Block size formula (in lockstep with compose-tree.ts):
 *    shortSide  = min(rect.w × canvasWidthPx, rect.h × canvasHeightPx)
 *    blockSize  = max(4, round(shortSide / 16))
 *    downW/H    = floor(rectPx / blockSize)
 *
 *  Rotated pixelate goes through `RotatedEffectCanvas` instead. */
function PixelateMosaicCanvas({
  rect,
  editorImageRef,
  canvasWidthPx,
  canvasHeightPx,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  editorImageRef: RefObject<HTMLImageElement | null>;
  canvasWidthPx: number;
  canvasHeightPx: number;
  isDraft?: boolean;
}): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = editorImageRef.current;
    if (canvas === null || img === null) return;

    const draw = (): void => {
      const rectXPx = rect.x * canvasWidthPx;
      const rectYPx = rect.y * canvasHeightPx;
      const rectWPx = Math.max(1, rect.w * canvasWidthPx);
      const rectHPx = Math.max(1, rect.h * canvasHeightPx);
      const shortSide = Math.min(rectWPx, rectHPx);
      const blockSizePx = Math.max(4, Math.round(shortSide / 16));
      const downW = Math.max(1, Math.floor(rectWPx / blockSizePx));
      const downH = Math.max(1, Math.floor(rectHPx / blockSizePx));
      canvas.width = downW;
      canvas.height = downH;
      const ctx = canvas.getContext("2d");
      if (ctx === null) return;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const scaleX = img.naturalWidth / canvasWidthPx;
      const scaleY = img.naturalHeight / canvasHeightPx;
      ctx.clearRect(0, 0, downW, downH);
      ctx.drawImage(
        img,
        rectXPx * scaleX,
        rectYPx * scaleY,
        rectWPx * scaleX,
        rectHPx * scaleY,
        0,
        0,
        downW,
        downH
      );
    };

    if (img.complete && img.naturalWidth > 0) {
      draw();
      return;
    }
    img.addEventListener("load", draw, { once: true });
    return () => {
      img.removeEventListener("load", draw);
    };
  }, [
    rect.x,
    rect.y,
    rect.w,
    rect.h,
    canvasWidthPx,
    canvasHeightPx,
    editorImageRef
  ]);
  return (
    <canvas
      ref={canvasRef}
      className={
        "ed-blur-item ed-blur-item--pixelate-canvas" + (isDraft ? " is-draft" : "")
      }
      style={{
        position: "absolute",
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.w * 100}%`,
        height: `${rect.h * 100}%`,
        imageRendering: "pixelated"
      }}
    />
  );
}
