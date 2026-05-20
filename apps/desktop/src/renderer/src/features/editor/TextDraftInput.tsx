// Inline HTML <input> overlaying the editor canvas while the user is
// typing a text annotation. Replaced on commit by the SVG TextGlyph
// (rendered by OverlaySvg).
//
// CSS font size is computed from the live canvas height so the input
// previews the SVG glyph's actual rendered size — fixes the historical
// "text jumps in size on commit" bug.

import type { CSSProperties, FormEvent, ReactElement } from "react";
import type { DraftText } from "./editor-types";

export function TextDraftInput({
  draft,
  inputRef,
  imageWidthPx,
  imageHeightPx,
  canvasRef,
  onChange,
  onCommit,
  onCancel
}: {
  draft: DraftText;
  inputRef: React.RefObject<HTMLInputElement | null>;
  imageWidthPx: number;
  imageHeightPx: number;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  onChange: (body: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): ReactElement {
  // The committed glyph renders via SVG <text> with fontSize in
  // viewBox units (0..1), scaled by preserveAspectRatio="none" to the
  // canvas's CSS height. So the committed text's CSS-px font size is
  //   canvasHeightCss × (sizePx / shortSidePx)
  // where sizePx = shortSidePx / 60 for "small". The draft input
  // historically used a fixed 13px font, producing a visible "jumps
  // in size" on commit. Match the SVG's effective size and the
  // baseline so the input is a faithful preview.
  const rect = canvasRef.current?.getBoundingClientRect() ?? null;
  const canvasCssHeight = rect?.height ?? 0;
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  // "small" is the only size the user can place from the text tool
  // today — keep this in sync with TextGlyph's `size === "small"`
  // branch (shortSide / 60).
  const sizePx = shortSide / 60;
  // Effective rendered CSS px on the live canvas.
  const fontPx = canvasCssHeight > 0 ? canvasCssHeight * (sizePx / shortSide) : 13;
  const style: CSSProperties = {
    position: "absolute",
    // dominantBaseline="hanging" on the committed glyph means the
    // text's TOP edge aligns with the y point. The input's top edge
    // should align too — but the input has padding above the text
    // baseline (we use 1px so the input chrome is minimal). Subtract
    // the padding so the actual text starts at draft.yn × height.
    left: `${draft.xn * 100}%`,
    top: `${draft.yn * 100}%`,
    transform: "translateY(-1px)",
    background: "color-mix(in srgb, var(--bg-app) 92%, transparent)",
    color: "var(--accent-bright, #ffa33d)",
    border: "1px solid var(--accent, #ff8a1f)",
    borderRadius: 3,
    padding: "1px 4px",
    font: `600 ${fontPx}px var(--font-sans, system-ui)`,
    lineHeight: 1,
    outline: "none",
    minWidth: 80
  };
  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    onCommit();
  }
  return (
    <form style={style} onSubmit={onSubmit}>
      <input
        ref={inputRef}
        type="text"
        value={draft.body}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Type to annotate…"
        style={{
          background: "transparent",
          color: "inherit",
          border: "none",
          outline: "none",
          font: "inherit",
          minWidth: 80
        }}
      />
    </form>
  );
}
