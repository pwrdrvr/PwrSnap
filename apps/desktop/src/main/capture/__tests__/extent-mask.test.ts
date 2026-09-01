import { describe, expect, it } from "vitest";
import { isExtentRect, MAX_SELECTOR_EXTENTS, planExtentMask } from "../extent-mask";

const SNAPSHOT_1X = { width: 1920, height: 1080 };
const ORIGIN = { x: 0, y: 0 };

/** Shorthand for the common single-display, unscaled case. */
function plan1x(rect: Parameters<typeof planExtentMask>[0]["rect"], extents: readonly { x: number; y: number; w: number; h: number }[]) {
  return planExtentMask({
    rect,
    extents,
    displayOrigin: ORIGIN,
    scaleFactor: 1,
    snapshot: SNAPSHOT_1X
  });
}

describe("planExtentMask", () => {
  it("places each extent relative to the union box, not the display", () => {
    // Two windows with a gap between them. The canvas is their union;
    // each layer lands at its offset INSIDE that canvas, so the gap
    // stays untouched (= transparent).
    const plan = plan1x({ x: 100, y: 200, w: 700, h: 400 }, [
      { x: 100, y: 200, w: 300, h: 400 },
      { x: 600, y: 250, w: 200, h: 200 }
    ]);
    expect(plan).not.toBeNull();
    expect(plan?.box).toEqual({ left: 100, top: 200, width: 700, height: 400 });
    expect(plan?.layers).toEqual([
      { extract: { left: 100, top: 200, width: 300, height: 400 }, left: 0, top: 0 },
      { extract: { left: 600, top: 250, width: 200, height: 200 }, left: 500, top: 50 }
    ]);
  });

  it("scales logical px to snapshot px on a Retina display", () => {
    const plan = planExtentMask({
      rect: { x: 100, y: 100, w: 400, h: 300 },
      extents: [
        { x: 100, y: 100, w: 200, h: 300 },
        { x: 400, y: 100, w: 100, h: 100 }
      ],
      displayOrigin: ORIGIN,
      scaleFactor: 2,
      snapshot: { width: 2880, height: 1800 }
    });
    expect(plan?.box).toEqual({ left: 200, top: 200, width: 800, height: 600 });
    expect(plan?.layers[0]).toEqual({
      extract: { left: 200, top: 200, width: 400, height: 600 },
      left: 0,
      top: 0
    });
    expect(plan?.layers[1]).toEqual({
      extract: { left: 800, top: 200, width: 200, height: 200 },
      left: 600,
      top: 0
    });
  });

  it("subtracts a secondary display's origin", () => {
    // A display to the right of the primary: global x 1920 is that
    // display's local x 0, and its snapshot starts there.
    const plan = planExtentMask({
      rect: { x: 2020, y: 60, w: 300, h: 200 },
      extents: [{ x: 2020, y: 60, w: 300, h: 200 }],
      displayOrigin: { x: 1920, y: 0 },
      scaleFactor: 1,
      snapshot: { width: 1440, height: 900 }
    });
    expect(plan?.box).toEqual({ left: 100, top: 60, width: 300, height: 200 });
    expect(plan?.layers[0]?.extract).toEqual({ left: 100, top: 60, width: 300, height: 200 });
  });

  it("clips an extent that hangs off the display edge", () => {
    // A window running past the right edge of the screen: only the
    // on-screen part exists in the snapshot.
    const plan = plan1x({ x: 1700, y: 100, w: 400, h: 200 }, [
      { x: 1700, y: 100, w: 400, h: 200 }
    ]);
    expect(plan?.box).toEqual({ left: 1700, top: 100, width: 220, height: 200 });
    expect(plan?.layers[0]).toEqual({
      extract: { left: 1700, top: 100, width: 220, height: 200 },
      left: 0,
      top: 0
    });
  });

  it("clamps a union box that starts off the top-left to the snapshot", () => {
    // Negative coordinates happen on multi-display setups where a
    // window straddles a boundary. The extract must never be negative
    // and the composite offset must never be negative — sharp throws
    // on both.
    const plan = plan1x({ x: -50, y: -30, w: 400, h: 300 }, [
      { x: -50, y: -30, w: 400, h: 300 }
    ]);
    expect(plan?.box).toEqual({ left: 0, top: 0, width: 350, height: 270 });
    expect(plan?.layers[0]).toEqual({
      extract: { left: 0, top: 0, width: 350, height: 270 },
      left: 0,
      top: 0
    });
  });

  it("drops an extent entirely outside the union box", () => {
    const plan = plan1x({ x: 100, y: 100, w: 200, h: 200 }, [
      { x: 100, y: 100, w: 200, h: 200 },
      { x: 900, y: 900, w: 100, h: 100 }
    ]);
    expect(plan?.layers).toHaveLength(1);
  });

  it("returns null when nothing survives clipping", () => {
    // Wholly off-screen pick — no pixels to composite, so the caller
    // must fail loudly rather than write an empty PNG.
    expect(
      plan1x({ x: 4000, y: 4000, w: 200, h: 200 }, [{ x: 4000, y: 4000, w: 200, h: 200 }])
    ).toBeNull();
  });

  it("returns null for degenerate input", () => {
    expect(plan1x({ x: 0, y: 0, w: 0, h: 100 }, [{ x: 0, y: 0, w: 10, h: 10 }])).toBeNull();
    expect(plan1x({ x: 0, y: 0, w: 100, h: 100 }, [])).toBeNull();
    expect(
      planExtentMask({
        rect: { x: 0, y: 0, w: 100, h: 100 },
        extents: [{ x: 0, y: 0, w: 10, h: 10 }],
        displayOrigin: ORIGIN,
        scaleFactor: 1,
        snapshot: { width: 0, height: 0 }
      })
    ).toBeNull();
  });

  it("never emits a zero-width extract from a sub-pixel extent", () => {
    // 0.4 logical px at 1x rounds to 0 — Math.max(1, …) keeps it a
    // legal extract instead of making sharp throw.
    const plan = plan1x({ x: 10, y: 10, w: 100, h: 100 }, [{ x: 10, y: 10, w: 0.4, h: 0.4 }]);
    expect(plan?.layers[0]?.extract.width).toBeGreaterThan(0);
    expect(plan?.layers[0]?.extract.height).toBeGreaterThan(0);
  });
});

