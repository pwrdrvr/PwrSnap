// Zod discriminated union for `Overlay`. Validate at every IPC boundary
// — Codex injects overlays in Phase 4 via DynamicToolCall responses,
// and we never trust LLM-routed structured output without a runtime
// validator. Phase 1 only writes auto-generated `crop` overlays for
// region capture; the editor tools (arrow / rect / text / etc.) land
// in Phase 2.
//
// Coordinate space: all overlays are normalized to [0, 1]^2 fractions
// of the source image's WxH. (0, 0) is top-left.

import { z } from "zod";

const NormalizedScalar = z.number().min(0).max(1);
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
  doubleEnded: z.boolean().optional()
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
  color: z.union([z.literal("auto"), z.string().regex(/^#[0-9a-f]{6}$/i)]).default("auto")
});

export const HighlightOverlay = z.object({
  kind: z.literal("highlight"),
  rect: NormalizedRect
});

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
  reason: z.string().max(80).optional()
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
  /** Two sizes — small / large — derived from image short-side at render time. */
  size: z.union([z.literal("small"), z.literal("large")]).default("small"),
  color: z.union([z.literal("auto"), z.string().regex(/^#[0-9a-f]{6}$/i)]).default("auto")
});

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
