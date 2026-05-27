// Tests for `TextHtmlOverlays` — the new owner of the
// "suppress the text overlay currently being re-edited" rule that used
// to live in OverlaySvg. Display + edit must not double-render the
// same glyph: TextDraftInput paints the editable copy, this component
// paints the rest of the persisted text rows.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";

import { TextHtmlOverlays, type TextHtmlOverlaysProps } from "../TextHtmlOverlays";

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

describe("TextHtmlOverlays — liveOverride drag preview", () => {
  // Live-drag preview parity with OverlaySvg / BlurOverlays. When the
  // user grabs a text overlay by its TransformHandles body-hit rect and
  // drags, the parent stashes the in-progress geometry as `draftGeometry`
  // and threads it into every renderer that paints overlays. Pre-fix,
  // TextHtmlOverlays didn't accept the override at all — the painted
  // glyph stayed at its persisted anchor and the user only saw the
  // dashed selection outline + handles move, with the text snapping
  // into place at pointerup. Same regression class the SVG-side fix
  // already protects against (see OverlaySvg.tsx `effectiveOverlays`).
  // computeTextHtmlStyle emits `position: absolute` ONLY on the
  // outer wrapper (the glyph is a static-position child). Use that
  // to pick the wrapper out of `div`s without having to know the
  // exact DOM nesting.
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

  test("override on a text row repositions the rendered wrapper", async () => {
    await render(
      [textRow("t1", { body: "moving", point: { x: 0.5, y: 0.5 } })],
      null,
      {
        layerId: "t1",
        geometry: { kind: "text", point: { x: 0.8, y: 0.3 } }
      }
    );
    const wrapper = findWrapper("moving");
    // computeTextHtmlStyle emits `left: ${point.x * 100}%` on the
    // wrapper — the override's point.x = 0.8 → 80%.
    expect(wrapper.style.left).toBe("80%");
    expect(wrapper.style.top).toBe("30%");
  });

  test("override only affects the matching row; other rows render at persisted point", async () => {
    await render(
      [
        textRow("t1", { body: "moving", point: { x: 0.5, y: 0.5 } }),
        textRow("t2", { body: "static", point: { x: 0.2, y: 0.7 } })
      ],
      null,
      {
        layerId: "t1",
        geometry: { kind: "text", point: { x: 0.9, y: 0.1 } }
      }
    );
    const movingWrapper = findWrapper("moving");
    const staticWrapper = findWrapper("static");
    expect(movingWrapper.style.left).toBe("90%");
    expect(movingWrapper.style.top).toBe("10%");
    // Untouched row stays at its persisted point.
    expect(staticWrapper.style.left).toBe("20%");
    expect(staticWrapper.style.top).toBe("70%");
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
