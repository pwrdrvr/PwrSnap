// Presenter geometry — how the camera track sits on the output canvas.
//
// Vocabulary: CAMERA is the source (device, file, timeline lane).
// PRESENTER is the object drawn on the canvas. `AvatarStyle` is the stored
// shape of the presenter; every editor control and both renderers (the
// stage preview and the FFmpeg export) go through these helpers so the
// preview and the file agree.
//
// Coordinates: `x` / `y` are the presenter's top-left as fractions of the
// canvas, `width` is a fraction of the canvas WIDTH. The height is not
// stored; it falls out of the crop's pixel aspect and the canvas aspect,
// which is why most helpers take a `PresenterGeometry`.

import type { AvatarStyle, CameraTrackMetadata } from "./camera";

export type PresenterLook = "cut" | "circle" | "rounded" | "square";
export type PresenterFraming = "face" | "upper" | "full";
export type PresenterSize = "small" | "medium" | "large";
export type PresenterAnchor = {
  h: "left" | "center" | "right";
  v: "top" | "middle" | "bottom";
};
export type PresenterCrop = AvatarStyle["crop"];

export type PresenterGeometry = {
  /** Camera width / height, in pixels. */
  cameraAspect: number;
  /** Output canvas width / height, in pixels. */
  canvasAspect: number;
};

export const PRESENTER_SIZES: Readonly<Record<PresenterSize, number>> = {
  small: 0.16,
  medium: 0.24,
  large: 0.34
};
export const PRESENTER_MIN_WIDTH = 0.08;
export const PRESENTER_MAX_WIDTH = 0.6;
/** Gap to the canvas edge, as a fraction of canvas WIDTH on both axes so
 *  the gap is the same number of pixels horizontally and vertically. */
export const PRESENTER_MARGIN = 0.025;
/** One sync nudge — a frame at 30 fps. */
export const PRESENTER_SYNC_STEP_SEC = 1 / 30;
export const PRESENTER_SYNC_LIMIT_SEC = 10;

const FULL_CROP: PresenterCrop = { x: 0, y: 0, width: 1, height: 1 };

export function geometryFor(
  camera: Pick<CameraTrackMetadata, "width" | "height">,
  canvas: { width: number; height: number }
): PresenterGeometry {
  return {
    cameraAspect: camera.width / Math.max(1, camera.height),
    canvasAspect: canvas.width / Math.max(1, canvas.height)
  };
}

export function presenterLook(style: AvatarStyle): PresenterLook {
  if (style.background === "remove") return "cut";
  if (style.shape === "circle") return "circle";
  if (style.shape === "rounded") return "rounded";
  return "square";
}

/** Pixel aspect (width / height) of what the presenter draws. */
export function presenterAspect(crop: PresenterCrop, cameraAspect: number): number {
  return (crop.width / crop.height) * cameraAspect;
}

/** Height as a fraction of canvas height. */
export function presenterHeight(style: AvatarStyle, geometry: PresenterGeometry): number {
  return (style.width * geometry.canvasAspect) / presenterAspect(style.crop, geometry.cameraAspect);
}

const round = (value: number): number => Math.round(value * 10000) / 10000;

function centeredCrop(width: number, height: number, top: number): PresenterCrop {
  const w = Math.min(1, Math.max(0.05, width));
  const h = Math.min(1, Math.max(0.05, height));
  return {
    x: round((1 - w) / 2),
    y: round(Math.min(Math.max(0, top), 1 - h)),
    width: round(w),
    height: round(h)
  };
}

/** Shrink a crop to a square in PIXELS, keeping its top edge and centre. */
function squareCrop(crop: PresenterCrop, cameraAspect: number): PresenterCrop {
  const aspect = presenterAspect(crop, cameraAspect);
  if (Math.abs(aspect - 1) < 0.001) return crop;
  if (aspect > 1) {
    const width = crop.height / cameraAspect;
    return { ...crop, x: round(crop.x + (crop.width - width) / 2), width: round(width) };
  }
  return { ...crop, height: round(crop.width * cameraAspect) };
}

/**
 * The crop a framing preset means for this camera. `face` is a square
 * around the top-centre, `upper` is a 4:3 head-and-shoulders cut, `full`
 * is the whole camera. A circle is always square, whatever the framing.
 */
export function framingCrop(
  framing: PresenterFraming,
  cameraAspect: number,
  look: PresenterLook = "cut"
): PresenterCrop {
  let crop: PresenterCrop;
  switch (framing) {
    case "full":
      crop = FULL_CROP;
      break;
    case "upper": {
      const width = (0.8 * (4 / 3)) / cameraAspect;
      crop =
        width <= 1 ? centeredCrop(width, 0.8, 0) : centeredCrop(1, cameraAspect / (4 / 3), 0);
      break;
    }
    case "face": {
      const width = 0.7 / cameraAspect;
      crop = width <= 1 ? centeredCrop(width, 0.7, 0.05) : centeredCrop(1, cameraAspect, 0.05);
      break;
    }
  }
  return look === "circle" ? squareCrop(crop, cameraAspect) : crop;
}

