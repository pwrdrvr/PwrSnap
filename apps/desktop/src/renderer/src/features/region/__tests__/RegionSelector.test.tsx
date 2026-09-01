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
let keyHandler: ((p: { key: string }) => void) | null = null;
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
    onSelectorKey: (h: (p: { key: string }) => void) => {
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
  for (const k of [
    "interaction",
    "snap",
    "spaceHeld",
    "fullWindow",
    "mode",
    "discarding",
    "pickCount",
    "outputMode"
  ]) {
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

async function emitKey(key: string): Promise<void> {
  await act(async () => {
    keyHandler?.({ key });
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

// --- U5 — multi-window pick set ------------------------------------
//
// The picker used to hold exactly one target. These pin the pick-set
// behavior: what adds, what removes, what the commit payload carries,
// and — the part that is easy to regress — where multi-select is
// deliberately unavailable.

/** Second and third snap targets, disjoint from WIN and each other. */
const WIN_B: WindowSnapEntry = {
  windowId: 7,
  pid: 2,
  bundleId: "com.test.b",
  appName: "App B",
  title: null,
  ownedByUs: false,
  zIndex: 1,
  rect: { x: 700, y: 100, w: 200, h: 150 },
  rawRect: { x: 700, y: 100, w: 200, h: 150 }
};
const WIN_C: WindowSnapEntry = {
  windowId: 9,
  pid: 3,
  bundleId: "com.test.c",
  appName: "App C",
  title: null,
  ownedByUs: false,
  zIndex: 2,
  rect: { x: 100, y: 500, w: 150, h: 120 },
  rawRect: { x: 100, y: 500, w: 150, h: 120 }
};

/** Overlaps WIN (200,150,400x300) in x∈[400,600], y∈[250,450]. */
const WIN_OVERLAP: WindowSnapEntry = {
  windowId: 11,
  pid: 4,
  bundleId: "com.test.d",
  appName: "App D",
  title: null,
  ownedByUs: false,
  zIndex: 3,
  rect: { x: 400, y: 250, w: 300, h: 200 },
  rawRect: { x: 400, y: 250, w: 300, h: 200 }
};

const centerOf = (w: WindowSnapEntry): { x: number; y: number } => ({
  x: w.rawRect.x + w.rawRect.w / 2,
  y: w.rawRect.y + w.rawRect.h / 2
});

/** Mount + publish the three-window scene at scale 1 (displayBounds =
 *  innerSize), so CSS px and logical px are the same number. */
async function mountScene(p: ModePayload = { mode: "auto" }): Promise<void> {
  await mount();
  await emitMode(p);
  await emitSnapshot({
    // WIN_OVERLAP is last so the z-order walk finds WIN first where
    // they overlap; centerOf(WIN_OVERLAP) is outside WIN, so it still
    // hit-tests to itself.
    windows: [WIN, WIN_B, WIN_C, WIN_OVERLAP],
    displayBounds: { width: window.innerWidth, height: window.innerHeight }
  });
}

/** Move to a window then mousedown/up on it with the given modifiers. */
async function clickWindow(
  w: WindowSnapEntry,
  init: { metaKey?: boolean } = {}
): Promise<void> {
  const c = centerOf(w);
  await mouseMove(c.x, c.y);
  await act(async () => {
    window.dispatchEvent(
      new MouseEvent("mousedown", {
        clientX: c.x,
        clientY: c.y,
        button: 0,
        bubbles: true,
        ...init
      })
    );
  });
  await mouseUp(c.x, c.y);
}

/** Geometry of the union frame, or of the lone pick box when only one
 *  pick is live (the union frame is not rendered then — it would draw a
 *  dashed border under the pick box's solid one). */
function selectionStyle(): { left: number; top: number; width: number; height: number } {
  const el =
    container?.querySelector(".region-rect") ??
    container?.querySelector('[data-testid="region-pick"]');
  if (!(el instanceof HTMLElement)) throw new Error("no selection frame found");
  const num = (v: string): number => Number.parseFloat(v.replace("px", ""));
  return {
    left: num(el.style.left),
    top: num(el.style.top),
    width: num(el.style.width),
    height: num(el.style.height)
  };
}

/** Number of hole rects in the SVG mask (one per kept extent). */
function maskHoles(): number {
  return container?.querySelectorAll('#region-mask-holes rect[fill="black"]').length ?? 0;
}

function pickBoxes(): HTMLElement[] {
  return Array.from(container?.querySelectorAll('[data-testid="region-pick"]') ?? []).filter(
    (e): e is HTMLElement => e instanceof HTMLElement
  );
}

function hud(): HTMLElement | null {
  const el = container?.querySelector('[data-testid="region-hud"]');
  return el instanceof HTMLElement ? el : null;
}

function hudButton(testId: string): HTMLElement {
  const el = container?.querySelector(`[data-testid="${testId}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`${testId} not found`);
  return el;
}

async function clickEl(el: Element): Promise<void> {
  await act(async () => {
    // The component's window-level mousedown must ignore this (the
    // [data-region-hud] guard); React's onClick must still fire.
    el.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { button: 0, bubbles: true }));
  });
}

describe("U5 — multi-window pick set", () => {
  test("⌘-click accumulates windows; the rect becomes their union", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    expect(pickBoxes()).toHaveLength(1);
    expect(selectionStyle()).toEqual({ left: 200, top: 150, width: 400, height: 300 });

    await clickWindow(WIN_B, { metaKey: true });
    expect(pickBoxes()).toHaveLength(2);
    // union of (200,150,400x300) and (700,100,200x150)
    expect(rectStyle()).toEqual({ left: 200, top: 100, width: 700, height: 350 });
    expect(document.body.dataset.pickCount).toBe("2");
    expect(rectStyle()).toEqual({ left: 200, top: 100, width: 700, height: 350 });
  });

  test("once a set exists a plain click is additive — no modifier needed", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B); // plain
    expect(pickBoxes()).toHaveLength(2);
    expect(submitRegion).not.toHaveBeenCalled();
  });

  test("clicking a picked window removes it; emptying returns to live snap", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    await clickWindow(WIN_B); // toggle off
    expect(pickBoxes()).toHaveLength(1);
    expect(selectionStyle()).toEqual({ left: 200, top: 150, width: 400, height: 300 });

    await clickWindow(WIN); // last one off
    expect(pickBoxes()).toHaveLength(0);
    expect(hud()).toBeNull();
    expect(document.body.dataset.pickCount).toBe("0");
    // Back to live snap under the cursor — which is still over WIN.
    expect(document.body.dataset.interaction).toBe("snap");
    expect(document.body.dataset.snap).toBe("window");
  });

  test("clicking the desktop with a set live keeps it", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await mouseMove(980, 700); // empty desktop
    await mouseDown(980, 700);
    await mouseUp(980, 700);
    expect(pickBoxes()).toHaveLength(1);
  });

  test("window mode: a plain click adds instead of committing", async () => {
    await mountScene({ mode: "window" });
    await clickWindow(WIN);
    expect(submitRegion).not.toHaveBeenCalled();
    expect(pickBoxes()).toHaveLength(1);
    await clickWindow(WIN_B);
    expect(pickBoxes()).toHaveLength(2);
  });

  test("commit sends the union rect, one extent per pick, and the mode", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    await keyDown("Enter");
    expect(submitRegion).toHaveBeenCalledTimes(1);
    expect(submitRegion.mock.calls[0]?.[0]).toEqual({
      ok: true,
      rect: { x: 200, y: 100, w: 700, h: 350 },
      displayId: 0,
      extents: [
        { x: 200, y: 150, w: 400, h: 300 },
        { x: 700, y: 100, w: 200, h: 150 }
      ],
      outputMode: "windows",
      // First pick names the capture's source app — a union's centre
      // often lands on empty desktop.
      snappedWindowId: WIN.windowId
    });
  });

  test("T flips the output mode; commit carries the flipped value", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    expect(document.body.dataset.outputMode).toBe("windows");
    await keyDown("T");
    expect(document.body.dataset.outputMode).toBe("rectangle");
    await keyDown("Enter");
    expect(submitRegion.mock.calls[0]?.[0]).toMatchObject({ outputMode: "rectangle" });
  });

  test("the output toggle is absent below two picks — both modes are the same pixels", async () => {
    await mountScene();
    await keyDown("T");
    expect(document.body.dataset.outputMode).toBe("windows");
    await clickWindow(WIN, { metaKey: true });
    expect(container?.querySelector('[data-testid="region-hud-mode-windows"]')).toBeNull();
    await keyDown("T");
    expect(document.body.dataset.outputMode).toBe("windows");
    // A second pick brings it back.
    await clickWindow(WIN_B);
    expect(container?.querySelector('[data-testid="region-hud-mode-windows"]')).not.toBeNull();
  });

  test("a lone pick in window mode still captures the full window, not a screen crop", async () => {
    // `window` mode has always meant the window's own backing buffer,
    // so a covered window comes out whole. Masking is a crop of the
    // frozen screen and cannot do that — one pick must keep the old
    // route. Two picks have no backing-buffer option and fall through
    // to the mask.
    await mountScene({ mode: "window" });
    await clickWindow(WIN);
    await keyDown("Enter");
    expect(submitRegion.mock.calls[0]?.[0]).toEqual({
      ok: true,
      rect: { x: 200, y: 150, w: 400, h: 300 },
      displayId: 0,
      snappedWindowId: WIN.windowId,
      fullWindow: true
    });
    expect(submitRegion.mock.calls[0]?.[0]).not.toHaveProperty("extents");
  });

  test("two picks in window mode fall through to the mask", async () => {
    await mountScene({ mode: "window" });
    await clickWindow(WIN);
    await clickWindow(WIN_B);
    await keyDown("Enter");
    expect(submitRegion.mock.calls[0]?.[0]).toMatchObject({
      outputMode: "windows",
      extents: [
        { x: 200, y: 150, w: 400, h: 300 },
        { x: 700, y: 100, w: 200, h: 150 }
      ]
    });
    expect(submitRegion.mock.calls[0]?.[0]).not.toHaveProperty("fullWindow");
  });

  test("the mask punches one hole per extent, or one for the box", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    await clickWindow(WIN_C);
    expect(maskHoles()).toBe(3);
    expect(container?.querySelector(".region-mask__alpha")).not.toBeNull();

    await keyDown("T"); // → rectangle
    expect(maskHoles()).toBe(1); // just the union box
    // Nothing becomes transparent, so there is no checker at all.
    expect(container?.querySelector(".region-mask__alpha")).toBeNull();
  });

  test("overlapping picks each get their own hole — no even-odd cancellation", async () => {
    // A dialog over its parent is the common case, and the reason this
    // is an SVG <mask> rather than an even-odd path: with even-odd the
    // intersection of two holes winds back to \"filled\" and the preview
    // paints kept pixels as dimmed + transparency-checkered.
    await mountScene();
    await clickWindow(WIN, { metaKey: true }); // 200,150 400x300
    // Click at 650,350 — inside WIN_OVERLAP (400..700) but past WIN's
    // right edge (600), so the z-order walk lands on WIN_OVERLAP and
    // does not toggle WIN back off.
    await mouseMove(650, 350);
    await mouseDown(650, 350);
    await mouseUp(650, 350);
    expect(pickBoxes()).toHaveLength(2);
    expect(maskHoles()).toBe(2);
    const holes = Array.from(
      container?.querySelectorAll('#region-mask-holes rect[fill="black"]') ?? []
    ).map((el) => el.getAttribute("x"));
    expect(holes).toEqual(["200", "400"]);
  });

  test("HUD: the segmented control sets the mode and a chip removes its pick", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    await clickEl(hudButton("region-hud-mode-rectangle"));
    expect(document.body.dataset.outputMode).toBe("rectangle");
    await clickEl(hudButton("region-hud-mode-windows"));
    expect(document.body.dataset.outputMode).toBe("windows");

    const chips = Array.from(container?.querySelectorAll('[data-testid="region-hud-chip"]') ?? []);
    expect(chips).toHaveLength(2);
    await clickEl(chips[0]!);
    expect(pickBoxes()).toHaveLength(1);
    expect(submitRegion).not.toHaveBeenCalled();
  });

  test("HUD: the Capture button commits", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickEl(hudButton("region-hud-capture"));
    expect(submitRegion).toHaveBeenCalledTimes(1);
    expect(submitRegion.mock.calls[0]?.[0]).toMatchObject({ ok: true, outputMode: "windows" });
  });

  test("a HUD press is not a canvas gesture — it never toggles a pick", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    const before = pickBoxes().length;
    await act(async () => {
      hudButton("region-hud-mode-windows").dispatchEvent(
        new MouseEvent("mousedown", { clientX: 500, clientY: 740, button: 0, bubbles: true })
      );
    });
    expect(pickBoxes()).toHaveLength(before);
    expect(document.body.dataset.interaction).toBe("snap");
  });

  test("Esc drops the set first, then exits", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    await keyDown("Escape");
    expect(pickBoxes()).toHaveLength(0);
    expect(submitRegion).not.toHaveBeenCalled();
    await delay(ESC_GUARD_WAIT_MS);
    await keyDown("Escape");
    expect(submitRegion).toHaveBeenCalledWith({ ok: false });
  });

  test("a commit clears the set — pre-warmed windows must not leak it", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    await keyDown("T");
    expect(document.body.dataset.outputMode).toBe("rectangle");
    await keyDown("Enter");
    expect(pickBoxes()).toHaveLength(0);
    expect(hud()).toBeNull();
    // outputMode resets too, so the next capture defaults to windows.
    expect(document.body.dataset.outputMode).toBe("windows");
  });

  test("video intent has no multi-select — ⌘-click draws instead", async () => {
    await mount();
    await emitMode({ mode: "auto", intent: "video" });
    await emitSnapshot({
      windows: [WIN, WIN_B, WIN_C],
      displayBounds: { width: window.innerWidth, height: window.innerHeight }
    });
    await clickWindow(WIN, { metaKey: true });
    expect(pickBoxes()).toHaveLength(0);
    expect(hud()).toBeNull();
  });

  test("region mode has no multi-select", async () => {
    await mountScene({ mode: "region" });
    await clickWindow(WIN, { metaKey: true });
    expect(pickBoxes()).toHaveLength(0);
    expect(hud()).toBeNull();
  });

  test("hovering an un-picked window previews the next add", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    const c = centerOf(WIN_B);
    await mouseMove(c.x, c.y);
    const hover = container?.querySelector(".region-pick-hover");
    expect(hover).not.toBeNull();
    // ...and the selection is NOT stomped by the hover.
    expect(selectionStyle()).toEqual({ left: 200, top: 150, width: 400, height: 300 });
    // Hovering an already-picked window shows no add preview.
    const back = centerOf(WIN);
    await mouseMove(back.x, back.y);
    expect(container?.querySelector(".region-pick-hover")).toBeNull();
  });

  test("⇧ cannot stomp the union rect", async () => {
    // ⇧ opts a single snap into full-window capture by rewriting `rect`
    // directly. With a pick set, `rect` is the derived union and
    // `setSnapRect` refuses to overwrite it — so an unguarded write
    // here corrupted the frame with no way back, and the mask (built
    // from `rect` in rectangle mode) then disagreed with what commit
    // actually captured.
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    const union = { left: 200, top: 100, width: 700, height: 350 };
    expect(rectStyle()).toEqual(union);
    await mouseMove(centerOf(WIN_B).x, centerOf(WIN_B).y);
    await keyDown("Shift");
    expect(rectStyle()).toEqual(union);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
    });
    expect(rectStyle()).toEqual(union);
  });

  test("a new mode signal drops the pick set — pre-warmed windows are reused", async () => {
    // This handler is the only per-show reset the renderer gets, and
    // main can end a session without a renderer-side commit or cancel
    // (`pickRegion` resolves an in-flight resolver with `cancelled` and
    // re-shows the same window). A surviving set would paint its HUD
    // over the next capture and ship its extents on commit.
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    expect(pickBoxes()).toHaveLength(2);
    await emitMode({ mode: "auto", intent: "video" });
    expect(pickBoxes()).toHaveLength(0);
    expect(hud()).toBeNull();
    expect(document.body.dataset.pickCount).toBe("0");
  });

  test("a leaked pick set can never be committed where multi-select is off", async () => {
    // Belt to the reset's braces: commit re-checks the capability
    // rather than trusting that a set could only exist where it was
    // allowed. A video commit must never carry extents — the recording
    // path reads only `rect` and would silently record the union.
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    // Force the leak the mode handler now prevents.
    await act(async () => {
      modeHandler?.({ mode: "auto", intent: "video" });
    });
    await keyDown("Enter");
    const payload = submitRegion.mock.calls[0]?.[0];
    expect(payload).not.toHaveProperty("extents");
    expect(payload).not.toHaveProperty("outputMode");
  });

  test("⌃-click does not pick on macOS — that is the secondary-click gesture", async () => {
    await mount();
    (window.pwrsnapApi as { platform: string }).platform = "darwin";
    await emitMode({ mode: "auto" });
    await emitSnapshot({
      windows: [WIN, WIN_B, WIN_C],
      displayBounds: { width: window.innerWidth, height: window.innerHeight }
    });
    const c = centerOf(WIN);
    await mouseMove(c.x, c.y);
    await act(async () => {
      window.dispatchEvent(
        new MouseEvent("mousedown", {
          clientX: c.x,
          clientY: c.y,
          button: 0,
          bubbles: true,
          ctrlKey: true
        })
      );
    });
    await mouseUp(c.x, c.y);
    expect(pickBoxes()).toHaveLength(0);
    // ⌘ still works there.
    await clickWindow(WIN, { metaKey: true });
    expect(pickBoxes()).toHaveLength(1);
  });

  test("dropping below two picks releases the rectangle mode", async () => {
    // The toggle and the `T` binding both disappear below two picks, so
    // a retained `rectangle` would be unreachable — and would silently
    // apply to the next window the user added.
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    await keyDown("T");
    expect(document.body.dataset.outputMode).toBe("rectangle");
    await clickWindow(WIN_B); // back down to one
    expect(document.body.dataset.outputMode).toBe("windows");
  });

  test("hint copy switches to the multi-select legend", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    expect(regionHintText()).toContain("add / remove window");
    // The output-shape key only appears once there is a gap to make
    // transparent.
    expect(regionHintText()).not.toContain("keep whole box");
    await clickWindow(WIN_B);
    expect(regionHintText()).toContain("keep whole box");
    await keyDown("T");
    expect(regionHintText()).toContain("transparent gaps");
  });
});
