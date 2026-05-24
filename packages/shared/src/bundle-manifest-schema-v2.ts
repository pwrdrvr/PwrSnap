// Zod schemas for v2 bundle manifest + document. ~/Documents/PwrSnap/
// is untrusted input; v2 expands the bundle layout to
// `sources/<sha>.png` and `layers/<nanoid>.png` directories, both of
// which are new attack surfaces this module forecloses. Every numeric
// field uses `.finite()` (no NaN / ±Inf — those crash sharp downstream);
// every dimension is capped at 32768 to prevent allocation-DoS;
// every string field has a length cap.
//
// All validation runs on every read AND every write at the bundle
// boundary. The discipline mirrors `bundle-manifest-schema.ts` (v1).

import { z } from "zod";

import { Overlay } from "./overlay-schemas";

/**
 * Minimal POSIX-style normalization check. Returns true only when
 * `s` is already in its normalized form. Used as a belt-and-suspenders
 * check alongside the strict regex allowlist: even if a future
 * maintainer broadens the regex, this catches `./foo`, `foo/./bar`,
 * `foo//bar`, trailing slashes, and trailing-dot segments.
 *
 * Stays self-contained because @pwrsnap/shared deliberately excludes
 * Node `types` from its tsconfig — the package runs in the renderer
 * too, so it can't depend on `node:path`.
 */
function isNormalizedPosix(s: string): boolean {
  if (s.length === 0) return false;
  if (s.startsWith("./")) return false;
  if (s.endsWith("/")) return false;
  if (s.endsWith("/.")) return false;
  if (s.includes("//")) return false;
  if (s.includes("/./")) return false;
  return true;
}

// --------------------------------------------------------------------
// Primitive guards
// --------------------------------------------------------------------

const FiniteNumber = z.number().refine((n) => Number.isFinite(n), {
  message: "expected a finite number (no NaN, no Infinity)"
});

const FiniteInt = z.number().int().refine((n) => Number.isFinite(n), {
  message: "expected a finite integer"
});

// Max usable image dimension; PNG spec allows up to 2^31-1 but no sane
// editor needs more than ~32K on a side, and capping here prevents
// canvas-dim-driven OOM (a 999_999_999² allocation = ~3.7 TB).
export const MAX_IMAGE_DIM_PX = 32_768;

// Layer IDs and source identifiers — content-addressable vs nanoid.
// Lowercase hex only; case sensitivity matters for ZIP filename matches
// on case-insensitive macOS APFS volumes.
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const NanoId16 = z.string().regex(/^[A-Za-z0-9_-]{16}$/);

// Bare filename — no separators, no leading dot, no null bytes.
// Identical to v1's PairedFilename gate; carried forward.
const PairedFilename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (s) => !s.includes("/") && !s.includes("\\") && !s.includes("\0") && !s.startsWith("."),
    "paired_png_filename must be a bare filename (no separators, no leading dot, no null bytes)"
  );

// --------------------------------------------------------------------
// Transform + geometry
// --------------------------------------------------------------------

export const AffineTransform = z.tuple([
  FiniteNumber, FiniteNumber,
  FiniteNumber, FiniteNumber,
  FiniteNumber, FiniteNumber
]);
export type AffineTransform = z.infer<typeof AffineTransform>;

export const CanvasRect = z.object({
  x: FiniteNumber,
  y: FiniteNumber,
  w: FiniteNumber.nonnegative(),
  h: FiniteNumber.nonnegative()
});
export type CanvasRect = z.infer<typeof CanvasRect>;

// --------------------------------------------------------------------
// Manifest
// --------------------------------------------------------------------

export const BundleManifestV2 = z.object({
  bundle_format_version: z.literal(2),
  capture_id: z.string().min(8).max(32),
  canvas_dimensions: z.object({
    width_px: z.number().int().positive().lte(MAX_IMAGE_DIM_PX),
    height_px: z.number().int().positive().lte(MAX_IMAGE_DIM_PX)
  }),
  paired_png_filename: PairedFilename,
  created_at: z.iso.datetime(),
  bundle_modified_at: z.iso.datetime()
});
export type BundleManifestV2 = z.infer<typeof BundleManifestV2>;

