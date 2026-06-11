// Component tests for RegionSelector — the region/window capture
// selector overlay. Drives the component via React's `act` + raw
// window-dispatched DOM events (the component attaches its handlers to
// `window`), mirroring the harness in
// features/editor/__tests__/CropTool.test.tsx. The repo does not use
// @testing-library/react.
//
// jsdom applies no CSS, so visibility-by-state assertions check the
// data-* attributes the CSS keys on (body[data-interaction],
// body[data-mode]) rather than computed styles. Geometry is read from
// inline styles, which the component writes directly.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import type { WindowSnapEntry } from "../../../preload-types";
import { RegionSelector } from "../RegionSelector";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

type ModePayload = {
  mode: "auto" | "region" | "window";
  screenUrl?: string;
  intent?: "snap" | "video";
};
type SnapshotPayload = {
  windows: WindowSnapEntry[];
  displayBounds: { width: number; height: number };
  cursor?: { x: number; y: number };
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

let modeHandler: ((p: ModePayload) => void) | null = null;
let snapshotHandler: ((p: SnapshotPayload) => void) | null = null;
let keyHandler: ((p: { key: string; shiftKey?: boolean }) => void) | null = null;
const submitRegion = vi.fn();

function installSelectorApi(): void {
  modeHandler = null;
  snapshotHandler = null;
  keyHandler = null;
  submitRegion.mockReset();
  window.pwrsnapApi = {
    platform: "test",
    versions: { chrome: "", electron: "", node: "" },
    dispatch: vi.fn(),
    on: vi.fn(() => () => undefined),
    submitRegion,
    onWindowListSnapshot: (h: (p: SnapshotPayload) => void) => {
      snapshotHandler = h;
      return () => undefined;
    },
    onSelectorKey: (h: (p: { key: string; shiftKey?: boolean }) => void) => {
      keyHandler = h;
      return () => undefined;
    },
    onSelectorMode: (h: (p: ModePayload) => void) => {
      modeHandler = h;
      return () => undefined;
    },
    requestTrayResize: vi.fn(),
    requestFloatOverResize: vi.fn(),
    startCaptureDrag: vi.fn(),
    startVideoDrag: vi.fn(),
    reportSelectorDiagnostics: vi.fn(),
    perfMark: vi.fn()
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
}

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(RegionSelector));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  installSelectorApi();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  // Clear the body attributes the component stamps so state never
  // leaks across tests.
  for (const k of ["interaction", "snap", "spaceHeld", "fullWindow", "mode", "discarding"]) {
    delete document.body.dataset[k];
  }
});

// --- event + query helpers (shared across unit describes) -----------

async function mouseMove(x: number, y: number): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
  });
}

async function emitMode(p: ModePayload): Promise<void> {
  await act(async () => {
    modeHandler?.(p);
  });
}

async function emitSnapshot(p: SnapshotPayload): Promise<void> {
  await act(async () => {
    snapshotHandler?.(p);
  });
}

function hLine(): HTMLElement {
  const el = container?.querySelector('[data-testid="region-crosshair-h"]');
  if (!(el instanceof HTMLElement)) throw new Error("horizontal crosshair line not found");
  return el;
}

function vLine(): HTMLElement {
  const el = container?.querySelector('[data-testid="region-crosshair-v"]');
  if (!(el instanceof HTMLElement)) throw new Error("vertical crosshair line not found");
  return el;
}

async function mouseDown(x: number, y: number, target?: Element): Promise<void> {
  await act(async () => {
    const ev = new MouseEvent("mousedown", { clientX: x, clientY: y, button: 0, bubbles: true });
    if (target !== undefined) {
      // dispatch on a specific element so event.target carries its dataset
      target.dispatchEvent(ev);
    } else {
      window.dispatchEvent(ev);
    }
  });
}

async function mouseUp(x: number, y: number): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: x, clientY: y, button: 0, bubbles: true }));
  });
}

async function keyDown(key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
    );
  });
}

async function emitKey(key: string, init: { shiftKey?: boolean } = {}): Promise<void> {
  await act(async () => {
    keyHandler?.({ key, ...init });
  });
}

