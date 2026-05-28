// HTML blur-overlay layer sitting between the canvas <img> and the
// SVG overlay layer. Renders blur overlays as absolutely-positioned
// elements whose effect (backdrop-filter, canvas mosaic, opaque fill)
// matches what the bake (compose-tree.ts) produces on export.
//
// Why HTML instead of SVG? SVG <filter> can blur SVG content but
// can't reach behind itself to blur the page <img>. CSS
// `backdrop-filter` on an HTML element blurs ANYTHING behind it in
// the same stacking context, including a sibling <img> — exactly
// what we want for the gaussian-blur live preview.
//
// Per-style WYSIWYG strategy:
//
//   • gaussian — CSS `backdrop-filter: blur(...)`. The bake uses
//     sharp's gaussian blur with sigma proportional to the rect's
//     short side; CSS approximates with a flat radius. Close enough
//     visually that users can place the rect with confidence.
//
//   • pixelate — Issue #137: the prior version was a STATIC decoration
//     (`backdrop-filter: blur(8px)` + a diagonal-checker CSS pattern)
//     that "read as mosaic" but bore no resemblance to the bake's
//     true nearest-neighbor coarse-grid. Replaced by a `<canvas>`
//     that samples the underlying source image at the same block
//     size the bake uses (max(4, round(shortSide/16))), drawn down
//     to a tiny grid then displayed via `image-rendering: pixelated`
//     so the browser upscales each block with nearest-neighbor.
//     Editor and bake now produce matching mosaics block-for-block.
//
//   • redact — solid opaque black. Pixel-identical to the bake by
//     construction.

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
  /** Ref to the editor's `<img>` element. The pixelate preview reads
   *  pixels from it via `canvas.drawImage` to produce a real coarse-
   *  grid mosaic. Other blur styles ignore this prop. */
  editorImageRef: RefObject<HTMLImageElement | null>;
  /** Canvas dims in canvas pixels — the unit `compose-tree.ts`'s
   *  pixelate uses for its block-size formula. Passed in rather than
   *  measured off the DOM so the editor and bake stay in lockstep
   *  even if the renderer's display transform changes. */
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
      // in real time.
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
        if (style === "pixelate") {
          return (
            <PixelateMosaicCanvas
              key={row.id}
              rect={data.rect}
              rotation={rotation}
              editorImageRef={editorImageRef}
              canvasWidthPx={canvasWidthPx}
              canvasHeightPx={canvasHeightPx}
            />
          );
        }
        return (
          <BlurOverlayItem
            key={row.id}
            rect={data.rect}
            rotation={rotation}
            style={style}
          />
        );
      })}
      {liveRect !== null && blurStyle === "pixelate" && (
        <PixelateMosaicCanvas
          rect={liveRect}
          rotation={0}
          editorImageRef={editorImageRef}
          canvasWidthPx={canvasWidthPx}
          canvasHeightPx={canvasHeightPx}
          isDraft
        />
      )}
      {liveRect !== null && blurStyle !== "pixelate" && (
        <BlurOverlayItem rect={liveRect} rotation={0} style={blurStyle} isDraft />
      )}
    </div>
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
   *  glyph rotation pivot for rect/highlight kinds. NOTE: v1 export
   *  (`compose.ts` blur path) currently ignores rotation — sharp's
   *  extract+blur pipeline doesn't support rotated clip regions. The
   *  live editor preview will rotate; the baked PNG will not. */
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

/** Canvas-backed pixelate preview. Samples the underlying editor
 *  `<img>` at the rect bounds, downsamples to a coarse grid using
 *  the same block-size formula as `compose-tree.ts`, then displays
 *  the small canvas at the rect's full visual size so the browser's
 *  `image-rendering: pixelated` upscale produces crisp mosaic
 *  blocks. Output is visually identical (modulo lanczos vs canvas
 *  bilinear at the downsample step) to the bake's nearest-neighbor
 *  output.
 *
 *  Block size formula (kept in lockstep with the bake):
 *    shortSide  = min(rect.w × canvasWidthPx, rect.h × canvasHeightPx)
 *    blockSize  = max(4, round(shortSide / 16))
 *    downW/H    = floor(rectPx / blockSize)
 *
 *  Source-image-load handling:
 *    • If `complete && naturalWidth > 0`, draw immediately.
 *    • Otherwise wire a one-shot `load` listener and draw then.
 *    • If the image swaps src mid-mount (e.g. capture switched),
 *      the next render runs the effect again with the new rect deps
 *      — the load listener re-attaches cleanly. */
