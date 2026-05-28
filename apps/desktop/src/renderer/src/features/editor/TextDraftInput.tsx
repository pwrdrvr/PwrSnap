// In-canvas text-entry overlay used while the user is typing a text
// annotation. The architecture is the only one that CAN'T regress on
// the "text changes appearance in edit mode" bug class, because the
// VISIBLE TEXT IS NOT RENDERED BY AN EDITABLE ELEMENT.
//
// Two elements share the wrapper:
//
//   1. A visible `<div>` styled by the same `computeTextHtmlStyle`
//      helper that `TextHtml` (the display surface) uses. Shows
//      `draft.body`. Not editable. Renders the glyphs + the
//      `-webkit-text-stroke` halo identically to the display.
//
//   2. An absolutely-positioned `<textarea>` on TOP of the visible
//      div. `color: transparent` so its OWN glyphs are invisible —
//      the user sees the visible div underneath. `caret-color` is
//      set to the accent so the blinking caret remains visible.
//      `value` and `onChange` are bound to the parent's draft state.
//      All keyboard handling (Enter commits, Shift+Enter newline,
//      Escape cancels) lives on the textarea.
//
// Paste sanitization is intentionally NOT handled — `<textarea>`
// already accepts plain text only (browsers strip rich content
// automatically, unlike `contentEditable`). If a future requirement
// adds paste filtering (e.g., normalize line endings), wire it via
// an `onPaste` handler on the textarea.
//
// Why this beats `contentEditable` (the previous attempt): Chromium
// strips / fails-to-apply `-webkit-text-stroke` on contentEditable
// elements in some configurations (observed in PwrSnap: display had
// the dark glyph halo, edit didn't — user-visible visible drift).
// `contentEditable` also normalizes `\n` to nested `<div>`/`<br>` on
// first focus (even with `plaintext-only` in some Chromium versions),
// which breaks line-height parity. None of those quirks can affect
// our visible text because our visible element is just a plain `div`
// with React-controlled children — identical to what `TextHtml`
// renders for the display surface.
//
// Why this beats "use the SAME div, just toggle contentEditable":
// even toggling contentEditable on the same element triggers the
// Chromium quirks. The contract this architecture enforces is "the
// visible element is NEVER editable" — that's the load-bearing
// invariant.

import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement
} from "react";
import {
  computeTextHtmlStyle,
  type TextSizeBucket
} from "@pwrsnap/shared";
import type { DraftText } from "./editor-types";
import { Z_INDEX_CHROME } from "./OverlaySvg";