const cropsMatch = (a: PresenterCrop, b: PresenterCrop): boolean =>
  Math.abs(a.x - b.x) < 0.002 &&
  Math.abs(a.y - b.y) < 0.002 &&
  Math.abs(a.width - b.width) < 0.002 &&
  Math.abs(a.height - b.height) < 0.002;

/** Which preset the stored crop is, or `null` for a hand-made crop. */
export function presenterFraming(
  style: AvatarStyle,
  cameraAspect: number
): PresenterFraming | null {
  const look = presenterLook(style);
  for (const framing of ["face", "upper", "full"] as const) {
    if (cropsMatch(style.crop, framingCrop(framing, cameraAspect, look))) return framing;
  }
  return null;
}

export function presenterSize(style: AvatarStyle): PresenterSize | null {
  for (const size of ["small", "medium", "large"] as const) {
    if (Math.abs(style.width - PRESENTER_SIZES[size]) < 0.004) return size;
  }
  return null;
}

/** The canvas ninth the presenter's centre sits in. */
export function presenterAnchor(style: AvatarStyle, geometry: PresenterGeometry): PresenterAnchor {
  const cx = style.x + style.width / 2;
  const cy = style.y + presenterHeight(style, geometry) / 2;
  return {
    h: cx < 1 / 3 ? "left" : cx > 2 / 3 ? "right" : "center",
    v: cy < 1 / 3 ? "top" : cy > 2 / 3 ? "bottom" : "middle"
  };
}

/** Keep the presenter on the canvas. Width is clamped first. */
export function clampPresenter(style: AvatarStyle, geometry: PresenterGeometry): AvatarStyle {
  const width = round(Math.min(PRESENTER_MAX_WIDTH, Math.max(PRESENTER_MIN_WIDTH, style.width)));
  const sized = { ...style, width };
  const height = presenterHeight(sized, geometry);
  return {
    ...sized,
    x: round(Math.min(Math.max(0, style.x), Math.max(0, 1 - width))),
    y: round(Math.min(Math.max(0, style.y), Math.max(0, 1 - height)))
  };
}

function marginY(geometry: PresenterGeometry): number {
  return PRESENTER_MARGIN * geometry.canvasAspect;
}

/** Snap targets per axis. A cut-out sits flush on the bottom edge — a
 *  person cut off at the waist reads as standing on the frame, while the
 *  same cut floating a few pixels up reads as a mistake. */
function snapTargets(style: AvatarStyle, geometry: PresenterGeometry) {
  const w = style.width;
  const h = presenterHeight(style, geometry);
  const flush = presenterLook(style) === "cut";
  return {
    x: { left: PRESENTER_MARGIN, center: (1 - w) / 2, right: 1 - PRESENTER_MARGIN - w },
    y: {
      top: marginY(geometry),
      middle: (1 - h) / 2,
      bottom: flush ? 1 - h : 1 - marginY(geometry) - h
    }
  };
}

export function placeAt(
  style: AvatarStyle,
  anchor: PresenterAnchor,
  geometry: PresenterGeometry
): AvatarStyle {
  const targets = snapTargets(style, geometry);
  return clampPresenter(
    { ...style, x: targets.x[anchor.h], y: targets.y[anchor.v] },
    geometry
  );
}

export type PresenterSnapGuides = { x: number | null; y: number | null };

/**
 * Where a free drag lands. Each axis snaps to the nearest edge or centre
 * line within `threshold` (canvas fractions); `guides` says which lines
 * caught it, as canvas-fraction positions of the guide, for drawing.
 */
export function snapDrag(
  style: AvatarStyle,
  geometry: PresenterGeometry,
  threshold = 0.025
): { style: AvatarStyle; guides: PresenterSnapGuides } {
  const targets = snapTargets(style, geometry);
  const w = style.width;
  const h = presenterHeight(style, geometry);
  let x = style.x;
  let y = style.y;
  let gx: number | null = null;
  let gy: number | null = null;
  for (const [key, target] of Object.entries(targets.x)) {
    if (Math.abs(style.x - target) <= threshold) {
      x = target;
      gx = key === "left" ? target : key === "right" ? target + w : 0.5;
      break;
    }
  }
  for (const [key, target] of Object.entries(targets.y)) {
    if (Math.abs(style.y - target) <= threshold * geometry.canvasAspect) {
      y = target;
      gy = key === "top" ? target : key === "bottom" ? target + h : 0.5;
      break;
    }
  }
  return { style: clampPresenter({ ...style, x, y }, geometry), guides: { x: gx, y: gy } };
}