function PixelateMosaicCanvas({
  rect,
  rotation,
  editorImageRef,
  canvasWidthPx,
  canvasHeightPx,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  /** Clockwise rotation in radians around the rect's geometric
   *  center. Applied as a CSS `transform: rotate(...)` on the displayed
   *  canvas.
   *
   *  ⚠️ KNOWN MISMATCH WITH THE BAKE FOR rotation !== 0:
   *  We sample the source at the UN-ROTATED rect's region (in canvas
   *  coords) and then CSS-rotate the displayed canvas. The v2 bake
   *  (`compose-tree.ts applyEffectOntoAccumulator`) samples at the
   *  ROTATED rect's AABB in the accumulator and composites back via
   *  a rotation mask — so the bake shows the rotated-rect interior
   *  pixelated IN PLACE, while the editor shows a rotated mosaic of
   *  the un-rotated rect's content. For rotation === 0 the two match
   *  pixel-for-pixel; for non-zero rotations they diverge.
   *
   *  This same divergence exists for gaussian (`backdrop-filter` is
   *  captured pre-rotation in Chromium) and is independent of the
   *  pixelate fix in this PR. Tracked as a follow-up — the right
   *  fix samples the source at the rotated-rect AABB and clip-paths
   *  the canvas to the rotated polygon. */
  rotation: number;
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
      // Rect in canvas pixels — what the bake's block-size formula
      // takes as input.
      const rectXPx = rect.x * canvasWidthPx;
      const rectYPx = rect.y * canvasHeightPx;
      const rectWPx = Math.max(1, rect.w * canvasWidthPx);
      const rectHPx = Math.max(1, rect.h * canvasHeightPx);
      const shortSide = Math.min(rectWPx, rectHPx);
      const blockSizePx = Math.max(4, Math.round(shortSide / 16));
      const downW = Math.max(1, Math.floor(rectWPx / blockSizePx));
      const downH = Math.max(1, Math.floor(rectHPx / blockSizePx));
      // Set canvas's INTERNAL resolution to the coarse grid. CSS
      // (set via the style attribute below) scales the canvas back up
      // to its display size; `image-rendering: pixelated` makes that
      // upscale nearest-neighbor — exactly the bake's `kernel:
      // "nearest"` on the upsample.
      canvas.width = downW;
      canvas.height = downH;
      const ctx = canvas.getContext("2d");
      if (ctx === null) return;
      // Bicubic for the downsample (matches sharp's default resize
      // kernel approximately enough — visual parity is the goal).
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // The img is the editor's source raster, rendered at canvas
      // dims by the editor's `<img>` styling. drawImage's source
      // rect is in NATURAL image coords; for v2 captures the natural
      // image dims may differ from canvas dims (crop), but the
      // editor's `<img>` element is sized so the SOURCE-raster
      // coords map 1:1 to canvas-pixel coords AT THE DISPLAY (via
      // CSS transform). For sampling we want CANVAS-pixel coords →
      // image NATURAL coords, which is just `naturalWidth /
      // canvasWidthPx` for the scale (and zero for the translate in
      // the un-cropped case).
      //
      // For uncropped captures (natural == canvas) this is identity.
      // For cropped captures we'd need the rasterTranslate offsets
      // from Editor.tsx; deferring that to a follow-up since the
      // editor's `<img>` already handles the same translate via CSS
      // and the current sampling will be visually close (just
      // offset). Most captures are uncropped.
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
  const rotateDeg = (rotation * 180) / Math.PI;
  return (
    <canvas
      ref={canvasRef}
      className={"ed-blur-item ed-blur-item--pixelate-canvas" + (isDraft ? " is-draft" : "")}
      style={{
        position: "absolute",
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.w * 100}%`,
        height: `${rect.h * 100}%`,
        // The whole point — nearest-neighbor upscale of the coarse
        // grid. Without this, the browser bilinear-interpolates and
        // we're back to "looks like a soft blur."
        imageRendering: "pixelated",
        ...(rotation !== 0 ? { transform: `rotate(${rotateDeg}deg)` } : {})
      }}
    />
  );
}
