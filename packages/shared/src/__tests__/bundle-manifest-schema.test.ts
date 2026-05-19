// Roundtrip + boundary tests for the bundle manifest + overlays zod
// schemas. ~/Documents/PwrSnap/ is untrusted input; these schemas are
// the trust boundary and must reject any shape that could mis-resolve a
// path, escape a directory, or fool the doctor reconcile pass into
// extracting attacker bytes.

import { describe, expect, test } from "vitest";

import {
  BUNDLE_ENTRY_ALLOWLIST,
  BundleManifestV1,
  BundleOverlayRecord,
  BundleOverlaysV1,
  isBundleEntryName
} from "../bundle-manifest-schema";

const validManifest = {
  bundle_format_version: 1 as const,
  capture_id: "abc123def456",
  source_sha256: "0".repeat(64),
  source_dimensions: { width_px: 1920, height_px: 1080 },
  paired_png_filename: "PwrSnap 2026-05-07 at 14.30.22.png",
  created_at: "2026-05-07T14:30:22.000Z",
  bundle_modified_at: "2026-05-07T14:30:22.000Z"
};

describe("BundleManifestV1", () => {
  test("accepts a well-formed manifest", () => {
    const parsed = BundleManifestV1.parse(validManifest);
    expect(parsed.capture_id).toBe("abc123def456");
    expect(parsed.bundle_format_version).toBe(1);
  });

  test("rejects a future bundle_format_version", () => {
    expect(() => BundleManifestV1.parse({ ...validManifest, bundle_format_version: 2 })).toThrow();
  });

  test("rejects a non-hex sha256", () => {
    expect(() => BundleManifestV1.parse({ ...validManifest, source_sha256: "not-hex" })).toThrow();
    expect(() =>
      BundleManifestV1.parse({ ...validManifest, source_sha256: "0".repeat(63) })
    ).toThrow();
    expect(() =>
      BundleManifestV1.parse({ ...validManifest, source_sha256: "G".repeat(64) })
    ).toThrow();
  });

  test("rejects zero or negative source dimensions", () => {
    expect(() =>
      BundleManifestV1.parse({
        ...validManifest,
        source_dimensions: { width_px: 0, height_px: 1080 }
      })
    ).toThrow();
    expect(() =>
      BundleManifestV1.parse({
        ...validManifest,
        source_dimensions: { width_px: 1920, height_px: -1 }
      })
    ).toThrow();
  });

  describe("paired_png_filename — the trust boundary for pair lookup", () => {
    test("rejects a path containing a forward slash", () => {
      expect(() =>
        BundleManifestV1.parse({ ...validManifest, paired_png_filename: "../etc/passwd" })
      ).toThrow();
      expect(() =>
        BundleManifestV1.parse({ ...validManifest, paired_png_filename: "subdir/file.png" })
      ).toThrow();
    });

    test("rejects a path containing a backslash (Windows traversal)", () => {
      expect(() =>
        BundleManifestV1.parse({ ...validManifest, paired_png_filename: "..\\foo.png" })
      ).toThrow();
    });

    test("rejects a leading dot (hidden / dotfile bait)", () => {
      expect(() =>
        BundleManifestV1.parse({ ...validManifest, paired_png_filename: ".hidden.png" })
      ).toThrow();
    });

    test("rejects a null-byte injection", () => {
      expect(() =>
        BundleManifestV1.parse({ ...validManifest, paired_png_filename: "ok.png\0.bad" })
      ).toThrow();
    });

    test("rejects empty string", () => {
      expect(() =>
        BundleManifestV1.parse({ ...validManifest, paired_png_filename: "" })
      ).toThrow();
    });

    test("accepts ordinary spaces and dots", () => {
      const parsed = BundleManifestV1.parse({
        ...validManifest,
        paired_png_filename: "PwrSnap 2026-05-07 at 14.30.22.png"
      });
      expect(parsed.paired_png_filename).toBe("PwrSnap 2026-05-07 at 14.30.22.png");
    });
  });

  test("rejects non-ISO datetime strings", () => {
    expect(() => BundleManifestV1.parse({ ...validManifest, created_at: "yesterday" })).toThrow();
    expect(() =>
      BundleManifestV1.parse({ ...validManifest, bundle_modified_at: "2026-05-07" })
    ).toThrow();
  });

  test("rejects capture_id outside the 8..32 char window", () => {
    expect(() => BundleManifestV1.parse({ ...validManifest, capture_id: "short" })).toThrow();
    expect(() =>
      BundleManifestV1.parse({ ...validManifest, capture_id: "x".repeat(33) })
    ).toThrow();
  });
});

