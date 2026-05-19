// Zod schemas for `manifest.json` and `overlays.json` — the two JSON
// entries inside every `.pwrsnap` ZIP bundle. Validate at every read AND
// every write. ~/Documents/PwrSnap/ is untrusted input (anything from
// AirDrop, Mail, browser download, or a compromised peer's iCloud can
// land there), so doctor reconcile and `bundle-store` BOTH parse through
// these before touching the DB or extracting other entries.
//
// Manifest is split from overlays so the doctor's cold-scan path
// (`yauzl` `lazyEntries` + manifest decompress only) doesn't pay for
// every capture's overlay data when reconciling — it only pulls
// overlays.json when the row needs rebuilding.

import { z } from "zod";

import { Overlay, OverlaySource } from "./overlay-schemas";

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

// Bare filename — no directory separators, no traversal, no nulls.
// Used by the doctor to find the paired flat PNG sibling.
const PairedFilename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (s) => !s.includes("/") && !s.includes("\\") && !s.includes("\0") && !s.startsWith("."),
    "paired_png_filename must be a bare filename (no separators, no leading dot, no null bytes)"
  );

export const BundleManifestV1 = z.object({
  bundle_format_version: z.literal(1),
  capture_id: z.string().min(8).max(32),
  source_sha256: Sha256Hex,
  source_dimensions: z.object({
    width_px: z.number().int().positive(),
    height_px: z.number().int().positive()
  }),
  /**
   * Legacy field: the basename of a paired flat PNG sibling that used
   * to be written next to the bundle for Finder visibility. As of the
   * bundle-is-system-of-record refactor, fresh bundles no longer write
   * this sibling, but the manifest field stays (always set to a sane
   * default like `${capture_id}.png`) so legacy bundles already on disk
   * keep validating and a future Thumbnail Extension can use the value
   * if it wants. Readers MUST NOT assume the file actually exists.
   */
  paired_png_filename: PairedFilename,
  created_at: z.iso.datetime(),
  bundle_modified_at: z.iso.datetime()
});

export type BundleManifestV1 = z.infer<typeof BundleManifestV1>;

// Overlay record as stored inside `overlays.json` — same shape as the
// `overlays` table row minus `capture_id` (implied by the bundle).
export const BundleOverlayRecord = z.object({
  id: z.string().min(1).max(64),
  data: Overlay,
  schema_version: z.number().int().nonnegative(),
  source: OverlaySource,
  z_index: z.number().int(),
  created_at: z.iso.datetime(),
  applied_at: z.iso.datetime().nullable(),
  rejected_at: z.iso.datetime().nullable(),
  superseded_by: z.string().nullable(),
  ai_run_id: z.string().nullable()
});

export type BundleOverlayRecord = z.infer<typeof BundleOverlayRecord>;

// Phase 4 forward-compat carrier. We don't need the inside-shape locked
// yet, but the bundle format must reserve a slot for AI-run records so
// future versions don't have to re-organize. Keep the schema permissive
// for now; tighten when Phase 4 lands.
export const BundleAIRunRecord = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  created_at: z.iso.datetime()
});

export type BundleAIRunRecord = z.infer<typeof BundleAIRunRecord>;

export const BundleOverlaysV1 = z.object({
  overlays_format_version: z.literal(1),
  // Mirrors `captures.bundle_overlays_version` — the convergence
  // checkpoint between DB and bundle. Doctor compares against
  // `captures.overlays_version` to detect a crash mid-debounce.
  overlays_version: z.number().int().nonnegative(),
  overlays: z.array(BundleOverlayRecord),
  tags: z.array(z.string().min(1).max(64)),
  description: z.string().nullable(),
  ai_runs: z.array(BundleAIRunRecord)
});

export type BundleOverlaysV1 = z.infer<typeof BundleOverlaysV1>;

// ZIP central-directory entries. yauzl does NOT auto-validate
// filenames — Zip-Slip defense is the consumer's job. Anything outside
// the ALLOWED set causes the bundle to be quarantined, not extracted.
//
// `BUNDLE_ENTRY_REQUIRED` is the subset that MUST be present in every
// bundle. Two entries are allowed but not required:
//
//   • `composite.png` — legacy. Pre-refactor bundles wrote a full-res
//     composite PNG inside the bundle (in addition to a paired flat
//     PNG sibling outside). Both have been removed for new bundles:
//     readers reconstruct the composite from source + overlays via
//     compose(), and the Thumbnail Extension uses composite_thumbnail
//     for Finder previews. Kept in the allowlist so legacy bundles
//     already on disk validate; new bundles don't write it.
//
//   • `composite_thumbnail.jpg` — low-resolution (max 1024px long
//     edge), JPEG quality 80, baked at pack time. The macOS Thumbnail
//     Extension reads this directly without re-running compose. Not
//     required because (a) tiny captures (already ≤ 1024px) skip it
//     since the source IS thumbnail-sized, and (b) legacy bundles
//     don't have it.
//
// Anything outside the allowlist is a Zip-Slip / shape-bomb attempt
// and the bundle is quarantined.
export const BUNDLE_ENTRY_ALLOWLIST = [
  "manifest.json",
  "overlays.json",
  "source.png",
  "composite.png",
  "composite_thumbnail.jpg"
] as const;

export const BUNDLE_ENTRY_REQUIRED = [
  "manifest.json",
  "overlays.json",
  "source.png"
] as const;

export type BundleEntryName = (typeof BUNDLE_ENTRY_ALLOWLIST)[number];

export function isBundleEntryName(name: string): name is BundleEntryName {
  return (BUNDLE_ENTRY_ALLOWLIST as readonly string[]).includes(name);
}
