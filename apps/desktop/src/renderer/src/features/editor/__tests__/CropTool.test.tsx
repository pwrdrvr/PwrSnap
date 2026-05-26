// Tests for CropTool — the v1-compatible crop overlay introduced in
// Phase 1 of the v2 editor refresh. The component manages its own
// rect state in source-pixel coords; tests drive interactions via
// React's act + raw pointer events so we don't take a hard dep on
// @testing-library/react.
//
// canvasRect is mocked as a DOMRect-like object. We size the canvas
// rect to match the source dimensions so 1 source-pixel == 1
// viewport-pixel, which keeps the pointer-event math trivial.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance
} from "vitest";

import { CropTool, formatAspectRatio, formatHud } from "../CropTool";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function makeRect(x: number, y: number, w: number, h: number): DOMRect {
  // DOMRect-like — only the props CropTool reads. Cast to DOMRect
  // for the component prop type.
  return {
    x,
    y,
    width: w,
    height: h,
    top: y,
    left: x,
    right: x + w,
    bottom: y + h,
    toJSON: () => ({})
  } as DOMRect;
}

type CommitFn = (rect: { x: number; y: number; w: number; h: number }) => void;
type CancelFn = () => void;

interface RenderProps {
  captureId?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  canvasRect?: DOMRect | null;
  onCommit?: ReturnType<typeof vi.fn<CommitFn>>;
  onCancel?: ReturnType<typeof vi.fn<CancelFn>>;
}

async function renderCropTool(p: RenderProps = {}): Promise<{
  onCommit: ReturnType<typeof vi.fn<CommitFn>>;
  onCancel: ReturnType<typeof vi.fn<CancelFn>>;
}> {
  const onCommit = p.onCommit ?? vi.fn<CommitFn>();
  const onCancel = p.onCancel ?? vi.fn<CancelFn>();
  const sw = p.sourceWidth ?? 1000;
  const sh = p.sourceHeight ?? 800;
  const cr = p.canvasRect === undefined ? makeRect(0, 0, sw, sh) : p.canvasRect;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(CropTool, {
        captureId: p.captureId ?? "cap_1",
        sourceWidth: sw,
        sourceHeight: sh,
        canvasRect: cr,
        onCommit,
        onCancel
      })
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { onCommit, onCancel };
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
}

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
});

/** Helper — fire a pointerdown on `el` with the given client coords. */
async function pointerDown(el: Element, clientX: number, clientY: number, pointerId = 1): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        pointerId
      })
    );
  });
}

async function pointerMove(el: Element, clientX: number, clientY: number, pointerId = 1): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        pointerId
      })
    );
  });
}

async function pointerUp(el: Element, clientX: number, clientY: number, pointerId = 1): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        pointerId
      })
    );
  });
}

