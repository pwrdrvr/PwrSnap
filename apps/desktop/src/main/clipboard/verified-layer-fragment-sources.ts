import { createHash } from "node:crypto";
import {
  CLIPBOARD_FRAGMENT_MAX_BYTES,
  type BundleLayerNode,
  type ClipboardLayerFragmentV1
} from "@pwrsnap/shared";
import {
  canonicalizeSafeRasterToPng,
  SafeRasterError,
  type SafeRasterErrorCode
} from "../image/safe-raster-decode";

type SanitizedFragmentSourcesResult =
  | {
      ok: true;
      layers: BundleLayerNode[];
      sources: Map<string, Buffer>;
    }
  | {
      ok: false;
      code:
        | "source_decode_failed"
        | "source_hash_mismatch"
        | "source_output_too_large"
        | "source_raster_rejected"
        | "source_ref_missing";
      message: string;
      rasterCode?: SafeRasterErrorCode;
    };

type VerifiedFragmentSource = {
  canonicalSha: string;
  pngBytes: Buffer;
};

/**
 * Verify hostile private-clipboard sources and return only canonical PNGs.
 * Nothing is persisted here; callers stage the returned map only after the
 * complete fragment has passed validation.
 */
export async function sanitizeLayerFragmentSources(
  sourceRefs: ClipboardLayerFragmentV1["source_refs"],
  layers: readonly BundleLayerNode[]
): Promise<SanitizedFragmentSourcesResult> {
  const verified = new Map<string, VerifiedFragmentSource>();
  let canonicalOutputBytes = 0;

  for (const ref of sourceRefs) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(ref.png_base64, "base64");
    } catch {
      return {
        ok: false,
        code: "source_decode_failed",
        message: "clipboard source_ref base64 decode failed"
      };
    }
    if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) {
      return {
        ok: false,
        code: "source_hash_mismatch",
        message: "clipboard source hash mismatch (refusing to ingest)"
      };
    }

    try {
      const { pngBytes } = await canonicalizeSafeRasterToPng(bytes);
      canonicalOutputBytes += pngBytes.byteLength;
      if (canonicalOutputBytes > CLIPBOARD_FRAGMENT_MAX_BYTES) {
        return {
          ok: false,
          code: "source_output_too_large",
          message: "clipboard source images exceed the fragment output cap"
        };
      }
      const canonicalSha = createHash("sha256")
        .update(pngBytes)
        .digest("hex");
      verified.set(ref.sha256, { canonicalSha, pngBytes });
    } catch (cause) {
      return {
        ok: false,
        code: "source_raster_rejected",
        message: "clipboard source image is not safe to import",
        rasterCode:
          cause instanceof SafeRasterError ? cause.code : "decode_failed"
      };
    }
  }

  const rewritten: BundleLayerNode[] = [];
  for (const node of layers) {
    if (node.kind !== "raster") {
      rewritten.push(node);
      continue;
    }
    const source = verified.get(node.source_ref.sha256);
    if (source === undefined) {
      return {
        ok: false,
        code: "source_ref_missing",
        message: "clipboard raster source is missing"
      };
    }
    rewritten.push({
      ...node,
      source_ref: {
        ...node.source_ref,
        sha256: source.canonicalSha
      }
    });
  }

  const sources = new Map<string, Buffer>();
  for (const source of verified.values()) {
    sources.set(source.canonicalSha, source.pngBytes);
  }
  return { ok: true, layers: rewritten, sources };
}
