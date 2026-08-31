// Zod discriminated union for `Overlay`. Validate at every IPC boundary
// — Codex injects overlays in Phase 4 via DynamicToolCall responses,
// and we never trust LLM-routed structured output without a runtime
// validator. Phase 1 only writes auto-generated `crop` overlays for
// region capture; the editor tools (arrow / rect / text / etc.) land
// in Phase 2.
//
// Coordinate space: overlay coords are normalized fractions of the
// CURRENT canvas's WxH. (0, 0) is top-left. The canonical case is
// values in [0, 1]^2 (overlay visible within the canvas), but coords
// OUTSIDE that range are also legal — see `NormalizedScalar` below.
// Crop is implemented as a viewport change (per pwrdrvr/PwrSnap#110),
// and overlays at absolute source pixels outside the cropped viewport
// must persist as DATA so undoing the crop restores them; that's only
// possible if the schema permits out-of-canvas coords.

import { z } from "zod";

import {
  annotationStrokeWidthPx,
  type AnnotationSizePreset
} from "./annotation-scale";

/** Thickness preset shared by ArrowOverlay + RectOverlay. Mirrors the
 *  `ToolSizePreset` value space in `protocol.ts` (the editor's tool-
 *  style memory) — picking "large" in the popover writes "large" into
 *  the overlay row. Numeric escape hatch (px-equivalent fraction)
 *  reserved for future power-user controls; pre-Phase 3.x rows omit
 *  the field entirely and render at the auto-derived stroke. */
export const OverlayThickness = z.union([
  z.literal("auto"),
  z.literal("small"),
  z.literal("medium"),
  z.literal("large"),
  z.literal("x-large"),
  z.number().positive().max(1)
]);
export type OverlayThickness = z.infer<typeof OverlayThickness>;

/** Fallback multipliers for the legacy two-arg call shape (no
 *  `basisPx`). Production paths all pass a basis. */
const LEGACY_THICKNESS_MULTIPLIERS: Readonly<
  Record<AnnotationSizePreset, number>
> = { small: 0.5, medium: 1, large: 2, "x-large": 3 };

/**
 * Resolve a thickness preset (or numeric override / "auto") to a
 * concrete stroke width in pixels.
 *
 * Presets are absolute rungs on the shared annotation ladder —
 * `basisPx / ANNOTATION_STROKE_DIVISORS[preset]` — NOT multipliers on
 * whatever the caller's auto stroke happened to be. Only `"auto"`
 * (and a missing field) passes `autoStrokePx` through.
 *
 * That inversion is the point of the 2026-08 recalibration. The old
 * shape was `max(autoStroke × multiplier, shortSide × floorFraction)`
 * over `autoStroke = clamp(shortSide / 220, 4, 14)`. Because the auto
 * stroke was pinned to an absolute 4 px for EVERY capture under an
 * 880 px short side — which is most window grabs — Small and Medium
 * both resolved to 2 px and 4 px on a 777×207 grab, a 1200×800 grab,
 * and a 473×178 grab alike: two presets, one behavior, no scaling.
 * Large and X-Large meanwhile escaped the clamp through their short-
 * side floor fractions and landed 2.7× away, so the ladder read
 * 3.2 / 4.9 / 13.0 / 21.6 px on 1080p. Sizing every rung off the
 * basis directly gives a uniform ~1.53× step at every resolution,
 * and makes Auto identical to Medium by construction rather than by
 * coincidence.
 *
 * Changing `ANNOTATION_STROKE_DIVISORS` re-bakes every existing
 * arrow / shape at that preset on next load. That is the deliberate
 * trade-off for "a preset means the same thing on every capture
 * regardless of when it was drawn" — the arrow style-version table
 * pins HEAD SHAPE across time, not user-picked sizes.
 *
 * @param thickness    The persisted preset / numeric override / "auto".
 * @param autoStrokePx The caller's auto-derived stroke, in pixels.
 *                     Returned verbatim for `"auto"` / missing.
 * @param basisPx      `annotationBasisPx(sourceW, sourceH)` for the
 *                     capture. Optional ONLY so legacy two-arg call
 *                     sites keep compiling; when omitted, presets fall
 *                     back to multiplying `autoStrokePx` and numeric
 *                     overrides pass through as bare fractions. New
 *                     code always passes it.
 */