// Real-time delay, used to let the Escape de-dupe guard (a ~50ms timer)
// disarm between a step-back and a deliberate second Escape. Kept just
// above ESCAPE_DEDUPE_MS so the second press is honored.
const ESC_GUARD_WAIT_MS = 70;
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** snap → pending → drawing → adjusting via a free-draw drag. */
async function drawRect(): Promise<void> {
  await mouseMove(100, 100);
  await mouseDown(100, 100);
  await mouseMove(300, 300);
  await mouseUp(300, 300);
}

function regionHintText(): string {
  const el = container?.querySelector(".region-hint");
  return (el?.textContent ?? "").toLowerCase();
}

function rectStyle(): { left: number; top: number; width: number; height: number } {
  const el = container?.querySelector(".region-rect");
  if (!(el instanceof HTMLElement)) throw new Error("region-rect not found");
  const num = (v: string): number => Number.parseFloat(v.replace("px", ""));
  return {
    left: num(el.style.left),
    top: num(el.style.top),
    width: num(el.style.width),
    height: num(el.style.height)
  };
}

const WIN: WindowSnapEntry = {
  windowId: 4242,
  pid: 1,
  bundleId: "com.test.app",
  appName: "Target App",
  title: null,
  ownedByUs: false,
  zIndex: 0,
  rect: { x: 200, y: 150, w: 400, h: 300 },
  rawRect: { x: 200, y: 150, w: 400, h: 300 }
};

const WIN_BEHIND: WindowSnapEntry = {
  windowId: 5252,
  pid: 2,
  bundleId: "com.test.behind",
  appName: "Behind App",
  title: null,
  ownedByUs: false,
  zIndex: 1,
  rect: { x: 150, y: 100, w: 500, h: 400 },
  rawRect: { x: 150, y: 100, w: 500, h: 400 }
};

/** snap → hover a window → click (no drag) → adjusting with a window
 *  snap. displayBounds = innerSize so the css-to-logical scale is 1. */
async function adjustWindowSnap(): Promise<void> {
  await emitSnapshot({
    windows: [WIN],
    displayBounds: { width: window.innerWidth, height: window.innerHeight }
  });
  const cx = WIN.rect.x + WIN.rect.w / 2;
  const cy = WIN.rect.y + WIN.rect.h / 2;
  await mouseMove(cx, cy);
  await mouseDown(cx, cy);
  await mouseUp(cx, cy);
}

describe("U1 — crosshair guide-lines", () => {
  test("mounts in snap mode and seeds the crosshair to viewport center", async () => {
    await mount();
    expect(document.body.dataset.interaction).toBe("snap");
    // jsdom defaults to 1024x768; seed = center.
    expect(vLine().style.left).toBe(`${window.innerWidth / 2}px`);
    expect(hLine().style.top).toBe(`${window.innerHeight / 2}px`);
  });

  test("mousemove repositions both lines to the cursor", async () => {
    await mount();
    await mouseMove(300, 200);
    expect(vLine().style.left).toBe("300px");
    expect(hLine().style.top).toBe("200px");
    // A second move tracks again.
    await mouseMove(450, 260);
    expect(vLine().style.left).toBe("450px");
    expect(hLine().style.top).toBe("260px");
  });

  test("window mode is surfaced as body[data-mode] (the CSS hide signal)", async () => {
    await mount();
    await emitMode({ mode: "window" });
    expect(document.body.dataset.mode).toBe("window");
    // auto / region keep the crosshair (attribute is not "window").
    await emitMode({ mode: "region" });
    expect(document.body.dataset.mode).toBe("region");
    await emitMode({ mode: "auto" });
    expect(document.body.dataset.mode).toBe("auto");
  });

  test("window-list snapshot cursor seeds the crosshair in snap mode", async () => {
    await mount();
    await emitSnapshot({
      windows: [],
      // displayBounds width == innerWidth → scale 1, so cursor maps 1:1.
      displayBounds: { width: window.innerWidth, height: window.innerHeight },
      cursor: { x: 120, y: 80 }
    });
    expect(vLine().style.left).toBe("120px");
    expect(hLine().style.top).toBe("80px");
  });

  test("forwarded-IPC Tab cycles overlapping snap targets without renderer focus", async () => {
    await mount();
    await emitSnapshot({
      windows: [WIN, WIN_BEHIND],
      displayBounds: { width: window.innerWidth, height: window.innerHeight }
    });
    await mouseMove(400, 300);
    expect(rectStyle()).toEqual({ left: 200, top: 150, width: 400, height: 300 });

    await emitKey("Tab");
    expect(rectStyle()).toEqual({ left: 150, top: 100, width: 500, height: 400 });

    await emitKey("Tab", { shiftKey: true });
    expect(rectStyle()).toEqual({ left: 200, top: 150, width: 400, height: 300 });
  });
});

