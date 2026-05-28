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
import {
  deriveBlurRadiusPx,
  readBlurStyle,
  readOverlayRotation
} from "@pwrsnap/shared";
import { rectFromDrag, type Draft } from "./editor-types";
import type { GeometryUpdate } from "./useCaptureModel";
import { Z_INDEX_CHROME } from "./OverlaySvg";
import "./BlurOverlays.css";

export function BlurOverlays({
  overlays,
  draft,
  blurStyle,
  liveOverride = null,
  editorImageRef,
  canvasWidthPx,
  canvasHeightPx,
  sourceWidthPx,
  sourceHeightPx,
  rasterTranslateXPx,
  rasterTranslateYPx
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
  /** Source raster's natural pixel dims. For uncropped v1/v2 captures
   *  these equal canvasWidthPx/H (= raster fills the canvas); for v2
   *  cropped captures sourceWidth > canvasWidth and the raster
   *  overflows the canvas wrap (clipped by overflow: hidden). Threading
   *  these in lets the canvas-based sampling paths convert canvas-px
   *  coords to img-natural-px coords correctly. See
   *  `computeEditorImageStyle` for the matching CSS sizing math. */
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Raster layer transform[4]/[5] — source-pixel translation applied
   *  to the editor's `<img>` so off-origin crops display the user's
   *  chosen region. Identity (0, 0) for uncropped captures + v1
   *  rows. Canvas sampling subtracts these from the AABB coords so the
   *  off-screen region of the source maps to the right natural-px. */
  rasterTranslateXPx: number;
  rasterTranslateYPx: number;
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
        // Persisted blur items carry their layer.z_index in CSS so
        // they stack against arrows / rects / text / highlight by
        // their layer's z_index — same canvas-wrap stacking context
        // across all kinds. Pre-fix the editor ignored cross-kind
        // z_index (each render container's items were in their own
        // bucket) and a Bring-Forward/Send-Backward on a layer of
        // one kind couldn't move it past a layer of a different
        // kind. The user's repro: "Bring Forward / Bring to Front
        // on that Rect does not bring it above the arrows... ever."
        return renderBlur({
          key: row.id,
          rect: data.rect,
          rotation,
          style,
          editorImageRef,
          canvasWidthPx,
          canvasHeightPx,
          sourceWidthPx,
          sourceHeightPx,
          rasterTranslateXPx,
          rasterTranslateYPx,
          zIndex: row.z_index
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
          sourceWidthPx,
          sourceHeightPx,
          rasterTranslateXPx,
          rasterTranslateYPx,
          isDraft: true,
          // Chrome z-index sentinel — paint ABOVE every persisted blur
          // (or other persisted layer) regardless of their layer.z_index.
          // Without this, the draft would inherit z-index auto (= 0) and
          // a high-z_index persisted blur could occlude the live-drag
          // preview. See OverlaySvg's chrome SVG for the parallel
          // rationale.
          zIndex: Z_INDEX_CHROME
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
  sourceWidthPx: number;
  sourceHeightPx: number;
  rasterTranslateXPx: number;
  rasterTranslateYPx: number;
  isDraft?: boolean;
  /** Optional CSS z-index for cross-kind ordering. Persisted blurs
   *  pass `row.z_index`; the in-flight draft passes `Z_INDEX_CHROME`
   *  so it paints above every persisted layer. Threaded uniformly
   *  to all three render branches so the rotation × style decision
   *  tree below doesn't have to know about chrome vs persisted. */
  zIndex?: number;
}): ReactElement {
  const { key, rect, rotation, style, isDraft = false, zIndex } = args;
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
        sourceWidthPx={args.sourceWidthPx}
        sourceHeightPx={args.sourceHeightPx}
        rasterTranslateXPx={args.rasterTranslateXPx}
        rasterTranslateYPx={args.rasterTranslateYPx}
        isDraft={isDraft}
        {...(zIndex !== undefined ? { zIndex } : {})}
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
        sourceWidthPx={args.sourceWidthPx}
        sourceHeightPx={args.sourceHeightPx}
        rasterTranslateXPx={args.rasterTranslateXPx}
        rasterTranslateYPx={args.rasterTranslateYPx}
        isDraft={isDraft}
        {...(zIndex !== undefined ? { zIndex } : {})}
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
      {...(zIndex !== undefined ? { zIndex } : {})}
    />
  );
}

function BlurOverlayItem({
  rect,
  rotation,
  style,
  isDraft = false,
  zIndex
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
  /** Optional CSS z-index for cross-kind ordering. Persisted blur
   *  items pass `row.z_index` so they stack against arrows / rects /
   *  text / highlight in the canvas's stacking context (the parent
   *  `.ed-blur-layer` has no z-index of its own → no stacking
   *  context, children's z-index applies to canvas-wrap). Draft
   *  preview items omit it (default `undefined`) and pick up the
   *  chrome z-index sentinel via the wrapping draft container. */
  zIndex?: number;
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
        ...(rotation !== 0 ? { transform: `rotate(${rotateDeg}deg)` } : {}),
        ...(zIndex !== undefined ? { zIndex } : {})
      }}
    />
  );
}

