// Test-first specs for the v2 bundle manifest + document zod schemas
// and `validateBundleZipEntryNamesV2`. ~/Documents/PwrSnap/ is
// untrusted input; v2 expands the bundle layout to `sources/<sha>.png`
// and `layers/<nanoid>.png` directories — every additional entry shape
// is a new attack surface that this gate forecloses.
//
// Each test reflects a HIGH/MED security finding from the v2 plan's
// deepening review. Numbered comments map to the security review's
// H1-H5 / M1-M6 grid.

import { describe, expect, test } from "vitest";

import {
  AffineTransform,
  BlurEffect,
  BundleDocumentV2,
  BundleManifestV2,
  CanvasRect,
  EffectLayer,
  GroupLayer,
  HighlightEffect,
  RasterLayer,
  VectorLayer,
  validateBundleZipEntryNamesV2
} from "../bundle-manifest-schema-v2";

const validManifest = {
  bundle_format_version: 2 as const,
  capture_id: "v2cap-abc123",
  canvas_dimensions: { width_px: 1920, height_px: 1080 },
  paired_png_filename: "v2cap-abc123.png",
  created_at: "2026-05-07T14:30:22.000Z",
  bundle_modified_at: "2026-05-07T14:30:22.000Z"
};

const validCommonProps = {
  id: "abc123def4567890",       // nanoid format: 16 URL-safe chars
  parent_id: null,
  name: "Root",
  visible: true,
  locked: false,
  opacity: 1,
  blend_mode: "normal" as const,
  transform: [1, 0, 0, 1, 0, 0],
  z_index: 0,
  source: "user" as const,
  ai_run_id: null,
  applied_at: "2026-05-07T14:30:22.000Z",
  rejected_at: null,
  superseded_by: null,
  created_at: "2026-05-07T14:30:22.000Z"
};

// --------------------------------------------------------------------
// BundleManifestV2 — identity, canvas, dimensions
// --------------------------------------------------------------------

describe("BundleManifestV2", () => {
  test("accepts a well-formed v2 manifest", () => {
    const parsed = BundleManifestV2.parse(validManifest);
    expect(parsed.bundle_format_version).toBe(2);
    expect(parsed.canvas_dimensions.width_px).toBe(1920);
  });

  test("rejects bundle_format_version other than the literal 2", () => {
    expect(() => BundleManifestV2.parse({ ...validManifest, bundle_format_version: 1 })).toThrow();
    expect(() => BundleManifestV2.parse({ ...validManifest, bundle_format_version: 3 })).toThrow();
  });

  test("rejects canvas_dimensions above the 32768 cap (H4)", () => {
    expect(() =>
      BundleManifestV2.parse({
        ...validManifest,
        canvas_dimensions: { width_px: 32769, height_px: 100 }
      })
    ).toThrow();
    expect(() =>
      BundleManifestV2.parse({
        ...validManifest,
        canvas_dimensions: { width_px: 100, height_px: 999_999_999 }
      })
    ).toThrow();
  });

  test("rejects zero or negative canvas dimensions", () => {
    expect(() =>
      BundleManifestV2.parse({
        ...validManifest,
        canvas_dimensions: { width_px: 0, height_px: 100 }
      })
    ).toThrow();
    expect(() =>
      BundleManifestV2.parse({
        ...validManifest,
        canvas_dimensions: { width_px: 100, height_px: -1 }
      })
    ).toThrow();
  });

  test("rejects fractional canvas dimensions (.int() required)", () => {
    expect(() =>
      BundleManifestV2.parse({
        ...validManifest,
        canvas_dimensions: { width_px: 100.5, height_px: 100 }
      })
    ).toThrow();
  });

  test("paired_png_filename rejects path traversal (H1 carryover)", () => {
    expect(() =>
      BundleManifestV2.parse({ ...validManifest, paired_png_filename: "../etc/passwd" })
    ).toThrow();
    expect(() =>
      BundleManifestV2.parse({ ...validManifest, paired_png_filename: "subdir/file.png" })
    ).toThrow();
    expect(() =>
      BundleManifestV2.parse({ ...validManifest, paired_png_filename: ".hidden.png" })
    ).toThrow();
    expect(() =>
      BundleManifestV2.parse({ ...validManifest, paired_png_filename: "ok.png\0.evil" })
    ).toThrow();
  });

  test("rejects non-ISO datetimes", () => {
    expect(() => BundleManifestV2.parse({ ...validManifest, created_at: "yesterday" })).toThrow();
    expect(() =>
      BundleManifestV2.parse({ ...validManifest, bundle_modified_at: "2026-05-07" })
    ).toThrow();
  });
});