describe("U2 — multi-step Escape", () => {
  test("Esc in snap (nothing picked) exits immediately", async () => {
    await mount();
    expect(document.body.dataset.interaction).toBe("snap");
    await keyDown("Escape");
    expect(submitRegion).toHaveBeenCalledTimes(1);
    expect(submitRegion).toHaveBeenCalledWith({ ok: false });
  });

  test("first Esc from a committed pick steps back to snap without submitting", async () => {
    await mount();
    await drawRect();
    expect(document.body.dataset.interaction).toBe("adjusting");

    await keyDown("Escape");
    expect(document.body.dataset.interaction).toBe("snap");
    expect(container?.querySelectorAll(".region-handle").length).toBe(0);
    expect(submitRegion).not.toHaveBeenCalled();
  });

  test("second Esc (after stepping back) exits", async () => {
    await mount();
    await drawRect();
    await keyDown("Escape"); // step back → snap
    expect(submitRegion).not.toHaveBeenCalled();
    await delay(ESC_GUARD_WAIT_MS); // let the de-dupe guard disarm
    await keyDown("Escape"); // now in snap → exit
    expect(submitRegion).toHaveBeenCalledTimes(1);
    expect(submitRegion).toHaveBeenCalledWith({ ok: false });
  });

  test("Esc during a staged interior discard clears the dim (no stuck data-discarding)", async () => {
    await mount();
    await drawRect(); // adjusting (free region)
    await mouseDown(150, 150); // stage a discard → pending, dim on
    expect(document.body.dataset.discarding).toBe("true");
    await keyDown("Escape"); // step back from pending → snap
    expect(document.body.dataset.interaction).toBe("snap");
    expect(document.body.dataset.discarding).toBe("false"); // not stuck
    expect(submitRegion).not.toHaveBeenCalled(); // step-back never submits
    await mouseUp(150, 150); // release the still-down button — no re-dim
    expect(document.body.dataset.discarding).toBe("false");
  });

  test("forwarded-IPC Escape steps back identically to the keydown path", async () => {
    await mount();
    await drawRect();
    await emitKey("Escape"); // the only-live path under macOS focus-withholding
    expect(document.body.dataset.interaction).toBe("snap");
    expect(submitRegion).not.toHaveBeenCalled();
  });

  test("a forwarded Esc right after a keydown step-back is swallowed (no cancel)", async () => {
    await mount();
    await drawRect();
    // Direct keydown steps back (renders → interaction now snap)...
    await keyDown("Escape");
    expect(document.body.dataset.interaction).toBe("snap");
    // ...and the duplicate forwarded delivery of the SAME press, arriving
    // within the de-dupe window with no mousemove between, must NOT cancel.
    await emitKey("Escape");
    expect(submitRegion).not.toHaveBeenCalled();
    expect(document.body.dataset.interaction).toBe("snap");
  });

  test("hint copy: 'esc back' while adjusting, 'esc cancel' in snap", async () => {
    await mount();
    expect(regionHintText()).toContain("cancel");
    expect(regionHintText()).not.toContain("back");
    await drawRect();
    expect(regionHintText()).toContain("back");
    expect(regionHintText()).not.toContain("cancel");
  });
});

