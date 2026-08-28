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
const frozenFrameMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  encode: vi.fn(),
  dispose: vi.fn()
}));
vi.mock("../frozen-frame", () => ({
  acquireFrozenDisplayFrame: frozenFrameMocks.acquire,
  encodeFrozenCrop: frozenFrameMocks.encode,
  disposeFrozenFrame: frozenFrameMocks.dispose
}));
import { RegionSelector } from "../RegionSelector";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type ModePayload = {
  invocationId: number;
  mode: "auto" | "region" | "window";
  screenUrl?: string;
  captureSource?:
    | {
        kind: "renderer-display-media";
        displayId: number;
        displayBounds: { width: number; height: number };
      }
    | { kind: "legacy-file"; screenUrl: string }
    | { kind: "none" };
  intent?: "snap" | "video";
  cursor?: boolean;
};
type SnapshotPayload = {
  invocationId: number;
  windows: WindowSnapEntry[];
  displayBounds: { width: number; height: number };
  cursor?: { x: number; y: number };
  status?: "ready" | "error";
};
type PresentationArmPayload = {
  invocationId: number;
  generation: number;
  surface: "frozen-frame" | "window-loading" | "error";
};

const DEFAULT_INVOCATION_ID = 1001;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

let modeHandler: ((p: ModePayload) => void) | null = null;
let snapshotHandler: ((p: SnapshotPayload) => void) | null = null;
let keyHandler: ((p: { key: string }) => void) | null = null;
let presentationArmHandler: ((p: PresentationArmPayload) => void) | null = null;
const submitRegion = vi.fn();
const notifySelectorSnapshotPainted = vi.fn();
const notifySelectorPresented = vi.fn();
const reportSelectorPerformance = vi.fn();
let nextAnimationFrameId = 1;
let animationFrames = new Map<number, FrameRequestCallback>();

function installSelectorApi(): void {
  modeHandler = null;
  snapshotHandler = null;
  keyHandler = null;
  presentationArmHandler = null;
  submitRegion.mockReset();
  notifySelectorSnapshotPainted.mockReset();
  notifySelectorPresented.mockReset();
  reportSelectorPerformance.mockReset();
  frozenFrameMocks.acquire.mockReset();
  frozenFrameMocks.encode.mockReset();
  frozenFrameMocks.dispose.mockReset();
  frozenFrameMocks.acquire.mockImplementation(async (canvas: HTMLCanvasElement) => ({
    canvas,
    width: 3840,
    height: 2160,
    transferMode: "bitmaprenderer" as const
  }));
  frozenFrameMocks.encode.mockResolvedValue({
    blob: new Blob([new Uint8Array(16)], { type: "image/png" }),
    width: 640,
    height: 480,
    mimeType: "image/png" as const
  });
  window.pwrsnapApi = {
    platform: "test",
    versions: { chrome: "", electron: "", node: "" },
    dispatch: vi.fn(),
    on: vi.fn(() => () => undefined),
    submitRegion,
    notifySelectorSnapshotPainted,
    notifySelectorPresented,
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
    onSelectorPresentationArm: (h: (p: PresentationArmPayload) => void) => {
      presentationArmHandler = h;
      return () => undefined;
    },
    requestTrayResize: vi.fn(),
    requestFloatOverResize: vi.fn(),
    startCaptureDrag: vi.fn(),
    startVideoDrag: vi.fn(),
    reportSelectorDiagnostics: vi.fn(),
    reportSelectorPerformance,
    perfMark: vi.fn()
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
}

async function mount(options: { activate?: boolean } = {}): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(RegionSelector));
  });
  await act(async () => {
    await Promise.resolve();
  });
  if (options.activate !== false) {
    await emitMode({ mode: "auto", invocationId: DEFAULT_INVOCATION_ID });
  }
}

beforeEach(() => {
  nextAnimationFrameId = 1;
  animationFrames = new Map();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextAnimationFrameId++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    animationFrames.delete(id);
  });
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
    "windowListCount",
    "windowListReady",
    "windowListState",
    "snapshotState"
  ]) {
    delete document.body.dataset[k];
  }
  vi.restoreAllMocks();
});

// --- event + query helpers (shared across unit describes) -----------

