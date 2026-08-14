// Grid copy palette — the floating L/M/H overlay used when Grid
// selection must not open the right inspector. Verifies:
//   • image cards route through clipboard:copy (bytes, not a file URL)
//   • FILE chip routes through clipboard:copy-path
//   • video selection mounts the shared export grid
//   • drag grip repositions; double-click resets
//   • toolbar/grip remain keyboard-focusable

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, Settings } from "@pwrsnap/shared";

const dispatchMock = vi.fn();
const startCaptureDragMock = vi.fn();
const subscribeMock = vi.fn((_channel: string, _handler: (payload: unknown) => void) => {
  return () => undefined;
});

vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args),
  subscribe: (...args: unknown[]) =>
    subscribeMock(args[0] as string, args[1] as (payload: unknown) => void),
  startCaptureDrag: (...args: unknown[]) => startCaptureDragMock(...args),
  startVideoDrag: vi.fn()
}));

import {
  GridCopyPalette,
  resetGridCopyPalettePositionForTests
} from "../GridCopyPalette";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  if (typeof (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver !== "function") {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {
        /* no-op */
      }
      unobserve(): void {
        /* no-op */
      }
      disconnect(): void {
        /* no-op */
      }
    };
  }
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const imageRecord: CaptureRecord = {
  id: "cap_image",
  kind: "image",
  captured_at: "2026-05-15T18:24:00.000Z",
  legacy_src_path: "/tmp/cap_image.png",
  bundle_path: null,
  flat_png_path: null,
  bundle_modified_at: null,
  bundle_format_version: 2,
  bundle_edits_version: 0,
  width_px: 1200,
  height_px: 800,
  device_pixel_ratio: 2,
  byte_size: 100_000,
  sha256: "sha_cap_image",
  source_app_bundle_id: "com.example.app",
  source_app_name: "Example",
  edits_version: 0,
  has_alpha: false,
  deleted_at: null
};

const videoRecord: CaptureRecord = {
  ...imageRecord,
  id: "cap_video",
  kind: "video",
  video: {
    durationSec: 4,
    containerFormat: "mp4",
    hasSystemAudio: false,
    hasMicrophoneAudio: false,
    defaultRange: { start: 0, end: 4 },
    previewPath: null,
    previewStatus: "ready"
  }
};

const settings = {
  library: { detailRail: { pinned: false, lastSelectedTab: "info" } },
  experimental: { dpiAwareExport: false }
} as unknown as Settings;

function ok<T>(value: T) {
  return { ok: true as const, value };
}

function installRects(): void {
  const proto = Element.prototype as Element & {
    getBoundingClientRect(): DOMRect;
  };
  proto.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    const testId = (this as HTMLElement).getAttribute?.("data-testid");
    if (testId === "psl-grid-copy-palette") {
      return {
        x: 200,
        y: 400,
        left: 200,
        top: 400,
        width: 360,
        height: 90,
        right: 560,
        bottom: 490,
        toJSON: () => ({})
      } as DOMRect;
    }
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      toJSON: () => ({})
    } as DOMRect;
  };
}

async function renderPalette(record: CaptureRecord = imageRecord): Promise<HTMLDivElement> {
  container = document.createElement("div");
  container.className = "psl__main";
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(GridCopyPalette, { record }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  resetGridCopyPalettePositionForTests();
  installRects();
  dispatchMock.mockImplementation(async (name: string) => {
    if (name === "settings:read") return ok(settings);
    if (name === "capture:presetMetrics") return ok({ metrics: [] });
    if (name === "clipboard:copy") return ok(undefined);
    if (name === "clipboard:copy-path") return ok(undefined);
    if (name === "video:presetMetrics") return ok({ metrics: [] });
    return ok(undefined);
  });
});

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  resetGridCopyPalettePositionForTests();
  dispatchMock.mockReset();
  startCaptureDragMock.mockReset();
});

describe("GridCopyPalette", () => {
  test("renders a focusable toolbar with Low/Med/High copy cards", async () => {
    const el = await renderPalette();
    const toolbar = el.querySelector<HTMLElement>('[data-testid="psl-grid-copy-palette"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.getAttribute("role")).toBe("toolbar");
    expect(toolbar?.getAttribute("aria-label")).toBe("Copy selected capture");
    expect(el.querySelectorAll(".fo__copy-btn")).toHaveLength(3);
    expect(el.textContent).toContain("Low");
    expect(el.textContent).toContain("Med");
    expect(el.textContent).toContain("High");
  });

  test("card body copies image bytes via clipboard:copy", async () => {
    const el = await renderPalette();
    const low = el.querySelector<HTMLButtonElement>(".fo__copy-btn");
    expect(low).not.toBeNull();

    await act(async () => {
      low?.click();
      await Promise.resolve();
    });

    expect(dispatchMock).toHaveBeenCalledWith("clipboard:copy", {
      captureId: "cap_image",
      preset: "low"
    });
    expect(dispatchMock.mock.calls.some(([name]) => name === "clipboard:copy-file")).toBe(
      false
    );
  });

  test("FILE chip copies the rendered path via clipboard:copy-path", async () => {
    const el = await renderPalette();
    const file = el.querySelector<HTMLAnchorElement>(".fo__copy-file");
    expect(file).not.toBeNull();

    await act(async () => {
      file?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(dispatchMock).toHaveBeenCalledWith("clipboard:copy-path", {
      captureId: "cap_image",
      preset: "low"
    });
  });

  test("video records mount the shared export grid instead of L/M/H cards", async () => {
    const el = await renderPalette(videoRecord);
    expect(el.querySelector('[data-testid="psl-grid-copy-palette-video"]')).not.toBeNull();
    expect(el.textContent).toContain("Export");
    expect(el.textContent).not.toContain("Copy to clipboard");
  });

  test("drag grip repositions the palette; double-click snaps back", async () => {
    const el = await renderPalette();
    const palette = el.querySelector<HTMLElement>('[data-testid="psl-grid-copy-palette"]');
    const grip = el.querySelector<HTMLButtonElement>('[data-testid="psl-grid-copy-palette-grip"]');
    expect(palette).not.toBeNull();
    expect(grip).not.toBeNull();
    expect(palette?.style.left).toBe("");

    await act(async () => {
      grip?.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 210,
          clientY: 410,
          pointerId: 1
        })
      );
      grip?.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 260,
          clientY: 450,
          pointerId: 1
        })
      );
      grip?.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 260,
          clientY: 450,
          pointerId: 1
        })
      );
      await Promise.resolve();
    });

    expect(palette?.style.left).not.toBe("");
    expect(palette?.style.top).not.toBe("");
    expect(palette?.classList.contains("is-positioned")).toBe(true);

    await act(async () => {
      grip?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(palette?.style.left).toBe("");
    expect(palette?.style.top).toBe("");
    expect(palette?.classList.contains("is-positioned")).toBe(false);
  });

  test("grip and copy buttons are keyboard-focusable", async () => {
    const el = await renderPalette();
    const grip = el.querySelector<HTMLButtonElement>('[data-testid="psl-grid-copy-palette-grip"]');
    const copy = el.querySelector<HTMLButtonElement>(".fo__copy-btn");
    expect(grip).not.toBeNull();
    expect(copy).not.toBeNull();

    grip?.focus();
    expect(document.activeElement).toBe(grip);

    copy?.focus();
    expect(document.activeElement).toBe(copy);
  });
});