describe("isExtentRect", () => {
  it("accepts a well-formed extent", () => {
    expect(isExtentRect({ x: 0, y: 0, w: 10, h: 10 })).toBe(true);
    expect(isExtentRect({ x: -5, y: -5, w: 1, h: 1 })).toBe(true);
  });

  it("rejects anything sharp would choke on", () => {
    expect(isExtentRect(null)).toBe(false);
    expect(isExtentRect("nope")).toBe(false);
    expect(isExtentRect({ x: 0, y: 0, w: 10 })).toBe(false);
    expect(isExtentRect({ x: 0, y: 0, w: "10", h: 10 })).toBe(false);
    expect(isExtentRect({ x: Number.NaN, y: 0, w: 10, h: 10 })).toBe(false);
    expect(isExtentRect({ x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 10 })).toBe(false);
    // Zero / negative area.
    expect(isExtentRect({ x: 0, y: 0, w: 0, h: 10 })).toBe(false);
    expect(isExtentRect({ x: 0, y: 0, w: 10, h: -1 })).toBe(false);
  });

  it("caps a pick at a size a real user can produce", () => {
    expect(MAX_SELECTOR_EXTENTS).toBe(64);
  });
});

// The plan is only useful if sharp actually produces transparency
// where no layer was placed. This runs the real composite the crop
// path runs — on a synthetic snapshot, so it needs no screen, no
// Electron, and no capture permission.
describe("planExtentMask → sharp composite", () => {
  it("keeps the extents opaque and leaves the gap transparent", async () => {
    const { default: sharp } = await import("sharp");
    // A 40×20 solid-red "screen".
    const snapshot = await sharp({
      create: { width: 40, height: 20, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } }
    })
      .png()
      .toBuffer();

    // Two 10-wide windows with a 10-wide gap between them.
    const plan = planExtentMask({
      rect: { x: 0, y: 0, w: 30, h: 20 },
      extents: [
        { x: 0, y: 0, w: 10, h: 20 },
        { x: 20, y: 0, w: 10, h: 20 }
      ],
      displayOrigin: { x: 0, y: 0 },
      scaleFactor: 1,
      snapshot: { width: 40, height: 20 }
    });
    expect(plan).not.toBeNull();
    if (plan === null) return;

    const layers = [];
    for (const layer of plan.layers) {
      layers.push({
        input: await sharp(snapshot).extract(layer.extract).png().toBuffer(),
        left: layer.left,
        top: layer.top
      });
    }
    const out = await sharp({
      create: {
        width: plan.box.width,
        height: plan.box.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite(layers)
      .png({ palette: false })
      .toBuffer();

    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(30);
    expect(info.height).toBe(20);
    expect(info.channels).toBe(4);
    const alphaAt = (x: number, y: number): number => data[(y * info.width + x) * 4 + 3] ?? -1;
    const redAt = (x: number, y: number): number => data[(y * info.width + x) * 4] ?? -1;
    // Inside extent 1 and extent 2: opaque, original pixels.
    expect(alphaAt(5, 10)).toBe(255);
    expect(redAt(5, 10)).toBe(255);
    expect(alphaAt(25, 10)).toBe(255);
    expect(redAt(25, 10)).toBe(255);
    // The gap between them: fully transparent.
    expect(alphaAt(15, 10)).toBe(0);
    // ...on both edges of the gap, so it isn't a one-pixel seam.
    expect(alphaAt(10, 0)).toBe(0);
    expect(alphaAt(19, 19)).toBe(0);
  });
});