async function keyDown(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function getRectEl(): HTMLElement {
  const el = container!.querySelector('[data-testid="crop-rect"]') as HTMLElement | null;
  if (el === null) throw new Error("crop-rect not found");
  return el;
}

function getRectLayout(): { left: number; top: number; width: number; height: number } {
  const el = getRectEl();
  // Inline style holds our source-of-truth layout (jsdom doesn't
  // compute layout). Parse the inline left/top/width/height values.
  const style = el.style;
  return {
    left: parseFloat(style.left),
    top: parseFloat(style.top),
    width: parseFloat(style.width),
    height: parseFloat(style.height)
  };
}

function getHudText(): string {
  return container!.querySelector('[data-testid="crop-hud"]')?.textContent ?? "";
}

beforeEach(() => {
  // Stub setPointerCapture / releasePointerCapture — jsdom doesn't
  // implement them but our component uses setPointerCapture for the
  // drag-leave-handle case.
  if (
    typeof (HTMLElement.prototype as unknown as { setPointerCapture?: unknown })
      .setPointerCapture !== "function"
  ) {
    (HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
      () => undefined;
    (HTMLElement.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture =
      () => undefined;
  } else {
    // Already exists — stub via spy so tests don't error on missing
    // pointer captures (jsdom's stub may still throw).
    const proto = HTMLElement.prototype as unknown as { setPointerCapture: () => void };
    const spy = vi.spyOn(proto, "setPointerCapture") as MockInstance;
    spy.mockImplementation(() => undefined);
  }
});

// ----------------------------------------------------------- pure helper tests

describe("formatAspectRatio", () => {
  test("400 × 300 reduces to 4:3", () => {
    expect(formatAspectRatio(400, 300)).toBe("4:3");
  });

  test("1024 × 768 reduces to 4:3", () => {
    expect(formatAspectRatio(1024, 768)).toBe("4:3");
  });

  test("1920 × 1080 reduces to 16:9", () => {
    expect(formatAspectRatio(1920, 1080)).toBe("16:9");
  });

  test("1000 × 333 falls back to decimal-:1 form", () => {
    expect(formatAspectRatio(1000, 333)).toBe("3.003:1");
  });
});

describe("formatHud", () => {
  test("composes W × H · ratio", () => {
    expect(formatHud(400, 300)).toBe("400 × 300 · 4:3");
    expect(formatHud(1024, 768)).toBe("1024 × 768 · 4:3");
    expect(formatHud(1920, 1080)).toBe("1920 × 1080 · 16:9");
    expect(formatHud(1000, 333)).toBe("1000 × 333 · 3.003:1");
  });
});

// -------------------------------------------------------------- render tests

describe("CropTool", () => {
  test("default render: rect centered at 60% of source dims; HUD shows W×H + ratio", async () => {
    // 1000 × 800 → 600 × 480 centered at (200, 160).
    await renderCropTool({ sourceWidth: 1000, sourceHeight: 800 });
    const layout = getRectLayout();
    expect(layout.width).toBeCloseTo(600);
    expect(layout.height).toBeCloseTo(480);
    expect(layout.left).toBeCloseTo(200);
    expect(layout.top).toBeCloseTo(160);
    // 600 / 480 = 5/4 (gcd 120).
    expect(getHudText()).toBe("600 × 480 · 5:4");
  });

  test("drag SE corner handle by +50 source-px → rect grows by 50 each axis; ratio updates", async () => {
    // 1000 × 800 default rect: 600×480 at (200,160). SE corner at
    // canvas coords (800, 640) — same as source coords (canvas
    // matches source dims).
    await renderCropTool({ sourceWidth: 1000, sourceHeight: 800 });
    const seHandle = container!.querySelector('[data-testid="crop-handle-se"]')!;
    await pointerDown(seHandle, 800, 640);
    await pointerMove(seHandle, 850, 690);
    await pointerUp(seHandle, 850, 690);
    const layout = getRectLayout();
    expect(layout.width).toBeCloseTo(650);
    expect(layout.height).toBeCloseTo(530);
    expect(layout.left).toBeCloseTo(200);
    expect(layout.top).toBeCloseTo(160);
    // 650 × 530 — gcd 10 → 65 : 53 (both ≤ 50? 65 > 50 → fallback)
    // ratio = 650/530 ≈ 1.226
    expect(getHudText()).toBe("650 × 530 · 1.226:1");
  });

  test("drag interior translates the rect without changing size", async () => {
    await renderCropTool({ sourceWidth: 1000, sourceHeight: 800 });
    const rectEl = getRectEl();
    // Click in the middle of the rect (500, 400) and drag to (550, 430).
    await pointerDown(rectEl, 500, 400);
    await pointerMove(rectEl, 550, 430);
    await pointerUp(rectEl, 550, 430);
    const layout = getRectLayout();
    expect(layout.width).toBeCloseTo(600);
    expect(layout.height).toBeCloseTo(480);
    expect(layout.left).toBeCloseTo(250);
    expect(layout.top).toBeCloseTo(190);
  });

  test("drag past canvas edge → rect constrained to canvas bounds", async () => {
    await renderCropTool({ sourceWidth: 1000, sourceHeight: 800 });
    const rectEl = getRectEl();
    // Default rect at (200, 160) size 600×480. Translate by
    // (+10000, +10000) — should clamp so rect fits inside canvas:
    // x = 1000 - 600 = 400, y = 800 - 480 = 320.
    await pointerDown(rectEl, 500, 400);
    await pointerMove(rectEl, 10500, 10400);
    await pointerUp(rectEl, 10500, 10400);
    const layout = getRectLayout();
    expect(layout.left).toBeCloseTo(400);
    expect(layout.top).toBeCloseTo(320);
    expect(layout.width).toBeCloseTo(600);
    expect(layout.height).toBeCloseTo(480);
  });

  test("resize below 16x16 → constrained to 16x16 min", async () => {
    await renderCropTool({ sourceWidth: 1000, sourceHeight: 800 });
    // Drag SE corner toward NW so the would-be size shrinks below
    // the 16px floor. NW is at (200, 160); drag SE from (800, 640)
    // to (205, 165) — would produce 5x5, expect clamp to 16x16.
    const seHandle = container!.querySelector('[data-testid="crop-handle-se"]')!;
    await pointerDown(seHandle, 800, 640);
    await pointerMove(seHandle, 205, 165);
    await pointerUp(seHandle, 205, 165);
    const layout = getRectLayout();
    expect(layout.width).toBeCloseTo(16);
    expect(layout.height).toBeCloseTo(16);
  });

  test("while dragging: rule-of-thirds guides are visible (4 lines)", async () => {
    await renderCropTool({ sourceWidth: 1000, sourceHeight: 800 });
    const seHandle = container!.querySelector('[data-testid="crop-handle-se"]')!;
    await pointerDown(seHandle, 800, 640);
    await pointerMove(seHandle, 810, 650);
    const guides = container!.querySelectorAll('[data-testid="crop-guide"]');
    expect(guides.length).toBe(4);
    await pointerUp(seHandle, 810, 650);
  });

  test("after mouseup: rule-of-thirds guides are hidden", async () => {
    await renderCropTool({ sourceWidth: 1000, sourceHeight: 800 });
    const seHandle = container!.querySelector('[data-testid="crop-handle-se"]')!;
    await pointerDown(seHandle, 800, 640);
    await pointerMove(seHandle, 810, 650);
    await pointerUp(seHandle, 810, 650);
    const guides = container!.querySelectorAll('[data-testid="crop-guide"]');
    expect(guides.length).toBe(0);
  });

  test("Escape → onCancel called", async () => {
    const { onCancel } = await renderCropTool({ sourceWidth: 1000, sourceHeight: 800 });
    await keyDown("Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("Enter → onCommit called with normalized [0,1] rect", async () => {
    const { onCommit } = await renderCropTool({ sourceWidth: 1000, sourceHeight: 800 });
    await keyDown("Enter");
    expect(onCommit).toHaveBeenCalledTimes(1);
    const arg = onCommit.mock.calls[0]![0];
    // Default rect: 600x480 at (200, 160) on 1000x800 source.
    expect(arg.x).toBeCloseTo(0.2);
    expect(arg.y).toBeCloseTo(0.2);
    expect(arg.w).toBeCloseTo(0.6);
    expect(arg.h).toBeCloseTo(0.6);
  });

  test("click outside the canvas (not on a handle) → onCancel called", async () => {
    const { onCancel } = await renderCropTool({
      sourceWidth: 1000,
      sourceHeight: 800,
      canvasRect: makeRect(0, 0, 1000, 800)
    });
    // Dispatch a window-level pointerdown at (2000, 2000) which is
    // outside the canvas rect.
    await act(async () => {
      window.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          clientX: 2000,
          clientY: 2000,
          pointerId: 99
        })
      );
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("HUD ratio for 400x300 crop → '400 × 300 · 4:3'", async () => {
    // Default rect for 666.6 × 500 source is 400 × 300.
    // Easier: render with the source matching that, default 60%.
    // 666.667 × 500 → 400 × 300. But float w/h round to integers in
    // the HUD anyway. Use 666 × 500 → 60% = 399.6 × 300 → HUD
    // rounds to 400 × 300.
    await renderCropTool({ sourceWidth: 666, sourceHeight: 500 });
    expect(getHudText()).toContain("400 × 300 · 4:3");
  });

  test("HUD ratio for 1024x768 → '1024 × 768 · 4:3'", async () => {
    // Resize the default rect to exactly 1024×768 via the SE handle.
    // Source 2000×1500; default rect = 1200×900 at (400, 300). Drag
    // SE corner from (1600, 1200) to (1424, 1068) → new size 1024×768.
    await renderCropTool({ sourceWidth: 2000, sourceHeight: 1500 });
    const seHandle = container!.querySelector('[data-testid="crop-handle-se"]')!;
    await pointerDown(seHandle, 1600, 1200);
    await pointerMove(seHandle, 1424, 1068);
    await pointerUp(seHandle, 1424, 1068);
    expect(getHudText()).toBe("1024 × 768 · 4:3");
  });

  test("HUD ratio for 1920x1080 → '1920 × 1080 · 16:9'", async () => {
    // Source 3200×1800; default rect = 1920×1080 at (640, 360).
    await renderCropTool({ sourceWidth: 3200, sourceHeight: 1800 });
    expect(getHudText()).toBe("1920 × 1080 · 16:9");
  });

  test("HUD ratio for 1000x333 → won't reduce cleanly", async () => {
    // Use the pure helper directly — driving the rect to exactly
    // (1000, 333) via pointer math would be brittle. The HUD's
    // formatter is the contract under test here.
    expect(formatHud(1000, 333)).toBe("1000 × 333 · 3.003:1");
  });

  // -------------------------------------- visible action cluster tests
  //
  // The Apply Crop + Cancel buttons inside the overlay are the
  // discoverable alternative to the ⌘↩ / Esc keyboard shortcuts.
  // They MUST fire the same callbacks as the keyboard accelerators
  // and MUST NOT initiate a rect drag when clicked (the buttons stop
  // pointerdown propagation).

  test("Apply button click → onCommit called with normalized rect", async () => {
    const { onCommit } = await renderCropTool({ sourceWidth: 1000, sourceHeight: 800 });
    const applyBtn = container!.querySelector('[data-testid="crop-apply"]') as HTMLButtonElement | null;
    expect(applyBtn).not.toBeNull();
    await act(async () => {
      applyBtn!.click();
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const arg = onCommit.mock.calls[0]![0];
    // Default 60% centered rect on 1000×800 → (0.2, 0.2, 0.6, 0.6).
    expect(arg.x).toBeCloseTo(0.2);
    expect(arg.y).toBeCloseTo(0.2);
    expect(arg.w).toBeCloseTo(0.6);
    expect(arg.h).toBeCloseTo(0.6);
  });

  test("Cancel button click → onCancel called", async () => {
    const { onCancel, onCommit } = await renderCropTool({
      sourceWidth: 1000,
      sourceHeight: 800
    });
    const cancelBtn = container!.querySelector('[data-testid="crop-cancel"]') as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();
    await act(async () => {
      cancelBtn!.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  test("Apply button pointerdown does NOT initiate a rect drag", async () => {
    // If propagation weren't stopped, pressing on the button would
    // start an "interior" drag on the parent rect. We verify by
    // moving the pointer after a press and observing the rect's
    // layout stays put.
    await renderCropTool({ sourceWidth: 1000, sourceHeight: 800 });
    const applyBtn = container!.querySelector('[data-testid="crop-apply"]') as HTMLButtonElement | null;
    expect(applyBtn).not.toBeNull();
    const before = getRectLayout();
    await pointerDown(applyBtn!, 700, 200);
    await pointerMove(applyBtn!, 800, 300);
    await pointerUp(applyBtn!, 800, 300);
    const after = getRectLayout();
    expect(after.left).toBeCloseTo(before.left);
    expect(after.top).toBeCloseTo(before.top);
    expect(after.width).toBeCloseTo(before.width);
    expect(after.height).toBeCloseTo(before.height);
  });

  test("overlay root is focused on mount (so Enter/Esc reach the window listener)", async () => {
    await renderCropTool({ sourceWidth: 1000, sourceHeight: 800 });
    const overlay = container!.querySelector('[data-testid="crop-tool"]') as HTMLElement | null;
    expect(overlay).not.toBeNull();
    expect(overlay!.getAttribute("tabindex")).toBe("-1");
    // jsdom respects programmatic focus; document.activeElement should
    // be the overlay after the mount-time .focus() call.
    expect(document.activeElement).toBe(overlay);
  });

  // ---------------- pwrdrvr/PwrSnap#110 visual contracts ---------------
  //
  // After-fixes screenshots showed two UX problems the user flagged
  // directly: (1) the visible 1px crop-rect line was drawn INSIDE the
  // rect's pixel bounds (via `border + box-sizing: border-box`), making
  // it ambiguous whether the 1px line counted as "kept" or "cropped";
  // (2) the W×H HUD used theme tokens that disappeared into a black
  // image when the user was in light theme (text dark, background ~32%
  // black-on-black = invisible).
  //
  // These tests pin the visual contract via INLINE style assertions so
  // a JSDOM render can verify them without a real layout engine.

  test("rect visible boundary uses CSS outline (drawn OUTSIDE the rect's pixel bounds), not border (drawn INSIDE)", async () => {
    // Outline draws JUST OUTSIDE the box without consuming any pixels
    // inside. The rect's left/top/width/height encode EXACTLY the
    // kept region; the visible indicator sits in the dim area. Pre-
    // fix used `border: 1px solid` with box-sizing: border-box, which
    // visibly ate the outermost 1px of the rect — the user perceived
    // the kept region as ~1 CSS px smaller than what got committed.
    await renderCropTool();
    const rect = container?.querySelector(
      '[data-testid="crop-rect"]'
    ) as HTMLElement | null;
    expect(rect).not.toBeNull();
    if (rect === null) throw new Error("unreachable");
    // Inline `outline` style — testable via the .style property.
    // The exact value is a CSS shorthand; assert the key parts.
    const outline = rect.style.outline;
    expect(outline, "rect must have an inline outline declaration").not.toBe("");
    expect(outline, "outline must be dashed (per user spec)").toMatch(/dashed/);
    expect(outline, "outline must be 1px thick (crisp, not chunky)").toMatch(/(^|\s)1px(\s|$)/);
    // Outline-offset 0 keeps the outline flush against the rect's
    // edge — drawn on the OUTSIDE of the box, not floating away.
    expect(rect.style.outlineOffset).toBe("0px");
    // CRITICAL: no `border` (1px+) on the inline style. The CSS
    // class might still declare a thin chrome border for, e.g.,
    // border-radius, but the *inline* style is the source of truth
    // for the kept-region boundary indicator.
    const border = rect.style.border;
    expect(border, "rect must NOT have an inline border that encroaches on kept pixels").not.toMatch(/^\s*\d+px/);
  });

  test("HUD has a theme-independent high-contrast inline background (visible on any image)", async () => {
    // Pre-fix the HUD inherited theme tokens (--bg-overlay,
    // --text-primary). In LIGHT theme those resolve to a ~32%
    // black scrim + near-black text — invisible on a black image
    // (which is what the user was cropping). Theme-independent
    // inline colors fix the entire bug class.
    await renderCropTool();
    const hud = container?.querySelector(
      '[data-testid="crop-hud"]'
    ) as HTMLElement | null;
    expect(hud).not.toBeNull();
    if (hud === null) throw new Error("unreachable");
    // Dark scrim — high enough opacity to read text against the
    // brightest possible image content.
    expect(hud.style.backgroundColor).toBe("rgba(0, 0, 0, 0.85)");
    // White text — pure white (not bone) so contrast is maximal
    // against the dark scrim regardless of theme.
    expect(hud.style.color).toBe("rgb(255, 255, 255)");
    // Subtle 1px white inset shadow for definition against light
    // images (where the dark scrim alone could blend in at the
    // edges).
    expect(hud.style.boxShadow).toContain("inset");
    expect(hud.style.boxShadow).toContain("rgba(255, 255, 255");
  });
});
