// Tests for `TextHtmlOverlays` — the new owner of the
// "suppress the text overlay currently being re-edited" rule that used
// to live in OverlaySvg. Display + edit must not double-render the
// same glyph: TextDraftInput paints the editable copy, this component
// paints the rest of the persisted text rows.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";

import {
  TextHtmlOverlays,
  type TextHtmlOverlaysProps
} from "../TextHtmlOverlays";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  // Stub ResizeObserver — jsdom doesn't ship one. We don't actually
  // exercise resize behavior in these tests (initial getBoundingClientRect
  // read covers the canvasCssHeight value), so a no-op observer is enough.
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
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

function textRow(
  id: string,
  data: Partial<Extract<OverlayRow["data"], { kind: "text" }>> = {}
): OverlayRow {
  return {
    id,
    capture_id: "cap_1",
    data: {
      kind: "text",
      point: { x: 0.5, y: 0.5 },
      body: "hello",
      size: "medium",
      color: "auto",
      ...data
    },
    schema_version: 1,
    created_at: "2026-05-24T00:00:00Z",
    applied_at: "2026-05-24T00:00:00Z",
    rejected_at: null,
    superseded_by: null,
    ai_run_id: null,
    source: "user",
    z_index: 0
  };
}

// Post-refactor: canvasCssHeight is a plain prop owned by EditorLoaded.
// Harness just supplies a sensible non-zero value — exact size doesn't
// matter for these tests (they assert on suppression + body content).
function Harness(props: {
  overlays: OverlayRow[];
  editingLayerId?: string | null;
  liveOverride?: TextHtmlOverlaysProps["liveOverride"];
}): ReturnType<typeof TextHtmlOverlays> {
  return createElement(TextHtmlOverlays, {
    overlays: props.overlays,
    editingLayerId: props.editingLayerId ?? null,
    imageWidthPx: 800,
    imageHeightPx: 400,
    sourceWidthPx: 800,
    sourceHeightPx: 400,
    canvasCssHeight: 400,
    liveOverride: props.liveOverride ?? null
  });
}

async function render(
  overlays: OverlayRow[],
  editingLayerId: string | null = null,
  liveOverride: TextHtmlOverlaysProps["liveOverride"] = null
): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Harness, { overlays, editingLayerId, liveOverride }));
  });
  // useLayoutEffect runs inside the act; one extra flush lets the
  // canvasCssHeight state update propagate.
  await act(async () => {
    await Promise.resolve();
  });
}

function textBodies(): string[] {
  // Inner glyph divs render the body text. The wrapper divs contain
  // the absolute-positioned glyph. Two divs per overlay (wrapper +
  // glyph).
  if (container === null) return [];
  return Array.from(container.querySelectorAll("div > div")).map(
    (el) => el.textContent ?? ""
  );
}

describe("TextHtmlOverlays — text overlay rendering", () => {
  test("renders one glyph div per text overlay", async () => {
    await render([
      textRow("t1", { body: "first" }),
      textRow("t2", { body: "second" })
    ]);
    const bodies = textBodies();
    expect(bodies).toContain("first");
    expect(bodies).toContain("second");
  });

  test("ignores non-text overlays", async () => {
    const arrowRow: OverlayRow = {
      id: "a1",
      capture_id: "cap_1",
      data: {
        kind: "arrow",
        from: { x: 0.1, y: 0.1 },
        to: { x: 0.9, y: 0.9 },
        color: "auto"
      },
      schema_version: 1,
      created_at: "2026-05-24T00:00:00Z",
      applied_at: "2026-05-24T00:00:00Z",
      rejected_at: null,
      superseded_by: null,
      ai_run_id: null,
      source: "user",
      z_index: 0
    };
    await render([arrowRow, textRow("t1", { body: "only text" })]);
    expect(textBodies()).toContain("only text");
    // No arrow text — the component shouldn't emit anything for arrows.
    expect(textBodies()).not.toContain("arrow");
  });
});

describe("TextHtmlOverlays — editingLayerId suppression", () => {
  // Same regression class as the original SVG-side suppression: the
  // overlay being re-edited must NOT also render in the display layer,
  // because TextDraftInput is painting the same glyph as an editable
  // textarea. Double-render = visible overlap / drift.

  test("suppresses the row whose id matches editingLayerId", async () => {
    await render(
      [textRow("t1", { body: "first" }), textRow("t2", { body: "second" })],
      "t1"
    );
    const bodies = textBodies();
    expect(bodies).not.toContain("first");
    expect(bodies).toContain("second");
  });

  test("renders everything when editingLayerId is null", async () => {
    await render(
      [textRow("t1", { body: "first" }), textRow("t2", { body: "second" })],
      null
    );
    const bodies = textBodies();
    expect(bodies).toContain("first");
    expect(bodies).toContain("second");
  });
});