// --------------------------------------------------------------------
// AffineTransform — finite() guards (H3)
// --------------------------------------------------------------------

describe("AffineTransform — finite-number guards", () => {
  test("accepts identity matrix", () => {
    const parsed = AffineTransform.parse([1, 0, 0, 1, 0, 0]);
    expect(parsed).toEqual([1, 0, 0, 1, 0, 0]);
  });

  test("rejects NaN at any position", () => {
    for (let i = 0; i < 6; i++) {
      const t = [1, 0, 0, 1, 0, 0];
      t[i] = Number.NaN;
      expect(() => AffineTransform.parse(t)).toThrow();
    }
  });

  test("rejects +Infinity and -Infinity at any position", () => {
    for (let i = 0; i < 6; i++) {
      const positive = [1, 0, 0, 1, 0, 0];
      positive[i] = Number.POSITIVE_INFINITY;
      const negative = [1, 0, 0, 1, 0, 0];
      negative[i] = Number.NEGATIVE_INFINITY;
      expect(() => AffineTransform.parse(positive)).toThrow();
      expect(() => AffineTransform.parse(negative)).toThrow();
    }
  });

  test("rejects tuples of wrong length", () => {
    expect(() => AffineTransform.parse([1, 0, 0, 1, 0])).toThrow();
    expect(() => AffineTransform.parse([1, 0, 0, 1, 0, 0, 0])).toThrow();
  });
});

// --------------------------------------------------------------------
// CanvasRect — finite + nonnegative dimensions
// --------------------------------------------------------------------