// Sigma derivation lives in `@pwrsnap/shared deriveBlurRadiusPx` —
// shared across the editor commit path, the v1→v2 doctor, and the
// rotated-gaussian canvas preview here so the three stay in lockstep.

/** Map a CANVAS-coord rect to the equivalent IMG-NATURAL-pixel source
 *  rect for `ctx.drawImage`. Mirrors the editor's `<img>` CSS sizing
 *  math from `computeEditorImageStyle`:
 *
 *    - The img is sized to `sourceWidth/canvasWidth × parent` so source
 *      raster pixels map 1:1 to canvas-px AT DISPLAY (modulo the
 *      naturalWidth/sourceWidth DPR ratio).
 *    - The img is CSS-translated by `rasterTranslate / source × 100%`
 *      so off-origin crops appear shifted. That translation, expressed
 *      in canvas-px, IS `rasterTranslateXPx`.
 *
 *  Inverse: a pixel at canvas-coord `cx` corresponds to img-natural-px
 *  `(cx - rasterTranslateXPx) × (naturalWidth / sourceWidthPx)`. The
 *  identity simplification (uncropped + natural == canvas) gives
 *  `srcX = cx` — what the previous code did. The general formula here
 *  handles cropped + DPR'd captures correctly.
 *
 *  Returns the source rect to pass as the first 4 numeric args to
 *  `ctx.drawImage(img, srcX, srcY, srcW, srcH, ...)`. */
