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

export type Tool = "pointer" | "arrow" | "shape" | "highlight" | "blur" | "text" | "crop";

/** Canonical toolbar order. Exported as an array of `Tool` so the
 *  toolbar row + the `useEditorToolState` cycle helpers consume the
 *  same source. `satisfies` proves at compile time that every member
 *  of `Tool` shows up exactly once — adding a new tool kind without
 *  updating this array becomes a typecheck error. */
export const TOOL_ORDER = [
  "pointer",
  "arrow",
  "shape",
  "highlight",
  "blur",
  "text",
  "crop"
] as const satisfies readonly Tool[];

export const TOOLS: ReadonlyArray<{
  id: Tool;
  label: string;
  key: string;
  icon: ReactElement;
}> = [
  // Pointer is the default — no-op on drag. Lets the user click on
  // the canvas to focus / inspect without accidentally drawing.
  // Drawing tools require an explicit click on the toolbar (or a key
  // shortcut: A S H B T).
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
      // Outline rect + inscribed circle hints at the multi-shape
      // picker behind this tool (Rect / Square / Circle / Oval /
      // Parallelogram). Same overall footprint as the legacy rect
      // glyph so the toolbar row visually stays balanced.
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="6" width="18" height="12" />
        <circle cx="12" cy="12" r="4" />
      </svg>
    )
  },
  {
    id: "highlight",
    label: "Highlight",
    key: "H",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <path d="M9 14 4 19v2h2l5-5" />
        <path d="M14 9 19 4l3 3-5 5" />
        <path d="M9 14l5 5" />
      </svg>
    )
  },
  {
    id: "blur",
    label: "Blur",
    key: "B",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="7" cy="12" r="2" />
        <circle cx="13" cy="8" r="2" />
        <circle cx="17" cy="14" r="2" />
        <circle cx="11" cy="17" r="2" />
      </svg>
    )
  },
  {
    id: "text",
    label: "Text",
    key: "T",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M5 6h14M12 6v14M9 20h6" />
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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 2v16h16" />
        <path d="M2 6h16v16" />
      </svg>
    )
  }
];
