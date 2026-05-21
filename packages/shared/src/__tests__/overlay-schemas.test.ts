// Round-trip tests for the overlay zod schemas. These guard the IPC
// boundary — every overlay coming back from the renderer or from a
// Phase 4 Codex DynamicToolCall response is reparsed through these
// schemas, so we hold the line on:
//   - kind discriminator presence + value
//   - normalized [0, 1] coord clamping
//   - hex color format vs the literal "auto"
//   - `default()` filling missing optional fields

import { describe, expect, test } from "vitest";
import {
  ArrowOverlay,
  BlurOverlay,
  CropOverlay,
  DEFAULT_BLUR_STYLE,
  HighlightOverlay,
  Overlay,
  OVERLAY_RENDER_ORDER,
  readBlurStyle,
  RectOverlay,
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

  test("rejects coords outside [0, 1]", () => {
    expect(() =>
      CropOverlay.parse({ kind: "crop", rect: { x: -0.1, y: 0, w: 0.5, h: 0.5 } })
    ).toThrow();
    expect(() =>
      CropOverlay.parse({ kind: "crop", rect: { x: 0, y: 0, w: 1.5, h: 0.5 } })
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
  test("RectOverlay round-trips", () => {
    const parsed = RectOverlay.parse({
      kind: "rect",
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
      color: "auto"
    });
    expect(parsed.color).toBe("auto");
  });

  test("HighlightOverlay round-trips", () => {
    const parsed = HighlightOverlay.parse({
      kind: "highlight",
      rect: { x: 0, y: 0, w: 1, h: 1 }
    });
    expect(parsed.kind).toBe("highlight");
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
