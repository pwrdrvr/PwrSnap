// hitTestOverlays — Phase 3.2 selection model unit tests. Hit-testing
// runs against the normalized [0,1] overlay coords and a per-call
// canvas short-side hint so the hit radius scales sensibly across
// captures of different sizes.
//
// The function picks the topmost overlay under the cursor (last in
// the list wins, because the SVG paints in array order — last
// painted is on top). Matches the "click selects what you see"
// affordance.

import { describe, expect, test } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";
import { hitTestOverlays } from "../Editor";

function makeRow(
  id: string,
  data: OverlayRow["data"]
): OverlayRow {
  return {
    id,
    capture_id: "cap-1",
    data,
    schema_version: 1,
    created_at: "2026-05-23T12:00:00.000Z",
    applied_at: null,
    rejected_at: null,
    superseded_by: null,
    ai_run_id: null,
    source: "user",
    z_index: 0
  };
}

describe("hitTestOverlays", () => {
  test("returns null on empty list", () => {
    expect(hitTestOverlays([], 0.5, 0.5, 1000)).toBe(null);
  });

  test("hits a rect when the point is inside its bounds", () => {
    const rows = [
      makeRow("r1", {
        kind: "shape",
        rect: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
        color: "auto"
      })
    ];
    expect(hitTestOverlays(rows, 0.3, 0.3, 1000)).toBe("r1");
  });

  test("misses a rect when the point is outside", () => {
    const rows = [
      makeRow("r1", {
        kind: "shape",
        rect: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
        color: "auto"
      })
    ];
    expect(hitTestOverlays(rows, 0.05, 0.05, 1000)).toBe(null);
  });

  test("picks the topmost overlay when two rects overlap", () => {
    const rows = [
      makeRow("under", {
        kind: "shape",
        rect: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 },
        color: "auto"
      }),
      makeRow("over", {
        kind: "shape",
        rect: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
        color: "auto"
      })
    ];
    expect(hitTestOverlays(rows, 0.3, 0.3, 1000)).toBe("over");
  });

  test("hits an arrow near the line segment", () => {
    const rows = [
      makeRow("a1", {
        kind: "arrow",
        from: { x: 0.1, y: 0.5 },
        to: { x: 0.9, y: 0.5 },
        color: "auto"
      })
    ];
    // Right on the line.
    expect(hitTestOverlays(rows, 0.5, 0.5, 1000)).toBe("a1");
    // Within hit radius (≈ 0.01 at 1000px short side).
    expect(hitTestOverlays(rows, 0.5, 0.508, 1000)).toBe("a1");
    // Outside hit radius — well off the line.
    expect(hitTestOverlays(rows, 0.5, 0.6, 1000)).toBe(null);
  });

  test("hits a highlight overlay (rect-shaped)", () => {
    const rows = [
      makeRow("h1", {
        kind: "highlight",
        rect: { x: 0.0, y: 0.0, w: 0.5, h: 0.5 }
      })
    ];
    expect(hitTestOverlays(rows, 0.25, 0.25, 1000)).toBe("h1");
  });

  test("hits a text overlay near its anchor point", () => {
    const rows = [
      makeRow("t1", {
        kind: "text",
        point: { x: 0.5, y: 0.5 },
        body: "hi",
        size: "small",
        color: "auto"
      })
    ];
    // Right at the anchor.
    expect(hitTestOverlays(rows, 0.5, 0.5, 1000)).toBe("t1");
    // 0.025 away — within the 4× text radius (0.04 at 1000px).
    expect(hitTestOverlays(rows, 0.525, 0.5, 1000)).toBe("t1");
    // 0.2 away — clearly outside.
    expect(hitTestOverlays(rows, 0.7, 0.5, 1000)).toBe(null);
  });

  test("skips crop overlays (not user-selectable in Phase 3.2)", () => {
    const rows = [
      makeRow("c1", {
        kind: "crop",
        rect: { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }
      })
    ];
    expect(hitTestOverlays(rows, 0.5, 0.5, 1000)).toBe(null);
  });

  describe("text bounding-rect hit (full glyph extent)", () => {
    // Pre-fix the text hit-test used a tiny `hitRadiusN * 4` circle
    // around the anchor point — users could only click the strokes /
    // dead-center of the first line of a multi-line text. The new
    // behavior uses the full bounding rectangle (matching what
    // `textBoundsBox` computes for the selection outline), so the
    // user can click ANYWHERE in the rendered glyph's extent.

    const dims = {
      canvasWidthPx: 1000,
      canvasHeightPx: 1000,
      sourceWidthPx: 1000,
      sourceHeightPx: 1000
    };

    test("multi-line text — hit lands inside the second line", () => {
      // sizePx for "medium" on a 1000px source = 1000/30 ≈ 33.3.
      // Body "first\n\nthird" has 3 lines (1 blank). naturalHeightPx
      // = 33.3 × 3 ≈ 100 source-px → 0.1 normalized.
      // Anchor at (0.5, 0.5) → box top at y=0.45, bottom at y=0.55.
      // Click at (0.55, 0.52) is inside the box (second line area).
      const rows = [
        makeRow("t1", {
          kind: "text",
          point: { x: 0.5, y: 0.5 },
          body: "first\n\nthird",
          size: "medium",
          color: "auto"
        })
      ];
      expect(hitTestOverlays(rows, 0.55, 0.52, 1000, dims)).toBe("t1");
    });

    test("multi-line text — click on the third line still hits", () => {
      const rows = [
        makeRow("t1", {
          kind: "text",
          point: { x: 0.5, y: 0.5 },
          body: "first\n\nthird",
          size: "medium",
          color: "auto"
        })
      ];
      // Third line, near the bottom of the bounding box.
      expect(hitTestOverlays(rows, 0.55, 0.545, 1000, dims)).toBe("t1");
    });

    test("text — click on whitespace between glyphs (inside box) still hits", () => {
      // Single-line "Cats" — pre-fix users complained they could only
      // hit the actual glyph strokes. With bounding-box hit, the
      // whitespace BETWEEN glyphs is also clickable since it's inside
      // the rectangle the wrapper covers.
      const rows = [
        makeRow("t1", {
          kind: "text",
          point: { x: 0.3, y: 0.5 },
          body: "Cats",
          size: "large", // bigger text = easier to assert numerics
          color: "auto"
        })
      ];
      // large bucket on 1000-px source: sizePx = 1000/18 ≈ 55.6;
      // width = 4 chars × 55.6 × 0.65 ≈ 144 source-px → 0.144 normalized.
      // Box spans x ∈ [0.3, 0.444], y ∈ [0.4722, 0.5278].
      // Click at (0.4, 0.5) is solidly inside — would have missed
      // the old radius hit-test (distN = 0.1 ≫ hitRadius × 4 = 0.04).
      expect(hitTestOverlays(rows, 0.4, 0.5, 1000, dims)).toBe("t1");
    });

    test("text — click well outside the bounding box misses", () => {
      const rows = [
        makeRow("t1", {
          kind: "text",
          point: { x: 0.3, y: 0.5 },
          body: "Cats",
          size: "small",
          color: "auto"
        })
      ];
      // Far to the right of the rendered "Cats" extent.
      expect(hitTestOverlays(rows, 0.9, 0.5, 1000, dims)).toBe(null);
    });

    test("text — point-radius fallback still works when dims aren't threaded", () => {
      // Older test call sites omit `textDims`. The fallback keeps the
      // pre-fix point-radius behavior so they don't all need to
      // inflate args. Same assertion as the original "hits a text
      // overlay near its anchor point" test (above).
      const rows = [
        makeRow("t1", {
          kind: "text",
          point: { x: 0.5, y: 0.5 },
          body: "hi",
          size: "small",
          color: "auto"
        })
      ];
      // No `textDims` → falls back to point-radius hit.
      expect(hitTestOverlays(rows, 0.525, 0.5, 1000)).toBe("t1");
      expect(hitTestOverlays(rows, 0.7, 0.5, 1000)).toBe(null);
    });
  });

  test("scales hit radius with canvas short side (smaller canvas → larger normalized radius)", () => {
    const rows = [
      makeRow("a1", {
        kind: "arrow",
        from: { x: 0.1, y: 0.5 },
        to: { x: 0.9, y: 0.5 },
        color: "auto"
      })
    ];
    // 0.02 above the line. On a 500px canvas (radius ≈ 0.02), this
    // should hit; on a 2000px canvas (radius ≈ 0.008), it should miss.
    expect(hitTestOverlays(rows, 0.5, 0.519, 500)).toBe("a1");
    expect(hitTestOverlays(rows, 0.5, 0.519, 2000)).toBe(null);
  });

  describe("rotated rect hit-test", () => {
    // A square 0.4×0.4 rect centered at (0.5, 0.5) rotated 90° CW. Use
    // a square canvas (1000×1000) so the math stays clean: pixel-space
    // rotation = normalized-space rotation when aspect is 1:1.
    const square = makeRow("r1", {
      kind: "shape",
      rect: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
      color: "auto",
      rotation: Math.PI / 2
    });
    // Use main's `textDims` shape — same dims field, expanded shape
    // (canvas + source). Rotation-aware rect hit-test derives
    // imageDims from textDims.canvasWidthPx/Height inside the helper.
    const dims = {
      canvasWidthPx: 1000,
      canvasHeightPx: 1000,
      sourceWidthPx: 1000,
      sourceHeightPx: 1000
    };

    test("center still hits regardless of rotation", () => {
      expect(hitTestOverlays([square], 0.5, 0.5, 1000, dims)).toBe("r1");
    });

    test("hits a point that's inside the ROTATED visible rect but outside the AABB-original would be... well, 90° on a square rotates onto itself", () => {
      // A 90° rotation of a square at (0.3, 0.3)-(0.7, 0.7) → same
      // bbox, so any inside-bbox point still hits. Use 45° on a non-
      // square rotation to actually exercise the inverse-rotate path.
      const rotated45 = makeRow("r45", {
        kind: "shape",
        rect: { x: 0.4, y: 0.45, w: 0.2, h: 0.1 },
        color: "auto",
        rotation: Math.PI / 2 // 90° rotation of a 0.2×0.1 rect → 0.1×0.2 visible
      });
      // At 90°, the rect's visible footprint goes from a horizontal
      // 0.2×0.1 to a vertical 0.1×0.2 around center (0.5, 0.5).
      // Visible bounds: x ∈ [0.45, 0.55], y ∈ [0.4, 0.6].
      // Test a point INSIDE the visible (rotated) rect that would
      // MISS the original axis-aligned bbox.
      // Original bbox: x ∈ [0.4, 0.6], y ∈ [0.45, 0.55].
      // (0.5, 0.42) is inside the visible rotated rect (vertical bar
      // around center) but OUTSIDE the original axis-aligned bounds.
      expect(hitTestOverlays([rotated45], 0.5, 0.42, 1000, dims)).toBe("r45");
      // Conversely: (0.42, 0.5) was INSIDE the original axis-aligned
      // bbox but the 90° rotation moves it OUTSIDE the visible rect.
      expect(hitTestOverlays([rotated45], 0.42, 0.5, 1000, dims)).toBe(null);
    });

    test("when imageDims omitted, falls back to legacy unrotated bbox test", () => {
      const rotated = makeRow("r1", {
        kind: "shape",
        rect: { x: 0.4, y: 0.45, w: 0.2, h: 0.1 },
        color: "auto",
        rotation: Math.PI / 2
      });
      // Without imageDims, hitTest falls back to the historical AABB
      // check — point inside the ORIGINAL bbox hits, regardless of
      // rotation. This is the back-compat path for any caller (tests
      // mostly) that doesn't pass dims.
      expect(hitTestOverlays([rotated], 0.42, 0.5, 1000)).toBe("r1");
      expect(hitTestOverlays([rotated], 0.5, 0.42, 1000)).toBe(null);
    });
  });

  describe("rotated text hit-test", () => {
    // Mirrors the rotated rect block above — when a text overlay
    // carries a non-zero rotation, the click point must be inverse-
    // rotated into the text's local frame so the rendered visible
    // glyph (not its un-rotated AABB) is what the user can click.
    //
    // Before the fix, only the rect/highlight/blur branch rotated the
    // click; the text branch tested the un-rotated bbox. Practical
    // symptom: a 90°-rotated piece of text became unclickable
    // anywhere outside its original-orientation footprint, even
    // though the visible glyph painted over those pixels.
    //
    // Square 1000×1000 canvas + source keeps the pixel-vs-normalized
    // math 1:1, so the test points are easy to reason about by hand.

    const dims = {
      canvasWidthPx: 1000,
      canvasHeightPx: 1000,
      sourceWidthPx: 1000,
      sourceHeightPx: 1000
    };

    // body "Cats!" (5 chars) at "medium" → sizePx ≈ 33.33, char-advance
    // ≈ 0.65 → naturalWidthPx ≈ 108, naturalHeightPx ≈ 33.
    // Box: x ∈ [0.5, 0.608], y ∈ [0.4833, 0.5167].
    // Pivot (body-box center): (0.554, 0.5). 90° CW rotation turns
    // the horizontal text bar into a vertical bar around the pivot.
    const wideText = makeRow("t1", {
      kind: "text",
      point: { x: 0.5, y: 0.5 },
      body: "Cats!",
      size: "medium",
      color: "auto",
      rotation: Math.PI / 2
    });

    test("click inside the ROTATED visible glyph but outside the un-rotated AABB still hits", () => {
      // (0.554, 0.46) sits above the original AABB (y < 0.4833) but
      // INSIDE the rotated visible glyph (which now extends
      // vertically around the pivot). Pre-fix this point missed
      // entirely — rotated text was unclickable above/below its
      // original line.
      expect(hitTestOverlays([wideText], 0.554, 0.46, 1000, dims)).toBe("t1");
    });

    test("click inside the un-rotated AABB but outside the ROTATED visible glyph misses", () => {
      // Converse direction: (0.6, 0.5) is well inside the original
      // horizontal bbox (x along the long axis of the un-rotated
      // text). After 90° rotation, the visible glyph is a narrow
      // vertical bar around x=0.554 — (0.6, 0.5) is far to the right
      // of where any glyph actually paints. Pre-fix this point
      // wrongly hit, selecting the layer despite no visible target.
      expect(hitTestOverlays([wideText], 0.6, 0.5, 1000, dims)).toBe(null);
    });

    test("when textDims omitted, rotated text falls back to the point-radius hit (no inverse-rotate)", () => {
      // The legacy no-dims caller path has no canvas dims to pixel-
      // scale the inverse-rotate against, so the function falls
      // through to the original anchor-point-radius check. Rotation
      // is irrelevant in this path; we assert it stays back-compat.
      expect(hitTestOverlays([wideText], 0.5, 0.5, 1000)).toBe("t1");
      // Outside the radius → still null. Rotation does NOT influence
      // the fallback path (would be a regression if it did).
      expect(hitTestOverlays([wideText], 0.9, 0.5, 1000)).toBe(null);
    });

    test("rotation=0 + dims threaded behaves identically to the un-rotated full-bbox test", () => {
      // A rotation === 0 (or omitted) row must round-trip through
      // the inverse-rotate path without coordinate drift. Same body
      // as wideText, no rotation.
      const unrotated = makeRow("t2", {
        kind: "text",
        point: { x: 0.5, y: 0.5 },
        body: "Cats!",
        size: "medium",
        color: "auto"
        // rotation intentionally omitted
      });
      // Inside the bbox.
      expect(hitTestOverlays([unrotated], 0.55, 0.5, 1000, dims)).toBe("t2");
      // Above the bbox — the rotated case asserts this DOES hit when
      // rotated; here it must NOT hit because rotation is 0.
      expect(hitTestOverlays([unrotated], 0.554, 0.46, 1000, dims)).toBe(null);
    });
  });
});
