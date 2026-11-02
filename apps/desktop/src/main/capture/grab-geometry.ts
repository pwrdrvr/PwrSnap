// Does a screen grab actually depict the display it was asked for?
//
// On macOS the question does not arise: `screencapture -R <bounds>` is
// TOLD the rect. Everywhere else the grab comes from
// `desktopCapturer.getSources`, which returns a LIST and leaves the
// caller to pick — and the only authoritative key, `display_id`, is
// documented as "an empty string if not available". When it is empty
// `captureDisplayNativeImage` guesses: the lone source when there is
// exactly one, otherwise the source at this display's index.
//
// Under an xdg-desktop-portal session that is not a guess about
// ORDERING, it is a guess about a different question entirely. The
// portal — not the app — decides what gets shared: the user is shown a
// picker and may hand back another monitor, a single window, or the
// whole multi-monitor desktop. Chromium surfaces one opaque source for
// all of those, so the `sources.length === 1` branch takes it with no
// `display_id` and, deliberately, no warning: on a single-monitor
// machine that branch is normally correct.
//
// Nothing downstream questions it. The selector renderer paints the
// grab with `object-fit: fill`, so a grab of the wrong shape is
// STRETCHED to the overlay rather than reported, and the crop maps the
// user's rect through `display.scaleFactor`, which describes the
// display and knows nothing about the grab. The user drags a box over
// content that is not where the box lands, and the file they get is
// pixels they never saw.
//
// Aspect ratio is the one property checkable without trusting the thing
// under test. `thumbnailSize` is a MAXIMUM and Chromium preserves
// aspect while scaling into it, so a healthy grab matches the display's
// aspect to within pixel rounding whatever size it comes back at — that
// is why this checks shape and not size. A different monitor of a
// different shape, a window, or a stitched multi-monitor desktop does
// not match.
//
// Necessary, not sufficient: two 16:9 monitors are indistinguishable
// this way, and so is a window that happens to share the display's
// shape. `display_id` is what separates those, and it is still tried
// first. This is the backstop for when it is absent.

/** Fraction by which a grab's aspect ratio may differ from its display's.
 *  Pixel rounding on a 1496-px-wide display moves the ratio by ~0.07%, so
 *  1% is far outside any healthy grab while still catching 16:9 vs 16:10
 *  (11% apart) and a dual-monitor desktop (100%+ apart). */
export const GRAB_ASPECT_TOLERANCE = 0.01;

export type GrabGeometryVerdict =
  | { readonly ok: true; readonly aspectDrift: number }
  | { readonly ok: false; readonly message: string };

type Size = { readonly width: number; readonly height: number };

function usableSize(size: Size): boolean {
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

/**
 * Compare a grab's shape against the display it is claimed to depict.
 *
 * `bounds` is the display's LOGICAL size; `grab` is in physical pixels.
 * The scale between them is deliberately not constrained — only the
 * ratio of the two axes is, because that is the part a wrong source
 * cannot fake and a legitimate downscale cannot break.
 */
export function checkGrabMatchesDisplay(args: {
  grab: Size;
  bounds: Size;
  tolerance?: number;
}): GrabGeometryVerdict {
  const { grab, bounds } = args;
  const tolerance = args.tolerance ?? GRAB_ASPECT_TOLERANCE;
  if (!usableSize(grab)) {
    return {
      ok: false,
      message: `screen grab has unusable dimensions ${grab.width}x${grab.height}`
    };
  }
  if (!usableSize(bounds)) {
    return {
      ok: false,
      message: `display has unusable bounds ${bounds.width}x${bounds.height}`
    };
  }
  const grabAspect = grab.width / grab.height;
  const displayAspect = bounds.width / bounds.height;
  const aspectDrift = Math.abs(grabAspect - displayAspect) / displayAspect;
  if (aspectDrift > tolerance) {
    return {
      ok: false,
      message:
        `screen grab is ${grab.width}x${grab.height} (aspect ${round(grabAspect)}) but the ` +
        `display is ${bounds.width}x${bounds.height} logical (aspect ${round(displayAspect)}) — ` +
        `${round(aspectDrift * 100)}% off, past the ${round(tolerance * 100)}% tolerance. ` +
        `The grab is of something other than this display.`
    };
  }
  return { ok: true, aspectDrift };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
