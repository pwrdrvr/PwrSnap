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

/**
 * Multiplier × auto-stroke + optional short-side floor for each
 * thickness preset. Hoisted to module scope so the object isn't
 * re-allocated on every call to `readOverlayThickness` — called once
 * per arrow/rect render, and renders can be hot during drag.
 *
 * Tuning notes (read before changing these — they affect every
 * arrow / rect overlay rendered, present and future):
 *
 *   • `small` floor = 0.003 of short side. On 1080p that's 3.24 px;
 *     on 4K 6.48 px. Calibrated to keep small arrows from collapsing
 *     to sub-pixel hairlines on high-DPI captures while still being
 *     visibly thinner than Medium on every resolution.
 *
 *   • `medium` floor = 0 (intentional — see below). Medium IS the
 *     auto stroke; applying a floor would silently push it past
 *     "auto" on big images and surprise users who picked Medium
 *     because they wanted the default.
 *
 *   • `large` floor = 0.012 of short side. On 1080p that's 12.96 px,
 *     auto × 2 wins at any reasonable image size. On 4K the floor
 *     starts matching (auto × 2 = 28 px ≈ floor = 25.92 px). On 5K+
 *     the floor decisively wins — this is the Retina rescue point.
 *
 *   • `x-large` floor = 0.020 of short side. On 1080p 21.6 px (still
 *     a bump over Large's 13 px). On 4K 43.2 px, on 5K 57.6 px —
 *     the "chonker" preset, deliberately disproportionate at any
 *     resolution.
 *
 * If you change these, every existing arrow at that preset re-bakes
 * at next load. That's the trade-off for "preset behavior is
 * consistent across captures regardless of when they were drawn"
 * (the version-table mechanism handles HEAD GEOMETRY but not user-
 * picked presets — see arrow.ts's `ARROW_STYLE_VERSIONS` comment).
 */
const THICKNESS_PRESETS: Readonly<
  Record<"small" | "medium" | "large" | "x-large", { multiplier: number; floorFraction: number }>
> = {
  small: { multiplier: 0.5, floorFraction: 0.003 },
  medium: { multiplier: 1, floorFraction: 0 },
  large: { multiplier: 2, floorFraction: 0.012 },
  "x-large": { multiplier: 3, floorFraction: 0.02 }
};

/**
 * Resolve a thickness preset (or numeric override / "auto") to a
 * concrete stroke value.
 *
 * Two call shapes — the third argument toggles between them:
 *   • Legacy two-arg (no shortSidePx): multiplier-only. Returns
 *     output in WHATEVER UNIT the auto value was passed in. Numeric
 *     thickness passes through verbatim (treated as a [0,1] fraction
 *     of short side; caller multiplies up if they want pixels).
 *   • Three-arg (with shortSidePx, in the same units as autoFraction):
 *     applies the floor formula `max(autoStroke × multiplier,
 *     shortSidePx × floorFraction)`. Numeric thickness is treated as
 *     a normalized fraction and expanded to pixels via shortSidePx.
 *
 * The two shapes exist because not all callers want the floor (it
 * changes the output for existing rows when added). The three-arg
 * form is the recommended new-code shape — it produces the Retina-
 * proportional Large/XL strokes the floor is calibrated for.
 *
 * @param thickness    The persisted preset / numeric override / "auto".
 * @param autoFraction The geometry's auto-derived stroke value, in
 *                     the same unit space (fraction or pixels) the
 *                     caller wants the output in. `medium` and
 *                     `auto` pass this through verbatim.
 * @param shortSidePx  Optional. Image short-side in the SAME unit
 *                     space as autoFraction. Enables the floor;
 *                     enables pixel expansion for numeric thickness.
 *                     Omit only when matching legacy behavior is
 *                     required.
 */
export function readOverlayThickness(
  thickness: OverlayThickness | undefined,
  autoFraction: number,
  shortSidePx?: number
): number {
  if (thickness === undefined || thickness === "auto") return autoFraction;
  if (typeof thickness === "number") {
    // Numeric thickness is a normalized fraction of short-side. If
    // shortSidePx is provided we expand to absolute units; otherwise
    // fall through verbatim (legacy "fraction in, fraction out").
    //
    // Footgun guard: numeric thickness should be ≤ 1 (it's a
    // normalized fraction). A value > 1 strongly suggests a caller
    // accidentally passed a PIXEL stroke into the legacy two-arg
    // form and is going to multiply by shortSide somewhere downstream
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
    if (thickness > 1 && shortSidePx === undefined) {
      const con = (globalThis as { console?: { warn(msg: string): void } }).console;
      con?.warn(
        `[readOverlayThickness] numeric thickness=${thickness} (> 1) passed without shortSidePx — ` +
          `did you mean to pass shortSidePx? Numeric thickness is a normalized [0,1] fraction; ` +
          `pixel values must go through the three-arg form.`
      );
    }
    return shortSidePx !== undefined ? thickness * shortSidePx : thickness;
  }
  const p = THICKNESS_PRESETS[thickness];
  const fromMultiplier = autoFraction * p.multiplier;
  if (shortSidePx === undefined || p.floorFraction === 0) return fromMultiplier;
  return Math.max(fromMultiplier, shortSidePx * p.floorFraction);
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
  styleVersion: z.number().int().positive().optional()
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

export const RectOverlay = z.object({
  kind: z.literal("rect"),
  rect: NormalizedRect,
  color: z.union([z.literal("auto"), z.string().regex(/^#[0-9a-f]{6}$/i)]).default("auto"),
  /** Optional stroke-thickness override (see ArrowOverlay.thickness). */
  thickness: OverlayThickness.optional(),
  /** When true, the rect renders as a solid fill in the resolved color
   *  rather than the default stroke-only outline. Optional for back-
   *  compat: legacy rows render as outline-only. */
  filled: z.boolean().optional(),
  /** Clockwise rotation in radians around the rect's geometric center.
   *  Optional for back-compat: legacy rows render as if `rotation = 0`.
   *  Range: any finite number (callers normalize to (-π, π] when it
   *  matters; renderers just pass through). */
  rotation: z.number().finite().optional()
});

export function readRectFilled(data: { filled?: boolean | undefined }): boolean {
  return data.filled ?? false;
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
  return data.opacity ?? DEFAULT_HIGHLIGHT_OPACITY;
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

export const TextOverlay = z.object({
  kind: z.literal("text"),
  point: NormalizedPoint,
  body: z.string().max(2000),
  /** Three sizes — small / medium / large — derived from image short-side
   *  at render time. The ratio between buckets is intentionally ~1.7×
   *  so they're visually distinct (the original v1 schema only had
   *  small/large at a 2× ratio, which mapped popover "medium" to "large"
   *  silently; users couldn't tell their picks apart). "medium" is a
   *  back-compatible addition: legacy rows with size="small"|"large"
   *  parse unchanged, and the renderer keeps its historical sizes for
   *  those buckets — only "medium" lands as a new in-between value. */
  size: z
    .union([z.literal("small"), z.literal("medium"), z.literal("large")])
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
  rotation: z.number().finite().optional()
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

export const Overlay = z.discriminatedUnion("kind", [
  ArrowOverlay,
  RectOverlay,
  HighlightOverlay,
  BlurOverlay,
  TextOverlay,
  StepOverlay,
  CropOverlay
]);

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
  "rect",
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
