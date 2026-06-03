// Round-trip tests for the overlay zod schemas. These guard the IPC
// boundary — every overlay coming back from the renderer or from a
// Phase 4 Codex DynamicToolCall response is reparsed through these
// schemas, so we hold the line on:
//   - kind discriminator presence + value
//   - normalized coords are FINITE real numbers (no NaN/Infinity);
//     out-of-canvas coords are permitted so crop is reversible (see
//     pwrdrvr/PwrSnap#110 review — crop is a viewport, not destructive)
//   - hex color format vs the literal "auto"
//   - `default()` filling missing optional fields

import { describe, expect, test } from "vitest";
import {
  ArrowOverlay,
  BlurOverlay,
  CropOverlay,
  DEFAULT_BLUR_STYLE,
  MAX_HIGHLIGHT_OPACITY,
  DEFAULT_PARALLELOGRAM_SKEW_DEG,
  deriveBlurRadiusPx,
  HighlightOverlay,
  Overlay,
  OVERLAY_RENDER_ORDER,
  OverlayThickness,
  readBlurStyle,
  readHighlightOpacity,
  readOverlayThickness,
  readShapeKind,
  readShapeSkewDeg,
  ShapeOverlay,
  StepOverlay,
  TextOverlay
} from "../overlay-schemas";

describe("CropOverlay", () => {
  test("accepts a rect inside [0, 1]^2", () => {
    const parsed = CropOverlay.parse({
      kind: "crop",
      rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }
    });
    expect(parsed.kind).toBe("crop");
  });

  test("accepts coords outside [0, 1] (crop is reversible; overlays may live outside the cropped viewport)", () => {
    // Pre-pwrdrvr/PwrSnap#110: NormalizedScalar was .min(0).max(1),
    // which rejected these. The reviewer flagged that as destructive:
    // an overlay at point.x=0.95 that gets transformed by a 60% crop
    // becomes point.x≈1.58, and the only way to round-trip an undo is
    // to PRESERVE that out-of-canvas coord. The renderer (SVG
    // overflow:hidden) and bake pipeline (sharp composite) clip at
    // paint time, so out-of-canvas overlays are invisible but still
    // present in the bundle.
    expect(
      CropOverlay.parse({ kind: "crop", rect: { x: -0.1, y: 0, w: 0.5, h: 0.5 } }).rect.x
    ).toBeCloseTo(-0.1, 6);
    expect(
      CropOverlay.parse({ kind: "crop", rect: { x: 0, y: 0, w: 1.5, h: 0.5 } }).rect.w
    ).toBeCloseTo(1.5, 6);
  });

  test("rejects non-finite coords (NaN/Infinity would crash the renderer)", () => {
    expect(() =>
      CropOverlay.parse({ kind: "crop", rect: { x: NaN, y: 0, w: 0.5, h: 0.5 } })
    ).toThrow();
    expect(() =>
      CropOverlay.parse({ kind: "crop", rect: { x: 0, y: 0, w: Infinity, h: 0.5 } })
    ).toThrow();
  });
});

describe("ArrowOverlay color field", () => {
  test("defaults to 'auto' when omitted", () => {
    const parsed = ArrowOverlay.parse({
      kind: "arrow",
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 }
    });
    expect(parsed.color).toBe("auto");
  });

  test("accepts a 6-char lowercase hex", () => {
    const parsed = ArrowOverlay.parse({
      kind: "arrow",
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
      color: "#ff8c00"
    });
    expect(parsed.color).toBe("#ff8c00");
  });

  test("rejects a 3-char hex (we want canonical form on the wire)", () => {
    expect(() =>
      ArrowOverlay.parse({
        kind: "arrow",
        from: { x: 0, y: 0 },
        to: { x: 1, y: 1 },
        color: "#f80"
      })
    ).toThrow();
  });
});

describe("Overlay discriminated union", () => {
  test("dispatches on `kind` to the right variant schema", () => {
    const arrow = Overlay.parse({
      kind: "arrow",
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 }
    });
    expect(arrow.kind).toBe("arrow");

    const blur = Overlay.parse({
      kind: "blur",
      rect: { x: 0, y: 0, w: 0.2, h: 0.2 },
      reason: "credit-card-number"
    });
    expect(blur.kind).toBe("blur");

    const text = Overlay.parse({
      kind: "text",
      point: { x: 0.5, y: 0.5 },
      body: "hello"
    });
    expect(text.kind).toBe("text");
  });

  test("rejects an unknown kind", () => {
    expect(() => Overlay.parse({ kind: "wat", rect: { x: 0, y: 0, w: 1, h: 1 } })).toThrow();
  });

  test("rejects a missing kind", () => {
    expect(() => Overlay.parse({ rect: { x: 0, y: 0, w: 1, h: 1 } })).toThrow();
  });
});

