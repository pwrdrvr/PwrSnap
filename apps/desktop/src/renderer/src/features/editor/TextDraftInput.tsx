// In-canvas text-entry overlay used while the user is typing a text
// annotation. Replaced on commit by the SVG TextGlyph (rendered by
// OverlaySvg).
//
// WYSIWYG design rules — every visible property here must mirror what
// TextGlyph renders. If TextGlyph changes, change this too, in
// lockstep.
//
// Layout contract (so click position matches commit position):
//   • The wrapper is absolutely positioned at the click point and
//     translateY(-50%)'d so the FIRST line's glyph center sits exactly
//     on the click point. TextGlyph uses `dominantBaseline="central"`
//     for the same reason — click and commit agree on vertical center.
//   • The textarea is `field-sizing: content`, so it auto-grows in
//     both axes as the user types. Multi-line via Shift+Enter; Enter
//     alone commits.
//   • Caret height = font-size (we set lineHeight: 1 with explicit
//     longhand properties; the `font` shorthand silently resets
//     line-height to "normal" so we avoid it).
//
// Size buckets (match TextGlyph + compose.ts textSvg in lockstep):
//   small  ≈ shortSide / 50
//   medium ≈ shortSide / 30   ← default for new captures
//   large  ≈ shortSide / 18

import type { CSSProperties, KeyboardEvent, ReactElement } from "react";
import type { DraftText } from "./editor-types";

export function TextDraftInput({
  draft,
  inputRef,
  imageWidthPx,
  imageHeightPx,
  canvasRef,
  /** Resolved committed-glyph color as a `#rrggbb` hex string OR a CSS
   *  var() expression. The caller resolves the active TextToolStyle's
   *  `color` via `resolveToolColor`; this component does not see the
   *  unresolved ToolColor union (which would re-introduce the "draft
   *  in --accent-bright vs commit in user-picked blue" mismatch). */
  colorHex,
  /** Resolved committed-glyph size bucket. Identical mapping to the
   *  one used in `commitText` (see `resolveTextSize` in Editor.tsx).
   *  Drives the textarea's font-size so the typing surface is the
   *  same px height as the committed glyph. */
  size,
  onChange,
  onCommit,
  onCancel
}: {
  draft: DraftText;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  imageWidthPx: number;
  imageHeightPx: number;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  colorHex: string;
  size: "small" | "medium" | "large";
  onChange: (body: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): ReactElement {
  // Mirror TextGlyph's px math EXACTLY — any drift here is a visible
  // "text jumps on commit" bug.
  const rect = canvasRef.current?.getBoundingClientRect() ?? null;
  const canvasCssHeight = rect?.height ?? 0;
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  const sizePx =
    size === "large" ? shortSide / 18 : size === "medium" ? shortSide / 30 : shortSide / 50;
  const fontPx =
    canvasCssHeight > 0 ? canvasCssHeight * (sizePx / shortSide) : 16;
  // Halo width scales with font size — same idea as TextGlyph's
  // `strokeWidth={fontSize * 0.08}`. Clamped to 1px minimum so very
  // small fonts still get a visible halo.
  const haloPx = Math.max(1, fontPx * 0.08);
  // Font family stack — verbatim from TextGlyph. Apple system fonts
  // render slightly differently from HTML's default "system-ui" alias,
  // so being explicit here keeps the rendered glyph metrics identical.
  const fontFamily =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  // Multi-direction white shadows approximate TextGlyph's SVG halo
  // (`fill="white"` background text drawn behind the colored fg). Eight
  // directional stops produce a uniform halo without a blur pass,
  // which keeps the edge crisp like the SVG stroke.
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
    left: `${draft.xn * 100}%`,
    top: `${draft.yn * 100}%`,
    // Center the wrapper's vertical midpoint on the click point. With
    // lineHeight:1 on a single line, the textarea's vertical center
    // is roughly the glyph center, which matches TextGlyph's
    // dominantBaseline="central". On Shift+Enter (additional lines),
    // the textarea grows DOWNWARD past the click point — same as the
    // committed multi-line layout (subsequent <tspan>s flow down).
    transform: "translateY(-50%)",
    pointerEvents: "auto"
  };
  const inputStyle: CSSProperties = {
    // Explicit font longhand — the `font` shorthand resets
    // `line-height` to "normal" (≈ 1.2), making the caret taller than
    // the font-size. We need lineHeight: 1 to land for caret height
    // to match the glyph height, so write each longhand individually.
    fontFamily,
    fontWeight: 600,
    fontSize: `${fontPx}px`,
    lineHeight: 1,
    color: colorHex,
    caretColor: "var(--accent, #ff8a1f)",
    textShadow,
    // No chrome — must visually match the committed glyph.
    background: "transparent",
    border: "none",
    outline: "none",
    padding: 0,
    margin: 0,
    // Multi-line textarea: don't wrap (annotations sit anywhere on
    // the canvas; auto-wrapping at the wrapper's edge would surprise
    // the user). The user controls line breaks via Shift+Enter.
    whiteSpace: "pre",
    resize: "none",
    overflow: "hidden",
    // Auto-grow with content in both axes. Chrome 123+ ships this;
    // Electron 41 includes it.
    fieldSizing: "content" as CSSProperties["fieldSizing"],
    minWidth: "1ch",
    // Keep the textarea readable on dark photos via the halo above;
    // also disable browser default scrollbar that would appear once
    // content exceeds the natural box (field-sizing: content already
    // grows, so overflow: hidden is just belt-and-suspenders).
    boxSizing: "content-box"
  };
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    // Enter alone commits; Shift+Enter inserts a newline. Match
    // conventional annotation-tool UX (Cleanshot, Skitch, etc.).
    // Without preventDefault, the textarea would also insert a newline
    // before our onCommit runs (since onCommit reads `draft.body`,
    // which hasn't seen the keystroke yet — the timing is fine but
    // we still want to suppress the default insertion).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onCommit();
    }
  }
  return (
    <div style={wrapperStyle}>
      <textarea
        ref={inputRef}
        value={draft.body}
        rows={1}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={onKeyDown}
        // No placeholder text — a "Type to annotate…" hint inside the
        // textarea would itself be WYSIWYG-incorrect (it'd appear in
        // the input's color/size/font, and disappear on first
        // keypress). The blinking caret + cursor position are the
        // affordance.
        style={inputStyle}
      />
    </div>
  );
}