export function readOverlayThickness(
  thickness: OverlayThickness | undefined,
  autoStrokePx: number,
  basisPx?: number
): number {
  if (thickness === undefined || thickness === "auto") return autoStrokePx;
  if (typeof thickness === "number") {
    // Numeric thickness is a normalized fraction of the annotation
    // basis. If basisPx is provided we expand to absolute pixels;
    // otherwise fall through verbatim (legacy "fraction in, fraction
    // out").
    //
    // Footgun guard: numeric thickness should be ≤ 1 (it's a
    // normalized fraction). A value > 1 strongly suggests a caller
    // accidentally passed a PIXEL stroke into the legacy two-arg
    // form and is going to multiply by the basis somewhere downstream
    // — producing a stroke wider than the image. Warn (but still
    // return the value) so the broken render doesn't propagate
    // silently.
    //
    // packages/shared is environment-agnostic (`"types": []` in the
    // tsconfig — no Node, no DOM lib), so we can't reference
    // `console` or `process` directly. Route through `globalThis`
    // with an inline cast: console is present in both Node and
    // browser; if some exotic runtime lacks it, the optional-chain
    // falls back to a silent no-op rather than throwing.
    if (thickness > 1 && basisPx === undefined) {
      const con = (globalThis as { console?: { warn(msg: string): void } }).console;
      con?.warn(
        `[readOverlayThickness] numeric thickness=${thickness} (> 1) passed without basisPx — ` +
          `did you mean to pass basisPx? Numeric thickness is a normalized [0,1] fraction; ` +
          `pixel values must go through the three-arg form.`
      );
    }
    return basisPx !== undefined ? thickness * basisPx : thickness;
  }
  if (basisPx === undefined) {
    // Pre-ladder fallback. Kept so a two-arg call still produces
    // something ordered small < medium < large < x-large rather than
    // silently returning the auto stroke for all four.
    return autoStrokePx * LEGACY_THICKNESS_MULTIPLIERS[thickness];
  }
  return annotationStrokeWidthPx(thickness, basisPx);
}

// Overlay coords are "normalized" with respect to the SOURCE raster's
// natural dims, NOT the current canvas dims. Before crop-as-layer
// (pwrdrvr/PwrSnap#110), this scalar was constrained to [0,1] under
// the assumption that overlay coords always referenced the visible
// canvas. That assumption breaks the moment a crop layer enters the
// tree: overlays at absolute source pixels outside the cropped
// viewport must persist as DATA (with coords > 1 or < 0 in the new
// canvas's [0,1] space) so undoing the crop restores them. Renderer
// and bake clip at canvas boundary at paint time (SVG overflow, sharp
// composite). Constraint widened to `.finite()` — disallows
// NaN/Infinity (those would crash the renderer), allows any real
// number (which is what "absolute source coord, expressed as a
// fraction of the current canvas" needs to be).
const NormalizedScalar = z.number().finite();
const NormalizedPoint = z.object({
  x: NormalizedScalar,
  y: NormalizedScalar
});
const NormalizedRect = z.object({
  x: NormalizedScalar,
  y: NormalizedScalar,
  w: NormalizedScalar,
  h: NormalizedScalar
});

/** Arrow head/end glyph. New in Phase 1 of the v2 editor refresh —
 *  existing arrows without this field render as `"filled-triangle"`
 *  (the legacy behavior). Renderer reads via `readArrowEndStyle`. */
export const ArrowEndStyle = z.enum(["filled-triangle", "open-triangle", "line", "dot"]);
export type ArrowEndStyle = z.infer<typeof ArrowEndStyle>;
export const DEFAULT_ARROW_END_STYLE: ArrowEndStyle = "filled-triangle";

/** Arrow stem stroke. Solid is the legacy default. Dashed/dotted are
 *  new in Phase 1. */
export const ArrowStemStyle = z.enum(["solid", "dashed", "dotted"]);
export type ArrowStemStyle = z.infer<typeof ArrowStemStyle>;
export const DEFAULT_ARROW_STEM_STYLE: ArrowStemStyle = "solid";

/** Contrast-border ("outline") mode carried by arrow / shape / text
 *  overlays. The border is the halo painted UNDER the colored glyph so
 *  it stays legible on busy or same-colored backgrounds.
 *
 *    auto   — the editor samples the pixels under the border's own
 *             path and resolves to black (light background) or white
 *             (everything else); the resolved pick is persisted in
 *             `outlineAuto` so the bake never re-samples (WYSIWYG +
 *             deterministic render cache).
 *    white  — always white (the historical arrow/shape halo).
 *    black  — always black.
 *    stripe — white base with black dashes; reads on any background.
 *             Arrow + shape only; text renderers coerce it to a solid
 *             stroke via `readOverlayOutline`'s fallback color.
 *    none   — no border at all.
 *
 *  The field is OPTIONAL for back-compat: rows without it keep their
 *  historical per-kind behavior (arrow/shape: solid white halo; text:
 *  the translucent rgba(0,0,0,0.6) glyph stroke), resolved as
 *  `{ kind: "legacy" }` by `readOverlayOutline` — existing captures
 *  render byte-identically. */
export const OverlayOutlineMode = z.enum(["auto", "white", "black", "stripe", "none"]);
export type OverlayOutlineMode = z.infer<typeof OverlayOutlineMode>;

/** Plain predicate over the enum's value space — the ONE list every
 *  boundary shares (editor style routing, settings validators, and
 *  the settings parser all consume this instead of hand-rolling the
 *  five literals). Kept as a hand-written predicate rather than
 *  `OverlayOutlineMode.safeParse` because the main-process settings
 *  validator deliberately avoids runtime zod (see the header of
 *  settings-validators.ts). */
