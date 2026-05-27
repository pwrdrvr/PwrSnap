// Tests for `TextDraftInput` — focused on what's testable without a real
// browser layout engine. jsdom doesn't lay out CSS or render fonts, so
// we can't observe the rendered glyph metrics directly; instead we pin
// the SVG-parity CSS properties as a regression guard. If a future
// refactor drops `-webkit-font-smoothing: antialiased` from the
// textarea, the visible "draft is heavier than the persisted glyph"
// wiggle returns — and this test fails.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { TextDraftInput } from "../TextDraftInput";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

async function renderInput(body = "hello"): Promise<HTMLTextAreaElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Post-refactor: canvasCssHeight is a plain prop instead of a ref
  // read. Pass a sensible non-zero value so font-size math has
  // numbers to work with — exact value doesn't matter for the
  // parity-CSS assertions in this file.
  const inputRef = { current: null as HTMLTextAreaElement | null };
  await act(async () => {
    root?.render(
      createElement(TextDraftInput, {
        draft: { kind: "text", xn: 0.5, yn: 0.5, body },
        inputRef,
        imageWidthPx: 1920,
        imageHeightPx: 1080,
        sourceWidthPx: 1920,
        sourceHeightPx: 1080,
        storedSizePx: undefined,
        canvasCssHeight: 400,
        colorHex: "#0080ff",
        size: "medium",
        weight: 700,
        onChange: () => undefined,
        onCommit: () => undefined,
        onCancel: () => undefined
      })
    );
  });
  // Architecture: TextDraftInput renders a VISIBLE <div> (showing
  // draft.body) plus an INVISIBLE <textarea> overlay (color:
  // transparent, captures keystrokes). The visible text is never
  // rendered by an editable element so contentEditable rendering
  // quirks can't cause display-vs-edit visual drift. Tests assert
  // against the textarea (the input sink); the visible div uses the
  // SAME `computeTextHtmlStyle` as TextHtml display, covered by
  // text-html-style.test.ts.
  const textarea = container.querySelector("textarea");
  if (textarea === null) {
    throw new Error("TextDraftInput did not render a textarea");
  }
  return textarea as HTMLTextAreaElement;
}

describe("TextDraftInput — SVG-parity rendering CSS", () => {
  // Regression: HTML text on macOS Chromium defaults to
  // `-webkit-font-smoothing: subpixel-antialiased` which renders
  // visibly heavier than the SVG <text> in OverlaySvg.TextGlyph. The
  // textarea MUST override that to "antialiased" so the live draft
  // matches the persisted glyph's weight. Pre-fix, clicking into an
  // existing text overlay to edit produced a noticeably bolder /
  // slightly narrower draft than the displayed glyph.

  // Note on -webkit-font-smoothing: jsdom's CSSOM doesn't recognise the
  // property and silently drops it during style-attribute parsing — so
  // we can't observe it on `ta.style` or via getAttribute("style"). The
  // production code DOES set it (see the SVG-parity block in
  // TextDraftInput.tsx). For coverage we'd need a real-browser /
  // visual-diff test. This file pins the properties jsdom can see.

  test("text-rendering is geometricPrecision (avoids HTML's optimize-legibility kerning pass)", async () => {
    const ta = await renderInput();
    // jsdom lowercases CSS keyword values during parse, so the
    // serialised form is "geometricprecision" even though we set
    // "geometricPrecision". Match case-insensitively — the on-screen
    // behavior is identical (CSS keyword matching is ASCII-case-
    // insensitive per spec).
    expect(ta.style.textRendering.toLowerCase()).toBe("geometricprecision");
  });

  test("font-kerning is explicit (defaults diverge between HTML + SVG across Chromium versions)", async () => {
    const ta = await renderInput();
    expect(ta.style.fontKerning).toBe("normal");
  });

  test("font-feature-settings + font-variant-ligatures pinned explicitly", async () => {
    const ta = await renderInput();
    // Both fields are explicit "normal" so a future browser default
    // shift can't quietly turn on contextual alternates / ligatures
    // that would skew advance widths between the draft and the SVG
    // glyph.
    expect(ta.style.fontFeatureSettings).toBe("normal");
    expect(ta.style.fontVariantLigatures).toBe("normal");
  });
});

describe("TextDraftInput — line-height", () => {
  test("lineHeight: 1 so caret height matches font-size", async () => {
    // The historical bug: the `font` shorthand resets line-height to
    // "normal" (≈ 1.2), which makes the caret taller than the glyph.
    // We set the longhand explicitly to 1 so caret + glyph match.
    const ta = await renderInput();
    expect(ta.style.lineHeight).toBe("1");
  });
});

describe("TextDraftInput — empty-state affordances", () => {
  // Regression for the "I clicked text tool, clicked the canvas,
  // nothing happened" bug. Before these fixes the visible div had 0
  // dimensions when `draft.body === ""`, the textarea (sized via
  // inset:0) inherited 0 dimensions, and the user saw no caret + no
  // bounding box → zero feedback that the system was waiting for
  // keystrokes. Both affordances live on the VISIBLE DIV (not the
  // textarea); these tests find the visible div as the wrapper's
  // first <div> child.

  function visibleDiv(): HTMLDivElement {
    if (container === null) throw new Error("container is null");
    // Structure: container > wrapper-div > [visible-div, textarea].
    // Both the container's child (wrapper) and the wrapper's child
    // (visible div) match `div > div` — pick the deeper one.
    const all = container.querySelectorAll("div");
    // all[0] = wrapper (container > wrapper), all[1] = visible div
    // (wrapper > visible-div). The textarea isn't a div so it doesn't
    // count.
    const div = all[1];
    if (div === undefined) throw new Error("visible div not found");
    return div;
  }

  test("min-width + min-height keep the wrapper visible when body is empty", async () => {
    await renderInput("");
    const div = visibleDiv();
    expect(div.style.minWidth).toBe("1ch");
    expect(div.style.minHeight).toBe("1em");
  });

  test("placeholder dashed outline only renders on empty body", async () => {
    await renderInput("");
    const empty = visibleDiv();
    // jsdom's CSSOM doesn't always parse `outline` shorthand cleanly
    // (especially with `var()` values) — fall back to inspecting the
    // raw inline-style attribute string, which React serializes
    // verbatim from the camelCase keys we set.
    const styleAttr = empty.getAttribute("style") ?? "";
    expect(styleAttr).toMatch(/outline:\s*[^;]*dashed/);
    expect(styleAttr).toMatch(/outline-offset:\s*2px/);
  });

  test("no placeholder outline once content lands", async () => {
    await renderInput("hello");
    const filled = visibleDiv();
    // Either no outline declaration at all, or empty value. The
    // production code drops the entire outline + outlineOffset block
    // from the style object when body is non-empty.
    const styleAttr = filled.getAttribute("style") ?? "";
    expect(styleAttr).not.toMatch(/outline:\s*[^;]*dashed/);
  });
});