describe("StepOverlay index range", () => {
  test("accepts integers in [1, 99]", () => {
    expect(StepOverlay.parse({ kind: "step", point: { x: 0, y: 0 }, index: 1 }).index).toBe(1);
    expect(StepOverlay.parse({ kind: "step", point: { x: 0, y: 0 }, index: 99 }).index).toBe(99);
  });

  test("rejects 0, negative, fractional, or > 99", () => {
    expect(() => StepOverlay.parse({ kind: "step", point: { x: 0, y: 0 }, index: 0 })).toThrow();
    expect(() => StepOverlay.parse({ kind: "step", point: { x: 0, y: 0 }, index: -1 })).toThrow();
    expect(() => StepOverlay.parse({ kind: "step", point: { x: 0, y: 0 }, index: 1.5 })).toThrow();
    expect(() => StepOverlay.parse({ kind: "step", point: { x: 0, y: 0 }, index: 100 })).toThrow();
  });
});

describe("TextOverlay body length", () => {
  test("accepts up to 2000 chars", () => {
    const body = "a".repeat(2000);
    expect(TextOverlay.parse({ kind: "text", point: { x: 0, y: 0 }, body }).body.length).toBe(
      2000
    );
  });

  test("rejects > 2000 chars", () => {
    const body = "a".repeat(2001);
    expect(() => TextOverlay.parse({ kind: "text", point: { x: 0, y: 0 }, body })).toThrow();
  });
});

describe("OVERLAY_RENDER_ORDER", () => {
  test("crop is first (smaller pixels downstream)", () => {
    expect(OVERLAY_RENDER_ORDER[0]).toBe("crop");
  });

  test("text is last (annotations sit on top of decorations)", () => {
    expect(OVERLAY_RENDER_ORDER[OVERLAY_RENDER_ORDER.length - 1]).toBe("text");
  });

  test("blur sits between crop and decorations (so blurs apply post-crop)", () => {
    const cropIdx = OVERLAY_RENDER_ORDER.indexOf("crop");
    const blurIdx = OVERLAY_RENDER_ORDER.indexOf("blur");
    const arrowIdx = OVERLAY_RENDER_ORDER.indexOf("arrow");
    expect(cropIdx).toBeLessThan(blurIdx);
    expect(blurIdx).toBeLessThan(arrowIdx);
  });
});