export function TextDraftInput({
  draft,
  inputRef,
  imageWidthPx,
  imageHeightPx,
  sourceWidthPx,
  sourceHeightPx,
  storedSizePx,
  canvasCssHeight,
  colorHex,
  size,
  weight,
  rotation,
  onChange,
  onCommit,
  onCancel
}: {
  draft: DraftText;
  /** Caller-owned ref to the textarea. Used for programmatic focus +
   *  caret placement (e.g., on re-edit, caret lands at body end). */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  imageWidthPx: number;
  imageHeightPx: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
  storedSizePx: number | undefined;
  /** Editor canvas CSS-pixel height — supplied by EditorLoaded which
   *  owns the canonical observation. Pre-refactor this component
   *  measured the canvas itself via getBoundingClientRect; that
   *  disagreed with TextHtmlOverlays's ResizeObserver-backed state
   *  mid-resize, producing visible font-size drift between display
   *  and edit. Now both consume one upstream value. */
  canvasCssHeight: number;
  colorHex: string;
  size: TextSizeBucket;
  weight: number;
  /** Optional rotation in radians. Re-edit path: pulled from the
   *  persisted row so the in-progress text rotates with the visible
   *  glyph beneath. New-placement path: undefined (no rotation set
   *  yet). Threaded into computeTextHtmlStyle which appends rotate()
   *  on the wrapper transform. */
  rotation?: number | undefined;
  onChange: (body: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): ReactElement {
  // Same helper TextHtml uses — display + edit visible-text go through
  // ONE decision tree for sizing, color, weight, halo, smoothing,
  // kerning. Any change here AUTOMATICALLY moves the display surface
  // in lockstep (and vice versa).
  const style = computeTextHtmlStyle({
    point: { x: draft.xn, y: draft.yn },
    size,
    weight,
    storedSizePx,
    colorHex,
    sourceWidthPx,
    sourceHeightPx,
    canvasWidthPx: imageWidthPx,
    canvasHeightPx: imageHeightPx,
    canvasCssHeight,
    ...(rotation !== undefined ? { rotation } : {})
  });
  const wrapperStyle: CSSProperties = {
    ...(style.wrapper as CSSProperties),
    pointerEvents: "auto",
    // Chrome z-index sentinel — sit ABOVE every persisted layer
    // regardless of their layer.z_index. Without this, a high-z_index
    // persisted text or blur could paint OVER the draft-input wrapper
    // and intercept the click/keystrokes meant for the textarea. See
    // OverlaySvg's chrome SVG for the parallel rationale.
    zIndex: Z_INDEX_CHROME
  };
  // Visible glyph element — same style as TextHtml.tsx's display div.
  // Identical rendering, identical halo, identical metrics.
  const visibleGlyphStyle: CSSProperties = {
    ...(style.glyph as CSSProperties),
    userSelect: "none",
    WebkitUserSelect: "none",
    // The textarea is `position: absolute` on top of this; we need
    // this div to lay out the wrapper's intrinsic dimensions so the
    // textarea's `inset: 0` can size against it.
    position: "relative",
    // Minimum dimensions so the wrapper has a clickable + caret-
    // rendering box even when `draft.body === ""` (fresh placement).
    // Without this the visible div has 0 dimensions when empty, the
    // textarea inherits 0 dimensions via `inset: 0`, and the blinking
    // caret has nowhere to render — zero feedback that the system is
    // waiting for keystrokes. Pre-unification the textarea had
    // `field-sizing: content` + `min-width: 1ch` which kept it
    // visible while empty; the visible-div + invisible-textarea
    // architecture has to re-establish that property here. `1ch` ≈
    // width of "0" in the active font; `1em` = one line of the
    // inherited font-size. Both auto-scale with the current bucket's
    // fontPx.
    minWidth: "1ch",
    minHeight: "1em"
  };
  // Invisible textarea — captures keystrokes, shows caret + selection.
  // Inherits sizing from the same `style.glyph` so its internal line
  // metrics match the visible div (caret height + advance per
  // character agree with where the visible glyphs actually sit).
  // `color: transparent` hides the textarea's own glyphs so the user
  // only sees the visible div underneath; `caret-color` overrides
  // the (transparent) color for the blinking caret. `selection`
  // background remains visible via the system selection styling.
  const textareaStyle: CSSProperties = {
    ...(style.glyph as CSSProperties),
    position: "absolute",
    // Cover the visible div exactly. The visible div has
    // `position: relative` so this textarea's `inset: 0` resolves
    // against the visible div's box.
    inset: 0,
    // Hide the textarea's own text rendering. The visible div
    // underneath shows the body.
    color: "transparent",
    // Hide the text-stroke halo on the textarea too — we don't want
    // a SECOND halo painted over the visible div's halo.
    WebkitTextStroke: "0",
    caretColor: "var(--accent, #ff8a1f)",
    background: "transparent",
    border: "none",
    outline: "none",
    resize: "none",
    overflow: "hidden",
    margin: 0,
    padding: 0,
    // Match the visible div's box exactly. content-box keeps the
    // textarea's content area equal to the wrapper's inner box (no
    // border/padding to subtract — both are zero).
    boxSizing: "content-box",
    // Width = 100% of the visible div. `inset: 0` already handles
    // this on both axes, but Safari has historically ignored inset
    // on textareas — be explicit.
    width: "100%",
    height: "100%"
  };
  // Cancel flag — set by Escape, checked by onBlur. Without this,
  // the textarea's `onBlur` (which auto-commits — the conventional
  // annotation-tool UX of "click away to save") races with Escape's
  // `onCancel` and commits the in-flight body even though the user
  // asked to abort. Refs survive unmount-time blur firing where
  // setState updates from Escape haven't been flushed yet.
  const cancelledRef = useRef<boolean>(false);

  // Initial focus + caret-at-end. Runs once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ta = inputRef.current;
    if (ta === null) return;
    ta.focus();
    // Place caret at end so additions append rather than overwriting.
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      // Mark as cancelled BEFORE onCancel so the imminent onBlur
      // (fired by the textarea losing focus when it unmounts) sees
      // the flag and short-circuits without committing the in-flight
      // body. Restoring `initialBodyRef.current` via onChange would
      // race the same way — by the time setState flushes, onCommit
      // has already read the stale `draft.body`. The cancel flag is
      // the only fix that doesn't depend on state-flush timing.
      cancelledRef.current = true;
      onCancel();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // Enter alone commits. preventDefault stops the textarea from
      // inserting a newline before our onCommit runs.
      e.preventDefault();
      onCommit();
      return;
    }
    // Shift+Enter falls through — the textarea's default behavior
    // inserts a `\n` into its value, which onChange picks up.
  }

  function onBlur(): void {
    if (cancelledRef.current) {
      // Escape already aborted — don't commit. The parent's
      // setDraft(null) from onCancel will unmount us shortly.
      return;
    }
    onCommit();
  }

  return (
    <div style={wrapperStyle}>
      {/* Visible text — same `<div>` shape and CSS as
          TextHtml.tsx's display surface. NOT editable. Renders glyphs
          + halo identically to display. */}
      <div style={visibleGlyphStyle}>{draft.body}</div>
      {/* Invisible textarea — captures keyboard, shows caret. The
          user can't see the textarea's own glyphs (color:
          transparent), only the visible div underneath. */}
      <textarea
        ref={inputRef}
        value={draft.body}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        rows={1}
        spellCheck={false}
        aria-label="Edit text annotation"
        style={textareaStyle}
      />
    </div>
  );
}