const validOverlayRecord = {
  id: "ov-001",
  data: { kind: "arrow" as const, from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: "auto" as const },
  schema_version: 1,
  source: "user" as const,
  z_index: 0,
  created_at: "2026-05-07T14:30:22.000Z",
  applied_at: "2026-05-07T14:30:22.000Z",
  rejected_at: null,
  superseded_by: null,
  ai_run_id: null
};

describe("BundleOverlayRecord", () => {
  test("accepts a well-formed record with applied + null lifecycle fields", () => {
    const parsed = BundleOverlayRecord.parse(validOverlayRecord);
    expect(parsed.id).toBe("ov-001");
    expect(parsed.data.kind).toBe("arrow");
    expect(parsed.applied_at).toBe("2026-05-07T14:30:22.000Z");
  });

  test("rejects an overlay with an invalid `data` shape", () => {
    expect(() =>
      BundleOverlayRecord.parse({
        ...validOverlayRecord,
        data: { kind: "wat" }
      })
    ).toThrow();
  });

  test("requires explicit nulls (not undefined) on lifecycle fields", () => {
    expect(() =>
      BundleOverlayRecord.parse({ ...validOverlayRecord, applied_at: undefined })
    ).toThrow();
  });
});

const validOverlaysJson = {
  overlays_format_version: 1 as const,
  overlays_version: 7,
  overlays: [validOverlayRecord],
  tags: ["work", "screenshots"],
  description: "a test capture",
  ai_runs: []
};

describe("BundleOverlaysV1", () => {
  test("roundtrips with a single overlay + tags + description", () => {
    const parsed = BundleOverlaysV1.parse(validOverlaysJson);
    expect(parsed.overlays).toHaveLength(1);
    expect(parsed.overlays_version).toBe(7);
    expect(parsed.description).toBe("a test capture");
  });

  test("description must be string|null, not undefined", () => {
    expect(() =>
      BundleOverlaysV1.parse({ ...validOverlaysJson, description: undefined })
    ).toThrow();
  });

  test("rejects negative overlays_version", () => {
    expect(() =>
      BundleOverlaysV1.parse({ ...validOverlaysJson, overlays_version: -1 })
    ).toThrow();
  });

  test("rejects empty tag string", () => {
    expect(() => BundleOverlaysV1.parse({ ...validOverlaysJson, tags: [""] })).toThrow();
  });

  test("rejects unknown overlay kind via the inner discriminated union", () => {
    expect(() =>
      BundleOverlaysV1.parse({
        ...validOverlaysJson,
        overlays: [
          {
            ...validOverlayRecord,
            data: { kind: "wat", rect: { x: 0, y: 0, w: 1, h: 1 } }
          }
        ]
      })
    ).toThrow();
  });
});

describe("BUNDLE_ENTRY_ALLOWLIST + isBundleEntryName", () => {
  test("contains exactly the five expected entries", () => {
    expect(BUNDLE_ENTRY_ALLOWLIST).toEqual([
      "manifest.json",
      "overlays.json",
      "source.png",
      "composite.png",          // legacy; pre-refactor bundles ship this
      "composite_thumbnail.jpg" // new; ≤ 1024px JPEG for the Thumbnail Extension
    ]);
  });

  test("isBundleEntryName accepts each allowlisted entry", () => {
    for (const name of BUNDLE_ENTRY_ALLOWLIST) {
      expect(isBundleEntryName(name)).toBe(true);
    }
  });

  test("isBundleEntryName rejects path-traversal attempts", () => {
    // The Zip-Slip threat model — yauzl does NOT auto-validate; this
    // helper is the gate.
    expect(isBundleEntryName("../etc/passwd")).toBe(false);
    expect(isBundleEntryName("../../etc/passwd")).toBe(false);
    expect(isBundleEntryName("..\\Windows\\System32\\hosts")).toBe(false);
    expect(isBundleEntryName("/etc/passwd")).toBe(false);
    expect(isBundleEntryName("manifest.json/../source.png")).toBe(false);
  });

  test("isBundleEntryName rejects subpaths that look like our entries", () => {
    expect(isBundleEntryName("subdir/manifest.json")).toBe(false);
    expect(isBundleEntryName("./manifest.json")).toBe(false);
    expect(isBundleEntryName("manifest.json\0")).toBe(false);
  });

  test("isBundleEntryName rejects unrelated extra entries", () => {
    expect(isBundleEntryName("LICENSE")).toBe(false);
    expect(isBundleEntryName("voice-describe.opus")).toBe(false); // Phase 5+ would gate via format version, not silent extra entry
    expect(isBundleEntryName("evil.sh")).toBe(false);
  });
});
