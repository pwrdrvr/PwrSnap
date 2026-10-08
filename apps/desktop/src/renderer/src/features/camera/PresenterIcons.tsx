// 16px stroke glyphs for the presenter toolbar, the camera lane and the
// transport. Same grid and weight as SourceChip's glyphs.

import type { ReactElement } from "react";

export type PresenterIconName =
  | "camera"
  | "eye"
  | "eyeOff"
  | "person"
  | "circle"
  | "rounded"
  | "square"
  | "chevronDown"
  | "mirror"
  | "snap"
  | "edge"
  | "left"
  | "right"
  | "more"
  | "tick"
  | "warn";

export function PresenterIcon({
  name,
  size = 14
}: {
  readonly name: PresenterIconName;
  readonly size?: number;
}): ReactElement {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };
  switch (name) {
    case "camera":
      return (
        <svg {...common}>
          <rect x="1.4" y="4" width="9.2" height="8" rx="2" />
          <path d="M10.6 7.6l4-2.2v5.2l-4-2.2z" />
        </svg>
      );
    case "eye":
      return (
        <svg {...common}>
          <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
          <circle cx="8" cy="8" r="2" />
        </svg>
      );
    case "eyeOff":
      return (
        <svg {...common}>
          <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
          <path d="M2.5 2.5l11 11" />
        </svg>
      );
    case "person":
      return (
        <svg {...common}>
          <circle cx="8" cy="5.4" r="2.6" />
          <path d="M3 14c.6-3 2.6-4.6 5-4.6s4.4 1.6 5 4.6" />
        </svg>
      );
    case "circle":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.6" />
        </svg>
      );
    case "rounded":
      return (
        <svg {...common}>
          <rect x="2.4" y="2.4" width="11.2" height="11.2" rx="3.6" />
        </svg>
      );
    case "square":
      return (
        <svg {...common}>
          <rect x="2" y="3.4" width="12" height="9.2" rx="1" />
        </svg>
      );
    case "chevronDown":
      return (
        <svg {...common} width={10} height={10}>
          <path d="M4 6.2L8 10l4-3.8" />
        </svg>
      );
    case "mirror":
      return (
        <svg {...common}>
          <path d="M8 1.8v12.4" strokeDasharray="1.6 1.8" />
          <path d="M5.8 4.4L2 11.6h3.8z" />
          <path d="M10.2 4.4l3.8 7.2h-3.8z" />
        </svg>
      );
    case "edge":
      // A head and shoulders with a dashed outline a step outside it:
      // the edge the cut-out trims.
      return (
        <svg {...common}>
          <circle cx="8" cy="6" r="2.2" />
          <path d="M3.8 13.5c.5-2.4 2.2-3.6 4.2-3.6s3.7 1.2 4.2 3.6" />
          <path d="M8 1.6a4.4 4.4 0 0 1 4.3 5.4M2.6 12.6" strokeDasharray="1.4 1.6" />
        </svg>
      );
    case "snap":
      return (
        <svg {...common}>
          <rect x="2" y="3" width="12" height="10" rx="1.6" />
          <rect x="9" y="8.6" width="3.4" height="2.8" rx=".6" fill="currentColor" stroke="none" />
        </svg>
      );
    case "left":
      return (
        <svg {...common} width={11} height={11}>
          <path d="M10 3.5L5.5 8l4.5 4.5" />
        </svg>
      );
    case "right":
      return (
        <svg {...common} width={11} height={11}>
          <path d="M6 3.5L10.5 8 6 12.5" />
        </svg>
      );
    case "more":
      return (
        <svg {...common}>
          <circle cx="3.5" cy="8" r=".9" fill="currentColor" />
          <circle cx="8" cy="8" r=".9" fill="currentColor" />
          <circle cx="12.5" cy="8" r=".9" fill="currentColor" />
        </svg>
      );
    case "tick":
      return (
        <svg {...common} width={12} height={12}>
          <path d="M3 8.4l3.2 3L13 4.6" />
        </svg>
      );
    case "warn":
      return (
        <svg {...common}>
          <path d="M8 2.2l6.2 11H1.8z" />
          <path d="M8 6.6v3M8 11.6v.1" />
        </svg>
      );
  }
}