export function isOverlayOutlineMode(value: unknown): value is OverlayOutlineMode {
  return (
    value === "auto" ||
    value === "white" ||
    value === "black" ||
    value === "stripe" ||
    value === "none"
  );
}

/** Resolved color persisted alongside `outline: "auto"` (see above). */
export const OverlayOutlineAutoColor = z.enum(["white", "black"]);
export type OverlayOutlineAutoColor = z.infer<typeof OverlayOutlineAutoColor>;

/** What a renderer should actually paint for an overlay's border.
 *  `legacy` = the pre-outline-field behavior for that overlay kind
 *  (arrow/shape: white halo; text: translucent black stroke) — kept
 *  distinct from `solid` so legacy rows stay byte-identical. */
export type ResolvedOverlayOutline =
  | { kind: "legacy" }
  | { kind: "none" }
  | { kind: "solid"; color: OverlayOutlineAutoColor }
  | { kind: "stripe" };

/** Resolve the persisted outline fields into a paint decision.
 *
 *  @param autoFallback The color an unresolved `outline: "auto"` (no
 *  stored `outlineAuto`, e.g. an AI-injected row the editor never
 *  touched) falls back to. Callers pass the color closest to that
 *  kind's legacy halo — "white" for arrow/shape, "black" for text —
 *  so the degenerate case degrades to the familiar look.
 *
 *  Text renderers cannot paint a striped glyph stroke
 *  (`-webkit-text-stroke` is single-color), so they coerce a `stripe`
 *  result to `{ kind: "solid", color: autoFallback }` at the call
 *  site — the mode is never offered for text in the UI, this is
 *  defense against hand-edited rows. */
export function readOverlayOutline(
  data: {
    outline?: OverlayOutlineMode | undefined;
    outlineAuto?: OverlayOutlineAutoColor | undefined;
  },
  autoFallback: OverlayOutlineAutoColor
): ResolvedOverlayOutline {
  switch (data.outline) {
    case undefined:
      return { kind: "legacy" };
    case "none":
      return { kind: "none" };
    case "white":
      return { kind: "solid", color: "white" };
    case "black":
      return { kind: "solid", color: "black" };
    case "stripe":
      return { kind: "stripe" };
    case "auto":
      return { kind: "solid", color: data.outlineAuto ?? autoFallback };
  }
}

/** Stripe geometry — shared by the live editor (OverlaySvg) and the
 *  bake (compose.ts) so both paint identical stripes. The stripe is a
 *  solid WHITE under-stroke plus a BLACK twin with this dash pattern;
 *  the colored glyph paints on top, so only the outline band shows
 *  the alternation. Segment length scales with the halo width so
 *  thick borders get chunky, readable stripes rather than fizz. */
export function outlineStripeDashArray(haloWidthPx: number): string {
  const seg = Math.max(4, haloWidthPx * 1.75);
  return `${seg} ${seg}`;
}

/** Black-twin stroke pattern for a dashed / dotted stem's striped
 *  border. `dashoffset` is 0 for the half-dash mode; the dot-alternate
 *  mode needs a non-zero `stroke-dashoffset` on the black twin. */
export interface OutlineStripeStemDash {
  dasharray: string;
  dashoffset: number;
}

/** Stripe phase for a dashed / dotted arrow stem. The white halo
 *  mirrors the stem's own dash pattern (so halo never fills the
 *  gaps); the black twin must then stripe WITHIN the painted dashes —
 *  the plain stripe pattern would drop black marks into the empty
 *  gaps. Two regimes:
 *
 *    • Dash-like stems (D ≥ G, e.g. "dashed" at 4×stroke): split each
 *      dash in half — `D/2` black, then a `D/2 + G` hole — so every
 *      black segment sits inside a painted white dash.
 *    • Dot-like stems (D < G, e.g. "dotted" at 0.01×stroke): the
 *      half-dash degenerates — round linecaps at halo width render a
 *      near-zero dash as a full-diameter disc that exactly covers the
 *      white dot, turning the whole stem black. Alternate WHOLE dots
 *      instead: double the cycle and shift the black dash onto every
 *      second dot via `stroke-dashoffset = D + G` (pattern position at
 *      the path start ⇒ black covers dots 1, 3, 5…), yielding
 *      alternating white/black dots.
 *
 *  Input is `computeStemDashArray`'s `"D G"` output; returns null when
 *  it can't be parsed (caller skips the black pass — the white halo
 *  alone is the legacy look). */
export function outlineStripeDashArrayForStemDash(
  stemDash: string
): OutlineStripeStemDash | null {
  const parts = stemDash.trim().split(/\s+/).map(Number);
  const d = parts[0];
  const g = parts[1];
  if (parts.length !== 2 || d === undefined || g === undefined) return null;
  if (!Number.isFinite(d) || !Number.isFinite(g) || d <= 0 || g < 0) return null;
  if (d < g) {
    const cycle = d + g;
    return { dasharray: `${d} ${2 * cycle - d}`, dashoffset: cycle };
  }
  return { dasharray: `${d / 2} ${d / 2 + g}`, dashoffset: 0 };
}

