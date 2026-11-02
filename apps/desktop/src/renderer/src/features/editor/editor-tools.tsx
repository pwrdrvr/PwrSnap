// Tool palette metadata for the annotation editor. Split out of
// Editor.tsx so that file exports only React components — non-component
// exports next to a component cause vite-plugin-react to bail out of
// Fast Refresh, which (when it bubbles up to App.tsx) leaves the
// renderer with a half-applied module graph and empty data stores.
//
// `icon` SVG path data is rendered by the Library's floating
// `<EditToolbar>` (Stage's bottom-center toolbar). The Editor's
// internal `EditorToolbar` (full + embedded chrome) reads only
// `id`/`label`/`key` and ignores the icon — keeping a single source
// avoids drift between the two toolbars.

import type { ReactElement } from "react";

export type Tool =
  | "pointer"
  | "arrow"
  | "shape"
  | "draw"
  | "highlight"
  | "blur"
  | "text"
  | "crop";

/** Canonical toolbar order. Exported as an array of `Tool` so the
 *  toolbar row + the `useEditorToolState` cycle helpers consume the
 *  same source. `satisfies` proves at compile time that every member
 *  of `Tool` shows up exactly once — adding a new tool kind without
 *  updating this array becomes a typecheck error. */
export const TOOL_ORDER = [
  "pointer",
  "arrow",
  "shape",
  "draw",
  "highlight",
  "blur",
  "text",
  "crop"
] as const satisfies readonly Tool[];

/** The Blur icon's cells: top-left corner and tone of each. */
const BLUR_MOSAIC: ReadonlyArray<readonly [number, number, number]> = [
  [3.5, 3.5, 0.95],
  [10, 3.5, 0.4],
  [16.5, 3.5, 0.7],
  [3.5, 10, 0.45],
  [10, 10, 0.8],
  [16.5, 10, 0.25],
  [3.5, 16.5, 0.7],
  [10, 16.5, 0.25],
  [16.5, 16.5, 0.55]
];

export const TOOLS: ReadonlyArray<{
  id: Tool;
  label: string;
  key: string;
  icon: ReactElement;
}> = [
  // Pointer is the default — no-op on drag. Lets the user click on
  // the canvas to focus / inspect without accidentally drawing.
  // Drawing tools require an explicit click on the toolbar (or a key
  // shortcut: A S D H B T).
  {
    id: "pointer",
    label: "Pointer",
    key: "V",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="m4 3 6 17 3-7 7-3z" />
      </svg>
    )
  },
  {
    id: "arrow",
    label: "Arrow",
    key: "A",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <path d="M5 19 19 5M19 5h-7M19 5v7" />
      </svg>
    )
  },
  {
    id: "shape",
    label: "Shape",
    key: "S",
    icon: (
      // A square in front of a circle. The circle stops short of the
      // square, so the two read as separate objects; drawn through each
      // other they read as a camera body and lens. The arc's ends sit
      // where the circle crosses a box 1.6 outside the square, with butt
      // caps so they stay square to that box.
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9.51 7.9A5.6 5.6 0 1 1 16.1 14.49" strokeLinecap="butt" />
        <rect x="3.5" y="9.5" width="11" height="11" rx="2.2" />
      </svg>
    )
  },
  // Draw — the freehand family: pen, marker, airbrush and the eraser that
  // cuts their strokes. Which one the next drag uses is the Draw style's
  // `mode`, picked in the property bar (or armed from a bag slot).
  {
    id: "draw",
    label: "Draw",
    key: "D",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3.5 16c3.5-11 6.5-11 8.5-4s5 7 8.5-5" />
      </svg>
    )
  },
  {
    id: "highlight",
    label: "Highlight",
    key: "H",
    icon: (
      // Two lines of text with a see-through box across them: the tool
      // drags a box, it does not draw a stroke. (A pen or marker here
      // would be Draw's picture.)
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 4.5h16M4 19.5h10" />
        <rect x="3" y="8.5" width="18" height="7" rx="1.6" fill="currentColor" fillOpacity="0.38" />
      </svg>
    )
  },
  {
    id: "blur",
    label: "Blur",
    key: "B",
    icon: (
      // A 3x3 mosaic of uneven tones, the usual "this is hidden" mark.
      // It stands for all three modes: gaussian, pixelate and redact.
      <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
        {BLUR_MOSAIC.map(([x, y, opacity]) => (
          <rect key={`${x},${y}`} x={x} y={y} width="4" height="4" rx="0.8" fillOpacity={opacity} />
        ))}
      </svg>
    )
  },
  {
    id: "text",
    label: "Text",
    key: "T",
    icon: (
      // The type-tool T: ticks on the crossbar and a foot on the stem
      // give it the weight of the glyphs beside it.
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 7.5V5h14v2.5M12 5v14M9 19h6" />
      </svg>
    )
  },
  // Crop landed in Phase 1 of the v2 editor refresh. Bound to `C`
  // (the same chord as Quick Capture's global hotkey but unique
  // inside the editor where global hotkeys don't fire). Activates the
  // CropTool overlay — 8 handles + rule-of-thirds + W×H HUD; ↵ commits.
  {
    id: "crop",
    label: "Crop",
    key: "C",
    icon: (
      // Two interlocked crop brackets. Short tails and rounded inner
      // corners keep them from reading as a hash mark, which two
      // edge-to-edge L's did.
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M7 2.5V15a2 2 0 0 0 2 2h12.5" />
        <path d="M17 21.5V9a2 2 0 0 0-2-2H2.5" />
      </svg>
    )
  }
];