function canvasRectToImgNaturalRect(args: {
  /** Canvas-pixel coords (the units in which rect.x*canvasWidthPx is
   *  expressed). Same coord space as the AABB returned by
   *  `computeRotatedAabb`. */
  canvasX: number;
  canvasY: number;
  canvasW: number;
  canvasH: number;
  img: HTMLImageElement;
  canvasWidthPx: number;
  canvasHeightPx: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
  rasterTranslateXPx: number;
  rasterTranslateYPx: number;
}): { srcX: number; srcY: number; srcW: number; srcH: number } {
  // naturalWidth might differ from sourceWidthPx on Retina captures
  // where the source PNG is at DPR-multiplied resolution. For most
  // captures the two are equal and the scale is 1. Guard against the
  // pathological zero-source case (would NaN the math).
  const safeSourceW = args.sourceWidthPx > 0 ? args.sourceWidthPx : 1;
  const safeSourceH = args.sourceHeightPx > 0 ? args.sourceHeightPx : 1;
  const scaleX = args.img.naturalWidth / safeSourceW;
  const scaleY = args.img.naturalHeight / safeSourceH;
  return {
    srcX: (args.canvasX - args.rasterTranslateXPx) * scaleX,
    srcY: (args.canvasY - args.rasterTranslateYPx) * scaleY,
    srcW: args.canvasW * scaleX,
    srcH: args.canvasH * scaleY
  };
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
  sourceWidthPx,
  sourceHeightPx,
  rasterTranslateXPx,
  rasterTranslateYPx,
  isDraft = false,
  zIndex
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
  sourceWidthPx: number;
  sourceHeightPx: number;
  rasterTranslateXPx: number;
  rasterTranslateYPx: number;
  isDraft?: boolean;
  /** Optional CSS z-index — see BlurOverlayItem for the contract.
   *  Persisted rotated blurs pass row.z_index for cross-kind stacking;
   *  draft preview gets `Z_INDEX_CHROME`. Threaded through `renderBlur`. */
  zIndex?: number;
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

      // Source coords → image NATURAL pixels. `canvasRectToImgNaturalRect`
      // handles the canvas-px → img-natural-px conversion AND the
      // crop-translation subtract in one place. Uncropped captures with
      // natural == canvas degenerate to identity (srcX === aabbX).
      // Cropped captures correctly subtract `rasterTranslateXPx` so the
      // off-origin region of the source raster maps to the right
      // natural-px in `drawImage`'s source rect.
      const src = canvasRectToImgNaturalRect({
        canvasX: aabb.aabbX,
        canvasY: aabb.aabbY,
        canvasW: aabb.aabbW,
        canvasH: aabb.aabbH,
        img,
        canvasWidthPx,
        canvasHeightPx,
        sourceWidthPx,
        sourceHeightPx,
        rasterTranslateXPx,
        rasterTranslateYPx
      });

      if (style === "gaussian") {
        // ctx.filter applies to the NEXT drawImage. σ matches the
        // bake's blur radius (compose-tree.ts calls sharp.blur(σ)
        // with the same effect.radius_px value).
        const sigma = deriveBlurRadiusPx({
          width: canvasWidthPx,
          height: canvasHeightPx
        });
        ctx.filter = `blur(${sigma}px)`;
        ctx.drawImage(
          img,
          src.srcX,
          src.srcY,
          src.srcW,
          src.srcH,
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
          src.srcX,
          src.srcY,
          src.srcW,
          src.srcH,
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
    sourceWidthPx,
    sourceHeightPx,
    rasterTranslateXPx,
    rasterTranslateYPx,
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
        clipPath: `polygon(${polygonPoints})`,
        ...(zIndex !== undefined ? { zIndex } : {})
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
  sourceWidthPx,
  sourceHeightPx,
  rasterTranslateXPx,
  rasterTranslateYPx,
  isDraft = false,
  zIndex
}: {
  rect: { x: number; y: number; w: number; h: number };
  editorImageRef: RefObject<HTMLImageElement | null>;
  canvasWidthPx: number;
  canvasHeightPx: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
  rasterTranslateXPx: number;
  rasterTranslateYPx: number;
  isDraft?: boolean;
  /** Optional CSS z-index — see BlurOverlayItem for the contract.
   *  Persisted pixelate items pass row.z_index for cross-kind
   *  stacking; draft preview gets `Z_INDEX_CHROME`. Threaded through
   *  `renderBlur` so this branch doesn't have to know about chrome
   *  vs persisted. */
  zIndex?: number;
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
      // Canvas-px → img-natural-px conversion via the shared helper.
      // Handles the uncropped degenerate case (srcX === rectXPx when
      // natural == canvas and rasterTranslate is identity) AND the
      // cropped case (subtract rasterTranslate so off-origin source
      // raster maps to the right natural-px region).
      const src = canvasRectToImgNaturalRect({
        canvasX: rectXPx,
        canvasY: rectYPx,
        canvasW: rectWPx,
        canvasH: rectHPx,
        img,
        canvasWidthPx,
        canvasHeightPx,
        sourceWidthPx,
        sourceHeightPx,
        rasterTranslateXPx,
        rasterTranslateYPx
      });
      ctx.clearRect(0, 0, downW, downH);
      ctx.drawImage(
        img,
        src.srcX,
        src.srcY,
        src.srcW,
        src.srcH,
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
    sourceWidthPx,
    sourceHeightPx,
    rasterTranslateXPx,
    rasterTranslateYPx,
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
        imageRendering: "pixelated",
        ...(zIndex !== undefined ? { zIndex } : {})
      }}
    />
  );
}