// --------------------------------------------------------------------
// Layer common props (extends every variant in the discriminated union)
// --------------------------------------------------------------------

// `blend_mode` is locked to `"normal"` in v2.0. Non-breaking enum
// extension when an editor blend-mode picker ships in v2.x.
const BlendMode = z.literal("normal");

const CommonLayerProps = {
  id: NanoId16,
  parent_id: z.string().max(64).nullable(),
  name: z.string().max(256),
  visible: z.boolean(),
  locked: z.boolean(),
  opacity: FiniteNumber.min(0).max(1),
  blend_mode: BlendMode,
  transform: AffineTransform,
  z_index: FiniteInt,
  source: z.enum(["user", "codex", "draft"]),
  ai_run_id: z.string().max(64).nullable(),
  applied_at: z.iso.datetime().nullable(),
  rejected_at: z.iso.datetime().nullable(),
  superseded_by: z.string().max(64).nullable(),
  created_at: z.iso.datetime()
};

// --------------------------------------------------------------------
// Layer kinds (3 variants in v2.0; MaskLayer + AdjustmentEffect deferred)
// --------------------------------------------------------------------

export const RasterSourceRef = z.object({
  kind: z.literal("embedded"),
  sha256: Sha256Hex
});
export type RasterSourceRef = z.infer<typeof RasterSourceRef>;

export const GroupLayer = z.object({
  ...CommonLayerProps,
  kind: z.literal("group"),
  collapsed: z.boolean()
});
export type GroupLayer = z.infer<typeof GroupLayer>;

export const RasterLayer = z.object({
  ...CommonLayerProps,
  kind: z.literal("raster"),
  source_ref: RasterSourceRef,
  natural_width_px: z.number().int().positive().lte(MAX_IMAGE_DIM_PX),
  natural_height_px: z.number().int().positive().lte(MAX_IMAGE_DIM_PX)
});
export type RasterLayer = z.infer<typeof RasterLayer>;

export const VectorLayer = z.object({
  ...CommonLayerProps,
  kind: z.literal("vector"),
  // `shape` is the existing v1 Overlay discriminated union — arrow /
  // rect / text / step / crop / highlight / blur slide in unchanged in
  // semantics. Coords switch from normalized [0,1]² to canvas pixels
  // at the migration boundary.
  shape: Overlay
});
export type VectorLayer = z.infer<typeof VectorLayer>;

export const BlurEffect = z.object({
  type: z.literal("blur"),
  // Radius capped at 200 — a 200-px blur on a 32k canvas is
  // already ludicrous; anything larger is almost certainly an
  // attacker probing sharp.
  radius_px: FiniteNumber.positive().lte(200)
});
export type BlurEffect = z.infer<typeof BlurEffect>;

