import { describe, expect, test } from "vitest";
import {
  clipDetailForWidth,
  pxPerSecFor,
  TIMELINE_PX_PER_SEC_1X,
  zoomIn,
  zoomOut
} from "../density";

describe("density ladder", () => {
  test("clip detail by rendered width: full ≥ 96, thumb ≥ 24, tick below", () => {
    expect(clipDetailForWidth(200)).toBe("full");
    expect(clipDetailForWidth(96)).toBe("full");
    expect(clipDetailForWidth(95)).toBe("thumb");
    expect(clipDetailForWidth(24)).toBe("thumb");
    expect(clipDetailForWidth(23)).toBe("tick");
    expect(clipDetailForWidth(2)).toBe("tick");
  });

  test("80 clips over 60 s in a 900 px strip are ticks at fit, thumbs at 2×, full at 4×", () => {
    const fit = pxPerSecFor("fit", 900, 60); // 15 px/s
    expect(clipDetailForWidth((60 / 80) * fit)).toBe("tick");
    expect(clipDetailForWidth((60 / 80) * pxPerSecFor(2, 900, 60))).toBe("thumb"); // 60 px
    expect(clipDetailForWidth((60 / 80) * pxPerSecFor(4, 900, 60))).toBe("full"); // 120 px
  });

  test("fit px/sec is width / duration; presets are absolute", () => {
    expect(pxPerSecFor("fit", 1000, 20)).toBe(50);
    expect(pxPerSecFor("fit", 1000, 0)).toBe(0);
    expect(pxPerSecFor(1, 1000, 20)).toBe(TIMELINE_PX_PER_SEC_1X);
    expect(pxPerSecFor(4, 1000, 20)).toBe(TIMELINE_PX_PER_SEC_1X * 4);
  });

  test("zoom in from fit skips presets that are not denser than fit; zoom out never goes below fit", () => {
    // A short reel fits at 55 px/s — denser than 1× (40), so ⌘+ goes to 2×.
    expect(zoomIn("fit", 55)).toBe(2);
    expect(zoomIn(2, 55)).toBe(4);
    expect(zoomIn(4, 55)).toBe(4);
    // ⌘− from 2× would land on 1× (40 px/s), which is LESS dense than fit
    // (55) — that would leave empty track past the reel, so it jumps to fit.
    expect(zoomOut(2, 55)).toBe("fit");
    expect(zoomOut("fit", 55)).toBe("fit");
    // A long reel fits at 15 px/s: the ladder is the plain preset ladder.
    expect(zoomIn("fit", 15)).toBe(1);
    expect(zoomOut(1, 15)).toBe("fit");
    expect(zoomOut(4, 15)).toBe(2);
  });
});
