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

import { MAX_SELECTOR_EXTENTS } from "@pwrsnap/shared";

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
  cursor?: boolean;
  quickCaptureAction?: "ask" | "snap" | "record";
  invocationId?: string;
  generation?: number;
};
type PresentationPayload = {
  invocationId: string;
  generation: number;
  screenUrl: string;
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
let presentationHandler: ((p: PresentationPayload) => void) | null = null;
const submitRegion = vi.fn();
const notifySelectorSnapshotPainted = vi.fn();
const notifySelectorPresented = vi.fn();

function installSelectorApi(): void {
  modeHandler = null;
  snapshotHandler = null;
  keyHandler = null;
  presentationHandler = null;
  submitRegion.mockReset();
  notifySelectorSnapshotPainted.mockReset();
  notifySelectorPresented.mockReset();
  window.pwrsnapApi = {
    platform: "test",
    versions: { chrome: "", electron: "", node: "" },
    dispatch: vi.fn(),
    on: vi.fn(() => () => undefined),
    submitRegion,
    notifySelectorSnapshotPainted,
    notifySelectorPresented,
    onSelectorPresentationRequest: (h: (p: PresentationPayload) => void) => {
      presentationHandler = h;
      return () => undefined;
    },
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
    "outputMode",
    "chooserBar",
    "quickAction"
  ]) {
    delete document.body.dataset[k];
  }
  vi.unstubAllGlobals();
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

async function emitPresentation(p: PresentationPayload): Promise<void> {
  await act(async () => {
    presentationHandler?.(p);
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

/** Press ↵ and return the single payload it submitted. */
async function commitAndRead(): Promise<Record<string, never> & any> {
  await keyDown("Enter");
  expect(submitRegion).toHaveBeenCalledTimes(1);
  return submitRegion.mock.calls[0]?.[0];
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

describe("diagnostic first-visible acknowledgement", () => {
  function installFrameHarness(): {
    callbacks: Map<number, FrameRequestCallback>;
    runNext: () => Promise<void>;
  } {
    let nextId = 1;
    const callbacks = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    return {
      callbacks,
      runNext: async () => {
        const next = callbacks.entries().next().value as
          | [number, FrameRequestCallback]
          | undefined;
        if (next === undefined) throw new Error("no pending animation frame");
        callbacks.delete(next[0]);
        await act(async () => next[1](16));
      }
    };
  }

  test("requires frozen-source decode and two post-request animation frames", async () => {
    const frames = installFrameHarness();
    await mount();
    const request = {
      invocationId: "trace-present-1",
      generation: 1,
      screenUrl: "pwrsnap-screen://r/snapshot-present-1"
    };

    await emitMode({ mode: "auto", screenUrl: request.screenUrl });
    await emitPresentation(request);
    expect(frames.callbacks.size).toBe(0);
    expect(notifySelectorPresented).not.toHaveBeenCalled();

    const image = container?.querySelector('img[src="pwrsnap-screen://r/snapshot-present-1"]');
    if (!(image instanceof HTMLImageElement)) throw new Error("snapshot image not found");
    await act(async () => image.dispatchEvent(new Event("load")));

    expect(notifySelectorSnapshotPainted).toHaveBeenCalledWith(request.screenUrl);
    expect(frames.callbacks.size).toBe(1);
    await frames.runNext();
    expect(notifySelectorPresented).not.toHaveBeenCalled();
    await frames.runNext();
    expect(notifySelectorPresented).toHaveBeenCalledWith(request);
  });

  test("cancels a stale generation before it can acknowledge a reused selector", async () => {
    const frames = installFrameHarness();
    await mount();
    const stale = {
      invocationId: "trace-stale-1",
      generation: 4,
      screenUrl: "pwrsnap-screen://r/stale"
    };
    await emitMode({ mode: "auto", screenUrl: stale.screenUrl });
    const staleImage = container?.querySelector('img[src="pwrsnap-screen://r/stale"]');
    if (!(staleImage instanceof HTMLImageElement)) throw new Error("stale image not found");
    await act(async () => staleImage.dispatchEvent(new Event("load")));
    await emitPresentation(stale);
    const staleFrame = [...frames.callbacks.values()][0];
    expect(staleFrame).toBeDefined();

    const current = {
      invocationId: "trace-current-2",
      generation: 5,
      screenUrl: "pwrsnap-screen://r/current"
    };
    await emitMode({ mode: "window", screenUrl: current.screenUrl });
    await emitPresentation(current);
    expect(frames.callbacks.size).toBe(0);
    await act(async () => staleFrame?.(16));
    expect(notifySelectorPresented).not.toHaveBeenCalled();

    const currentImage = container?.querySelector('img[src="pwrsnap-screen://r/current"]');
    if (!(currentImage instanceof HTMLImageElement)) throw new Error("current image not found");
    await act(async () => currentImage.dispatchEvent(new Event("load")));
    await frames.runNext();
    await frames.runNext();
    expect(notifySelectorPresented).toHaveBeenCalledTimes(1);
    expect(notifySelectorPresented).toHaveBeenCalledWith(current);
  });
});

/** snap → hover a window → click (no drag) → adjusting with a window
 *  snap. displayBounds = innerSize so the css-to-logical scale is 1. */
/** Click a window in `auto` mode. Since Quick Capture picks on click,
 *  this leaves one pick live and the interaction in `snap` — NOT the
 *  `adjusting` state a window click used to produce. */
async function pickWindowSnap(): Promise<void> {
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
  test("dragging out of a picked window drops the pick and free-draws", async () => {
    await mount();
    await pickWindowSnap();
    expect(document.body.dataset.interaction).toBe("snap");
    expect(document.body.dataset.pickCount).toBe("1");

    // Interior mousedown + drag past threshold → a brand-new region.
    // This is the gesture click-to-pick must not have cost: in `auto`
    // mode almost every region drag starts on top of some window.
    await mouseDown(400, 300);
    await mouseMove(420, 320); // > DRAG_ENGAGE_PX → drawing
    await mouseMove(700, 500);
    await mouseUp(700, 500);

    expect(document.body.dataset.interaction).toBe("adjusting");
    expect(document.body.dataset.pickCount).toBe("0");
    expect(rectStyle()).toEqual({ left: 400, top: 300, width: 300, height: 200 });
    // The pick was dropped — commit carries the drawn rect alone, with
    // no window id and no extents to override it.
    await keyDown("Enter");
    expect(submitRegion).toHaveBeenCalledTimes(1);
    const payload = submitRegion.mock.calls[0]?.[0];
    expect(payload.ok).toBe(true);
    expect(payload.snappedWindowId).toBeUndefined();
    expect(payload).not.toHaveProperty("extents");
    expect(payload.rect).toEqual({ x: 400, y: 300, w: 300, h: 200 });
  });

  test("interior drag on a free-drawn region replaces it", async () => {
    await mount();
    await emitSnapshot({
      windows: [WIN],
      displayBounds: { width: window.innerWidth, height: window.innerHeight }
    });
    await drawRect(); // (100,100)-(300,300)
    await mouseDown(250, 200); // inside the rect and inside WIN
    await mouseMove(270, 220);
    await mouseMove(500, 400);
    await mouseUp(500, 400);
    expect(rectStyle()).toEqual({ left: 250, top: 200, width: 250, height: 200 });
    expect(document.body.dataset.pickCount).toBe("0");
  });

  test("interior click (no drag) keeps a free-drawn region — no jump to full display", async () => {
    // The window list matters: without it `pickCandidateFor` finds
    // nothing and the pick intercept never runs, so this passed against
    // a build where an interior click DESTROYED the region. WIN covers
    // (200,150)-(600,450), which contains the drawn rect.
    await mount();
    await emitSnapshot({
      windows: [WIN],
      displayBounds: { width: window.innerWidth, height: window.innerHeight }
    });
    await drawRect();
    const before = rectStyle();
    expect(before).toEqual({ left: 100, top: 100, width: 200, height: 200 });
    // (250,200) is inside the drawn rect AND inside WIN — the overlap
    // is the whole point. A press at (150,150) misses WIN, so it never
    // reaches the pick intercept and proves nothing.
    await mouseDown(250, 200);
    await mouseUp(250, 200); // no drag → keep
    expect(document.body.dataset.interaction).toBe("adjusting");
    expect(document.body.dataset.pickCount).toBe("0");
    expect(rectStyle()).toEqual(before); // unchanged, NOT the window's box
  });

  test("a click on a window picks it — it does not commit or enter adjusting", async () => {
    // The regression this replaced: in `auto` mode a plain click used
    // to bind the window into `adjusting`, so there was no way to add a
    // second window without a modifier nobody discovered.
    await mount();
    await pickWindowSnap();
    expect(document.body.dataset.interaction).toBe("snap");
    expect(submitRegion).not.toHaveBeenCalled();
    expect(selectionStyle()).toEqual({ left: 200, top: 150, width: 400, height: 300 });
    // A lone pick still commits as the plain single-window capture it
    // always was: rect + windowId, no extents to composite.
    await keyDown("Enter");
    const payload = submitRegion.mock.calls[0]?.[0];
    expect(payload.snappedWindowId).toBe(WIN.windowId);
    expect(payload.rect).toEqual({ x: 200, y: 150, w: 400, h: 300 });
    expect(payload).not.toHaveProperty("extents");
  });

  test("discard-pending dims the rect while staged; cleared on mouseup", async () => {
    await mount();
    await emitSnapshot({
      windows: [WIN],
      displayBounds: { width: window.innerWidth, height: window.innerHeight }
    });
    await drawRect();
    await mouseDown(250, 200); // inside the rect and inside WIN
    expect(document.body.dataset.discarding).toBe("true");
    await mouseUp(250, 200);
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
  init: { metaKey?: boolean; ctrlKey?: boolean } = {}
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

/** The pick-set half of the HUD. Present only while a set is live —
 *  the chooser bar renders the same container with no chips. */
function hudChips(): HTMLElement[] {
  return Array.from(
    container?.querySelectorAll('[data-testid="region-hud-chip"]') ?? []
  ).filter((e): e is HTMLElement => e instanceof HTMLElement);
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
  test("plain clicks accumulate windows; the rect becomes their union", async () => {
    await mountScene();
    await clickWindow(WIN);
    expect(pickBoxes()).toHaveLength(1);
    expect(selectionStyle()).toEqual({ left: 200, top: 150, width: 400, height: 300 });

    await clickWindow(WIN_B);
    expect(pickBoxes()).toHaveLength(2);
    // union of (200,150,400x300) and (700,100,200x150)
    expect(rectStyle()).toEqual({ left: 200, top: 100, width: 700, height: 350 });
    expect(document.body.dataset.pickCount).toBe("2");
    expect(rectStyle()).toEqual({ left: 200, top: 100, width: 700, height: 350 });
  });

  test("⌘ still picks — the modifier is inert, not forbidden", async () => {
    // ⌘-click was the old opt-in. It has to keep working: muscle memory
    // aside, a press that is already a pick cannot be made not-a-pick
    // by a modifier the overlay binds nothing else to.
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

  test("clicking the desktop with a set live keeps it, and settles in snap", async () => {
    await mountScene();
    await clickWindow(WIN);
    await mouseMove(980, 700); // empty desktop
    await mouseDown(980, 700);
    await mouseUp(980, 700);
    expect(pickBoxes()).toHaveLength(1);
    // Back in `snap`, not parked in `pending`: a stale `pending` keeps
    // its mousedown origin, so the next bare mousemove would measure
    // against it and promote to `drawing` with no button held.
    expect(document.body.dataset.interaction).toBe("snap");
    await mouseMove(400, 300);
    expect(document.body.dataset.interaction).toBe("snap");
    expect(pickBoxes()).toHaveLength(1);
  });

  test("a drag that starts on a window free-draws — click-to-pick did not eat it", async () => {
    // The whole reason picks resolve on mouseup: in `auto` mode most of
    // the screen is covered by windows, so deciding on mousedown means
    // either clicks cannot pick or drags cannot start from a window.
    await mountScene();
    const c = centerOf(WIN);
    await mouseMove(c.x, c.y);
    await mouseDown(c.x, c.y);
    await mouseMove(c.x + 20, c.y + 20); // past DRAG_ENGAGE_PX
    await mouseMove(900, 640);
    await mouseUp(900, 640);
    expect(pickBoxes()).toHaveLength(0);
    expect(document.body.dataset.interaction).toBe("adjusting");
    expect(rectStyle()).toEqual({
      left: c.x,
      top: c.y,
      width: 900 - c.x,
      height: 640 - c.y
    });
  });

  test("a drag from empty desktop replaces a live set with the region", async () => {
    await mountScene();
    await clickWindow(WIN);
    await mouseMove(980, 700);
    await mouseDown(980, 700);
    await mouseMove(960, 680);
    await mouseMove(700, 500);
    await mouseUp(700, 500);
    expect(pickBoxes()).toHaveLength(0);
    // The set is gone; the bar that remains is the Snap/Record chooser
    // (the drag landed in `adjusting`), which carries no chips.
    expect(hudChips()).toHaveLength(0);
    expect(rectStyle()).toEqual({ left: 700, top: 500, width: 280, height: 200 });
    await keyDown("Enter");
    const payload = submitRegion.mock.calls[0]?.[0];
    expect(payload).not.toHaveProperty("extents");
    expect(payload.rect).toEqual({ x: 700, y: 500, w: 280, h: 200 });
  });

  test("an arrow key promotes a lone pick to an adjustable rect", async () => {
    // Clicking a window used to land in `adjusting`, where arrows
    // nudged. Click-to-pick lands in `snap` instead, so without the
    // promotion the arrows would be silently dead on exactly the
    // selection they used to move.
    await mountScene();
    await clickWindow(WIN);
    expect(document.body.dataset.interaction).toBe("snap");
    await keyDown("ArrowRight");
    expect(document.body.dataset.interaction).toBe("adjusting");
    expect(pickBoxes()).toHaveLength(0);
    expect(hudChips()).toHaveLength(0);
    expect(rectStyle()).toEqual({ left: 201, top: 150, width: 400, height: 300 });
    // The commit still names the window that was picked.
    await keyDown("Enter");
    const payload = submitRegion.mock.calls[0]?.[0];
    expect(payload.snappedWindowId).toBe(WIN.windowId);
    expect(payload).not.toHaveProperty("extents");
  });

  test("the promotion tags the picked window, not whatever the cursor left on", async () => {
    await mountScene();
    await clickWindow(WIN);
    await mouseMove(centerOf(WIN_B).x, centerOf(WIN_B).y); // hover elsewhere
    await keyDown("ArrowRight");
    await keyDown("Enter");
    expect(submitRegion.mock.calls[0]?.[0].snappedWindowId).toBe(WIN.windowId);
  });

  test("arrows do not nudge a union of two picks", async () => {
    // The rect is derived there; moving it would strand the extents on
    // windows the box no longer matches.
    await mountScene();
    await clickWindow(WIN);
    await clickWindow(WIN_B);
    const before = rectStyle();
    await keyDown("ArrowRight");
    expect(rectStyle()).toEqual(before);
    expect(pickBoxes()).toHaveLength(2);
    expect(document.body.dataset.interaction).toBe("snap");
  });

  test("Tab then click picks the window Tab highlighted, not the one on top", async () => {
    // Tab exists to reach a window BURIED under another, and in window
    // mode it is the only way. It moves the snap target without moving
    // the cursor, so a pick that re-hit-tests from the pointer would
    // highlight the buried window and then pick the one above it.
    await mountScene();
    // (250,200) lies inside WIN (200,150,400x300) and inside WIN_OVERLAP
    // (450,300,400x300)? No — pick a point inside both.
    const p = { x: 500, y: 350 };
    await mouseMove(p.x, p.y);
    // Frontmost at that point is WIN (z-order ascending, WIN first).
    expect(document.body.dataset.snap).toBe("window");
    await keyDown("Tab");
    await mouseDown(p.x, p.y);
    await mouseUp(p.x, p.y);
    expect(pickBoxes()).toHaveLength(1);
    await keyDown("Enter");
    // Whatever Tab landed on is what must be picked — assert the pick
    // followed the highlight rather than hard-coding a z-order.
    const payload = submitRegion.mock.calls[0]?.[0];
    expect(payload.snappedWindowId).toBe(WIN_OVERLAP.windowId);
  });

  test("Escape on a lone pick returns to the snap under the cursor, not the display", async () => {
    // resetToSnap() hard-sets the display rect, so Escaping a pick used
    // to leave the whole screen armed — one ↵ from a full-screen grab.
    await mountScene();
    const c = centerOf(WIN);
    await clickWindow(WIN);
    await mouseMove(c.x, c.y);
    await keyDown("Escape");
    expect(pickBoxes()).toHaveLength(0);
    expect(document.body.dataset.snap).toBe("window");
    expect(rectStyle()).toEqual({ left: 200, top: 150, width: 400, height: 300 });
    // And it matches the other route out of a set: removing the chip.
    await clickWindow(WIN);
    await clickWindow(WIN);
    expect(rectStyle()).toEqual({ left: 200, top: 150, width: 400, height: 300 });
  });

  test("one physical ↵ delivered twice submits once", async () => {
    // Main arms Return as a global shortcut AND the renderer hears the
    // keydown, so a single press can arrive on both paths. The second
    // delivery ran against the state the first had already reset and
    // shipped the whole display.
    await mountScene();
    await clickWindow(WIN);
    await keyDown("Enter");
    await keyDown("Enter");
    expect(submitRegion).toHaveBeenCalledTimes(1);
    expect(submitRegion.mock.calls[0]?.[0].rect).toEqual({ x: 200, y: 150, w: 400, h: 300 });
  });

  test("window mode: a nudged pick commits the nudged rect, not the whole window", async () => {
    // `fullWindow` routes to the window's backing buffer, which never
    // reads `rect` — so taking it after an arrow nudge silently threw
    // the nudge away while the hint advertised `arrows nudge`.
    await mountScene({ mode: "window" });
    await clickWindow(WIN);
    await keyDown("ArrowRight");
    await keyDown("ArrowRight");
    await keyDown("Enter");
    const payload = submitRegion.mock.calls[0]?.[0];
    expect(payload.rect).toEqual({ x: 202, y: 150, w: 400, h: 300 });
    expect(payload).not.toHaveProperty("fullWindow");
    expect(payload.snappedWindowId).toBe(WIN.windowId);
  });

  test("window mode: an un-nudged pick still takes the full-window path", async () => {
    await mountScene({ mode: "window" });
    await clickWindow(WIN);
    await keyDown("Enter");
    expect(submitRegion.mock.calls[0]?.[0].fullWindow).toBe(true);
  });

  test("a new mode signal resets the frame, not just the pick set", async () => {
    // Main can end a session with no renderer commit/cancel and re-show
    // the same pre-warmed window; on Windows/Linux the panel is never
    // destroyed. Dropping the picks was not enough — `togglePick` had
    // already written their union into `rect`, so ↵ on the next show
    // captured the abandoned session's bounding box.
    await mountScene();
    await clickWindow(WIN);
    await clickWindow(WIN_B);
    expect(rectStyle()).toEqual({ left: 200, top: 100, width: 700, height: 350 });
    await emitMode({ mode: "auto", intent: "video" });
    expect(document.body.dataset.pickCount).toBe("0");
    expect(document.body.dataset.interaction).toBe("snap");
    expect(rectStyle()).toEqual({
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight
    });
  });

  test("a held mousedown does not survive a mode signal as a phantom drag", async () => {
    // Release can go to a hidden window, so `pending` outlived the show
    // and one bare mousemove promoted it to `drawing` with no button.
    await mountScene();
    await mouseMove(50, 50);
    await mouseDown(50, 50);
    expect(document.body.dataset.interaction).toBe("pending");
    await emitMode({ mode: "auto" });
    expect(document.body.dataset.interaction).toBe("snap");
    await mouseMove(400, 400);
    expect(document.body.dataset.interaction).not.toBe("drawing");
  });

  test("⇧ does not latch across a commit into the next show", async () => {
    await mountScene();
    await mouseMove(centerOf(WIN).x, centerOf(WIN).y);
    await keyDown("Shift", { shiftKey: true });
    expect(document.body.dataset.fullWindow).toBe("true");
    await keyDown("Enter");
    expect(submitRegion.mock.calls[0]?.[0].fullWindow).toBe(true);
    expect(document.body.dataset.fullWindow).toBe("false");
  });

  test("the pick set is capped where main's validator caps it", async () => {
    // Past MAX_SELECTOR_EXTENTS main rejects the WHOLE payload, and a
    // rejected payload resolves the session as `cancelled` — so the
    // capture vanished with no error, exactly like an Escape.
    await mount();
    await emitMode({ mode: "auto" });
    const many = Array.from({ length: MAX_SELECTOR_EXTENTS + 5 }, (_, i) => ({
      ...WIN,
      windowId: 1000 + i,
      zIndex: i,
      rect: { x: i * 2, y: 0, w: 4, h: 4 },
      rawRect: { x: i * 2, y: 0, w: 4, h: 4 }
    }));
    await emitSnapshot({
      windows: many,
      displayBounds: { width: window.innerWidth, height: window.innerHeight }
    });
    for (const w of many) await clickWindow(w);
    expect(pickBoxes()).toHaveLength(MAX_SELECTOR_EXTENTS);
    await keyDown("Enter");
    expect(submitRegion.mock.calls[0]?.[0].extents).toHaveLength(MAX_SELECTOR_EXTENTS);
  });

  test("the Esc affordance says 'back' while a pick set is live", async () => {
    // handleEscape checks the pick set FIRST, but togglePick parks the
    // interaction in `snap`, so reading interaction.kind alone said
    // "cancel" for a state Esc actually steps back from.
    await mountScene();
    expect(regionHintText()).toContain("cancel");
    await clickWindow(WIN);
    expect(regionHintText()).toContain("back");
    expect(regionHintText()).not.toContain("cancel");
  });

  test("the record picker does not advertise picking", async () => {
    // runInteractiveRecord opens as mode:"auto", intent:"video", where
    // multiSelectAllowed() is false and a click cannot pick.
    await mountScene({ mode: "auto", intent: "video" });
    await mouseMove(centerOf(WIN).x, centerOf(WIN).y);
    expect(regionHintText()).not.toContain("pick ");
    await clickWindow(WIN);
    expect(pickBoxes()).toHaveLength(0);
  });

  test("at a fractional scale the committed extents are the logical rects main sent", async () => {
    // Every other test runs at cssToLogical 1, where `toLogical` is the
    // identity — so the conversion could be DELETED with the whole
    // suite still green (verified: it was). Scaled-mode Retina and
    // every Windows display at 125%/150% are fractional, and there a
    // dropped conversion ships `extents` in CSS px beside a `rect` in
    // logical px; planExtentMask then finds no overlap and the capture
    // fails outright.
    //
    // displayBounds 1348 against jsdom's 1024 viewport → the renderer
    // scales the window list by 1024/1348 on the way in, and commit
    // must scale it back exactly.
    const A = { ...WIN, windowId: 501, zIndex: 0, rect: { x: 120, y: 100, w: 240, h: 180 }, rawRect: { x: 120, y: 100, w: 240, h: 180 } };
    const B = { ...WIN, windowId: 502, zIndex: 1, rect: { x: 500, y: 300, w: 300, h: 200 }, rawRect: { x: 500, y: 300, w: 300, h: 200 } };
    await mount();
    await emitMode({ mode: "auto" });
    await emitSnapshot({ windows: [A, B], displayBounds: { width: 1348, height: 900 } });
    const scale = window.innerWidth / 1348;
    const clickAt = async (w: WindowSnapEntry): Promise<void> => {
      const x = (w.rawRect.x + w.rawRect.w / 2) * scale;
      const y = (w.rawRect.y + w.rawRect.h / 2) * scale;
      await mouseMove(x, y);
      await mouseDown(x, y);
      await mouseUp(x, y);
    };
    await clickAt(A);
    await clickAt(B);
    const payload = await commitAndRead();
    expect(payload.extents).toEqual([A.rawRect, B.rawRect]);
    // And the union is the union of those, in the same space.
    expect(payload.rect).toEqual({ x: 120, y: 100, w: 680, h: 400 });
    // Which means no extent can fall outside the box the mask clips to.
    for (const e of payload.extents) {
      expect(e.x).toBeGreaterThanOrEqual(payload.rect.x);
      expect(e.x + e.w).toBeLessThanOrEqual(payload.rect.x + payload.rect.w);
      expect(e.y).toBeGreaterThanOrEqual(payload.rect.y);
      expect(e.y + e.h).toBeLessThanOrEqual(payload.rect.y + payload.rect.h);
    }
  });

  test("window mode: a hand wobble past the drag threshold still picks", async () => {
    // Window mode has no competing drag gesture, so travel must not
    // cost the pick the way it does in `auto`.
    await mountScene({ mode: "window" });
    const c = centerOf(WIN);
    await mouseMove(c.x, c.y);
    await mouseDown(c.x, c.y);
    await mouseMove(c.x + 6, c.y + 6);
    await mouseUp(c.x + 6, c.y + 6);
    expect(pickBoxes()).toHaveLength(1);
    expect(submitRegion).not.toHaveBeenCalled();
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
    await clickWindow(WIN);
    await clickWindow(WIN_B);
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
    expect(hudChips()).toHaveLength(0);
    expect(document.body.dataset.pickCount).toBe("0");
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

  test("a new mode signal also drops a pick armed but not yet released", async () => {
    // A pick resolves on mouseup, so a press can outlive the session it
    // was made in: main re-shows the same pre-warmed window on a new
    // mode signal while the button is still down. Releasing it must not
    // deposit a window from the abandoned session — least of all into
    // `region` mode or a video pick, where multi-select is off and the
    // user has no way to click it back off.
    await mountScene();
    const c = centerOf(WIN);
    await mouseMove(c.x, c.y);
    await mouseDown(c.x, c.y);
    await emitMode({ mode: "region" });
    await mouseUp(c.x, c.y);
    expect(pickBoxes()).toHaveLength(0);
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

  test("on macOS a bare click picks — no modifier, no ⌃ special case", async () => {
    // The shipped-and-wrong version of this behavior required ⌘ in
    // `auto` mode, with a carve-out refusing ⌃ because ⌃+left-click is
    // the macOS secondary click. Both are gone: a bare press over a
    // window is a pick, so ⌃ neither grants nor withholds anything, and
    // the overlay has no context menu for ⌃ to have been protecting.
    await mount();
    (window.pwrsnapApi as { platform: string }).platform = "darwin";
    await emitMode({ mode: "auto" });
    await emitSnapshot({
      windows: [WIN, WIN_B, WIN_C],
      displayBounds: { width: window.innerWidth, height: window.innerHeight }
    });
    await clickWindow(WIN);
    expect(pickBoxes()).toHaveLength(1);
    await clickWindow(WIN_B);
    expect(pickBoxes()).toHaveLength(2);
    expect(submitRegion).not.toHaveBeenCalled();
    // And ⌃-click — which on macOS arrives as button 0 with ctrlKey,
    // the secondary-click gesture the removed carve-out refused —
    // behaves like any other click. Without actually DISPATCHING a
    // ctrlKey event this test could not tell a restored carve-out from
    // a working one.
    await clickWindow(WIN_C, { ctrlKey: true });
    expect(pickBoxes()).toHaveLength(3);
    await clickWindow(WIN_C, { ctrlKey: true });
    expect(pickBoxes()).toHaveLength(2);
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

// ---------------------------------------------------------------------
// U6 — Snap-vs-Record chooser (issue #75)
// ---------------------------------------------------------------------
// The chooser is NOT a modal step. `↵` still commits, and what it
// commits is the policy's primary action; the other action lives on a
// second key + a second button. So the tests below are mostly about two
// things: which action a keystroke maps to, and whether the payload
// gained an `action` field (a snap must stay byte-for-byte identical to
// the pre-chooser wire shape).
describe("U6 — Snap-vs-Record chooser", () => {
  /** The primary (↵) button; its `data-action` says what it commits. */
  function primaryButton(): HTMLElement {
    return hudButton("region-hud-capture");
  }

  /** The secondary action button, or null when none is offered. */
  function altButton(): HTMLElement | null {
    const el = container?.querySelector('[data-testid="region-hud-alt"]');
    return el instanceof HTMLElement ? el : null;
  }

  test("ask: ↵ still snaps, and the payload is unchanged by the chooser", async () => {
    await mountScene();
    await drawRect();
    const payload = await commitAndRead();
    // The whole point of putting the chooser on the bar instead of in a
    // dialog: Quick Capture is still one keystroke, and the wire shape
    // main has always parsed is untouched.
    expect(payload).not.toHaveProperty("action");
    expect(payload).not.toHaveProperty("captureCursor");
    expect(payload.rect).toEqual({ x: 100, y: 100, w: 200, h: 200 });
  });

  test("ask: the bar offers both actions once the selection is latched", async () => {
    await mountScene();
    // Live snap — the frame is still following the cursor, so there is
    // nothing to anchor a mouse chooser to. Keys only.
    await mouseMove(400, 300);
    expect(hud()).toBeNull();
    expect(regionHintText()).toContain("record");

    await drawRect();
    expect(document.body.dataset.chooserBar).toBe("true");
    expect(primaryButton().dataset.action).toBe("snap");
    expect(primaryButton().textContent).toContain("Capture");
    expect(altButton()?.dataset.action).toBe("record");
    expect(altButton()?.textContent).toContain("Record");
  });

  test("ask: R records the latched selection", async () => {
    await mountScene();
    await drawRect();
    await keyDown("r");
    expect(submitRegion).toHaveBeenCalledTimes(1);
    const payload = submitRegion.mock.calls[0]?.[0];
    expect(payload.action).toBe("record");
    // The cursor bake rides along, exactly as it does from the
    // dedicated video selector.
    expect(payload.captureCursor).toBe(true);
    expect(payload.rect).toEqual({ x: 100, y: 100, w: 200, h: 200 });
  });

  test("ask: the Record button commits the same thing R does", async () => {
    await mountScene();
    await drawRect();
    const alt = altButton();
    expect(alt).not.toBeNull();
    await clickEl(alt as HTMLElement);
    expect(submitRegion.mock.calls[0]?.[0].action).toBe("record");
  });

  test("ask: R records a single-window pick without extents", async () => {
    // One pick is one rectangle — the union box IS the extent, so the
    // commit carries no `extents` and a recording is honest.
    await mountScene();
    await clickWindow(WIN);
    expect(document.body.dataset.pickCount).toBe("1");
    await keyDown("R");
    const payload = submitRegion.mock.calls[0]?.[0];
    expect(payload.action).toBe("record");
    expect(payload).not.toHaveProperty("extents");
    expect(payload.snappedWindowId).toBe(WIN.windowId);
  });

  test("R needs a bare press — ⌘R / ⌃R must not start a recording", async () => {
    // ⌘R is Reload in a dev build and ⌃R is a shell history search.
    // Neither may be a screen recording.
    await mountScene();
    await drawRect();
    await keyDown("r", { metaKey: true });
    await keyDown("r", { ctrlKey: true });
    expect(submitRegion).not.toHaveBeenCalled();
    await keyDown("r");
    expect(submitRegion).toHaveBeenCalledTimes(1);
  });

  test("C toggles the cursor bake on the chooser path", async () => {
    await mountScene({ mode: "auto", cursor: true });
    await drawRect();
    expect(regionHintText()).toContain("cursor: on");
    await keyDown("c");
    expect(regionHintText()).toContain("cursor: off");
    await keyDown("r");
    expect(submitRegion.mock.calls[0]?.[0].captureCursor).toBe(false);
  });

  test("C does not leak the cursor field onto a snap payload", async () => {
    await mountScene();
    await drawRect();
    await keyDown("c");
    const payload = await commitAndRead();
    expect(payload).not.toHaveProperty("captureCursor");
  });

  test('snap policy: no Record affordance and R is inert', async () => {
    await mountScene({ mode: "auto", quickCaptureAction: "snap" });
    await drawRect();
    // No bar at all — this is exactly what the selector rendered before
    // the chooser existed.
    expect(hud()).toBeNull();
    expect(document.body.dataset.chooserBar).toBe("false");
    expect(regionHintText()).not.toContain("record");
    await keyDown("r");
    expect(submitRegion).not.toHaveBeenCalled();
    await keyDown("Enter");
    expect(submitRegion.mock.calls[0]?.[0]).not.toHaveProperty("action");
  });

  test("record policy: ↵ records and S takes the snap", async () => {
    await mountScene({ mode: "auto", quickCaptureAction: "record" });
    await drawRect();
    expect(primaryButton().dataset.action).toBe("record");
    expect(primaryButton().textContent).toContain("Record");
    expect(altButton()?.dataset.action).toBe("snap");
    await keyDown("Enter");
    expect(submitRegion.mock.calls[0]?.[0].action).toBe("record");
  });

  test("record policy: S escapes to a plain snap", async () => {
    await mountScene({ mode: "auto", quickCaptureAction: "record" });
    await drawRect();
    await keyDown("s");
    expect(submitRegion).toHaveBeenCalledTimes(1);
    expect(submitRegion.mock.calls[0]?.[0]).not.toHaveProperty("action");
  });

  test("S is unbound unless Record has taken over ↵", async () => {
    await mountScene();
    await drawRect();
    await keyDown("s");
    expect(submitRegion).not.toHaveBeenCalled();
  });

  test("2+ picks: Record is disabled and R does nothing", async () => {
    // THE seam. `multiSelectAllowed()` could exclude video by reading
    // `intent` only because intent was fixed at hotkey time. The chooser
    // moves the decision after the commit, so a Record here would ship
    // the union bounding box to a recorder that never reads `extents` —
    // recording exactly the gaps the picker painted transparent.
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    expect(document.body.dataset.pickCount).toBe("2");
    const alt = altButton();
    expect(alt).not.toBeNull();
    expect((alt as HTMLButtonElement).disabled).toBe(true);
    await keyDown("r");
    expect(submitRegion).not.toHaveBeenCalled();
    // The legend says why, rather than the key silently doing nothing.
    expect(regionHintText()).toContain("one rectangle only");
    // ↵ still works and still ships the mask.
    await keyDown("Enter");
    const payload = submitRegion.mock.calls[0]?.[0];
    expect(payload).not.toHaveProperty("action");
    expect(payload.extents).toHaveLength(2);
  });

  test("2+ picks under the record policy: ↵ falls back to a snap", async () => {
    // The policy cannot make ↵ do something the selection does not
    // support. It must degrade to the honest action, never to a
    // recording of the gaps.
    await mountScene({ mode: "auto", quickCaptureAction: "record" });
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    expect(primaryButton().dataset.action).toBe("snap");
    await keyDown("Enter");
    const payload = submitRegion.mock.calls[0]?.[0];
    expect(payload).not.toHaveProperty("action");
    expect(payload.extents).toHaveLength(2);
  });

  test("dropping back to one pick re-enables Record", async () => {
    await mountScene();
    await clickWindow(WIN, { metaKey: true });
    await clickWindow(WIN_B);
    expect((altButton() as HTMLButtonElement).disabled).toBe(true);
    await clickWindow(WIN_B); // remove
    expect((altButton() as HTMLButtonElement).disabled).toBe(false);
    await keyDown("r");
    expect(submitRegion.mock.calls[0]?.[0].action).toBe("record");
  });

  test("video intent ignores the chooser entirely", async () => {
    // The dedicated Video Capture selector already knows what it is.
    // Offering "Record" next to a rect badged RECORD would be nonsense,
    // and `S` must not turn a video hotkey into a screenshot.
    await mountScene({ mode: "auto", intent: "video", quickCaptureAction: "record" });
    await drawRect();
    expect(hud()).toBeNull();
    expect(altButton()).toBeNull();
    await keyDown("s");
    expect(submitRegion).not.toHaveBeenCalled();
    await keyDown("Enter");
    const payload = submitRegion.mock.calls[0]?.[0];
    // Byte-for-byte the pre-chooser video payload: cursor, no `action`.
    expect(payload).not.toHaveProperty("action");
    expect(payload.captureCursor).toBe(true);
  });

  test("the policy is re-read on every show of the pre-warmed window", async () => {
    // Same window, second capture. A stale `record` policy would make
    // the next ↵ start a recording the user never asked for.
    await mountScene({ mode: "auto", quickCaptureAction: "record" });
    await drawRect();
    expect(primaryButton().dataset.action).toBe("record");
    await emitMode({ mode: "auto", quickCaptureAction: "snap" });
    await drawRect();
    expect(document.body.dataset.quickAction).toBe("snap");
    expect(hud()).toBeNull();
    await keyDown("Enter");
    expect(submitRegion.mock.calls[0]?.[0]).not.toHaveProperty("action");
  });
});
