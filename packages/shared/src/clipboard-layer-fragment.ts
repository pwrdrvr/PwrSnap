// Clipboard layer-fragment wire format. Carries serialized v2 layer
// nodes + referenced source bytes across PwrSnap instances via a
// private macOS UTI (`com.pwrdrvr.pwrsnap.layer-fragment`). Pasting
// PwrSnap A → PwrSnap B preserves layer transforms / effects / masks
// exactly; pasting into non-PwrSnap consumers (Slack, Messages) falls
// back to the standard PNG bytes co-written alongside the UTI buffer.
//
// Five layers of defense the receiving paste handler enforces — see
// docs/plans/2026-05-07-002-feat-bundle-format-v2-layer-tree-plan.md
// §"Clipboard — private UTI with defense-in-depth":
//
//   1. CLIPBOARD_FRAGMENT_MAX_BYTES — hard size cap before JSON.parse
//   2. layers max count — DoS guard on tree-build cost
//   3. zod schema validation
//   4. sha256(pngBytes) verification — closes the trojan vector where
//      an attacker claims a known-good sha but ships different bytes
//   5. sharp decode-probe — the bytes must actually decode as PNG and
//      have sane dimensions
//
// Defense (1) lives at the IPC handler boundary; (2)+(3) here in the
// zod schema; (4)+(5) at the paste handler before any layer is
// inserted.

import { z } from "zod";

import { BundleLayerNode, MAX_IMAGE_DIM_PX } from "./bundle-manifest-schema-v2";

/**
 * 64 MiB hard cap on the deserialized fragment buffer. A larger
 * payload either represents an attacker probing OOM or a user trying
 * to copy something pathological — either way, refuse.
 *
 * Calibrated against the largest credible single-PNG payload: a 4K
 * (3840×2160) RGBA PNG at maximum compression is ~30-40 MiB. 64 MiB
 * gives headroom for two such layers plus the JSON envelope.
 */
export const CLIPBOARD_FRAGMENT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Phase 5 multi-image paste/drop: per-image size cap for
 * `editor:pasteImageAsLayer` / `editor:dropImageAsLayer`. 32 MiB sits
 * comfortably above a 4K screenshot (~25 MiB worst-case RGBA PNG) and
 * below the worker-thread heap budget — anything larger is almost
 * certainly an attacker probing OOM or a user dragging in something
 * pathological (multi-page TIFF, raw camera dump).
 */
export const PASTE_IMAGE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Hard upper bound on layer count per paste. Mirrors the bundle
 * document's 4096 cap (BundleDocumentV2.layers). A malicious payload
 * with 100k+ adversarial parent_id chains would otherwise stall the
 * tree-builder before the depth bound trips.
 */
export const CLIPBOARD_FRAGMENT_MAX_LAYERS = 4_096;

/** Hard upper bound on source_refs count. */
export const CLIPBOARD_FRAGMENT_MAX_SOURCES = 256;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const Base64Png = z
  .string()
  .min(1)
  .max(80 * 1024 * 1024)
  .refine((s) => /^[A-Za-z0-9+/=]*$/.test(s), "must be standard base64");

export const ClipboardSourceRef = z.object({
  sha256: Sha256Hex,
  /** Base64-encoded PNG bytes. Receiver verifies sha256(decoded) === sha256
   *  AND that sharp can decode the bytes as PNG before accepting the
   *  payload. */
  png_base64: Base64Png
});
export type ClipboardSourceRef = z.infer<typeof ClipboardSourceRef>;

/** The source capture's canvas frame (px) at copy time — the [0,1]²
 *  frame the copied layer coords were normalized against. */
export const ClipboardSourceFrame = z.object({
  width_px: z.number().int().positive().lte(MAX_IMAGE_DIM_PX),
  height_px: z.number().int().positive().lte(MAX_IMAGE_DIM_PX)
});
export type ClipboardSourceFrame = z.infer<typeof ClipboardSourceFrame>;

export const ClipboardLayerFragmentV1 = z.object({
  format_version: z.literal(1),
  /** Originating capture id — informational only; not used by the
   *  receiver to look up the capture (cross-instance paste can't
   *  guarantee the recipient has the row). Logged for audit + debug. */
  source_capture_id: z.string().min(8).max(32),
  /** Selected layers in z-order. parent_id pointers within the
   *  selection are preserved; layers pointing OUTSIDE the selection
   *  are reparented to null at paste time (orphan-pointer cleanup). */
  layers: z.array(BundleLayerNode).max(CLIPBOARD_FRAGMENT_MAX_LAYERS),
  /** Sources referenced by any raster layer in `layers`. Receiver
   *  inserts these into the target capture's bundle if not already
   *  present (content-addressable dedup). */
  source_refs: z.array(ClipboardSourceRef).max(CLIPBOARD_FRAGMENT_MAX_SOURCES),
  /** ISO-8601 timestamp of when the copy occurred. */
  copied_at: z.iso.datetime(),
  /** Source capture's canvas frame (px) the copied layer coords were
   *  normalized against. Present ONLY when the copy baked the base
   *  source raster's visible region (so the block is overhang-free and
   *  can be scale-to-fit into a differently-sized paste target — see
   *  `placeLayerIntoTarget`). Absent for annotation-only copies, where
   *  paste keeps the verbatim relative positions. OPTIONAL for
   *  back-compat with fragments produced before placement-aware paste
   *  shipped. */
  source_frame: ClipboardSourceFrame.optional()
});
export type ClipboardLayerFragmentV1 = z.infer<typeof ClipboardLayerFragmentV1>;

/**
 * macOS UTI for the private clipboard type. Registered in
 * electron-builder.yml's extendInfo.UTExportedTypeDeclarations.
 * Format-neutral on the wire (utf-8 JSON over a buffer); the version
 * field on the payload discriminates schema bumps.
 */
export const CLIPBOARD_LAYER_FRAGMENT_UTI = "com.pwrdrvr.pwrsnap.layer-fragment";