describe("U3 — interior drag discards + redraws", () => {
  test("interior drag on a window snap discards it and free-draws a new region", async () => {
    await mount();
    await adjustWindowSnap();
    expect(document.body.dataset.interaction).toBe("adjusting");

    // Interior mousedown + drag past threshold → a brand-new region.
    await mouseDown(400, 300);
    await mouseMove(420, 320); // > DRAG_ENGAGE_PX → drawing
    await mouseMove(700, 500);
    await mouseUp(700, 500);

    expect(document.body.dataset.interaction).toBe("adjusting");
    expect(rectStyle()).toEqual({ left: 400, top: 300, width: 300, height: 200 });
    // The window pick was discarded — commit carries no snappedWindowId.
    await keyDown("Enter");
    expect(submitRegion).toHaveBeenCalledTimes(1);
    const payload = submitRegion.mock.calls[0]?.[0];
    expect(payload.ok).toBe(true);
    expect(payload.snappedWindowId).toBeUndefined();
  });

  test("interior drag on a free-drawn region replaces it", async () => {
    await mount();
    await drawRect(); // (100,100)-(300,300)
    await mouseDown(150, 150);
    await mouseMove(170, 170);
    await mouseMove(500, 400);
    await mouseUp(500, 400);
    expect(rectStyle()).toEqual({ left: 150, top: 150, width: 350, height: 250 });
  });

  test("interior click (no drag) keeps a free-drawn region — no jump to full display", async () => {
    await mount();
    await drawRect();
    const before = rectStyle();
    expect(before).toEqual({ left: 100, top: 100, width: 200, height: 200 });
    await mouseDown(150, 150);
    await mouseUp(150, 150); // no drag → keep
    expect(document.body.dataset.interaction).toBe("adjusting");
    expect(rectStyle()).toEqual(before); // unchanged, NOT the full viewport
  });

  test("interior click (no drag) keeps a window snap + preserves snappedWindowId", async () => {
    await mount();
    await adjustWindowSnap();
    await mouseDown(400, 300);
    await mouseUp(400, 300); // no drag → keep
    expect(document.body.dataset.interaction).toBe("adjusting");
    expect(rectStyle()).toEqual({ left: 200, top: 150, width: 400, height: 300 });
    await keyDown("Enter");
    const payload = submitRegion.mock.calls[0]?.[0];
    expect(payload.snappedWindowId).toBe(WIN.windowId);
  });

  test("discard-pending dims the rect while staged; cleared on mouseup", async () => {
    await mount();
    await drawRect();
    await mouseDown(150, 150);
    expect(document.body.dataset.discarding).toBe("true");
    await mouseUp(150, 150);
    expect(document.body.dataset.discarding).toBe("false");
  });

  test("handle mousedown still resizes (not discard)", async () => {
    await mount();
    await drawRect();
    const handle = container?.querySelector(".region-handle.br");
    if (!(handle instanceof HTMLElement)) throw new Error("br handle not found");
    await mouseDown(300, 300, handle);
    expect(document.body.dataset.interaction).toBe("resizing");
    expect(document.body.dataset.discarding).not.toBe("true");
  });

  test("Space-held interior mousedown still moves", async () => {
    await mount();
    await drawRect();
    await keyDown(" "); // sets spaceHeld (adjusting only)
    await mouseDown(150, 150);
    expect(document.body.dataset.interaction).toBe("moving");
  });
});

describe("U4 — border move-band", () => {
  test("move-bands render only while adjusting", async () => {
    await mount();
    expect(container?.querySelectorAll(".region-move-band").length).toBe(0); // snap
    await drawRect();
    expect(container?.querySelectorAll(".region-move-band").length).toBe(4); // adjusting
  });

  test("dragging a border move-band translates the selection", async () => {
    await mount();
    await drawRect(); // (100,100,200,200)
    const band = container?.querySelector(".region-move-band.top");
    if (!(band instanceof HTMLElement)) throw new Error("top move-band not found");
    await mouseDown(200, 100, band);
    expect(document.body.dataset.interaction).toBe("moving");
    await mouseMove(250, 130); // +50, +30
    await mouseUp(250, 130);
    expect(document.body.dataset.interaction).toBe("adjusting");
    expect(rectStyle()).toEqual({ left: 150, top: 130, width: 200, height: 200 });
  });

  test("interior drag still redraws (band drag and interior drag don't overlap)", async () => {
    await mount();
    await drawRect();
    // Deep interior (not a band) → discard + redraw, not move.
    await mouseDown(200, 200);
    await mouseMove(220, 220);
    await mouseMove(500, 450);
    await mouseUp(500, 450);
    expect(rectStyle()).toEqual({ left: 200, top: 200, width: 300, height: 250 });
  });
});
