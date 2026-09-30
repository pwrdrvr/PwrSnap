import { useId } from "react";

type Tier = { x: number; y: number };

const BACK: Tier = { x: 43, y: 27 };
const MID: Tier = { x: 35, y: 41 };
const FRONT: Tier = { x: 27, y: 55 };
const RECT = { width: 58, height: 46, rx: 6 } as const;
const STROKE = 9;

/** One tier's stroke band painted black into a mask: "a tier in front covers here". */
function CutRect({ x, y }: Tier) {
  return (
    <rect
      x={x}
      y={y}
      {...RECT}
      fill="none"
      stroke="#000"
      strokeWidth={STROKE}
      strokeLinejoin="round"
    />
  );
}

/**
 * PwrSnap brand mark — three layered rounded rectangles, suggesting a
 * stack of captured screenshots: front bottom-left at full strength, mid
 * at 0.55, back top-right at 0.3 (the same tiers as the app icon from
 * `scripts/generate-app-icon.swift`). Stroke uses currentColor so the host
 * can recolor; it defaults to `--accent`. See design/AGENTS.md §1.
 *
 * The stack's ink is centred in the 128 box (x 22.5–105.5, y 22.5–105.5),
 * so a flex parent that centres the box centres the drawn mark too — the
 * title strips put it on their y=20 centreline that way.
 *
 * HARD STACK, not a blend: each tier is masked by the stroke bands of the
 * tiers in front of it (back by mid + front, mid by front), so a crossing
 * shows only the front tier instead of compositing the two alphas into a
 * brighter patch. Same construction as `scripts/generate-tray-icon.mjs`.
 * The mark renders many times per document, so the mask ids come from
 * `useId` — a shared id would resolve to whichever copy came first.
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
  // useId output carries punctuation (`:r0:`, `«r0»`, `_r_0_` by React
  // version); keep only what is safe unescaped inside `url(#…)`.
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const behindFront = `ps-mark-${uid}-behind-front`;
  const behindMidFront = `ps-mark-${uid}-behind-mid-front`;
  return (
    <svg
      viewBox="0 0 128 128"
      width={size}
      height={size}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "PwrSnap" })}
      style={{ display: "block", color: "var(--accent)" }}
    >
      <defs>
        <mask id={behindFront} maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
          <rect width="128" height="128" fill="#fff" />
          <CutRect {...FRONT} />
        </mask>
        <mask id={behindMidFront} maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
          <rect width="128" height="128" fill="#fff" />
          <CutRect {...MID} />
          <CutRect {...FRONT} />
        </mask>
      </defs>
      <g fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round">
        <rect
          x={BACK.x}
          y={BACK.y}
          {...RECT}
          strokeOpacity={0.3}
          mask={`url(#${behindMidFront})`}
        />
        <rect x={MID.x} y={MID.y} {...RECT} strokeOpacity={0.55} mask={`url(#${behindFront})`} />
        <rect x={FRONT.x} y={FRONT.y} {...RECT} />
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
