import { describe, expect, test } from "vitest";
import { AvatarStyleSchema, DEFAULT_AVATAR_STYLE } from "../camera";
import {
  defaultPresenterStyle,
  formatSyncOffset,
  framingCrop,
  placeAt,
  presenterAnchor,
  presenterAspect,
  presenterFraming,
  presenterHeight,
  presenterLook,
  presenterSize,
  snapDrag,
  withFraming,
  withLook,
  withSize,
  withSyncNudge,
  type PresenterGeometry
} from "../presenter";

const wide: PresenterGeometry = { cameraAspect: 16 / 9, canvasAspect: 16 / 9 };
const screen: PresenterGeometry = { cameraAspect: 16 / 9, canvasAspect: 16 / 10 };

describe("presenter defaults", () => {
  test("the stored default is the computed default for a 16:9 camera on a 16:9 canvas", () => {
    const computed = defaultPresenterStyle(wide);
    expect(computed.x).toBeCloseTo(DEFAULT_AVATAR_STYLE.x, 3);
    expect(computed.y).toBeCloseTo(DEFAULT_AVATAR_STYLE.y, 3);
    expect(computed.width).toBe(DEFAULT_AVATAR_STYLE.width);
    expect(computed.crop).toEqual(DEFAULT_AVATAR_STYLE.crop);
    expect(computed.mirror).toBe(false);
  });

  test("a cut-out starts flush on the bottom edge, inset from the right", () => {
    const style = defaultPresenterStyle(screen);
    expect(presenterLook(style)).toBe("cut");
    expect(style.y + presenterHeight(style, screen)).toBeCloseTo(1, 3);
    expect(style.x + style.width).toBeCloseTo(0.975, 3);
    expect(AvatarStyleSchema.safeParse(style).success).toBe(true);
  });
});

describe("framing", () => {
  test("upper body is 4:3 and a face is square, on any camera", () => {
    for (const cameraAspect of [16 / 9, 4 / 3, 9 / 16]) {
      expect(presenterAspect(framingCrop("upper", cameraAspect), cameraAspect)).toBeCloseTo(4 / 3, 2);
      expect(presenterAspect(framingCrop("face", cameraAspect), cameraAspect)).toBeCloseTo(1, 2);
    }
  });

  test("a circle crops square whatever framing it was given", () => {
    const crop = framingCrop("upper", 16 / 9, "circle");
    expect(presenterAspect(crop, 16 / 9)).toBeCloseTo(1, 3);
    expect(crop.y).toBe(0);
  });

  test("reads the preset back from a stored crop", () => {
    const style = withFraming(defaultPresenterStyle(screen), "face", screen);
    expect(presenterFraming(style, screen.cameraAspect)).toBe("face");
    expect(
      presenterFraming({ ...style, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }, 16 / 9)
    ).toBeNull();
  });
});

describe("looks", () => {
  test("switching look keeps the presenter in its corner", () => {
    const cut = defaultPresenterStyle(screen);
    const circle = withLook(cut, "circle", screen);
    expect(presenterLook(circle)).toBe("circle");
    expect(circle.background).toBe("original");
    expect(presenterAnchor(circle, screen)).toEqual({ h: "right", v: "bottom" });
    // Off the edge, back to the margin.
    expect(circle.y + presenterHeight(circle, screen)).toBeLessThan(0.99);
    expect(circle.x + circle.width).toBeCloseTo(cut.x + cut.width, 3);
    const back = withLook(circle, "cut", screen);
    expect(back.shape).toBeUndefined();
    expect(back.y + presenterHeight(back, screen)).toBeCloseTo(1, 3);
  });

  test("a whole-camera circle becomes a face circle", () => {
    const square = withLook(withFraming(defaultPresenterStyle(screen), "full", screen), "square", screen);
    expect(presenterFraming(square, 16 / 9)).toBe("full");
    expect(presenterFraming(withLook(square, "circle", screen), 16 / 9)).toBe("face");
  });

  test("every look round-trips through the schema", () => {
    let style = defaultPresenterStyle(screen);
    for (const look of ["circle", "rounded", "square", "cut"] as const) {
      style = withLook(style, look, screen);
      expect(AvatarStyleSchema.safeParse(style).success).toBe(true);
      expect(presenterLook(style)).toBe(look);
    }
  });
});

describe("placement", () => {
  test("snaps each axis to the nearest edge or centre and reports the guide", () => {
    const style = { ...defaultPresenterStyle(screen), x: 0.03, y: 0.3 };
    const { style: snapped, guides } = snapDrag(style, screen);
    expect(snapped.x).toBeCloseTo(0.025, 4);
    expect(guides.x).toBeCloseTo(0.025, 4);
    expect(guides.y).toBeNull();
  });

  test("stays on the canvas", () => {
    const style = placeAt({ ...defaultPresenterStyle(screen), x: 5 }, { h: "left", v: "top" }, screen);
    expect(style.x).toBeCloseTo(0.025, 4);
    const dragged = snapDrag({ ...style, x: 0.99, y: 0.99 }, screen).style;
    expect(dragged.x + dragged.width).toBeLessThanOrEqual(1.0001);
    expect(dragged.y + presenterHeight(dragged, screen)).toBeLessThanOrEqual(1.0001);
  });

  test("sizes grow out of the corner they are anchored to", () => {
    const style = defaultPresenterStyle(screen);
    const large = withSize(style, "large", screen);
    expect(presenterSize(large)).toBe("large");
    expect(large.x + large.width).toBeCloseTo(style.x + style.width, 3);
    expect(large.y + presenterHeight(large, screen)).toBeCloseTo(1, 3);
  });
});

describe("sync", () => {
  test("nudges by one frame and formats with a sign", () => {
    const style = withSyncNudge(withSyncNudge(defaultPresenterStyle(screen), 1), 3);
    expect(style.syncOffsetSec).toBeCloseTo(0.133, 3);
    expect(formatSyncOffset(style.syncOffsetSec)).toBe("+0.13 s");
    expect(formatSyncOffset(-0.5)).toBe("−0.50 s");
    expect(formatSyncOffset(undefined)).toBe("±0.00 s");
    expect(withSyncNudge({ ...style, syncOffsetSec: 9.99 }, 3).syncOffsetSec).toBe(10);
  });
});
