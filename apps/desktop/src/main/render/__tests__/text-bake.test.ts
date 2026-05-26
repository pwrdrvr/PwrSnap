// Bake-path tests for text overlay sizing. Same string-level assertion
// style as `rect-bake.test.ts` + `arrow-bake.test.ts` — pin the
// emitted SVG's `font-size` attribute against the expected SOURCE-
// shortSide-derived value, which is INVARIANT across crops.
//
// User-reported bug on PR #110 follow-up: clipboard:copy MED on a v2
// cropped capture showed the text shrunken relative to the editor
// view. Editor was patched in commit `881cff0` (renderer-side
// computeTextGlyphSize uses sourceShortSide); the bake's `textSvg`
// in `compose.ts` was NOT touched in that commit and still derives
// fontSize from the (cropped) CANVAS short side. Exports therefore
// render text at a different size than the editor.
//
// Pre-fix expected fail mode: `textSvg(data, canvasW, canvasH)` doesn't
// take source dims — the new signature (with source dims) doesn't
// exist yet, so adding source-dim args to the call is a compile
// error. That IS the red signal for these tests.

import { describe, expect, test } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";
import { textSvgForV2 } from "../compose";

function baseText(
  size: "small" | "medium" | "large" = "medium"
): Extract<OverlayRow["data"], { kind: "text" }> {
  return {
    kind: "text",
    point: { x: 0.5, y: 0.5 },
    body: "M",
    size,
    color: "auto"
  };
}

describe("textSvg (bake) — fontSize derives from SOURCE shortSide, not canvas", () => {
  test("uncropped (canvas == source): fontSize equals sourceShortSide/30 for medium", () => {
    // Sanity baseline: when canvas dims match the source raster's
    // natural dims (no crop), the formula resolves to the same value
    // regardless of which shortSide drives it. This is the legacy
    // behavior — must not regress.
    const svg = textSvgForV2(baseText("medium"), 800, 600, 800, 600);
    expect(svg).toMatch(/font-size="20"/); // 600 / 30
  });

  test("v2 cropped (canvas shorter than source): fontSize uses SOURCE shortSide", () => {
    // The bug case. Source raster is 800×600 (shortSide 600); canvas
    // was cropped down to 400×300 (shortSide 300). A "medium" text on
    // this layer-tree row should render at sourceShortSide/30 = 600/30 = 20
    // canvas pixels tall — NOT canvasShortSide/30 = 300/30 = 10 canvas
    // pixels tall.
    //
    // canvas-pixel space and source-pixel space share the same scale
    // in v2 (a crop is a viewport change, not a resampling), so a
    // fontSize of 20 in canvas pixels equals 20 source pixels — what
    // the editor's commit `881cff0` settled on.
    const svg = textSvgForV2(baseText("medium"), 400, 300, 800, 600);
    expect(
      svg,
      "textSvg must derive fontSize from sourceShortSide (= 600/30 = 20), NOT from canvasShortSide (would be 300/30 = 10). Editor commit 881cff0 fixed the equivalent bug renderer-side; this test pins the bake side."
    ).toMatch(/font-size="20"/);
    expect(svg).not.toMatch(/font-size="10"/);
  });

  test("v2 cropped: small / large buckets also derive from sourceShortSide", () => {
    // Source 800×600, canvas 400×300 — same bug class for the other
    // size buckets. Divisors are 50 / 30 / 18.
    const small = textSvgForV2(baseText("small"), 400, 300, 800, 600);
    expect(small).toMatch(/font-size="12"/); // 600 / 50

    const large = textSvgForV2(baseText("large"), 400, 300, 800, 600);
    expect(large).toMatch(new RegExp(`font-size="${600 / 18}"`)); // 33.333...
  });

  test("row with explicit sizePx field overrides bucket × source math", () => {
    // pwrdrvr/PwrSnap#110: the row carries `sizePx: 100` — bake must
    // emit font-size="100" regardless of bucket / source / canvas
    // dims. This is the load-bearing path for the new "Custom" UX:
    // a row whose sizePx is between two buckets renders at its
    // stored value, and the popover surfaces "Custom".
    const data: Extract<OverlayRow["data"], { kind: "text" }> = {
      ...baseText("medium"),
      sizePx: 100
    };
    const svg = textSvgForV2(data, 400, 300, 800, 600);
    expect(svg).toMatch(/font-size="100"/);
    expect(svg).not.toMatch(/font-size="20"/); // would be source-shortSide bucket
  });

  test("legacy callers without source dims fall back to canvas shortSide", () => {
    // v1 captures and any caller that doesn't have source dims at
    // hand can omit them; in that case `textSvg` falls back to the
    // pre-#110-bake behavior (use canvas shortSide). Safe no-op for
    // v1 (where canvas == source) and existing v2 callers that
    // haven't been updated to thread source dims yet. This keeps the
    // fix backward-compatible at the API surface.
    const svg = textSvgForV2(baseText("medium"), 400, 300);
    expect(svg).toMatch(/font-size="10"/); // 300 / 30, legacy behavior
  });
});