describe("CanvasRect", () => {
  test("accepts a standard rect", () => {
    expect(CanvasRect.parse({ x: 10, y: 10, w: 100, h: 200 })).toEqual({
      x: 10, y: 10, w: 100, h: 200
    });
  });

  test("rejects NaN/Inf coordinates (H3)", () => {
    expect(() => CanvasRect.parse({ x: Number.NaN, y: 0, w: 1, h: 1 })).toThrow();
    expect(() => CanvasRect.parse({ x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 1 })).toThrow();
  });

  test("rejects negative width/height", () => {
    expect(() => CanvasRect.parse({ x: 0, y: 0, w: -1, h: 1 })).toThrow();
    expect(() => CanvasRect.parse({ x: 0, y: 0, w: 1, h: -1 })).toThrow();
  });

  test("allows zero-area rect (clip can collapse)", () => {
    expect(CanvasRect.parse({ x: 0, y: 0, w: 0, h: 0 })).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

// --------------------------------------------------------------------
// RasterLayer
// --------------------------------------------------------------------

describe("RasterLayer", () => {
  const validRaster = {
    ...validCommonProps,
    id: "rasterlayer01234",
    kind: "raster" as const,
    source_ref: { kind: "embedded" as const, sha256: "a".repeat(64) },
    natural_width_px: 1920,
    natural_height_px: 1080
  };

  test("accepts a well-formed raster layer", () => {
    const parsed = RasterLayer.parse(validRaster);
    expect(parsed.kind).toBe("raster");
    expect(parsed.source_ref.sha256).toBe("a".repeat(64));
  });

  test("rejects non-hex sha256", () => {
    expect(() =>
      RasterLayer.parse({
        ...validRaster,
        source_ref: { kind: "embedded", sha256: "not-hex" }
      })
    ).toThrow();
    expect(() =>
      RasterLayer.parse({
        ...validRaster,
        source_ref: { kind: "embedded", sha256: "A".repeat(64) } // uppercase rejected
      })
    ).toThrow();
  });

  test("rejects source_ref.kind other than 'embedded' (R11 — linked deferred)", () => {
    expect(() =>
      RasterLayer.parse({
        ...validRaster,
        source_ref: { kind: "linked", sha256: "a".repeat(64) }
      })
    ).toThrow();
  });

  test("rejects natural dimensions above 32768 cap (H4)", () => {
    expect(() =>
      RasterLayer.parse({ ...validRaster, natural_width_px: 32769 })
    ).toThrow();
    expect(() =>
      RasterLayer.parse({ ...validRaster, natural_height_px: 999_999_999 })
    ).toThrow();
  });

  test("rejects zero or negative natural dimensions", () => {
    expect(() => RasterLayer.parse({ ...validRaster, natural_width_px: 0 })).toThrow();
    expect(() => RasterLayer.parse({ ...validRaster, natural_height_px: -1 })).toThrow();
  });

  test("rejects an opacity outside [0,1] (carryover from v1 model)", () => {
    expect(() => RasterLayer.parse({ ...validRaster, opacity: 1.5 })).toThrow();
    expect(() => RasterLayer.parse({ ...validRaster, opacity: -0.1 })).toThrow();
  });

  test("rejects blend_mode other than 'normal' in v2.0", () => {
    expect(() => RasterLayer.parse({ ...validRaster, blend_mode: "multiply" })).toThrow();
  });

  test("rejects an id not in nanoid format (16 URL-safe chars)", () => {
    // Too short
    expect(() => RasterLayer.parse({ ...validRaster, id: "short" })).toThrow();
    // Wrong charset (contains `.`)
    expect(() =>
      RasterLayer.parse({ ...validRaster, id: "abc.def.ghi.jklm" })
    ).toThrow();
    // UUID-format also rejected (correctness fix — Sec-M6)
    expect(() =>
      RasterLayer.parse({ ...validRaster, id: "12345678-1234-1234-1234-123456789012" })
    ).toThrow();
  });

  test("name capped at 256 chars (Sec-L4)", () => {
    expect(() =>
      RasterLayer.parse({ ...validRaster, name: "x".repeat(257) })
    ).toThrow();
    expect(RasterLayer.parse({ ...validRaster, name: "x".repeat(256) }).name.length).toBe(256);
  });

  test("ai_run_id capped at 64 chars (Sec-L4)", () => {
    expect(() =>
      RasterLayer.parse({ ...validRaster, ai_run_id: "x".repeat(65) })
    ).toThrow();
  });
});

// --------------------------------------------------------------------
// VectorLayer
// --------------------------------------------------------------------

describe("VectorLayer", () => {
  const validVector = {
    ...validCommonProps,
    id: "vectorlayer01234",
    kind: "vector" as const,
    shape: {
      kind: "arrow" as const,
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
      color: "auto" as const
    }
  };

  test("accepts a well-formed vector layer with an arrow shape", () => {
    const parsed = VectorLayer.parse(validVector);
    expect(parsed.kind).toBe("vector");
    expect(parsed.shape.kind).toBe("arrow");
  });

  test("rejects an invalid Overlay shape", () => {
    expect(() =>
      VectorLayer.parse({ ...validVector, shape: { kind: "unknown-kind" } })
    ).toThrow();
  });
});

// --------------------------------------------------------------------
// EffectLayer + Blur / Highlight
// --------------------------------------------------------------------

describe("BlurEffect — finite() + bounded radius", () => {
  test("accepts a valid blur", () => {
    expect(BlurEffect.parse({ type: "blur", radius_px: 12.5 })).toEqual({ type: "blur", radius_px: 12.5 });
  });

  test("rejects zero, negative, NaN, +Inf radius", () => {
    expect(() => BlurEffect.parse({ type: "blur", radius_px: 0 })).toThrow();
    expect(() => BlurEffect.parse({ type: "blur", radius_px: -1 })).toThrow();
    expect(() => BlurEffect.parse({ type: "blur", radius_px: Number.NaN })).toThrow();
    expect(() => BlurEffect.parse({ type: "blur", radius_px: Number.POSITIVE_INFINITY })).toThrow();
  });

  test("rejects radius above 200 (sane upper bound)", () => {
    expect(() => BlurEffect.parse({ type: "blur", radius_px: 201 })).toThrow();
  });
});

describe("HighlightEffect", () => {
  test("accepts a valid highlight", () => {
    expect(
      HighlightEffect.parse({
        type: "highlight",
        tint_hex: "#ff8c00",
        opacity: 0.5,
        blend: "screen",
        rotation: Math.PI / 4
      })
    ).toEqual({
      type: "highlight", tint_hex: "#ff8c00", opacity: 0.5, blend: "screen", rotation: Math.PI / 4
    });
  });

  test("rejects opacity outside [0,1] or non-finite", () => {
    expect(() =>
      HighlightEffect.parse({ type: "highlight", tint_hex: "#ff8c00", opacity: 1.1 })
    ).toThrow();
    expect(() =>
      HighlightEffect.parse({ type: "highlight", tint_hex: "#ff8c00", opacity: Number.NaN })
    ).toThrow();
  });

  test("rejects bad tint_hex", () => {
    expect(() =>
      HighlightEffect.parse({ type: "highlight", tint_hex: "#f80", opacity: 0.5 })
    ).toThrow();
  });
});

describe("EffectLayer", () => {
  const validEffect = {
    ...validCommonProps,
    id: "effectlayer01234",
    kind: "effect" as const,
    effect: { type: "blur" as const, radius_px: 8 },
    clip_rect: null
  };

  test("accepts a blur effect with null clip_rect (entire canvas)", () => {
    const parsed = EffectLayer.parse(validEffect);
    expect(parsed.effect.type).toBe("blur");
    expect(parsed.clip_rect).toBeNull();
  });

  test("accepts a highlight effect with a clip rect", () => {
    const parsed = EffectLayer.parse({
      ...validEffect,
      effect: { type: "highlight", tint_hex: "#ff0000", opacity: 0.3 },
      clip_rect: { x: 10, y: 10, w: 100, h: 100 }
    });
    expect(parsed.clip_rect).toEqual({ x: 10, y: 10, w: 100, h: 100 });
  });

  test("rejects an effect.type other than blur or highlight (AdjustmentEffect deferred)", () => {
    expect(() =>
      EffectLayer.parse({
        ...validEffect,
        effect: { type: "adjustment", kind: "curves", params: {} }
      })
    ).toThrow();
  });
});

// --------------------------------------------------------------------
// GroupLayer
// --------------------------------------------------------------------

describe("GroupLayer", () => {
  test("accepts a collapsed group with no children specifics (children resolve via parent_id)", () => {
    const parsed = GroupLayer.parse({
      ...validCommonProps,
      id: "grouplayer012345",
      kind: "group" as const,
      collapsed: false
    });
    expect(parsed.kind).toBe("group");
    expect(parsed.collapsed).toBe(false);
  });
});

// --------------------------------------------------------------------
// BundleDocumentV2
// --------------------------------------------------------------------

describe("BundleDocumentV2", () => {
  const validDoc = {
    document_format_version: 1 as const,
    edits_version: 0,
    layers: [],
    tags: [],
    description: null,
    ai_runs: []
  };

  test("accepts an empty document", () => {
    const parsed = BundleDocumentV2.parse(validDoc);
    expect(parsed.layers).toEqual([]);
  });

  test("rejects document_format_version other than 1", () => {
    expect(() =>
      BundleDocumentV2.parse({ ...validDoc, document_format_version: 2 })
    ).toThrow();
  });

  test("rejects negative edits_version", () => {
    expect(() => BundleDocumentV2.parse({ ...validDoc, edits_version: -1 })).toThrow();
  });

  test("rejects layer count above 4096 (M3 DoS guard)", () => {
    const layers = Array.from({ length: 4097 }, (_, i) => ({
      ...validCommonProps,
      id: i.toString(36).padStart(16, "0").slice(0, 16),
      kind: "group" as const,
      collapsed: false
    }));
    expect(() => BundleDocumentV2.parse({ ...validDoc, layers })).toThrow();
  });

  test("rejects description above 4096 chars (Sec-L4)", () => {
    expect(() =>
      BundleDocumentV2.parse({ ...validDoc, description: "x".repeat(4097) })
    ).toThrow();
  });

  test("rejects tag length above 64", () => {
    expect(() => BundleDocumentV2.parse({ ...validDoc, tags: ["x".repeat(65)] })).toThrow();
  });

  test("rejects tags array above 256 entries", () => {
    const tags = Array.from({ length: 257 }, (_, i) => `tag-${i}`);
    expect(() => BundleDocumentV2.parse({ ...validDoc, tags })).toThrow();
  });
});

// --------------------------------------------------------------------
// validateBundleZipEntryNamesV2 — path validator with per-version
// prefix allowlist + Zip-Slip carryover
// --------------------------------------------------------------------

const v2RequiredEntries = ["manifest.json", "document.json", "composite.png"];

describe("validateBundleZipEntryNamesV2 — happy paths", () => {
  test("accepts the three fixed entries with no nested files", () => {
    const result = validateBundleZipEntryNamesV2(v2RequiredEntries);
    expect(result.ok).toBe(true);
  });

  test("accepts fixed entries plus a sources/<sha>.png entry", () => {
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      `sources/${"a".repeat(64)}.png`
    ]);
    expect(result.ok).toBe(true);
  });

  test("accepts fixed entries plus a layers/<nanoid>.png entry", () => {
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      "layers/abc-def_ghi_jklm.png"
    ]);
    expect(result.ok).toBe(true);
  });

  test("accepts multiple sources + layers (real document shape)", () => {
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      `sources/${"a".repeat(64)}.png`,
      `sources/${"b".repeat(64)}.png`,
      "layers/abc-def_ghi_jklm.png",
      "layers/aaaaaaaaaaaaaaaa.png"
    ]);
    expect(result.ok).toBe(true);
  });
});

