// Canonical hash for the render-bake cache key. Plan §"Decision 1"
// requires a stable, schema-version-aware hash so the disk cache can
// be invalidated cleanly when the overlay set changes — and so that
// reordering inserts, key-order changes in the JSON blob, or
// irrelevant whitespace don't produce a fresh hash for an
// equivalent overlay set.
//
// What goes into the hash:
//   • format ("png" | "webp")
//   • target_width
//   • encoder_version (bumps when lossless output semantics change)
//   • applied overlays (rejected_at IS NULL, applied_at IS NOT NULL,
//     superseded_by IS NULL), sorted by (z_index ASC, id ASC), each
//     overlay's `data` blob canonicalized.
//
// What does NOT go into the hash:
//   • `created_at`, `id`, `source` — all metadata; the visual result
//     is identical regardless.
//   • Pending suggestions (applied_at IS NULL) — they don't affect
//     the bake. Once applied, they bump overlays_version + change
//     the hash.
//
// This file is main-only because Node's `crypto` is the simplest
// SHA-256. The pure data-canonicalization (the input to sha256) is
// the load-bearing bit; the hash function itself is interchangeable.

import { createHash } from "node:crypto";
import stringify from "safe-stable-stringify";
import type { OverlayRow } from "@pwrsnap/shared";

const RENDER_ENCODER_VERSION = 2;

export type RenderHashInput = {
  /** Output format. */
  format: "png" | "webp";
  /** Target width in pixels. */
  width: number;
  /** Applied overlays for the capture. Order doesn't matter — we
   *  sort canonically inside this function. Pass already-filtered
   *  to applied (applied_at IS NOT NULL, etc.) so the caller's
   *  intent is explicit. */
  appliedOverlays: ReadonlyArray<Pick<OverlayRow, "id" | "data" | "z_index">>;
};

/**
 * Compute the render-inputs hash. Returns 64 hex chars (SHA-256).
 *
 * Property guarantee (verified by unit test): re-ordering the
 * `appliedOverlays` array, shuffling key order in any overlay's
 * `data` blob, and adding/removing irrelevant whitespace MUST NOT
 * change the output.
 */
export function computeRenderHash(input: RenderHashInput): string {
  const sortedOverlays = [...input.appliedOverlays].sort((a, b) => {
    if (a.z_index !== b.z_index) return a.z_index - b.z_index;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  // Project each overlay to JUST the visually-significant fields.
  // The `data` blob is canonicalized via safe-stable-stringify which
  // sorts keys deterministically.
  const projected = sortedOverlays.map((o) => ({
    z: o.z_index,
    d: o.data
  }));
  const canonical = stringify({
    encoderVersion: RENDER_ENCODER_VERSION,
    format: input.format,
    width: input.width,
    overlays: projected
  });
  if (canonical === undefined) {
    // safe-stable-stringify returns undefined for cyclic input; our
    // overlays can't be cyclic (Zod-validated POJOs), so this is a
    // defensive guard, not an expected path.
    throw new Error("computeRenderHash: stringify returned undefined");
  }
  return createHash("sha256").update(canonical).digest("hex");
}