describe("Overlay smoke — the variants we ship in Phase 1 + Phase 2", () => {
  test("ShapeOverlay round-trips", () => {
    const parsed = ShapeOverlay.parse({
      kind: "shape",
      shape: "rect",
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
      color: "auto"
    });
    expect(parsed.color).toBe("auto");
    expect(parsed.shape).toBe("rect");
  });

  test("ShapeOverlay accepts every shape kind", () => {
    for (const shape of [
      "rect",
      "square",
      "circle",
      "oval",
      "parallelogram"
    ] as const) {
      const parsed = ShapeOverlay.parse({
        kind: "shape",
        shape,
        rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
      });
      expect(parsed.shape).toBe(shape);
    }
  });

  test("ShapeOverlay shape is optional — legacy rows default to rect", () => {
    const parsed = ShapeOverlay.parse({
      kind: "shape",
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 }
    });
    expect(parsed.shape).toBeUndefined();
    expect(readShapeKind(parsed)).toBe("rect");
  });

  test("ShapeOverlay parallelogram carries an explicit skewDeg", () => {
    const parsed = ShapeOverlay.parse({
      kind: "shape",
      shape: "parallelogram",
      rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.3 },
      skewDeg: 22
    });
    expect(parsed.skewDeg).toBe(22);
    expect(readShapeSkewDeg(parsed)).toBe(22);
  });

  test("readShapeSkewDeg defaults parallelogram without skewDeg to 15°", () => {
    expect(
      readShapeSkewDeg({ shape: "parallelogram" })
    ).toBe(DEFAULT_PARALLELOGRAM_SKEW_DEG);
  });

  test("readShapeSkewDeg returns 0 for non-parallelogram shapes", () => {
    expect(readShapeSkewDeg({ shape: "rect", skewDeg: 30 })).toBe(0);
    expect(readShapeSkewDeg({ shape: "circle", skewDeg: 30 })).toBe(0);
  });

  test("Overlay migrates legacy kind:\"rect\" rows to kind:\"shape\"", () => {
    // The on-disk shape from before the Rect → Shape rename. Routes
    // through Overlay.parse (NOT ShapeOverlay.parse directly) because
    // the preprocess shim lives on the top-level discriminated union.
    const migrated = Overlay.parse({
      kind: "rect",
      rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      color: "#ff0000",
      thickness: "large",
      filled: true,
      rotation: 0.25
    });
    expect(migrated.kind).toBe("shape");
    if (migrated.kind !== "shape") throw new Error("kind narrowing");
    expect(readShapeKind(migrated)).toBe("rect");
    expect(migrated.color).toBe("#ff0000");
    expect(migrated.thickness).toBe("large");
    expect(migrated.filled).toBe(true);
    expect(migrated.rotation).toBe(0.25);
    expect(migrated.rect).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
  });

  test("Overlay migration is idempotent — kind:\"shape\" passes through", () => {
    const passthrough = Overlay.parse({
      kind: "shape",
      shape: "circle",
      rect: { x: 0, y: 0, w: 0.3, h: 0.3 }
    });
    if (passthrough.kind !== "shape") throw new Error("kind narrowing");
    expect(passthrough.shape).toBe("circle");
  });

  test("HighlightOverlay round-trips", () => {
    const parsed = HighlightOverlay.parse({
      kind: "highlight",
      rect: { x: 0, y: 0, w: 1, h: 1 }
    });
    expect(parsed.kind).toBe("highlight");
  });

  test("readHighlightOpacity clamps stale opaque values to the marker range", () => {
    expect(readHighlightOpacity({ opacity: 1 })).toBe(MAX_HIGHLIGHT_OPACITY);
  });

  test("BlurOverlay reason is optional", () => {
    const parsed = BlurOverlay.parse({
      kind: "blur",
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 }
    });
    expect(parsed.reason).toBeUndefined();
  });

  test("BlurOverlay accepts every BlurStyle", () => {
    for (const style of ["gaussian", "pixelate", "redact"] as const) {
      const parsed = BlurOverlay.parse({
        kind: "blur",
        rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
        style
      });
      expect(parsed.style).toBe(style);
    }
  });

  test("BlurOverlay rejects an unknown style", () => {
    expect(() =>
      BlurOverlay.parse({
        kind: "blur",
        rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
        style: "vignette"
      })
    ).toThrow();
  });

  test("BlurOverlay style is optional — legacy rows parse cleanly", () => {
    const parsed = BlurOverlay.parse({
      kind: "blur",
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 }
    });
    expect(parsed.style).toBeUndefined();
  });

  test("readBlurStyle defaults legacy rows to the canonical default", () => {
    expect(readBlurStyle({})).toBe(DEFAULT_BLUR_STYLE);
    expect(readBlurStyle({ style: "pixelate" })).toBe("pixelate");
    expect(readBlurStyle({ style: "redact" })).toBe("redact");
  });
});

