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
  return (
    <svg
      viewBox="0 0 128 128"
      width={size}
      height={size}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "PwrSnap" })}
      style={{ display: "block", color: "var(--accent)" }}
    >
      <g fill="none" stroke="currentColor" strokeWidth={9} strokeLinejoin="round">
        <rect x="43" y="27" width="58" height="46" rx="6" strokeOpacity={0.3} />
        <rect x="35" y="41" width="58" height="46" rx="6" strokeOpacity={0.55} />
        <rect x="27" y="55" width="58" height="46" rx="6" />
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