async function mouseMove(x: number, y: number): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
  });
}

async function emitMode(p: ModePayload): Promise<void> {
  await act(async () => {
    const { screenUrl, ...rest } = p;
    modeHandler?.({
      ...rest,
      captureSource:
        p.captureSource ??
        (screenUrl === undefined ? { kind: "none" } : { kind: "legacy-file", screenUrl })
    } as unknown as ModePayload);
  });
}

async function emitSnapshot(p: SnapshotPayload): Promise<void> {
  await act(async () => {
    snapshotHandler?.(p);
  });
}

async function emitPresentationArm(p: PresentationArmPayload): Promise<void> {
  await act(async () => {
    presentationArmHandler?.(p);
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
    const ev = new MouseEvent("mousedown", {
      clientX: x,
      clientY: y,
      button: 0,
      bubbles: true
    });
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
    window.dispatchEvent(
      new MouseEvent("mouseup", {
        clientX: x,
        clientY: y,
        button: 0,
        bubbles: true
      })
    );
  });
}

async function keyDown(key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init
      })
    );
  });
}

async function emitKey(key: string): Promise<void> {
  await act(async () => {
    keyHandler?.({ key });
  });
}

async function emitSnapshotImageEvent(type: "load" | "error"): Promise<void> {
  const image = container?.querySelector("img");
  if (!(image instanceof HTMLImageElement)) throw new Error("snapshot image not found");
  await act(async () => {
    image.dispatchEvent(new Event(type));
  });
}

async function flushAnimationFrame(): Promise<void> {
  const callbacks = Array.from(animationFrames.values());
  animationFrames.clear();
  await act(async () => {
    for (const callback of callbacks) callback(0);
  });
}