describe("OverlayThickness + readOverlayThickness", () => {
  // The thickness preset table is the user-facing knob for stroke
  // weight. These tests cover:
  //   * x-large lands in the type union (added for Retina rescue)
  //   * legacy two-arg call (no shortSide) preserves byte-identical
  //     multiplier-only behavior
  //   * three-arg call (with shortSide) activates the floor formula
  //     on Large/X-Large so high-DPI captures don't get hairline
  //     strokes
  //   * numeric thickness path scales correctly under both shapes

  test("OverlayThickness accepts x-large", () => {
    expect(OverlayThickness.parse("x-large")).toBe("x-large");
  });

  test("legacy two-arg form: multiplier-only, no floor applied", () => {
    // 200 short-side, auto=4 → small=2, medium=4, large=8, xl=12.
    // With NO shortSidePx the floor never activates regardless of
    // image dims. This preserves byte-identical pre-floor output
    // so call sites that haven't opted in stay unchanged.
    expect(readOverlayThickness("small", 4)).toBeCloseTo(2, 5);
    expect(readOverlayThickness("medium", 4)).toBeCloseTo(4, 5);
    expect(readOverlayThickness("large", 4)).toBeCloseTo(8, 5);
    expect(readOverlayThickness("x-large", 4)).toBeCloseTo(12, 5);
  });

  test("three-arg form: low-res image — floor is below multiplier, no-op", () => {
    // 1080 short-side. auto stroke ≈ 5 (1080/220, clamped within
    // [4,14]). Pass autoStrokeWidthPx=5 + shortSide=1080.
    //   small  = max(5 × 0.5,  1080 × 0.003)  = max(2.5,  3.24)  = 3.24
    //   medium = 5  (no floor)
    //   large  = max(5 × 2,    1080 × 0.012)  = max(10,   12.96) = 12.96
    //   xl     = max(5 × 3,    1080 × 0.020)  = max(15,   21.6)  = 21.6
    // Note: on this image the floor IS active for small/large/xl
    // — the auto path is clamped down at MIN_PX so floors do help
    // even at 1080p for the bigger presets. Medium stays at auto.
    expect(readOverlayThickness("medium", 5, 1080)).toBeCloseTo(5, 5);
    expect(readOverlayThickness("large", 5, 1080)).toBeCloseTo(12.96, 1);
    expect(readOverlayThickness("x-large", 5, 1080)).toBeCloseTo(21.6, 1);
  });

  test("three-arg form: Retina image — floor lifts Large/XL off STROKE_MAX_PX cap", () => {
    // 4K-ish short side (2160). auto stroke is clamped to STROKE_MAX_PX=14.
    // Pre-fix: large = 14 × 2 = 28 px (≈ 1.3% of short side — thin).
    // Post-fix: large = max(28, 2160 × 0.012) = max(28, 25.92) = 28
    //   (still wins via multiplier on this size)
    //          x-large = max(14 × 3, 2160 × 0.020) = max(42, 43.2) = 43.2
    //   (floor wins, lifting XL past the multiplier-only ceiling)
    expect(readOverlayThickness("large", 14, 2160)).toBeCloseTo(28, 1);
    expect(readOverlayThickness("x-large", 14, 2160)).toBeCloseTo(43.2, 1);
  });

  test("three-arg form: 5K Retina — floor decisively wins for Large", () => {
    // 5K short side (2880). auto = 14 (capped).
    //   large  = max(14 × 2, 2880 × 0.012) = max(28, 34.56) = 34.56
    //   x-large= max(14 × 3, 2880 × 0.020) = max(42, 57.6)  = 57.6
    // The whole point of the floor: at 5K, Large goes from a 28px
    // multiplier-only stroke (visually thin) to a 34.56px floor-
    // driven stroke (visually present).
    expect(readOverlayThickness("large", 14, 2880)).toBeCloseTo(34.56, 1);
    expect(readOverlayThickness("x-large", 14, 2880)).toBeCloseTo(57.6, 1);
  });

  test("medium has no floor — picking M never silently bumps past auto", () => {
    // Medium IS auto by design. The floor formula must NOT lift
    // medium on huge images; otherwise users who picked M because
    // they wanted "the default" would get surprised on Retina.
    for (const shortSide of [720, 1080, 1440, 2160, 2880, 4320]) {
      expect(readOverlayThickness("medium", 10, shortSide)).toBeCloseTo(10, 5);
    }
  });

  test("auto / undefined pass through regardless of shortSide", () => {
    expect(readOverlayThickness(undefined, 7)).toBeCloseTo(7, 5);
    expect(readOverlayThickness(undefined, 7, 1080)).toBeCloseTo(7, 5);
    expect(readOverlayThickness("auto", 7, 2880)).toBeCloseTo(7, 5);
  });

  test("numeric thickness: legacy two-arg passes through; three-arg expands to pixels", () => {
    // Legacy: numeric is a normalized fraction returned verbatim
    // (caller multiplies by shortSide if they want pixels).
    expect(readOverlayThickness(0.02, 5)).toBeCloseTo(0.02, 5);
    // New: with shortSide, numeric is expanded to pixels. On a
    // 1080-px image, thickness=0.02 → 21.6 px.
    expect(readOverlayThickness(0.02, 5, 1080)).toBeCloseTo(21.6, 1);
  });

  test("ArrowOverlay schema accepts x-large in the thickness field", () => {
    const parsed = ArrowOverlay.parse({
      kind: "arrow",
      from: { x: 0.1, y: 0.5 },
      to: { x: 0.9, y: 0.5 },
      thickness: "x-large"
    });
    expect(parsed.thickness).toBe("x-large");
  });

  test("ShapeOverlay schema accepts x-large in the thickness field", () => {
    const parsed = ShapeOverlay.parse({
      kind: "shape",
      shape: "rect",
      rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      thickness: "x-large"
    });
    expect(parsed.thickness).toBe("x-large");
  });
});