/**
 * Apply a change that alters the presenter's size or aspect (look,
 * framing, size) without moving it off the corner it was in: the edges
 * nearest the canvas edges keep their gap.
 */
export function reanchor(
  before: AvatarStyle,
  after: AvatarStyle,
  geometry: PresenterGeometry
): AvatarStyle {
  const anchor = presenterAnchor(before, geometry);
  const h0 = presenterHeight(before, geometry);
  const w1 = after.width;
  const h1 = presenterHeight(after, geometry);
  const x =
    anchor.h === "left"
      ? before.x
      : anchor.h === "right"
        ? before.x + before.width - w1
        : before.x + (before.width - w1) / 2;
  let y =
    anchor.v === "top"
      ? before.y
      : anchor.v === "bottom"
        ? before.y + h0 - h1
        : before.y + (h0 - h1) / 2;
  if (anchor.v === "bottom") {
    // Entering a cut-out drops the presenter onto the edge; leaving one
    // lifts it back to the margin.
    const wasFlush = before.y + h0 >= 0.999;
    if (presenterLook(after) === "cut") y = 1 - h1;
    else if (wasFlush) y = 1 - marginY(geometry) - h1;
  }
  return clampPresenter({ ...after, x, y }, geometry);
}

export function withLook(
  style: AvatarStyle,
  look: PresenterLook,
  geometry: PresenterGeometry
): AvatarStyle {
  if (look === presenterLook(style)) return style;
  const framing = presenterFraming(style, geometry.cameraAspect) ?? "upper";
  const next: AvatarStyle =
    look === "cut"
      ? { ...withoutShape(style), background: "remove" }
      : {
          ...style,
          background: "original",
          shape: look === "circle" ? "circle" : look === "rounded" ? "rounded" : "rect"
        };
  // A circle of the whole camera is a face-sized circle — "full" framing
  // has no meaning inside a circle that crops it square anyway.
  const nextFraming = look === "circle" && framing === "full" ? "face" : framing;
  return reanchor(
    style,
    { ...next, crop: framingCrop(nextFraming, geometry.cameraAspect, look) },
    geometry
  );
}

function withoutShape(style: AvatarStyle): AvatarStyle {
  const { shape: _shape, ...rest } = style;
  return rest;
}

export function withFraming(
  style: AvatarStyle,
  framing: PresenterFraming,
  geometry: PresenterGeometry
): AvatarStyle {
  return reanchor(
    style,
    { ...style, crop: framingCrop(framing, geometry.cameraAspect, presenterLook(style)) },
    geometry
  );
}

export function withSize(
  style: AvatarStyle,
  size: PresenterSize,
  geometry: PresenterGeometry
): AvatarStyle {
  return reanchor(style, { ...style, width: PRESENTER_SIZES[size] }, geometry);
}

export function withSyncNudge(style: AvatarStyle, frames: number): AvatarStyle {
  const next = (style.syncOffsetSec ?? 0) + frames * PRESENTER_SYNC_STEP_SEC;
  const clamped = Math.max(-PRESENTER_SYNC_LIMIT_SEC, Math.min(PRESENTER_SYNC_LIMIT_SEC, next));
  return { ...style, syncOffsetSec: Math.round(clamped * 1000) / 1000 };
}

/** The presenter an untouched recording gets: a medium cut-out, head and
 *  shoulders, flush in the bottom-right corner, not mirrored (the export
 *  shows what the camera saw, so text in the shot stays readable). */
export function defaultPresenterStyle(geometry: PresenterGeometry): AvatarStyle {
  const base: AvatarStyle = {
    visible: true,
    background: "remove",
    x: 0,
    y: 0,
    width: PRESENTER_SIZES.medium,
    mirror: false,
    crop: framingCrop("upper", geometry.cameraAspect, "cut")
  };
  return placeAt(base, { h: "right", v: "bottom" }, geometry);
}

/** The stored style if there is one, otherwise the default for this
 *  camera on this canvas. Every renderer resolves through here. */
export function resolvePresenterStyle(
  stored: AvatarStyle | null | undefined,
  geometry: PresenterGeometry
): AvatarStyle {
  return stored ?? defaultPresenterStyle(geometry);
}

/** Corner radius as a fraction of the presenter's SHORTER side. The stage
 *  multiplies it into CSS pixels and the export into an FFmpeg alpha mask,
 *  so the two edges match. */
export function presenterCornerRadius(shape: AvatarStyle["shape"]): number {
  return shape === "circle" ? 0.5 : shape === "rounded" ? 0.16 : 0;
}

export function formatSyncOffset(sec: number | undefined): string {
  const value = sec ?? 0;
  const sign = value > 0.0005 ? "+" : value < -0.0005 ? "−" : "±";
  return `${sign}${Math.abs(value).toFixed(2)} s`;
}