export const HighlightEffect = z.object({
  type: z.literal("highlight"),
  tint_hex: z.string().regex(/^#[0-9a-f]{6}$/i),
  opacity: FiniteNumber.min(0).max(1)
});
export type HighlightEffect = z.infer<typeof HighlightEffect>;

// v2.0 ships blur + highlight only. AdjustmentEffect deferred — it had
// `params: z.record(z.unknown())` in the first-cut plan, which is a
// validation hole (anything goes). When the first real adjustment lands,
// add a discriminated variant with a proper schema.
const EffectSpec = z.discriminatedUnion("type", [BlurEffect, HighlightEffect]);
export type EffectSpec = z.infer<typeof EffectSpec>;

export const EffectLayer = z.object({
  ...CommonLayerProps,
  kind: z.literal("effect"),
  effect: EffectSpec,
  clip_rect: CanvasRect.nullable()
});
export type EffectLayer = z.infer<typeof EffectLayer>;

// MaskLayer deferred. mask_id slots on RasterLayer / EffectLayer can
// return when the editor mask tool ships; v2.0 has no UX consumer.

export const BundleLayerNode = z.discriminatedUnion("kind", [
  GroupLayer, RasterLayer, VectorLayer, EffectLayer
]);
export type BundleLayerNode = z.infer<typeof BundleLayerNode>;
export type BundleLayerKind = BundleLayerNode["kind"];

// --------------------------------------------------------------------
// Document — replaces v1's flat overlays array
// --------------------------------------------------------------------

// Forward-compat AI-run carrier. Tightened when Phase 4+ AI pipeline
// ships its real shape.
export const BundleAIRunRecordV2 = z.object({
  id: z.string().min(1).max(64),
  kind: z.string().min(1).max(64),
  created_at: z.iso.datetime()
});
export type BundleAIRunRecordV2 = z.infer<typeof BundleAIRunRecordV2>;

export const BundleDocumentV2 = z.object({
  document_format_version: z.literal(1),
  // Mirrors `captures.edits_version` (renamed from v1's
  // `overlays_version` in migration 0004). Convergence checkpoint
  // between DB and bundle.
  edits_version: z.number().int().nonnegative(),
  layers: z.array(BundleLayerNode).max(4_096),
  tags: z.array(z.string().min(1).max(64)).max(256),
  description: z.string().max(4_096).nullable(),
  ai_runs: z.array(BundleAIRunRecordV2).max(1_024)
});
export type BundleDocumentV2 = z.infer<typeof BundleDocumentV2>;

// --------------------------------------------------------------------
// V2 ZIP entry allowlist — per-version prefix validator
// --------------------------------------------------------------------

// Recognized v2 bundle entries. `composite_thumbnail.jpg` replaced
// the legacy `composite.png` in the PR #90 era — the packer in
// bundle-store.ts (writeV2Bundle / repackV2Bundle) writes the smaller
// JPEG thumbnail and intentionally does NOT write the full-resolution
// composite.png anymore ("readers reconstruct the full-res; the
// macOS Thumbnail Extension reads composite_thumbnail.jpg").
//
// The thumbnail is OPTIONAL — small images skip it entirely — so it
// lives in the allowlist (treated as valid when present) but is
// absent from the missing-check below.
//
// We keep `composite.png` in the allowlist for back-compat with
// historic bundles that still have it sitting around; the legacy-
// bundle migration's Pass C rewrites those bundles to drop it, but
// until the user opens or repacks each one, the entry persists.
const V2_FIXED_ENTRIES = new Set([
  "manifest.json",
  "document.json",
  "composite.png",
  "composite_thumbnail.jpg"
]);
const V2_PATTERNS: readonly RegExp[] = [
  /^sources\/[0-9a-f]{64}\.png$/,
  /^layers\/[A-Za-z0-9_-]{16}\.png$/
];

// Sanitized error message — entry names are attacker-controlled and
// could carry log-injection / terminal-escape sequences. We surface
// counts to the renderer; main-process logs receive sanitized previews.
export type BundleEntryValidationV2 =
  | { ok: true }
  | {
      ok: false;
      badEntries: readonly string[];
      missingEntries: readonly string[];
      duplicateEntries: readonly string[];
    };

export function validateBundleZipEntryNamesV2(names: readonly string[]): BundleEntryValidationV2 {
  const bad: string[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const name of names) {
    // Zip-Slip pre-checks identical to v1.
    if (
      name.length === 0 ||
      name.includes("..") ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes("\0")
    ) {
      bad.push(name);
      continue;
    }
    // Normalized basename check — defeats `./foo.png`, `/./bar/`,
    // trailing dots, etc. (M2 defense). Belt-and-suspenders alongside
    // the strict regex below.
    if (!isNormalizedPosix(name)) {
      bad.push(name);
      continue;
    }
    if (V2_FIXED_ENTRIES.has(name) || V2_PATTERNS.some((re) => re.test(name))) {
      if (seen.has(name)) {
        duplicates.push(name);
      } else {
        seen.add(name);
      }
    } else {
      bad.push(name);
    }
  }

  // Required entries: just the two JSON descriptors. The composite
  // (full-res `composite.png` OR thumbnail `composite_thumbnail.jpg`)
  // used to live here; the packer dropped composite.png in PR #90 and
  // thumbnail is intentionally optional ("omitted for small images"),
  // so neither is required for validation. Readers fall back to
  // reconstructing the composite from sources/* + document.json
  // layers when neither thumbnail nor composite is present.
  const missing = ["manifest.json", "document.json"].filter(
    (n) => !seen.has(n)
  );

  if (bad.length === 0 && duplicates.length === 0 && missing.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    badEntries: bad,
    missingEntries: missing,
    duplicateEntries: duplicates
  };
}