async function flushDoubleAnimationFrame(): Promise<void> {
  await flushAnimationFrame();
  await flushAnimationFrame();
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

function rectStyle(): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
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

const WIN_B: WindowSnapEntry = {
  ...WIN,
  windowId: 4343,
  appName: "Other Target App",
  zIndex: 1,
  rect: { x: 650, y: 150, w: 300, h: 300 },
  rawRect: { x: 650, y: 150, w: 300, h: 300 }
};

/** snap → hover a window → click (no drag) → adjusting with a window
 *  snap. displayBounds = innerSize so the css-to-logical scale is 1. */
async function adjustWindowSnap(): Promise<void> {
  await emitSnapshot({
    invocationId: DEFAULT_INVOCATION_ID,
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
    await emitMode({ mode: "window", invocationId: 1 });
    expect(document.body.dataset.mode).toBe("window");
    // auto / region keep the crosshair (attribute is not "window").
    await emitMode({ mode: "region", invocationId: 2 });
    expect(document.body.dataset.mode).toBe("region");
    await emitMode({ mode: "auto", invocationId: 3 });
    expect(document.body.dataset.mode).toBe("auto");
  });

  test("window-list snapshot cursor seeds the crosshair in snap mode", async () => {
    await mount();
    await emitSnapshot({
      invocationId: DEFAULT_INVOCATION_ID,
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
    expect(submitRegion).toHaveBeenCalledWith({
      ok: false,
      invocationId: DEFAULT_INVOCATION_ID
    });
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
    expect(submitRegion).toHaveBeenCalledWith({
      ok: false,
      invocationId: DEFAULT_INVOCATION_ID
    });
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
    expect(rectStyle()).toEqual({
      left: 400,
      top: 300,
      width: 300,
      height: 200
    });
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
    expect(rectStyle()).toEqual({
      left: 150,
      top: 150,
      width: 350,
      height: 250
    });
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
    expect(rectStyle()).toEqual({
      left: 200,
      top: 150,
      width: 400,
      height: 300
    });
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
    expect(rectStyle()).toEqual({
      left: 150,
      top: 130,
      width: 200,
      height: 200
    });
  });

  test("interior drag still redraws (band drag and interior drag don't overlap)", async () => {
    await mount();
    await drawRect();
    // Deep interior (not a band) → discard + redraw, not move.
    await mouseDown(200, 200);
    await mouseMove(220, 220);
    await mouseMove(500, 450);
    await mouseUp(500, 450);
    expect(rectStyle()).toEqual({
      left: 200,
      top: 200,
      width: 300,
      height: 250
    });
  });
});

describe("U5 — window-picker loading and invocation correctness", () => {
  test("a duplicate list delivery cannot rewind a newer pointer highlight", async () => {
    await mount();
    await emitMode({ mode: "window", invocationId: 4 });
    const payload: SnapshotPayload = {
      invocationId: 4,
      status: "ready",
      windows: [WIN, WIN_B],
      displayBounds: { width: window.innerWidth, height: window.innerHeight },
      cursor: { x: 400, y: 300 }
    };

    await emitSnapshot(payload);
    expect(document.body.dataset.snap).toBe("window");

    // The user moves to B after the first delivery. A compatibility resend
    // still carries the trigger-time cursor over A and must be idempotent.
    await mouseMove(800, 300);
    await emitSnapshot(payload);
    await keyDown("Enter");

    expect(submitRegion).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        invocationId: 4,
        snappedWindowId: WIN_B.windowId,
        fullWindow: true
      })
    );
  });

  test("a press during loading cannot retain a display target when the list resolves before mouseup", async () => {
    await mount();
    await emitMode({ mode: "window", invocationId: 5 });

    await mouseDown(400, 300);
    expect(document.body.dataset.interaction).toBe("snap");

    await emitSnapshot({
      invocationId: 5,
      status: "ready",
      windows: [WIN],
      displayBounds: { width: window.innerWidth, height: window.innerHeight },
      cursor: { x: 400, y: 300 }
    });
    await mouseUp(400, 300);

    expect(document.body.dataset.interaction).toBe("snap");
    expect(document.body.dataset.snap).toBe("window");
    expect(submitRegion).not.toHaveBeenCalled();

    // A complete click after readiness commits the current HWND normally.
    await mouseDown(400, 300);
    await mouseUp(400, 300);
    expect(submitRegion).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        invocationId: 5,
        snappedWindowId: WIN.windowId,
        fullWindow: true
      })
    );
  });

  test("an id-less mode/list payload cannot activate or submit the pre-warmed selector", async () => {
    await mount({ activate: false });

    await act(async () => {
      modeHandler?.({ mode: "auto" } as unknown as ModePayload);
      snapshotHandler?.({
        windows: [WIN],
        displayBounds: { width: window.innerWidth, height: window.innerHeight }
      } as unknown as SnapshotPayload);
    });
    await keyDown("Enter");
    await keyDown("Escape");

    expect(submitRegion).not.toHaveBeenCalled();
    expect(document.body.dataset.windowListCount).not.toBe("1");
  });

  test("a new mode invocation immediately clears stale HWND candidates", async () => {
    await mount();
    await emitMode({ mode: "window", invocationId: 1 });
    await emitSnapshot({
      invocationId: 1,
      status: "ready",
      windows: [WIN],
      displayBounds: { width: window.innerWidth, height: window.innerHeight },
      cursor: { x: 400, y: 300 }
    });
    expect(document.body.dataset.windowListState).toBe("ready");
    expect(document.body.dataset.snap).toBe("window");

    await emitMode({ mode: "window", invocationId: 2 });
    expect(document.body.dataset.windowListState).toBe("loading");
    expect(document.body.dataset.windowListCount).toBe("0");
    expect(document.body.dataset.snap).toBe("display");
    expect(container?.querySelector('[data-testid="region-window-status"]')?.textContent).toContain(
      "Finding open windows"
    );

    // Moving over the previous invocation's window and pressing Enter
    // cannot revive or submit its stale HWND geometry.
    await mouseMove(400, 300);
    await keyDown("Enter");
    expect(submitRegion).not.toHaveBeenCalled();
  });

  test("ignores a mismatched list result and submits only the current invocation", async () => {
    await mount();
    await emitMode({ mode: "window", invocationId: 7 });

    await emitSnapshot({
      invocationId: 6,
      status: "ready",
      windows: [WIN],
      displayBounds: { width: window.innerWidth, height: window.innerHeight },
      cursor: { x: 400, y: 300 }
    });
    expect(document.body.dataset.windowListState).toBe("loading");
    expect(document.body.dataset.windowListCount).toBe("0");

    await emitSnapshot({
      invocationId: 7,
      status: "ready",
      windows: [WIN],
      displayBounds: { width: window.innerWidth, height: window.innerHeight },
      cursor: { x: 400, y: 300 }
    });
    expect(document.body.dataset.windowListState).toBe("ready");
    expect(document.body.dataset.windowListCount).toBe("1");
    expect(document.body.dataset.snap).toBe("window");

    await keyDown("Enter");
    expect(submitRegion).toHaveBeenCalledTimes(1);
    expect(submitRegion).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        invocationId: 7,
        snappedWindowId: WIN.windowId,
        fullWindow: true
      })
    );
  });

  test.each([
    {
      name: "empty",
      payload: { status: "ready" as const, windows: [] as WindowSnapEntry[] },
      copy: "No capturable windows found"
    },
    {
      name: "error",
      payload: { status: "error" as const, windows: [] as WindowSnapEntry[] },
      copy: "Couldn’t inspect open windows"
    }
  ])(
    "renders a truthful $name terminal state, blocks Enter, and exposes mouse cancel",
    async ({ payload, copy }) => {
      await mount();
      await emitMode({ mode: "window", invocationId: 11 });
      await emitSnapshot({
        invocationId: 11,
        ...payload,
        displayBounds: { width: window.innerWidth, height: window.innerHeight }
      });

      expect(
        container?.querySelector('[data-testid="region-window-status"]')?.textContent
      ).toContain(copy);
      await keyDown("Enter");
      expect(submitRegion).not.toHaveBeenCalled();

      const dismiss = container?.querySelector(".region-window-dismiss");
      if (!(dismiss instanceof HTMLButtonElement)) throw new Error("window dismiss not found");
      await act(async () => dismiss.click());
      expect(submitRegion).toHaveBeenCalledTimes(1);
      expect(submitRegion).toHaveBeenCalledWith({
        ok: false,
        invocationId: 11
      });
    }
  );

  test("the loading shell exposes an invocation-safe mouse Cancel", async () => {
    await mount();
    await emitMode({ mode: "window", invocationId: 13 });

    const cancelButton = container?.querySelector(".region-window-dismiss");
    if (!(cancelButton instanceof HTMLButtonElement)) throw new Error("window cancel not found");
    expect(cancelButton.textContent).toBe("Cancel");
    await act(async () => cancelButton.click());

    expect(submitRegion).toHaveBeenCalledTimes(1);
    expect(submitRegion).toHaveBeenCalledWith({ ok: false, invocationId: 13 });
    await keyDown("Escape");
    expect(submitRegion).toHaveBeenCalledTimes(1);
  });

  test("auto mode stays display-usable while fresh window candidates load", async () => {
    await mount();
    await emitMode({
      mode: "auto",
      invocationId: 12,
      screenUrl: "pwrsnap-screen://r/current"
    });
    expect(document.body.dataset.windowListState).toBe("loading");
    await emitSnapshotImageEvent("load");

    await keyDown("Enter");
    expect(submitRegion).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, invocationId: 12 })
    );
  });
});

