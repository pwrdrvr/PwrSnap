import type { Capture } from "./captures";

// Neutral placeholder thumbnail for demo/seed fixtures only. Real
// captures render a baked <img> in Library.tsx (the `record !== null`
// branch); this generic chrome-and-lines mock is what fills the grid
// when there's no backing record. It is intentionally brand-agnostic:
// a single neutral palette built from the design-system tokens (the
// PwrSnap accent + neutral surfaces/borders), NOT a per-app
// brand-colored palette. The only fixed colors are the traffic-light
// dots, which are macOS window-chrome conventions, not a third-party
// brand mark.
//
// All colors are pulled from CSS custom properties (resolved at render
// time via `var(--token)`) so the placeholder follows the active theme
// and never hardcodes a brand hex.

const PLACEHOLDER = {
  // Gradient stops for the cell background — neutral surface →
  // elevated surface → a faint accent tint.
  bg: "var(--bg-panel)",
  mid: "var(--bg-panel-elevated)",
  hi: "var(--accent-soft)",
  // Mock window chrome + content lines.
  chrome: "var(--border-strong)",
  lines: "var(--text-secondary)"
} as const;

function thumbStyle(c: Capture) {
  const angle = (c.id * 47) % 360;
  return {
    background: `linear-gradient(${angle}deg, ${PLACEHOLDER.bg} 0%, ${PLACEHOLDER.mid} 60%, ${PLACEHOLDER.hi} 100%)`
  } as const;
}

function ThumbContent({ c }: { c: Capture }) {
  const w = 100;
  const h = 62;
  const { chrome, lines } = PLACEHOLDER;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: "100%", display: "block" }}
    >
      <rect x="0" y="0" width={w} height={h} fill={chrome} opacity="0.32" />
      <rect x="0" y="0" width={w} height="6" fill={chrome} opacity="0.92" />
      <circle cx="3" cy="3" r="1" fill="#ff5f57" />
      <circle cx="6.5" cy="3" r="1" fill="#febc2e" />
      <circle cx="10" cy="3" r="1" fill="#28c840" />
      <rect x="0" y="6" width="22" height={h - 6} fill={chrome} opacity="0.5" />
      {[0, 1, 2, 3, 4].map((i) => (
        <rect
          key={i}
          x="3"
          y={10 + i * 7}
          width="16"
          height="2.6"
          fill={lines}
          opacity={0.18 + ((c.id + i) % 3) * 0.08}
        />
      ))}
      {Array.from({ length: 6 }).map((_, i) => {
        const ww = 30 + ((c.id * 7 + i * 13) % 40);
        return (
          <rect
            key={i}
            x="26"
            y={11 + i * 7}
            width={ww}
            height="2.4"
            fill={lines}
            opacity={0.32 - i * 0.025}
          />
        );
      })}
      <rect
        x="26"
        y="40"
        width="64"
        height="18"
        fill={lines}
        opacity="0.08"
        stroke={lines}
        strokeOpacity="0.3"
        strokeWidth="0.4"
      />
      <rect x="29" y="44" width="22" height="2.4" fill={lines} opacity="0.4" />
      <rect x="29" y="49" width="40" height="1.8" fill={lines} opacity="0.25" />
      <rect x="29" y="52.5" width="34" height="1.8" fill={lines} opacity="0.25" />
    </svg>
  );
}

export function Thumb({ c }: { c: Capture }) {
  return (
    <div style={{ position: "absolute", inset: 0, ...thumbStyle(c) }}>
      <ThumbContent c={c} />
    </div>
  );
}
