import { useId } from "react";

/**
 * The app icon's glyph (`scripts/generate-app-icon.swift`), redrawn from the
 * same 1024-box coordinates with AppKit's y-up flipped to SVG's y-down: three
 * 450×340 rounded rectangles (rx 48, stroke 56) stepped 64 across and 80 up,
 * front bottom-left at full strength, mid at 0.55, back top-right at 0.3.
 * Any change to the icon's mark is a change here too — see design/AGENTS.md §1.
 */
const RECT = { width: 450, height: 340, rx: 48 } as const;
const STROKE = 56;
const FRONT = { x: 223, y: 422 } as const;
const MID = { x: 287, y: 342 } as const;
const BACK = { x: 351, y: 262 } as const;

/**
 * The glyph's own bounds (x 195–829, y 234–790, stroke included) squared
 * about their centre, so the mark fills its box edge to edge and its ink is
 * centred in it. That is the Pwr-family convention (PwrGit's `PwrGitMark`
 * does the same), and it is what lets a flex parent that centres the box put
 * the drawn mark on a title strip's y=20 centreline.
 */
const VIEW_BOX = "195 195 634 634";

/** One tier's rectangle outline. */
function tierRect(at: { x: number; y: number }, extra: Record<string, unknown> = {}) {
  return <rect x={at.x} y={at.y} width={RECT.width} height={RECT.height} rx={RECT.rx} {...extra} />;
}

/** A tier's stroke band painted black into a luminance mask: whatever it
 *  covers is cut out of the tiers behind it. */
function cutout(at: { x: number; y: number }) {
  return tierRect(at, {
    fill: "none",
    stroke: "#000",
    strokeWidth: STROKE,
    strokeLinejoin: "round"
  });
}

/**
 * PwrSnap brand mark — the stacked-screenshots glyph from the app icon.
 * Stroke uses currentColor, pinned to `--accent` on the svg itself so the
 * surrounding text color never leaks in.
 *
 * HARD STACK, not a blend: each tier is masked by the stroke bands of the
 * tiers in front of it, exactly as the icon generator clips them, so the mid
 * and front strokes keep their own opacity everywhere they are seen and the
 * back tier is simply behind them. Plain `strokeOpacity` layering would let
 * the 0.3 back stroke show through the 0.55 mid one and light up every
 * crossing. Mask ids come from `useId`, so every instance on a page (title
 * strip, tray, float-over) references its own masks.
 *
 * `decorative` hides it from assistive tech. Pass it wherever the wordmark
 * sits next to the mark and already names the app.
 */
export function PwrSnapMark({
  size = 16,
  decorative = false
}: {
  size?: number;
  decorative?: boolean;
}) {
  // useId's punctuation (":r0:", "«r0»", "_r_0_") varies by React version and
  // is not safe inside `url(#…)`; keep it to plain id characters.
  const id = `pwrsnap-mark-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const behindFront = `${id}-behind-front`;
  const behindMidFront = `${id}-behind-mid-front`;
  const mask = { maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 1024, height: 1024 } as const;
  return (
    <svg
      viewBox={VIEW_BOX}
      width={size}
      height={size}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "PwrSnap" })}
      style={{ display: "block", color: "var(--accent)" }}
    >
      <defs>
        <mask id={behindFront} {...mask}>
          <rect x={0} y={0} width={1024} height={1024} fill="#fff" />
          {cutout(FRONT)}
        </mask>
        <mask id={behindMidFront} {...mask}>
          <rect x={0} y={0} width={1024} height={1024} fill="#fff" />
          {cutout(MID)}
          {cutout(FRONT)}
        </mask>
      </defs>
      <g fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round">
        {tierRect(BACK, { strokeOpacity: 0.3, mask: `url(#${behindMidFront})` })}
        {tierRect(MID, { strokeOpacity: 0.55, mask: `url(#${behindFront})` })}
        {tierRect(FRONT)}
      </g>
    </svg>
  );
}

/**
 * "PwrSnap" wordmark — single inline span so it never gets split by a
 * flex gap on its parent. "Pwr" inherits text color, "Snap" picks up the
 * accent.
 */
export function PwrSnapWordmark() {
  return (
    <span className="pwrsnap-wordmark">
      Pwr<span className="pwrsnap-wordmark__a">Snap</span>
    </span>
  );
}
