// Composite-thumbnail sharp pipeline — the ONLY libvips work behind the
// bundle's `composite_thumbnail.jpg`. Kept deliberately dependency-thin:
// it imports `sharp` and nothing else (no `electron`, no `./db`, no
// bundle-store). That isolation is load-bearing — this module is
// imported by `workers/composite-thumbnail-worker.ts`, which runs on a
// `worker_thread` where Electron main-process APIs are unavailable.
// Pulling in anything that transitively reaches `electron` would break
// the worker at module-eval time.
//
// `bundle-store.buildCompositeThumbnail` is the public entry point most
// callers use; it dispatches to the worker (off the Chromium main
// thread) when the worker bundle is present and falls back to
// `buildCompositeThumbnailInProcess` here otherwise.

import sharp from "sharp";

/**
 * Maximum long-edge dimension for the bundle's `composite_thumbnail.jpg`.
 * Sized to look sharp at macOS Finder's largest icon view (512×512
 * Retina = 1024-physical) and Quick Look's preview pane. Going larger
 * trades bundle size for marginal sharpness; smaller would show
 * blocking when Finder upscales for Cover Flow / column previews.
 */
export const COMPOSITE_THUMBNAIL_MAX_DIM_PX = 1024;

// JPEG quality 90 (was 80 pre always-write). Why bumped: with the
// size-skip optimization removed, even very small sources now go
// through JPEG encoding at their natural dimensions (no resize
// smoothing first). q80 introduces visible ringing around sharp
// edges — text, icons, UI chrome — which are EXACTLY what
// screenshots contain. q90 keeps file size in the same ballpark
// (≈10% increase for natural photos, less for already-clean PNG
// content) while eliminating most visible artifacts. The thumbnail
// is sized for Finder icons + Quick Look first-pass renders;
// readers downstream of those still bake the full-res composite
// from sources/* via sharp when they need pixel fidelity.
const COMPOSITE_THUMBNAIL_JPEG_QUALITY = 90;

/**
 * Generate a JPEG thumbnail of the composite in-process. Always returns
 * a Buffer — never null.
 *
 * This is the raw sharp pipeline. Prefer `bundle-store`'s
 * `buildCompositeThumbnail` wrapper, which moves this decode/encode onto
 * a worker thread when one is available so it never competes with the
 * Chromium main thread (e.g. during the boot-time v1→v2 sweep).
 *
 * `withoutEnlargement: true` is the safety belt — sharp would otherwise
 * upscale on `width:` for a request larger than the source. For sources
 * already smaller than the cap, the output is sized at the source's
 * natural dimensions (no upscale), just JPEG-encoded.
 *
 * sharp infers source dimensions from the buffer's PNG header, so no
 * caller-side dim hint is needed.
 */
export async function buildCompositeThumbnailInProcess(
  compositePng: Buffer
): Promise<Buffer> {
  // Resize the long edge to COMPOSITE_THUMBNAIL_MAX_DIM_PX; the short
  // edge is computed by sharp from the source aspect ratio. `fit:
  // "inside"` preserves aspect ratio without cropping.
  // `withoutEnlargement: true` is critical here: for sources already
  // ≤ the target, sharp leaves the dimensions alone and only re-
  // encodes to JPEG. No upscaling, no quality loss from interpolation.
  return await sharp(compositePng)
    .resize({
      width: COMPOSITE_THUMBNAIL_MAX_DIM_PX,
      height: COMPOSITE_THUMBNAIL_MAX_DIM_PX,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({ quality: COMPOSITE_THUMBNAIL_JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}
