import type { Capture } from "./captures";

const PALETTE: Record<string, [string, string, string]> = {
  telegram: ["#0e2230", "#229ED9", "#65b6e2"],
  excel: ["#0a1f0e", "#107c41", "#5fb47e"],
  vscode: ["#0a1424", "#1f3b6e", "#7baaff"],
  chrome: ["#1a1a1a", "#4285f4", "#fbbc04"],
  figma: ["#1f0a18", "#a259ff", "#f24e1e"],
  slack: ["#1a0e1a", "#611f5c", "#ecb22e"],
  terminal: ["#0a0a0a", "#1f1f1f", "#5fb47e"],
  notion: ["#1a1a18", "#2f2f2f", "#e5e5e5"],
  linear: ["#0e0e1c", "#5e6ad2", "#a4adff"],
  github: ["#0d1117", "#1f2733", "#7d8590"],
  zoom: ["#0a1a2e", "#2d8cff", "#75b6ff"],
  safari: ["#0e1a24", "#2d7fb6", "#7fd0ff"],
  preview: ["#1a140e", "#5c4a3a", "#b89878"],
  finder: ["#1a1a1a", "#3a3a3a", "#7f7f7f"]
};

const CHROME_LINE: Record<string, { chrome: string; lines: string }> = {
  telegram: { chrome: "#229ED9", lines: "rgba(255,255,255,0.6)" },
  excel: { chrome: "#107c41", lines: "rgba(255,255,255,0.55)" },
  vscode: { chrome: "#1f3b6e", lines: "#7baaff" },
  chrome: { chrome: "#dadce0", lines: "rgba(255,255,255,0.7)" },
  figma: { chrome: "#2c2c2c", lines: "#a259ff" },
  slack: { chrome: "#3f0e3f", lines: "#ecb22e" },
  terminal: { chrome: "#1f1f1f", lines: "#5fb47e" },
  notion: { chrome: "#2f2f2f", lines: "#e5e5e5" },
  linear: { chrome: "#252633", lines: "#a4adff" },
  github: { chrome: "#1f2733", lines: "#7d8590" },
  zoom: { chrome: "#0e1f3a", lines: "#75b6ff" },
  safari: { chrome: "#1a2a3a", lines: "#7fd0ff" },
  preview: { chrome: "#3a3024", lines: "#d4b890" },
  finder: { chrome: "#2a2a2a", lines: "#aaa" }
};

function thumbStyle(c: Capture) {
  const palette = PALETTE[c.app] ?? PALETTE.finder!;
  const [bg, mid, hi] = palette;
  const angle = (c.id * 47) % 360;
  return {
    background: `linear-gradient(${angle}deg, ${bg} 0%, ${mid} 60%, ${hi} 100%)`
  } as const;
}

function ThumbContent({ c }: { c: Capture }) {
  const w = 100;
  const h = 62;
  const palette = CHROME_LINE[c.app] ?? CHROME_LINE.finder!;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: "100%", display: "block" }}
    >
      <rect x="0" y="0" width={w} height={h} fill={palette.chrome} opacity="0.32" />
      <rect x="0" y="0" width={w} height="6" fill={palette.chrome} opacity="0.92" />
      <circle cx="3" cy="3" r="1" fill="#ff5f57" />
      <circle cx="6.5" cy="3" r="1" fill="#febc2e" />
      <circle cx="10" cy="3" r="1" fill="#28c840" />
      <rect x="0" y="6" width="22" height={h - 6} fill={palette.chrome} opacity="0.5" />
      {[0, 1, 2, 3, 4].map((i) => (
        <rect
          key={i}
          x="3"
          y={10 + i * 7}
          width="16"
          height="2.6"
          fill={palette.lines}
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
            fill={palette.lines}
            opacity={0.32 - i * 0.025}
          />
        );
      })}
      <rect
        x="26"
        y="40"
        width="64"
        height="18"
        fill={palette.lines}
        opacity="0.08"
        stroke={palette.lines}
        strokeOpacity="0.3"
        strokeWidth="0.4"
      />
      <rect x="29" y="44" width="22" height="2.4" fill={palette.lines} opacity="0.4" />
      <rect x="29" y="49" width="40" height="1.8" fill={palette.lines} opacity="0.25" />
      <rect x="29" y="52.5" width="34" height="1.8" fill={palette.lines} opacity="0.25" />
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