/** Halo (under-stroke) color for a resolved border, as SVG color
 *  keywords. The single mapping behind the editor/bake WYSIWYG pair —
 *  ArrowGlyph/ShapeGlyph (live preview) and arrowSvg/shapeSvg (bake)
 *  all consume this, so the mapping cannot drift between surfaces.
 *  Legacy and unresolved-auto both land on the historical white. */
export function outlineHaloColor(
  resolved: ResolvedOverlayOutline
): "white" | "black" {
  return resolved.kind === "solid" && resolved.color === "black"
    ? "black"
    : "white";
}

/** Solid-mode glyph-stroke hex for a resolved TEXT border, or null
 *  when the mode isn't solid. The two text surfaces (HTML style via
 *  computeTextHtmlStyle, and the SVG fallback in compose.ts) share
 *  this arm; their legacy/none arms deliberately stay local (the
 *  historical translucent constants differ by surface). */
export function outlineSolidStrokeHex(
  resolved: ResolvedOverlayOutline
): "#000000" | "#ffffff" | null {
  if (resolved.kind !== "solid") return null;
  return resolved.color === "black" ? "#000000" : "#ffffff";
}

/** Auto stroke width for SHAPE glyphs — the Medium rung of the shared
 *  annotation ladder, so an auto shape, an auto arrow, and a Medium
 *  anything all paint the same weight.
 *
 *  Single source of truth consumed by the editor's
 *  `shapeStrokeGeometry` (paint + hit-test + drag rect) and by the
 *  bake's `shapeSvg`. The filled rim reaches it transitively — the
 *  rim IS the stroked path's halo, so it reads `outlinePx` rather
 *  than calling here again. The bake's stroked band
 *  used to run its own `clamp(shortSide / 220, 4, 14)` formula, which
 *  disagreed with this one — an auto stroked shape previewed at 8 px
 *  on 1080p and exported at 4.9 px. Routing both through here is what
 *  closes that WYSIWYG gap. */
export function shapeAutoStrokeWidthPx(basisPx: number): number {
  return annotationStrokeWidthPx("medium", basisPx);
}

/** Contrast-border (halo / rim) width for ONE side of a glyph, given
 *  the colored stroke it sits under — a quarter of the stroke, never
 *  thinner than 1.5px so a hairline glyph still reads against a busy
 *  background.
 *
 *  Same rule as the stroke ladder above, for the same reason: this is
 *  a DERIVED quantity the editor and the bake must agree on
 *  pixel-for-pixel, so it is read, not recomputed. Consumed by
 *  `shapeStrokeGeometry` + `ArrowGlyph` (editor) and by `arrowSvg` +
 *  `shapeSvg` (bake).
 *
 *  Four hand-written copies of this formula existed before it was
 *  hoisted — two of them with the arguments flipped
 *  (`Math.max(stroke * 0.25, 1.5)`), which is how you can tell they
 *  were typed independently rather than shared. Don't add a fifth. */
export function outlineHaloWidthPx(strokeWidthPx: number): number {
  return Math.max(1.5, strokeWidthPx * 0.25);
}

/** Total width of the painted halo stroke under a colored glyph
 *  stroke — the colored stroke plus `outlineHaloWidthPx` on each
 *  side. This is the width the halo primitive is stroked at, and the
 *  value `outlineStripeDashArray` phases the stripe against. */
export function outlineHaloStrokeWidthPx(strokeWidthPx: number): number {
  return strokeWidthPx + outlineHaloWidthPx(strokeWidthPx) * 2;
}

/** Text can't paint a striped glyph stroke, so its resolved outline
 *  never carries the stripe branch. */
export type ResolvedTextOutline = Exclude<ResolvedOverlayOutline, { kind: "stripe" }>;

/** Text-specific resolution: black is the auto fallback (closest to
 *  the legacy translucent-black stroke), and a stray `stripe` value
 *  coerces to solid black. */
export function readTextOverlayOutline(data: {
  outline?: OverlayOutlineMode | undefined;
  outlineAuto?: OverlayOutlineAutoColor | undefined;
}): ResolvedTextOutline {
  const resolved = readOverlayOutline(data, "black");
  if (resolved.kind === "stripe") return { kind: "solid", color: "black" };
  return resolved;
}