describe("validateBundleZipEntryNamesV2 — Zip-Slip carryover (v1 cases)", () => {
  test("rejects a directory-traversal entry under sources/", () => {
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      "sources/../etc/passwd"
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects ../../etc/passwd as a top-level entry", () => {
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      "../../etc/passwd"
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects a Windows-style traversal under sources/", () => {
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      "sources\\..\\..\\Windows\\System32\\hosts"
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects an absolute path", () => {
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      "/etc/passwd"
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects null-byte injection in entry names (M2 carryover)", () => {
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      `sources/${"a".repeat(64)}.png\0.evil`
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("validateBundleZipEntryNamesV2 — v2-specific path fuzzing", () => {
  test("rejects URL-encoded traversal (M2 — must not be decoded)", () => {
    // %2e%2e is encoded ".." — the regex must reject this because % is
    // not in the allowed sha256/nanoid charsets. Verifies that future
    // maintainers who broaden the regex don't accidentally decode.
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      "sources/%2e%2e/foo.png"
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects homograph attacks (M1 — Cyrillic 'о' looks like Latin 'o')", () => {
    // U+043E (Cyrillic 'о') in 'sоurces' — regex rejects because
    // non-ASCII char isn't in the [0-9a-f] / [A-Za-z0-9_-] sets.
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      `sоurces/${"a".repeat(64)}.png` // first 'о' is Cyrillic
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects uppercase sha (M1 — sha256 hex must be lowercase)", () => {
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      `sources/${"A".repeat(64)}.png`
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects mixed-case directory prefix", () => {
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      `SOURCES/${"a".repeat(64)}.png`
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects sha of wrong length", () => {
    const result1 = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      `sources/${"a".repeat(63)}.png`
    ]);
    const result2 = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      `sources/${"a".repeat(65)}.png`
    ]);
    expect(result1.ok).toBe(false);
    expect(result2.ok).toBe(false);
  });

  test("rejects nanoid of wrong length or wrong charset", () => {
    const shortNanoid = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      "layers/short.png"
    ]);
    const longNanoid = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      "layers/way-too-long-for-a-nanoid.png"
    ]);
    const badChars = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      "layers/has.invalid.png"
    ]);
    expect(shortNanoid.ok).toBe(false);
    expect(longNanoid.ok).toBe(false);
    expect(badChars.ok).toBe(false);
  });

  test("rejects subpath under sources/ (no two-level nesting)", () => {
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      `sources/${"a".repeat(64)}/foo.png`
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects thumbnails/ entries (NOT in v2.0 allowlist — deferred)", () => {
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      `thumbnails/${"a".repeat(64)}.webp`
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects extra benign-looking top-level entries (LICENSE etc.)", () => {
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      "LICENSE"
    ]);
    expect(result.ok).toBe(false);
  });

  test("rejects double-dot-slash inside an otherwise-valid name", () => {
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      "sources/./foo.png"
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("validateBundleZipEntryNamesV2 — missing + duplicate enforcement", () => {
  test("rejects when manifest.json is missing", () => {
    const result = validateBundleZipEntryNamesV2(["document.json", "composite.png"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingEntries).toContain("manifest.json");
    }
  });

  test("rejects when document.json is missing", () => {
    const result = validateBundleZipEntryNamesV2(["manifest.json", "composite.png"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingEntries).toContain("document.json");
    }
  });

  test("accepts the minimal v2 bundle (manifest + document only) — composite is optional", () => {
    // The packer in bundle-store.ts dropped `composite.png` in PR #90
    // and the `composite_thumbnail.jpg` thumbnail is intentionally
    // optional (omitted for small images). Readers reconstruct the
    // composite from sources/* + document.json layers when neither
    // is present. So a v2 bundle with just manifest.json + document.json
    // is structurally valid.
    const result = validateBundleZipEntryNamesV2(["manifest.json", "document.json"]);
    expect(result.ok).toBe(true);
  });

  test("accepts composite_thumbnail.jpg as a known entry", () => {
    // The current packer writes composite_thumbnail.jpg (replaces the
    // legacy composite.png). The validator must recognize it as a
    // known v2 entry — otherwise it'd land in `badEntries` and
    // reject every bundle the live packer produces.
    const result = validateBundleZipEntryNamesV2([
      "manifest.json",
      "document.json",
      "composite_thumbnail.jpg"
    ]);
    expect(result.ok).toBe(true);
  });

  test("rejects duplicate manifest.json (shadow-entry attack)", () => {
    const result = validateBundleZipEntryNamesV2([
      "manifest.json",
      "manifest.json",
      "document.json",
      "composite.png"
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.duplicateEntries).toContain("manifest.json");
    }
  });

  test("rejects duplicate sources/<sha>.png (shadow-entry attack on a nested entry)", () => {
    const sha = "a".repeat(64);
    const result = validateBundleZipEntryNamesV2([
      ...v2RequiredEntries,
      `sources/${sha}.png`,
      `sources/${sha}.png`
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.duplicateEntries).toContain(`sources/${sha}.png`);
    }
  });
});
