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
  windows: never[];
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

async function emitKey(key: string): Promise<void> {
  await act(async () => {
    keyHandler?.({ key });
  });
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
    await mouseMove(150, 150); // re-aim re-arms the de-dupe guard
    await keyDown("Escape"); // now in snap → exit
    expect(submitRegion).toHaveBeenCalledTimes(1);
    expect(submitRegion).toHaveBeenCalledWith({ ok: false });
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