describe("U6 — snapshot and paint feedback", () => {
  test("acknowledges a truthful post-show window shell only after two frames", async () => {
    await mount();
    await emitMode({ mode: "window", invocationId: 19 });
    await flushDoubleAnimationFrame();

    // Hidden diagnostic prepaint does not satisfy the public contract.
    expect(reportSelectorPerformance).toHaveBeenCalledWith({
      invocationId: 19,
      mark: "shell-painted"
    });
    expect(notifySelectorPresented).not.toHaveBeenCalled();

    await emitPresentationArm({
      invocationId: 19,
      generation: 7,
      surface: "window-loading"
    });
    expect(notifySelectorPresented).not.toHaveBeenCalled();
    await flushAnimationFrame();
    expect(notifySelectorPresented).not.toHaveBeenCalled();
    await flushAnimationFrame();
    expect(notifySelectorPresented).toHaveBeenCalledWith({
      invocationId: 19,
      generation: 7,
      surface: "window-loading"
    });
  });

  test("ignores untruthful arms and superseded presentation generations", async () => {
    await mount();
    await emitMode({ mode: "window", invocationId: 18 });

    await emitPresentationArm({
      invocationId: 999,
      generation: 1,
      surface: "window-loading"
    });
    await emitPresentationArm({
      invocationId: 18,
      generation: 2,
      surface: "frozen-frame"
    });
    await flushDoubleAnimationFrame();
    expect(notifySelectorPresented).not.toHaveBeenCalled();

    await emitPresentationArm({
      invocationId: 18,
      generation: 3,
      surface: "window-loading"
    });
    await flushAnimationFrame();
    await emitPresentationArm({
      invocationId: 18,
      generation: 4,
      surface: "window-loading"
    });
    await flushDoubleAnimationFrame();
    expect(notifySelectorPresented).toHaveBeenCalledTimes(1);
    expect(notifySelectorPresented).toHaveBeenCalledWith({
      invocationId: 18,
      generation: 4,
      surface: "window-loading"
    });
  });

  test("acknowledges a decoded snapshot only after a guarded paint opportunity", async () => {
    await mount();
    await emitMode({
      mode: "auto",
      invocationId: 20,
      screenUrl: "pwrsnap-screen://r/ready"
    });
    await emitSnapshotImageEvent("load");

    expect(document.body.dataset.snapshotState).toBe("ready");
    expect(notifySelectorSnapshotPainted).not.toHaveBeenCalled();
    await flushAnimationFrame();
    expect(notifySelectorSnapshotPainted).not.toHaveBeenCalled();
    await flushAnimationFrame();
    expect(notifySelectorSnapshotPainted).toHaveBeenCalledWith({
      snapshotKey: "pwrsnap-screen://r/ready",
      invocationId: 20,
      status: "painted"
    });
  });

  test("a snapshot decode error is opaque/truthful and cannot commit", async () => {
    await mount();
    await emitMode({
      mode: "auto",
      invocationId: 21,
      screenUrl: "pwrsnap-screen://r/broken"
    });
    await emitSnapshotImageEvent("error");

    expect(document.body.dataset.snapshotState).toBe("error");
    expect(
      container?.querySelector('[data-testid="region-snapshot-status"]')?.textContent
    ).toContain("Couldn’t load the frozen screen");
    expect(notifySelectorSnapshotPainted).not.toHaveBeenCalled();
    await flushAnimationFrame();
    expect(notifySelectorSnapshotPainted).not.toHaveBeenCalled();
    await flushAnimationFrame();
    expect(notifySelectorSnapshotPainted).toHaveBeenCalledWith({
      snapshotKey: "pwrsnap-screen://r/broken",
      invocationId: 21,
      status: "error"
    });
    await keyDown("Enter");
    expect(submitRegion).not.toHaveBeenCalled();

    await keyDown("Escape");
    expect(submitRegion).toHaveBeenCalledWith({ ok: false, invocationId: 21 });
  });

  test("the snapshot error shell has a Dismiss path and suppresses a stale paint ack", async () => {
    await mount();
    await emitMode({
      mode: "auto",
      invocationId: 22,
      screenUrl: "pwrsnap-screen://r/broken-dismiss"
    });
    await emitSnapshotImageEvent("error");

    const dismiss = container?.querySelector(".region-snapshot-dismiss");
    if (!(dismiss instanceof HTMLButtonElement)) throw new Error("Dismiss button not found");
    await act(async () => {
      dismiss.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(submitRegion).toHaveBeenCalledWith({ ok: false, invocationId: 22 });

    await flushDoubleAnimationFrame();
    expect(notifySelectorSnapshotPainted).not.toHaveBeenCalled();
  });

  test("reports shell paint before terminal window-target paint without a wall-clock assertion", async () => {
    await mount();
    await emitMode({ mode: "window", invocationId: 31 });

    expect(reportSelectorPerformance).not.toHaveBeenCalled();
    await flushDoubleAnimationFrame();
    expect(reportSelectorPerformance).toHaveBeenNthCalledWith(1, {
      invocationId: 31,
      mark: "shell-painted"
    });

    await emitSnapshot({
      invocationId: 31,
      status: "ready",
      windows: [],
      displayBounds: { width: window.innerWidth, height: window.innerHeight }
    });
    expect(reportSelectorPerformance).toHaveBeenCalledTimes(1);
    await flushDoubleAnimationFrame();
    expect(reportSelectorPerformance).toHaveBeenNthCalledWith(2, {
      invocationId: 31,
      mark: "window-targets-painted"
    });
  });

  test("a superseded invocation cannot report a stale shell paint", async () => {
    await mount();
    await emitMode({ mode: "window", invocationId: 40 });
    await flushAnimationFrame();
    await emitMode({ mode: "window", invocationId: 41 });
    await flushDoubleAnimationFrame();

    expect(reportSelectorPerformance).not.toHaveBeenCalledWith({
      invocationId: 40,
      mark: "shell-painted"
    });
    expect(reportSelectorPerformance).toHaveBeenCalledWith({
      invocationId: 41,
      mark: "shell-painted"
    });
  });
});

describe("U7 — renderer-owned frozen frame transport", () => {
  test("freezes once and transfers only the committed crop before submitting", async () => {
    await mount({ activate: false });
    await emitMode({
      mode: "region",
      invocationId: DEFAULT_INVOCATION_ID,
      captureSource: {
        kind: "renderer-display-media",
        displayId: 9,
        displayBounds: { width: window.innerWidth * 2, height: window.innerHeight * 2 }
      }
    });

    const port = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      start: vi.fn(),
      close: vi.fn()
    };
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: {
            type: "pwrsnap-selector-frame-port",
            invocationId: DEFAULT_INVOCATION_ID
          },
          ports: [port as unknown as MessagePort]
        })
      );
    });
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "authorize",
      invocationId: DEFAULT_INVOCATION_ID
    });

    await act(async () => {
      port.onmessage?.({
        data: { type: "authorized", invocationId: DEFAULT_INVOCATION_ID }
      } as MessageEvent);
      port.onmessage?.({
        data: { type: "authorized", invocationId: DEFAULT_INVOCATION_ID }
      } as MessageEvent);
      await Promise.resolve();
    });
    expect(frozenFrameMocks.acquire).toHaveBeenCalledTimes(1);
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "frame-ready",
        invocationId: DEFAULT_INVOCATION_ID,
        width: 3840,
        height: 2160
      })
    );
    await flushDoubleAnimationFrame();
    expect(notifySelectorSnapshotPainted).toHaveBeenCalledWith({
      snapshotKey: `renderer-display-media:${DEFAULT_INVOCATION_ID}`,
      invocationId: DEFAULT_INVOCATION_ID,
      status: "painted"
    });

    await keyDown("Enter");
    await vi.waitFor(() => {
      expect(frozenFrameMocks.encode).toHaveBeenCalledTimes(1);
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "crop-start",
          invocationId: DEFAULT_INVOCATION_ID,
          width: 640,
          height: 480,
          mimeType: "image/png",
          totalBytes: 16
        })
      );
    });
    expect(submitRegion).not.toHaveBeenCalled();

    await act(async () => {
      port.onmessage?.({
        data: { type: "crop-started", invocationId: DEFAULT_INVOCATION_ID }
      } as MessageEvent);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "crop-chunk",
          invocationId: DEFAULT_INVOCATION_ID,
          sequence: 0,
          bytes: expect.any(ArrayBuffer)
        }),
        [expect.any(ArrayBuffer)]
      );
    });
    await act(async () => {
      port.onmessage?.({
        data: {
          type: "crop-chunk-accepted",
          invocationId: DEFAULT_INVOCATION_ID,
          sequence: 0
        }
      } as MessageEvent);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(port.postMessage).toHaveBeenCalledWith({
        type: "crop-end",
        invocationId: DEFAULT_INVOCATION_ID,
        chunks: 1
      });
    });
    await act(async () => {
      port.onmessage?.({
        data: { type: "crop-accepted", invocationId: DEFAULT_INVOCATION_ID }
      } as MessageEvent);
      await Promise.resolve();
    });
    expect(submitRegion).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        invocationId: DEFAULT_INVOCATION_ID,
        rect: {
          x: 0,
          y: 0,
          w: window.innerWidth * 2,
          h: window.innerHeight * 2
        }
      })
    );
  });
});
