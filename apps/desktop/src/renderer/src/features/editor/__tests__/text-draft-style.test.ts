// Tests for `resolveTextDraftStyle` — the single decision point for
// "is this a fresh placement or a re-edit, and which style wins?"
//
// The bug these tests pin: re-editing a text overlay used to derive
// size/weight/color from the CURRENT TEXT TOOL STYLE, not from the
// persisted overlay row. Result: a row placed as "small" with the tool
// later set to "medium" would render via TextDraftInput at ~1.67× its
// committed size (the small/medium bucket ratio is 50/30). The
// `storedSizePx` override (pwrdrvr/PwrSnap#110) covered fresh captures
// post-#110, but legacy rows without sizePx silently fell through to
// the wrong bucket. User-visible symptom: text overlay grows on edit-
// click, shrinks back on commit.
//
// The contract these tests enforce:
//   • editingOverlay set → ALL style fields (color / size / weight /
//     storedSizePx) come from the persisted row. The tool style is
//     irrelevant. This is the load-bearing branch.
//   • editingOverlay null → tool style wins. Pre-existing behavior.

import { describe, expect, test } from "vitest";
import type { OverlayRow, TextToolStyle } from "@pwrsnap/shared";
import { resolveTextDraftStyle, resolveTextSizeBucket } from "../text-draft-style";

function textOverlay(
  data: Partial<Extract<OverlayRow["data"], { kind: "text" }>> = {}
): { data: Extract<OverlayRow["data"], { kind: "text" }> } {
  return {
    data: {
      kind: "text",
      point: { x: 0.5, y: 0.5 },
      body: "hello",
      size: "medium",
      color: "auto",
      ...data
    }
  };
}

function toolStyle(overrides: Partial<TextToolStyle> = {}): TextToolStyle {
  return {
    color: "auto",
    fontSize: "medium",
    weight: "bold",
    ...overrides
  };
}

describe("resolveTextDraftStyle — first placement (editingOverlay=null)", () => {
  test("uses the tool style's color/size/weight; storedSizePx is undefined", () => {
    const style = resolveTextDraftStyle({
      editingOverlay: null,
      activeToolStyle: toolStyle({
        color: "#ff0000",
        fontSize: "large",
        weight: "regular"
      })
    });
    expect(style.size).toBe("large");
    expect(style.colorHex).toBe("#ff0000");
    // "regular" → readTextWeight returns 400.
    expect(style.weight).toBe(400);
    // No persisted row yet — caller has to fall back to bucket math
    // inside computeTextGlyphSize.
    expect(style.storedSizePx).toBeUndefined();
  });

  test("'auto' color resolves to the accent var() expression", () => {
    const style = resolveTextDraftStyle({
      editingOverlay: null,
      activeToolStyle: toolStyle({ color: "auto" })
    });
    expect(style.colorHex).toBe("var(--accent, #ff8a1f)");
  });
});

describe("resolveTextDraftStyle — re-edit (editingOverlay set) — REGRESSION", () => {
  // Bottom line: the active tool style must NOT influence any field
  // when re-editing. Every assertion below pairs a persisted-row value
  // with a CONTRADICTING tool-style value; the resolved style must
  // mirror the row, not the tool.

  test("size bucket comes from the OVERLAY, ignoring the tool's bucket", () => {
    const style = resolveTextDraftStyle({
      editingOverlay: textOverlay({ size: "small" }),
      // Tool is set to large — must be ignored during re-edit.
      activeToolStyle: toolStyle({ fontSize: "large" })
    });
    expect(style.size).toBe("small");
  });

  test("color comes from the OVERLAY, ignoring the tool's color", () => {
    const style = resolveTextDraftStyle({
      editingOverlay: textOverlay({ color: "#00ff00" }),
      activeToolStyle: toolStyle({ color: "#ff0000" })
    });
    expect(style.colorHex).toBe("#00ff00");
  });

  test("weight comes from the OVERLAY, ignoring the tool's weight", () => {
    const style = resolveTextDraftStyle({
      // Persisted overlay is "regular" → readTextWeight returns 400.
      editingOverlay: textOverlay({ weight: "regular" }),
      // Tool style is "bold" — must be ignored.
      activeToolStyle: toolStyle({ weight: "bold" })
    });
    expect(style.weight).toBe(400);
  });

  test("storedSizePx is the OVERLAY's persisted absolute px when present", () => {
    const style = resolveTextDraftStyle({
      editingOverlay: textOverlay({ size: "small", sizePx: 12.5 }),
      activeToolStyle: toolStyle({ fontSize: "large" })
    });
    expect(style.storedSizePx).toBe(12.5);
    // Bucket name still mirrors the row for the UI / Custom-bucket
    // detection in the popover — but the px-level draw uses sizePx.
    expect(style.size).toBe("small");
  });

  test("legacy row without sizePx returns storedSizePx=undefined, falls back to OVERLAY's bucket", () => {
    // The original bug surfaced specifically here: legacy rows hit
    // bucket math in computeTextGlyphSize, and pre-fix that math used
    // the TOOL's bucket. After the fix, the bucket also comes from
    // the row, so the draft renders at the row's size regardless of
    // the tool's current setting.
    const style = resolveTextDraftStyle({
      editingOverlay: textOverlay({ size: "small" }), // no sizePx
      activeToolStyle: toolStyle({ fontSize: "medium" })
    });
    expect(style.storedSizePx).toBeUndefined();
    expect(style.size).toBe("small");
  });

  test("legacy row without weight defaults to the historical bold=600", () => {
    // readTextWeight returns 600 when `weight` is missing — matches
    // what the bake hardcoded pre-popover so legacy rows look the same.
    const style = resolveTextDraftStyle({
      editingOverlay: textOverlay({ /* no weight */ }),
      activeToolStyle: toolStyle({ weight: "regular" })
    });
    expect(style.weight).toBe(600);
  });

  test("activeToolStyle is allowed to be null during re-edit (commit ignores it)", () => {
    // The text tool may have been deactivated between placement and
    // re-edit (e.g., the user switched to Pointer to select, then
    // double-clicked). The helper must still resolve from the row.
    const style = resolveTextDraftStyle({
      editingOverlay: textOverlay({ size: "large", color: "#123456", weight: "bold" }),
      activeToolStyle: null
    });
    expect(style.size).toBe("large");
    expect(style.colorHex).toBe("#123456");
    expect(style.weight).toBe(700);
  });

  test("'auto' color on the overlay resolves to the accent var()", () => {
    const style = resolveTextDraftStyle({
      editingOverlay: textOverlay({ color: "auto" }),
      activeToolStyle: toolStyle({ color: "#ff0000" })
    });
    expect(style.colorHex).toBe("var(--accent, #ff8a1f)");
  });
});

describe("resolveTextSizeBucket — popover preset → bucket", () => {
  // Exhaustive sanity table so a future popover-preset addition (e.g.
  // a "tiny" or another XL bucket) is forced to update this map AND
  // surface in the tests.
  test.each([
    ["small", "small"],
    ["medium", "medium"],
    ["large", "large"],
    ["x-large", "large"], // collapses to large defensively
    ["auto", "medium"]
  ] as const)("'%s' resolves to '%s'", (input, expected) => {
    expect(resolveTextSizeBucket(input)).toBe(expected);
  });

  test("a numeric font-size resolves to 'medium' (popover only exposes presets today)", () => {
    expect(resolveTextSizeBucket(48)).toBe("medium");
  });
});