export const ArrowOverlay = z.object({
  kind: z.literal("arrow"),
  from: NormalizedPoint,
  to: NormalizedPoint,
  /** "auto" derives stroke + color from image short-side; explicit hex overrides. */
  color: z.union([z.literal("auto"), z.string().regex(/^#[0-9a-f]{6}$/i)]).default("auto"),
  label: z.string().max(80).optional(),
  /** Phase 1 v2-editor refresh — optional for back-compat. Legacy rows
   *  rendered through `readArrowEndStyle` / `readArrowStemStyle` get
   *  the pre-Phase-1 defaults. */
  endStyle: ArrowEndStyle.optional(),
  stemStyle: ArrowStemStyle.optional(),
  /** When true, render the same end glyph at both endpoints. Legacy
   *  rows omit this field (rendered as single-ended). */
  doubleEnded: z.boolean().optional(),
  /** Optional stroke-thickness override. Maps through
   *  `readOverlayThickness` to a stroke fraction; missing / "auto"
   *  preserves the legacy short-side-derived stroke. */
  thickness: OverlayThickness.optional(),
  /** Pins which version of the arrow style table to use for head
   *  proportions + stroke clamps. Stamped at commit time with
   *  `CURRENT_ARROW_STYLE_VERSION` from `arrow.ts`; legacy rows
   *  without the field fall back to v1 (the historical 3.5/2.6
   *  proportions) so changing the current version doesn't
   *  retroactively rewrite existing captures. See the
   *  `ARROW_STYLE_VERSIONS` table in `arrow.ts` for the recipe per
   *  version. */
  styleVersion: z.number().int().positive().optional(),
  /** Contrast-border mode (see `OverlayOutlineMode`). Optional for
   *  back-compat — legacy rows render the historical solid white
   *  halo via `readOverlayOutline`'s `legacy` branch. */
  outline: OverlayOutlineMode.optional(),
  /** Resolved color for `outline: "auto"`, sampled + persisted by the
   *  editor at placement/move time so the bake never re-samples. */
  outlineAuto: OverlayOutlineAutoColor.optional()
});

/** Mirror of readBlurStyle — applies the legacy default for arrows
 *  drawn before the endStyle field existed. Keeps the renderer from
 *  repeating the `?? "filled-triangle"` fallback at every paint site. */
export function readArrowEndStyle(
  data: { endStyle?: ArrowEndStyle | undefined }
): ArrowEndStyle {
  return data.endStyle ?? DEFAULT_ARROW_END_STYLE;
}

export function readArrowStemStyle(
  data: { stemStyle?: ArrowStemStyle | undefined }
): ArrowStemStyle {
  return data.stemStyle ?? DEFAULT_ARROW_STEM_STYLE;
}

export function readArrowDoubleEnded(
  data: { doubleEnded?: boolean | undefined }
): boolean {
  return data.doubleEnded ?? false;
}

/** Geometric shape variant carried on a ShapeOverlay row. Drives the
 *  primitive the renderer + bake emit:
 *    rect          → free-aspect <rect>
 *    square        → 1:1-locked <rect> (constraint enforced at draw time;
 *                    a row that was committed as a square but later
 *                    transformed off-ratio still renders as the literal
 *                    rect.w × rect.h box)
 *    circle        → 1:1-locked <ellipse>
 *    oval          → free-aspect <ellipse>
 *    parallelogram → <polygon> with horizontal skew = `skewDeg` */
export const ShapeKind = z.enum([
  "rect",
  "square",
  "circle",
  "oval",
  "parallelogram"
]);
export type ShapeKind = z.infer<typeof ShapeKind>;
export const DEFAULT_SHAPE_KIND: ShapeKind = "rect";

/** Default horizontal skew for parallelogram shape (in degrees). Matches
 *  Keynote/Figma's default. Positive = top edge shifted right. */
export const DEFAULT_PARALLELOGRAM_SKEW_DEG = 15;

export const ShapeOverlay = z.object({
  kind: z.literal("shape"),
  /** Which geometric primitive this overlay represents. Optional for
   *  back-compat with rows migrated from the pre-shape RectOverlay schema
   *  (read via `readShapeKind`, which defaults to "rect"). */
  shape: ShapeKind.optional(),
  rect: NormalizedRect,
  color: z.union([z.literal("auto"), z.string().regex(/^#[0-9a-f]{6}$/i)]).default("auto"),
  /** Optional stroke-thickness override (see ArrowOverlay.thickness). */
  thickness: OverlayThickness.optional(),
  /** When true, the shape renders as a solid fill in the resolved color
   *  rather than the default stroke-only outline. Optional for back-
   *  compat: legacy rows render as outline-only. */
  filled: z.boolean().optional(),
  /** Clockwise rotation in radians around the shape's bbox center.
   *  Optional for back-compat: legacy rows render as if `rotation = 0`. */
  rotation: z.number().finite().optional(),
  /** Horizontal skew in degrees, applied only when `shape === "parallelogram"`.
   *  Positive values shift the top edge to the right. Ignored for every
   *  other shape kind. Read via `readShapeSkewDeg`, which defaults to
   *  DEFAULT_PARALLELOGRAM_SKEW_DEG (15°) for legacy parallelogram rows
   *  without the field. */
  skewDeg: z.number().finite().optional(),
  /** Contrast-border mode (see `OverlayOutlineMode` / ArrowOverlay.outline).
   *  Legacy stroked shapes render the historical white halo; legacy
   *  FILLED shapes render no rim (both via the `legacy` branch). */
  outline: OverlayOutlineMode.optional(),
  /** Resolved color for `outline: "auto"` (see ArrowOverlay.outlineAuto). */
  outlineAuto: OverlayOutlineAutoColor.optional()
});

/** Resolve the persisted shape kind, applying the default for rows
 *  migrated from RectOverlay (which had no `shape` field — all such rows
 *  represent a rectangle by definition). */
export function readShapeKind(data: {
  shape?: ShapeKind | undefined;
}): ShapeKind {
  return data.shape ?? DEFAULT_SHAPE_KIND;
}

export function readShapeFilled(data: { filled?: boolean | undefined }): boolean {
  return data.filled ?? false;
}

/** Resolve the skew angle for a parallelogram. Returns 0 for any other
 *  shape kind (renderers should branch on shape first, but reading 0 here
 *  is a safe no-op skew). Legacy parallelogram rows without the field
 *  resolve to the 15° default. */
export function readShapeSkewDeg(data: {
  shape?: ShapeKind | undefined;
  skewDeg?: number | undefined;
}): number {
  if (readShapeKind(data) !== "parallelogram") return 0;
  if (data.skewDeg === undefined || !Number.isFinite(data.skewDeg)) {
    return DEFAULT_PARALLELOGRAM_SKEW_DEG;
  }
  return data.skewDeg;
}

/** Read the rotation (radians, clockwise) off any overlay kind that
 *  carries one. Legacy rows + arrow / step (which don't carry rotation)
 *  resolve to 0. Renderers + bake call this rather than touching
 *  `data.rotation` directly so the back-compat default lives in one
 *  place. */
export function readOverlayRotation(data: {
  rotation?: number | undefined;
}): number {
  if (data.rotation === undefined || !Number.isFinite(data.rotation)) return 0;
  return data.rotation;
}

/** Blend mode for highlight overlays. Mirrors `HighlightBlendMode` in
 *  `protocol.ts` (the popover/settings preference type) — same value
 *  space by design so the picker writes verbatim into the row. The zod
 *  schema lives here as the runtime source-of-truth for the on-disk
 *  row; the type alias is re-imported from protocol below. */
export const HighlightBlendModeSchema = z.enum(["multiply", "screen", "overlay"]);
type HighlightBlendMode = z.infer<typeof HighlightBlendModeSchema>;
export const DEFAULT_HIGHLIGHT_BLEND_MODE: HighlightBlendMode = "multiply";
export const DEFAULT_HIGHLIGHT_COLOR_HEX = "#facc15";
export const DEFAULT_HIGHLIGHT_OPACITY = 0.3;
export const MAX_HIGHLIGHT_OPACITY = 0.6;

export const HighlightOverlay = z.object({
  kind: z.literal("highlight"),
  rect: NormalizedRect,
  /** Phase 3.1 v2-editor refresh — optional for back-compat. Legacy
   *  rows (which had only `rect`) render with the historical yellow
   *  default via `readHighlightColor`. Either an "auto" sentinel (use
   *  legacy yellow) or an explicit hex from the popover swatches. */
  color: z
    .union([z.literal("auto"), z.string().regex(/^#[0-9a-f]{6}$/i)])
    .optional(),
  /** 0..1 opacity. Optional for back-compat; default applied via
   *  `readHighlightOpacity`. */
  opacity: z.number().min(0).max(1).optional(),
  /** CSS-style blend mode. Optional for back-compat. */
  blend: HighlightBlendModeSchema.optional(),
  /** Clockwise rotation in radians around the rect's geometric center.
   *  See RectOverlay.rotation. */
  rotation: z.number().finite().optional()
});

/** Mirrors `readBlurStyle` / `readArrowEndStyle`: applies the legacy
 *  yellow default for highlight rows drawn before the color field
 *  existed. Renderers should ALWAYS read through this helper rather
 *  than touching `data.color` directly, so legacy rows render
 *  identically before and after the schema bump. */
export function readHighlightColor(data: {
  color?: "auto" | string | undefined;
}): string {
  if (data.color === undefined || data.color === "auto") {
    return DEFAULT_HIGHLIGHT_COLOR_HEX;
  }
  return data.color;
}

export function readHighlightOpacity(data: { opacity?: number | undefined }): number {
  const raw = data.opacity ?? DEFAULT_HIGHLIGHT_OPACITY;
  if (!Number.isFinite(raw)) return DEFAULT_HIGHLIGHT_OPACITY;
  return Math.min(MAX_HIGHLIGHT_OPACITY, Math.max(0, raw));
}

export function readHighlightBlend(
  data: { blend?: HighlightBlendMode | undefined }
): HighlightBlendMode {
  return data.blend ?? DEFAULT_HIGHLIGHT_BLEND_MODE;
}

/** How the blur region renders: a soft Gaussian smear, a chunky
 *  mosaic / pixelation, or a solid opaque "redaction" box. All three
 *  ship in compose.ts; the renderer previews each with a distinct
 *  glyph so the user knows what they're getting before export. */
export const BlurStyle = z.enum(["gaussian", "pixelate", "redact"]);
export type BlurStyle = z.infer<typeof BlurStyle>;
/** Default applied for legacy rows (created before the style field
 *  existed) and as the initial style for new captures. Matches the
 *  pre-v2 behavior — single Gaussian blur for every blur overlay. */
export const DEFAULT_BLUR_STYLE: BlurStyle = "gaussian";

export const BlurOverlay = z.object({
  kind: z.literal("blur"),
  rect: NormalizedRect,
  /** Render style. Optional for backwards compat — legacy rows are
   *  parsed as `"gaussian"` via the default in `readBlurStyle` below. */
  style: BlurStyle.optional(),
  /** Explicit gaussian blur radius in pixels. Optional for back-compat
   *  and for the default Auto mode, where renderers derive the radius
   *  from the canvas short-side via `deriveBlurRadiusPx`. Pixelate and
   *  redact keep their existing rect-derived / solid-fill behavior. */
  radiusPx: z.number().positive().finite().max(200).optional(),
  /** Why the blur was applied — for the AI suggestion strip. */
  reason: z.string().max(80).optional(),
  /** Clockwise rotation in radians around the rect's geometric center.
   *  Honored by the live editor (CSS transform on the backdrop-filter
   *  div); the v1 bake currently composites blur unrotated — sharp's
   *  extract+blur pipeline doesn't support rotated clip regions
   *  directly, so v1 export ignores `rotation` on blur. Captured here
   *  so the field round-trips through copy/paste/undo and so a future
   *  bake pass can honor it without a schema migration. */
  rotation: z.number().finite().optional()
});

/** Read the style off a blur overlay, applying the default for legacy
 *  rows that pre-date the style field. Keeps every render / bake site
 *  from having to repeat the `?? "gaussian"` fallback. */
export function readBlurStyle(
  data: { style?: BlurStyle | undefined }
): BlurStyle {
  return data.style ?? DEFAULT_BLUR_STYLE;
}

export function readBlurRadiusPx(
  data: { radiusPx?: number | undefined },
  canvas: { width: number; height: number }
): number {
  const raw = data.radiusPx;
  if (raw === undefined || !Number.isFinite(raw)) return deriveBlurRadiusPx(canvas);
  return Math.max(1, Math.min(200, raw));
}

/** Canonical blur sigma derivation: **1.5% of the canvas short-side**
 *  with an 8px floor and the v2 `BlurEffect.radius_px` schema cap of
 *  200 applied at the top.
 *
 *  The single source of truth for three call sites that previously
 *  re-implemented the same formula:
 *
 *   - `overlayToLayer.ts deriveBlurRadiusPx` (renderer — fresh blur
 *      committed via the editor blur tool)
 *   - `v1-to-v2-doctor.ts deriveBlurRadiusPx` (main — v1→v2 migration
 *      of legacy blur overlays)
 *   - `BlurOverlays.tsx deriveBlurSigmaPx` (renderer — editor canvas
 *      preview for rotated gaussian blurs)
 *
 *  All three must use the same radius so the editor preview matches
 *  the bake's blur strength, and a re-bake produces the same output
 *  regardless of whether the row was created freshly in v2 or
 *  doctored up from v1. Drift between copies was the kind of
 *  silent-WYSIWYG bug PR #129 / #137 / #147 spent multiple review
 *  rounds untangling. */
export function deriveBlurRadiusPx(canvas: { width: number; height: number }): number {
  const shortSide = Math.min(canvas.width, canvas.height);
  return Math.max(1, Math.min(200, Math.max(8, Math.round(shortSide * 0.015))));
}

export const TextOverlay = z.object({
  kind: z.literal("text"),
  point: NormalizedPoint,
  body: z.string().max(2000),
  /** Four sizes — small / medium / large / x-large — derived from the
   *  capture's `annotationBasisPx` at render time (see
   *  `annotation-scale.ts`). The ratio between buckets is ~1.66× so
   *  they're visually distinct at a glance.
   *
   *  Both later buckets are back-compatible additions: legacy rows
   *  with size="small"|"large" parse unchanged. "medium" landed as the
   *  in-between value the original two-bucket v1 schema lacked (which
   *  had silently mapped the popover's "medium" onto "large");
   *  "x-large" continues the same ladder upward, so a big screenshot
   *  can carry text that still reads after the image is scaled down
   *  into a doc or a chat message. */
  size: z
    .union([
      z.literal("small"),
      z.literal("medium"),
      z.literal("large"),
      z.literal("x-large")
    ])
    .default("medium"),
  /** Glyph weight. Optional for back-compat — legacy rows (no weight
   *  field) render at the historical "bold" weight (600) the bake
   *  hardcoded, so existing captures look identical pre/post upgrade.
   *  New rows from the popover carry an explicit "regular" or "bold".
   *  The popover always offered this control, but pre-fix nothing
   *  honored it — every draft, every committed glyph, every export
   *  rendered at 600 regardless of pick. */
  weight: z.union([z.literal("regular"), z.literal("bold")]).optional(),
  color: z.union([z.literal("auto"), z.string().regex(/^#[0-9a-f]{6}$/i)]).default("auto"),
  /** Absolute text height in source/canvas pixels (the two share the
   *  same scale in v2 — crop is a viewport change, not a resampling).
   *  When present, renderers + bake use this directly and IGNORE the
   *  bucket math; `size` is then UI-intent metadata only ("user last
   *  picked Medium") used by the popover to highlight the right
   *  button. Lets the same row mean different absolute sizes for
   *  native vs cropped captures of the same dim — and lets the popover
   *  surface a "Custom" indicator when sizePx doesn't match any of the
   *  current canvas's bucket values (pwrdrvr/PwrSnap#110).
   *
   *  Optional for back-compat: legacy rows (no sizePx) keep
   *  rendering via the bucket + source-shortSide formula in
   *  `computeTextGlyphSize`. */
  sizePx: z.number().positive().finite().optional(),
  /** Clockwise rotation in radians around the anchor point. See
   *  RectOverlay.rotation. */
  rotation: z.number().finite().optional(),
  /** Contrast-border mode (see `OverlayOutlineMode`). Legacy text rows
   *  render the historical translucent rgba(0,0,0,0.6) glyph stroke
   *  via the `legacy` branch. `stripe` is not offered for text in the
   *  UI; renderers coerce it to a solid stroke. */
  outline: OverlayOutlineMode.optional(),
  /** Resolved color for `outline: "auto"` (see ArrowOverlay.outlineAuto). */
  outlineAuto: OverlayOutlineAutoColor.optional()
});

/** Map the optional `weight` field to a CSS font-weight number.
 *  Legacy rows (no weight) fall back to the historical 600 (semi-bold)
 *  the bake/render used to hardcode — keeps existing captures looking
 *  unchanged. New rows resolve "regular" → 400, "bold" → 700.
 *  Renderers (TextGlyph in OverlaySvg, textSvg in compose.ts, and
 *  TextDraftInput) all read through this helper so the weight is
 *  resolved in exactly one place. */
export function readTextWeight(data: {
  weight?: "regular" | "bold" | undefined;
}): number {
  if (data.weight === "regular") return 400;
  if (data.weight === "bold") return 700;
  return 600;
}

export const StepOverlay = z.object({
  kind: z.literal("step"),
  point: NormalizedPoint,
  /** Numbered-step counter; renderer auto-increments per capture in Phase 2. */
  index: z.number().int().min(1).max(99)
});

export const CropOverlay = z.object({
  kind: z.literal("crop"),
  rect: NormalizedRect
});

/** Internal: discriminated union over the canonical (post-migration)
 *  overlay shapes. Consumers use the `Overlay` export below, which
 *  wraps this in a preprocess shim that transparently rewrites legacy
 *  `kind: "rect"` rows into `kind: "shape", shape: "rect"` at parse
 *  time — keeps every on-disk row from before the Rect→Shape rename
 *  reading without a DB migration. */
const OverlayCanonical = z.discriminatedUnion("kind", [
  ArrowOverlay,
  ShapeOverlay,
  HighlightOverlay,
  BlurOverlay,
  TextOverlay,
  StepOverlay,
  CropOverlay
]);

/** Legacy → canonical input migrator. Any row with `kind: "rect"` is
 *  rewritten to `kind: "shape", shape: "rect"` before the discriminated
 *  union runs — the rest of the row carries forward verbatim (rect,
 *  color, thickness, filled, rotation all line up). Non-rect rows pass
 *  through unchanged. The shim is idempotent: a row already at
 *  `kind: "shape"` is returned as-is. */
function migrateLegacyOverlay(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (obj.kind === "rect") {
    return { ...obj, kind: "shape", shape: obj.shape ?? "rect" };
  }
  return value;
}

export const Overlay = z.preprocess(migrateLegacyOverlay, OverlayCanonical);

export type Overlay = z.infer<typeof Overlay>;
export type OverlayKind = Overlay["kind"];

/**
 * Render order — `compose.ts` applies overlays in this sequence so the
 * crop comes first (smaller pixels downstream), blur over the cropped
 * source, decorations on top, text last. Phase 2 lands the renderer.
 */
export const OVERLAY_RENDER_ORDER: OverlayKind[] = [
  "crop",
  "blur",
  "highlight",
  "shape",
  "arrow",
  "step",
  "text"
];

/**
 * Source of an overlay row in `overlays.source`.
 *
 *   • `user`   — drawn by the user in Edit mode (Phase 2+).
 *   • `codex`  — Phase 4 AI suggestion (initially `applied_at = null` —
 *                except sensitive-data blurs which are auto-applied
 *                synchronously).
 *   • `draft`  — partial overlay persisted on app close mid-drag so the
 *                user can resume on next open.
 */
export const OverlaySource = z.union([z.literal("user"), z.literal("codex"), z.literal("draft")]);
export type OverlaySource = z.infer<typeof OverlaySource>;

/**
 * Database-row shape of an overlay. The `data` JSON column is parsed
 * back through `Overlay` at every read — never trust the column blindly.
 */
export type OverlayRow = {
  id: string;
  capture_id: string;
  data: Overlay;
  schema_version: number;
  created_at: string;
  applied_at: string | null;
  rejected_at: string | null;
  superseded_by: string | null;
  ai_run_id: string | null;
  source: OverlaySource;
  z_index: number;
};
