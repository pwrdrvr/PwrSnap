// In-canvas text-entry overlay used while the user is typing a text
// annotation. Replaced on commit by the SVG TextGlyph (rendered by
// OverlaySvg).
//
// WYSIWYG design rules — every visible property here must mirror what
// the committed glyph renders. If TextGlyph changes, change this too,
// in lockstep. The earlier version drew a tiny orange-bordered chrome
// box with a Geist font at 13px regardless of the active tool style;
// the committed glyph then rendered at Apple-system 600 in the user-
// picked color and a different vertical position. User-visible jump
// on every commit. Fix:
//
//   • Same font family stack as TextGlyph (-apple-system, ...).
//   • Same font weight (600 — committed glyph hardcodes 600 today;
//     when TextToolStyle.weight starts being honored in TextGlyph,
//     plumb it through here in lockstep).
//   • Same color — resolved from the active TextToolStyle at the
//     call site and passed in as a hex string. "auto" falls back to
//     the brand accent (matches TextGlyph's auto branch).
//   • Same size — derived from the active TextToolStyle's fontSize
//     bucket ("small" / "large") and the image short-side, identical
//     to TextGlyph's `sizePx` math.
//   • No chrome — no border, no background, no padding, no rounded
//     corners. The text appears at the eventual final position. A
//     thin white text-shadow halo keeps the caret visible on any
//     background; it's a softer version of TextGlyph's SVG halo
//     (white-fill+black-stroke layered under the colored glyph).
//   • Caret-color uses the accent so the blink is visible even when
//     the body text would otherwise blend into the background.

import type { CSSProperties, FormEvent, ReactElement } from "react";
import type { DraftText } from "./editor-types";

export function TextDraftInput({
  draft,
  inputRef,
  imageWidthPx,
  imageHeightPx,
  canvasRef,
  /** Resolved committed-glyph color as a `#rrggbb` hex string. The
   *  caller resolves the active TextToolStyle's `color` via
   *  `resolveToolColor`; this component does not see the unresolved
   *  ToolColor union (which would re-introduce the "draft renders in
   *  --accent-bright but commit renders in user-picked blue"
   *  mismatch). Pass the *displayed* color, not the persisted token. */
  colorHex,
  /** Resolved committed-glyph size bucket. Identical mapping to the
   *  one used in `commitText` (see `resolveTextSize` in Editor.tsx).
   *  Drives the input's font-size so the typing surface is the same
   *  px height as the committed glyph. */
  size,
  onChange,
  onCommit,
  onCancel
}: {
  draft: DraftText;
  inputRef: React.RefObject<HTMLInputElement | null>;
  imageWidthPx: number;
  imageHeightPx: number;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  colorHex: string;
  size: "small" | "large";
  onChange: (body: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): ReactElement {
  // Mirror TextGlyph's px math EXACTLY. `sizePx` is the SVG viewBox
  // unit for the committed glyph; we then scale to CSS px via the
  // live canvas height so the input previews at the rendered size.
  // Any drift here is a visible "text jumps on commit" bug.
  const rect = canvasRef.current?.getBoundingClientRect() ?? null;
  const canvasCssHeight = rect?.height ?? 0;
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  const sizePx = size === "large" ? shortSide / 30 : shortSide / 60;
  const fontPx =
    canvasCssHeight > 0 ? canvasCssHeight * (sizePx / shortSide) : 13;
  // Halo width scales with font size, same idea as TextGlyph's
  // `strokeWidth={fontSize * 0.08}`. Clamped to 1px minimum so very
  // small fonts still get a visible halo.
  const haloPx = Math.max(1, fontPx * 0.08);
  // Font family stack — verbatim from TextGlyph.
  const fontFamily =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  // Multi-direction white shadows approximate TextGlyph's SVG halo
  // (`fill="white"` background text drawn behind the colored fg).
  // Eight directional stops produce a uniform halo without a blur
  // pass, which keeps the edge crisp like the SVG stroke.
  const textShadow = [
    `-${haloPx}px -${haloPx}px 0 rgba(255,255,255,0.9)`,
    `${haloPx}px -${haloPx}px 0 rgba(255,255,255,0.9)`,
    `-${haloPx}px ${haloPx}px 0 rgba(255,255,255,0.9)`,
    `${haloPx}px ${haloPx}px 0 rgba(255,255,255,0.9)`,
    `0 -${haloPx}px 0 rgba(255,255,255,0.9)`,
    `0 ${haloPx}px 0 rgba(255,255,255,0.9)`,
    `-${haloPx}px 0 0 rgba(255,255,255,0.9)`,
    `${haloPx}px 0 0 rgba(255,255,255,0.9)`
  ].join(", ");
  const wrapperStyle: CSSProperties = {
    position: "absolute",
    // TextGlyph uses `dominantBaseline="hanging"` so y = top edge of
    // the glyph. With lineHeight: 1 and padding: 0, the input's text
    // top edge ≈ the wrapper's top edge — no offset needed.
    left: `${draft.xn * 100}%`,
    top: `${draft.yn * 100}%`,
    // Container must not steal pointer events from the canvas around
    // it; only the input itself accepts focus.
    pointerEvents: "auto"
  };
  const inputStyle: CSSProperties = {
    // No chrome — the draft must visually match the committed glyph.
    background: "transparent",
    border: "none",
    outline: "none",
    padding: 0,
    margin: 0,
    color: colorHex,
    // Committed glyph hardcodes weight 600 today; match it. When
    // TextGlyph begins honoring TextToolStyle.weight, switch this to
    // the same mapping in lockstep.
    font: `600 ${fontPx}px ${fontFamily}`,
    lineHeight: 1,
    // Caret in the brand accent so it's visible even when colorHex
    // is white / light / blends with the bg.
    caretColor: "var(--accent, #ff8a1f)",
    textShadow,
    // Auto-grow with content: width is the longer of the typed-body
    // measure or a minimum to anchor the caret while empty. CSS
    // `field-sizing: content` does this natively in modern Chromium;
    // we're on Electron 38+ which ships it. Fallback minWidth keeps
    // the caret visible if field-sizing isn't honored.
    fieldSizing: "content" as CSSProperties["fieldSizing"],
    minWidth: "1ch"
  };
  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    onCommit();
  }
  return (
    <form style={wrapperStyle} onSubmit={onSubmit}>
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
        // No placeholder text — a "Type to annotate…" hint inside the
        // input would itself be WYSIWYG-incorrect (it'd appear in the
        // input's color/size/font, and disappear on first keypress).
        // The blinking caret + cursor position are the affordance.
        style={inputStyle}
      />
    </form>
  );
}