describe("TextOverlay sizePx (absolute text height in source pixels)", () => {
  // pwrdrvr/PwrSnap#110: a sibling field to `size` that stores the
  // ABSOLUTE text height in source pixels. The bucket enum stays as
  // the user's last UI intent; sizePx is the resolved truth. Decoupling
  // them lets `"medium"` mean different absolute sizes for two
  // canvases of the same dim depending on placement history (native vs
  // cropped) — without this field, the bucket math at render time has
  // to pick ONE source-of-truth (canvas shortSide OR source shortSide)
  // and is forced to lie to the user on one of the two cases.
  //
  // Optional for back-compat. Legacy rows (no sizePx) keep parsing
  // and rendering exactly as they did before this change; the new
  // field only takes effect when the renderer/bake see it populated.

  test("accepts a positive finite sizePx", () => {
    const parsed = TextOverlay.parse({
      kind: "text",
      point: { x: 0.5, y: 0.5 },
      body: "Hi",
      size: "medium",
      sizePx: 64
    });
    expect(parsed.sizePx).toBe(64);
  });

  test("legacy row without sizePx parses cleanly — field stays undefined", () => {
    const parsed = TextOverlay.parse({
      kind: "text",
      point: { x: 0.5, y: 0.5 },
      body: "Hi"
    });
    expect(parsed.sizePx).toBeUndefined();
  });

  test("rejects non-positive or non-finite sizePx (defensive — would crash the renderer)", () => {
    const base = { kind: "text", point: { x: 0, y: 0 }, body: "x", size: "small" };
    expect(() => TextOverlay.parse({ ...base, sizePx: 0 })).toThrow();
    expect(() => TextOverlay.parse({ ...base, sizePx: -5 })).toThrow();
    expect(() => TextOverlay.parse({ ...base, sizePx: NaN })).toThrow();
    expect(() => TextOverlay.parse({ ...base, sizePx: Infinity })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// deriveBlurRadiusPx — single source of truth, used by three call sites
// (editor commit, v1→v2 doctor, editor canvas preview). A drift between
// them was the kind of silent-WYSIWYG bug PR #129/#137/#147 spent
// multiple review rounds untangling.
// ─────────────────────────────────────────────────────────────────────

describe("deriveBlurRadiusPx — sigma derivation contract", () => {
  test("matches the 1.5%-of-shortSide rule for typical capture dims", () => {
    // 1920×1080 → shortSide=1080 → round(16.2) = 16
    expect(deriveBlurRadiusPx({ width: 1920, height: 1080 })).toBe(16);
    // 2880×1620 (Retina 1440×1620 logical) → shortSide=1620 → round(24.3) = 24
    expect(deriveBlurRadiusPx({ width: 2880, height: 1620 })).toBe(24);
    // 742×658 (the test capture in the user reports on PR #148) →
    // shortSide=658 → round(9.87) = 10
    expect(deriveBlurRadiusPx({ width: 742, height: 658 })).toBe(10);
  });

  test("floors at 8px so tiny rects don't smooth out below recognizability", () => {
    // shortSide=400 → 1.5% = 6 → floor lifts to 8
    expect(deriveBlurRadiusPx({ width: 400, height: 800 })).toBe(8);
    // shortSide=100 → 1.5% = 1.5 → floor lifts to 8
    expect(deriveBlurRadiusPx({ width: 100, height: 100 })).toBe(8);
  });

  test("caps at 200px to match the v2 BlurEffect.radius_px schema bound", () => {
    // shortSide=20000 → 1.5% = 300 → cap to 200
    expect(deriveBlurRadiusPx({ width: 30000, height: 20000 })).toBe(200);
  });

  test("uses MIN(width, height) as the short side, not max", () => {
    // Wide capture (height is short side)
    expect(deriveBlurRadiusPx({ width: 3000, height: 600 })).toBe(9); // round(600*0.015)
    // Tall capture (width is short side)
    expect(deriveBlurRadiusPx({ width: 600, height: 3000 })).toBe(9);
  });
});
