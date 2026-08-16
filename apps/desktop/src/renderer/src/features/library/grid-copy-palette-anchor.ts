// Placement math for the Grid copy palette's `follow` anchor mode.
//
// Pure geometry so the flip logic is unit-testable without a DOM: given
// the stage box (`.psl__main`), the selected tile's box, and the
// palette's own measured box — all in VIEWPORT coordinates — return the
// STAGE-RELATIVE top-left the palette should paint at.
//
// Placement is popover-style and tried in a fixed order, taking the
// first candidate that fits inside the stage without covering the tile:
//
//   below → above → right → left
//
// If none fit (a tile taller/wider than the stage minus the palette,
// which happens at 1-column zoom on a short window), we fall back to
// the side with the most room and clamp — the palette may then overlap
// the tile, but it stays on-screen and reachable, which matters more.
//
// Coordinates are stage-relative because `.psl__grid-copy-palette` is
// `position: absolute` inside `.psl__main`; that also means a saved
// spot survives a sidebar/window resize the same way EditToolbar's
// does.

/** Axis-aligned box in viewport coordinates. Structurally a subset of
 *  DOMRect so callers can pass `getBoundingClientRect()` straight in. */
export type AnchorBox = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

export type AnchorPlacement = "below" | "above" | "right" | "left";

export type AnchorResult = {
  /** Stage-relative x of the palette's left edge. */
  readonly x: number;
  /** Stage-relative y of the palette's top edge. */
  readonly y: number;
  readonly placement: AnchorPlacement;
};

/** Gap between the tile edge and the palette edge. */
export const ANCHOR_GAP_PX = 12;
/** Minimum breathing room between the palette and the stage edges. */
export const ANCHOR_MARGIN_PX = 8;

function clamp(value: number, min: number, max: number): number {
  // `max < min` happens when the palette is wider/taller than the
  // available band; prefer the min edge so it stays anchored to the
  // top/left of the stage rather than drifting off the far edge.
  return Math.min(Math.max(min, max), Math.max(min, value));
}

/**
 * Resolve the stage-relative position for `follow` mode.
 *
 * All three boxes are viewport-space (`getBoundingClientRect()`); the
 * returned point is stage-space. Returns `null` when the stage has no
 * area yet (pre-layout / display:none), so callers can leave the
 * palette at its CSS default instead of pinning it to (0,0).
 */
export function resolveFollowAnchor(input: {
  readonly stage: AnchorBox;
  readonly tile: AnchorBox;
  readonly palette: AnchorBox;
  readonly gap?: number;
  readonly margin?: number;
}): AnchorResult | null {
  const { stage, tile, palette } = input;
  if (stage.width <= 0 || stage.height <= 0) return null;
  const gap = input.gap ?? ANCHOR_GAP_PX;
  const margin = input.margin ?? ANCHOR_MARGIN_PX;

  const stageLeft = stage.left;
  const stageTop = stage.top;
  const stageRight = stage.left + stage.width;
  const stageBottom = stage.top + stage.height;
  const tileRight = tile.left + tile.width;
  const tileBottom = tile.top + tile.height;

  // Horizontal/vertical centering used by the below/above and
  // right/left arms respectively — the palette lines up on the tile's
  // midpoint, then gets clamped into the stage below.
  const centeredX = tile.left + tile.width / 2 - palette.width / 2;
  const centeredY = tile.top + tile.height / 2 - palette.height / 2;

  const minX = stageLeft + margin;
  const maxX = stageRight - palette.width - margin;
  const minY = stageTop + margin;
  const maxY = stageBottom - palette.height - margin;

  const candidates: readonly {
    placement: AnchorPlacement;
    left: number;
    top: number;
    fits: boolean;
  }[] = [
    {
      placement: "below",
      left: clamp(centeredX, minX, maxX),
      top: tileBottom + gap,
      fits: tileBottom + gap + palette.height <= stageBottom - margin
    },
    {
      placement: "above",
      left: clamp(centeredX, minX, maxX),
      top: tile.top - gap - palette.height,
      fits: tile.top - gap - palette.height >= stageTop + margin
    },
    {
      placement: "right",
      left: tileRight + gap,
      top: clamp(centeredY, minY, maxY),
      fits: tileRight + gap + palette.width <= stageRight - margin
    },
    {
      placement: "left",
      left: tile.left - gap - palette.width,
      top: clamp(centeredY, minY, maxY),
      fits: tile.left - gap - palette.width >= stageLeft + margin
    }
  ];

  const chosen =
    candidates.find((c) => c.fits) ??
    // Nothing fits — pick whichever side has the most slack and let the
    // clamp below keep the palette on-screen.
    (stageBottom - tileBottom >= tile.top - stageTop
      ? candidates[0]
      : candidates[1]);

  return {
    x: clamp(chosen.left, minX, maxX) - stageLeft,
    y: clamp(chosen.top, minY, maxY) - stageTop,
    placement: chosen.placement
  };
}