describe("TextHtmlOverlays — liveOverride propagation", () => {
  // Regression for user report: "Text rotation is not live anymore?
  // Just the box is rotating?" — during a rotation-handle drag, the
  // SVG selection outline (OverlaySvg.effectiveOverlays) rotated with
  // the gesture but the HTML text glyph stayed at its persisted
  // rotation until pointerup, because TextHtmlOverlays wasn't applying
  // the same `liveOverride` projection OverlaySvg uses. These tests
  // pin the parity: when a `liveOverride` matches a text row, the
  // rendered wrapper transform reflects the override's rotation /
  // point, not the persisted values. Same coverage also pins the
  // simpler "drag a text by its body to move it" preview behavior.

  // computeTextHtmlStyle emits `position: absolute` ONLY on the outer
  // wrapper (the glyph is a static-position child). Use that to pick
  // the wrapper for a specific text body when multiple rows are
  // rendered. For single-row tests, `wrapper()` below grabs the only
  // wrapper without needing a body lookup.
  function findWrapper(body: string): HTMLElement {
    if (container === null) throw new Error("container missing");
    const wrappers = Array.from(
      container.querySelectorAll<HTMLDivElement>("div")
    ).filter((el) => el.style.position === "absolute");
    const hit = wrappers.find((el) => el.textContent === body);
    if (hit === undefined) {
      throw new Error(`wrapper for body=${JSON.stringify(body)} not found`);
    }
    return hit;
  }

  function wrapper(): HTMLElement {
    if (container === null) throw new Error("container not initialized");
    // TextHtml renders exactly one outer wrapper div per text row;
    // single-row tests rely on the first div being the wrapper.
    const w = container.querySelector("div");
    if (w === null) throw new Error("no wrapper div rendered");
    return w as HTMLElement;
  }

  function wrapperTransform(): string {
    return wrapper().style.transform ?? "";
  }

  function wrapperLeftTop(): { left: string; top: string } {
    const w = wrapper();
    return { left: w.style.left ?? "", top: w.style.top ?? "" };
  }

  test("override rotation drives the wrapper transform, not persisted rotation", async () => {
    const persistedRotation = 0;
    const liveRotation = Math.PI / 4; // 45° during drag
    const row = textRow("t1", { rotation: persistedRotation });
    await render(
      [row],
      null,
      new Map([
        [
          "t1",
          {
            kind: "text",
            point: { x: 0.5, y: 0.5 },
            rotation: liveRotation
          }
        ]
      ])
    );
    // computeTextHtmlStyle emits rotate(<rad>rad) at the end of the
    // wrapper transform when rotation !== undefined.
    expect(wrapperTransform()).toContain(`rotate(${liveRotation}rad)`);
    // And the persisted-zero rotation should NOT have been used — a
    // rotate(0rad) anywhere would indicate the override was ignored.
    expect(wrapperTransform()).not.toContain("rotate(0rad)");
  });

  test("override point drives the wrapper position, not persisted point", async () => {
    const row = textRow("t1", { point: { x: 0.1, y: 0.1 } });
    await render(
      [row],
      null,
      new Map([
        ["t1", { kind: "text", point: { x: 0.9, y: 0.9 } }]
      ])
    );
    // Wrapper position is left/top: percent-of-canvas — driven by
    // point.x/y * 100. Persisted (0.1, 0.1) would yield 10% / 10%;
    // override (0.9, 0.9) wins.
    expect(wrapperLeftTop()).toEqual({ left: "90%", top: "90%" });
  });

  test("override only affects the matching row; other rows render at persisted point", async () => {
    await render(
      [
        textRow("t1", { body: "moving", point: { x: 0.5, y: 0.5 } }),
        textRow("t2", { body: "static", point: { x: 0.2, y: 0.7 } })
      ],
      null,
      new Map([
        ["t1", { kind: "text", point: { x: 0.9, y: 0.1 } }]
      ])
    );
    const movingWrapper = findWrapper("moving");
    const staticWrapper = findWrapper("static");
    expect(movingWrapper.style.left).toBe("90%");
    expect(movingWrapper.style.top).toBe("10%");
    // Untouched row stays at its persisted point.
    expect(staticWrapper.style.left).toBe("20%");
    expect(staticWrapper.style.top).toBe("70%");
  });

  test("override targeting a different layer leaves this row alone", async () => {
    // The override Map's keys don't include this row's id — the
    // projection's `.get(row.id)` returns undefined and the row
    // passes through unchanged, preserving the persisted rotation.
    const persistedRotation = Math.PI / 2; // 90°
    const row = textRow("t1", { rotation: persistedRotation });
    await render(
      [row],
      null,
      new Map([
        [
          "OTHER",
          {
            kind: "text",
            point: { x: 0.5, y: 0.5 },
            rotation: 0
          }
        ]
      ])
    );
    expect(wrapperTransform()).toContain(`rotate(${persistedRotation}rad)`);
  });

  test("override rotation omitted keeps persisted rotation (point-only drag)", async () => {
    // Body-drag updates point but not rotation. The merge must only
    // overwrite rotation when the geometry update carries one — same
    // shape as applyGeometryLocally for text overlays.
    const persistedRotation = Math.PI / 6;
    const row = textRow("t1", {
      rotation: persistedRotation,
      point: { x: 0.2, y: 0.2 }
    });
    await render(
      [row],
      null,
      new Map([
        [
          "t1",
          {
            kind: "text",
            point: { x: 0.7, y: 0.7 }
            // rotation intentionally absent
          }
        ]
      ])
    );
    // Point came from override (left/top, not transform).
    expect(wrapperLeftTop()).toEqual({ left: "70%", top: "70%" });
    // Rotation came from the row (transform).
    expect(wrapperTransform()).toContain(`rotate(${persistedRotation}rad)`);
  });

  test("null liveOverride renders persisted rotation as-is", async () => {
    const persistedRotation = Math.PI / 3;
    const row = textRow("t1", { rotation: persistedRotation });
    await render([row], null, null);
    expect(wrapperTransform()).toContain(`rotate(${persistedRotation}rad)`);
  });

  test("override whose geometry kind ≠ text leaves the text row alone", async () => {
    // The override pipeline is shared across overlay kinds — OverlaySvg
    // hands the same `liveOverride` down. If the user is dragging a
    // RECT (geometry.kind === "rect") that happens to share an id
    // with a text row (impossible in practice but the type system
    // doesn't enforce it), the projection must NOT smear rect
    // geometry onto the text row. The implementation gates on
    // `applyGeometryLocally` returning null when the merged kind
    // doesn't match the row's kind; this test pins that behavior.
    const persistedRotation = Math.PI / 4;
    const row = textRow("t1", {
      rotation: persistedRotation,
      point: { x: 0.3, y: 0.4 }
    });
    await render(
      [row],
      null,
      new Map([
        [
          "t1",
          // Rect-kind geometry — would carry a `rect` field, not
          // `point` / `rotation`. The merge should refuse it and
          // pass the row through unchanged.
          {
            kind: "rect",
            rect: { x: 0.8, y: 0.8, w: 0.1, h: 0.1 },
            rotation: Math.PI / 2
          }
        ]
      ])
    );
    // Persisted point + rotation both survive.
    expect(wrapperLeftTop()).toEqual({ left: "30%", top: "40%" });
    expect(wrapperTransform()).toContain(`rotate(${persistedRotation}rad)`);
  });

  test("multi-entry override (multi-drag) overrides each matching row independently", async () => {
    // Regression for user report: "multi-select on 4 arrows works...
    // only problem with it was: no live drag... it just jumps them
    // on release." The fix changed `liveOverride` from a single-id
    // `{ layerId, geometry }` to `ReadonlyMap<id, GeometryUpdate>`
    // so the multi-drag pointermove handler can stash one entry per
    // selected layer and every renderer projects all of them
    // concurrently. This test pins the multi-entry behavior at the
    // TextHtmlOverlays surface for text-kind multi-drag.
    await render(
      [
        textRow("t1", { body: "first", point: { x: 0.1, y: 0.1 } }),
        textRow("t2", { body: "second", point: { x: 0.2, y: 0.2 } }),
        textRow("t3", { body: "third", point: { x: 0.3, y: 0.3 } })
      ],
      null,
      new Map([
        // Translate t1 by (+0.5, +0.4) → (0.6, 0.5)
        ["t1", { kind: "text", point: { x: 0.6, y: 0.5 } }],
        // Translate t2 by (+0.5, +0.4) → (0.7, 0.6)
        ["t2", { kind: "text", point: { x: 0.7, y: 0.6 } }]
        // t3 intentionally OMITTED — its row should stay at the
        // persisted point. Multi-drag entries are per-layer; a
        // partial multi-select doesn't move unselected siblings.
      ])
    );
    const w1 = findWrapper("first");
    const w2 = findWrapper("second");
    const w3 = findWrapper("third");
    expect(w1.style.left).toBe("60%");
    expect(w1.style.top).toBe("50%");
    expect(w2.style.left).toBe("70%");
    expect(w2.style.top).toBe("60%");
    // Untouched row stays put.
    expect(w3.style.left).toBe("30%");
    expect(w3.style.top).toBe("30%");
  });

  test("empty override Map is the same as null (no projection)", async () => {
    // Defensive: a size-0 Map can show up briefly during gesture
    // wind-down. The projection should short-circuit identically to
    // null so we don't allocate a fresh `effectiveOverlays` array
    // for nothing.
    const row = textRow("t1", { point: { x: 0.4, y: 0.5 } });
    await render([row], null, new Map());
    expect(wrapperLeftTop()).toEqual({ left: "40%", top: "50%" });
  });
});

describe("TextHtmlOverlays — multi-line preservation", () => {
  test("blank lines (Shift+Enter twice) survive into the rendered glyph", async () => {
    // Regression for the SVG-side bug where empty <tspan> elements
    // collapsed to 0 height — the user typed blank lines in the
    // editor and they vanished after commit. HTML line-boxes always
    // take vertical space, so blank lines round-trip naturally.
    // We assert by checking the body text contains the literal \n\n
    // (HTML rendering preserves the whitespace via white-space: pre).
    const body = "line one\n\nline three";
    await render([textRow("t1", { body })]);
    const bodies = textBodies();
    // textContent collapses some whitespace, but our white-space:pre
    // glyph div emits the exact body. textContent of the glyph div
    // is the body itself.
    expect(bodies).toContain(body);
  });
});
