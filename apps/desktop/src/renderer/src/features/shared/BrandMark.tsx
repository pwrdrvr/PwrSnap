/**
 * PwrSnap brand mark — three layered rounded rectangles, suggesting a
 * stack of captured screenshots. Lifted from `design/assets/logo-pwrsnap.svg`.
 * Stroke uses currentColor so the host can recolor (default amber accent).
 */
export function PwrSnapMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 128 128"
      width={size}
      height={size}
      role="img"
      aria-label="PwrSnap"
      style={{ display: "block", color: "var(--accent)" }}
    >
      <g fill="none" stroke="currentColor" strokeWidth={9} strokeLinejoin="round">
        <rect x="42" y="22" width="58" height="46" rx="6" strokeOpacity={0.3} />
        <rect x="34" y="36" width="58" height="46" rx="6" strokeOpacity={0.55} />
        <rect x="26" y="50" width="58" height="46" rx="6" />
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
