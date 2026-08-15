// Grid copy palette — the floating L/M/H overlay used when Grid
// selection must not open the right inspector. Verifies:
//   • image cards route through clipboard:copy (bytes, not a file URL)
//   • FILE chip routes through clipboard:copy-path
//   • video selection mounts the shared export grid
//   • drag grip repositions; double-click resets
//   • toolbar/grip remain keyboard-focusable
//   • follow-mode anchoring: positions next to the selected tile,
//     flips at the stage edges, drags into `pinned` (persisted), and
//     re-anchors when the 📌 toggle flips back
//   • the preview drawer opens/closes and persists its state

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
  startVideoDrag: vi.fn(),
  // Pure URL builders — mirror the real implementations so the preview
  // drawer's asserted src values stay meaningful.
  captureSrcUrl: (captureId: string) => `pwrsnap-capture://r/${captureId}`,
  cacheUrl: (captureId: string, width: number, format = "webp", v?: number) =>
    `pwrsnap-cache://r/${captureId}/${width}w.${format}` +
    (v === undefined ? "" : `?v=${v}`)
}));

import {
  GridCopyPalette,
  resetGridCopyPalettePositionForTests
} from "../GridCopyPalette";
import { resolveFollowAnchor } from "../grid-copy-palette-anchor";

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

type Box = { left: number; top: number; width: number; height: number };

function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, width, height };
}

function toDomRect(b: Box): DOMRect {
  return {
    x: b.left,
    y: b.top,
    left: b.left,
    top: b.top,
    width: b.width,
    height: b.height,
    right: b.left + b.width,
    bottom: b.top + b.height,
    toJSON: () => ({})
  } as DOMRect;
}

// Mutable per-test geometry. `.psl__main` is the stage, the palette is
// keyed off its testid, and any `.psl__cell` reports the tile box —
// which is what the follow-anchor math consumes.
let stageBox: Box = box(0, 0, 800, 600);
let tileBox: Box = box(100, 100, 180, 120);
let paletteBox: Box = box(200, 400, 360, 90);

function installRects(): void {
  stageBox = box(0, 0, 800, 600);
  tileBox = box(100, 100, 180, 120);
  paletteBox = box(200, 400, 360, 90);
  const proto = Element.prototype as Element & {
    getBoundingClientRect(): DOMRect;
  };
  proto.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    const el = this as HTMLElement;
    if (el.getAttribute?.("data-testid") === "psl-grid-copy-palette") {
      return toDomRect(paletteBox);
    }
    if (el.classList?.contains("psl__cell")) return toDomRect(tileBox);
    return toDomRect(stageBox);
  };
}

/**
 * Mount the palette inside a `.psl__main` stage. `withTile` adds the
 * `.psl__cell[data-cell-id]` element the follow-anchor code looks for;
 * tests that want the CSS-default (bottom-center) placement omit it.
 */
async function renderPalette(
  record: CaptureRecord = imageRecord,
  options: { withTile?: boolean } = {}
): Promise<HTMLDivElement> {
  container = document.createElement("div");
  container.className = "psl__main";
  document.body.appendChild(container);
  if (options.withTile === true) {
    const tile = document.createElement("div");
    tile.className = "psl__cell";
    tile.setAttribute("data-cell-id", record.id);
    container.appendChild(tile);
  }
  const mount = document.createElement("div");
  container.appendChild(mount);
  root = createRoot(mount);
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

  test("follow mode anchors the palette just below the selected tile", async () => {
    const el = await renderPalette(imageRecord, { withTile: true });
    const palette = el.querySelector<HTMLElement>('[data-testid="psl-grid-copy-palette"]');
    expect(palette?.getAttribute("data-anchor")).toBe("follow");
    // Tile is 180x120 at (100,100) → bottom 220; +12px gap = 232.
    // Centered horizontally: 100 + 90 - 180 = 10 (inside the stage).
    expect(palette?.style.top).toBe("232px");
    expect(palette?.style.left).toBe("10px");
    expect(palette?.classList.contains("is-positioned")).toBe(true);
  });

  test("follow mode leaves the CSS default when the tile isn't rendered", async () => {
    const el = await renderPalette(imageRecord);
    const palette = el.querySelector<HTMLElement>('[data-testid="psl-grid-copy-palette"]');
    expect(palette?.style.left).toBe("");
    expect(palette?.style.top).toBe("");
  });

  test("dragging switches the anchor to pinned and persists it", async () => {
    const el = await renderPalette(imageRecord, { withTile: true });
    const palette = el.querySelector<HTMLElement>('[data-testid="psl-grid-copy-palette"]');
    const grip = el.querySelector<HTMLButtonElement>('[data-testid="psl-grid-copy-palette-grip"]');

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

    expect(dispatchMock).toHaveBeenCalledWith("settings:write", {
      library: { gridCopyPalette: { anchor: "pinned" } }
    });
    expect(palette?.getAttribute("data-anchor")).toBe("pinned");
    // Dragged spot (palette top 400 + 40px of pointer travel), not the
    // tile-relative one.
    expect(palette?.style.top).toBe("440px");
    expect(
      dispatchMock.mock.calls.filter(
        ([name]) => name === "settings:write"
      )
    ).toHaveLength(1);
  });

  test("📌 toggle flips back to follow and re-anchors to the tile", async () => {
    const el = await renderPalette(imageRecord, { withTile: true });
    const palette = el.querySelector<HTMLElement>('[data-testid="psl-grid-copy-palette"]');
    const toggle = el.querySelector<HTMLButtonElement>(
      '[data-testid="psl-grid-copy-palette-anchor-toggle"]'
    );
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(toggle?.getAttribute("aria-label")).toBe("Follow selection");

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });
    expect(palette?.getAttribute("data-anchor")).toBe("pinned");
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    expect(toggle?.getAttribute("aria-label")).toBe("Stay put");
    expect(dispatchMock).toHaveBeenCalledWith("settings:write", {
      library: { gridCopyPalette: { anchor: "pinned" } }
    });

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });
    expect(palette?.getAttribute("data-anchor")).toBe("follow");
    expect(dispatchMock).toHaveBeenCalledWith("settings:write", {
      library: { gridCopyPalette: { anchor: "follow" } }
    });
    // Re-anchored immediately, back onto the tile.
    expect(palette?.style.top).toBe("232px");
    expect(palette?.style.left).toBe("10px");
  });

  test("hydrates the persisted pinned anchor from settings", async () => {
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "settings:read") {
        return ok({
          ...settings,
          library: {
            ...(settings as unknown as { library: Record<string, unknown> }).library,
            gridCopyPalette: { anchor: "pinned", previewOpen: false }
          }
        });
      }
      if (name === "capture:presetMetrics") return ok({ metrics: [] });
      return ok(undefined);
    });
    const el = await renderPalette(imageRecord, { withTile: true });
    const palette = el.querySelector<HTMLElement>('[data-testid="psl-grid-copy-palette"]');
    expect(palette?.getAttribute("data-anchor")).toBe("pinned");
    // Pinned with no dragged position yet → CSS default, NOT the tile.
    expect(palette?.style.left).toBe("");
  });

  test("preview drawer is collapsed by default and persists when opened", async () => {
    const el = await renderPalette();
    const toggle = el.querySelector<HTMLButtonElement>(
      '[data-testid="psl-grid-copy-palette-preview-toggle"]'
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.getAttribute("aria-label")).toBe("Show preview");
    expect(el.querySelector('[data-testid="psl-grid-copy-palette-preview"]')).toBeNull();

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });

    const drawer = el.querySelector<HTMLElement>(
      '[data-testid="psl-grid-copy-palette-preview"]'
    );
    expect(drawer).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.getAttribute("aria-label")).toBe("Hide preview");
    // The chevron drives the drawer via aria-controls.
    expect(toggle?.getAttribute("aria-controls")).toBe(drawer?.id);
    // Image capture → a contain-fit cache thumbnail, not the full-res
    // capture protocol.
    const img = drawer?.querySelector<HTMLImageElement>("img");
    expect(img?.getAttribute("src")).toContain("pwrsnap-cache://r/cap_image/800w.webp");
    expect(dispatchMock).toHaveBeenCalledWith("settings:write", {
      library: { gridCopyPalette: { previewOpen: true } }
    });

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="psl-grid-copy-palette-preview"]')).toBeNull();
    expect(dispatchMock).toHaveBeenCalledWith("settings:write", {
      library: { gridCopyPalette: { previewOpen: false } }
    });
  });

  test("preview drawer hydrates open from settings and shows video inline", async () => {
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "settings:read") {
        return ok({
          ...settings,
          library: {
            ...(settings as unknown as { library: Record<string, unknown> }).library,
            gridCopyPalette: { anchor: "follow", previewOpen: true }
          }
        });
      }
      if (name === "video:presetMetrics") return ok({ metrics: [] });
      return ok(undefined);
    });
    const el = await renderPalette(videoRecord);
    const drawer = el.querySelector<HTMLElement>(
      '[data-testid="psl-grid-copy-palette-preview"]'
    );
    expect(drawer).not.toBeNull();
    const video = drawer?.querySelector<HTMLVideoElement>("video");
    expect(video?.getAttribute("src")).toBe("pwrsnap-capture://r/cap_video");
    expect(video?.hasAttribute("muted") || video?.muted).toBeTruthy();
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

// Pure placement math — exercised directly so the flip order is pinned
// down without a DOM. Stage is 800x600 at the origin unless stated;
// the palette is 360x90; gap 12, margin 8.
describe("resolveFollowAnchor", () => {
  const stage = box(0, 0, 800, 600);
  const palette = box(0, 0, 360, 90);

  test("prefers below the tile, horizontally centered", () => {
    const r = resolveFollowAnchor({ stage, tile: box(200, 100, 180, 120), palette });
    expect(r).toEqual({ x: 110, y: 232, placement: "below" });
  });

  test("flips above when below would clip the stage bottom", () => {
    // Tile bottom 560 → below would need 560 + 12 + 90 = 662 > 592.
    const r = resolveFollowAnchor({ stage, tile: box(200, 440, 180, 120), palette });
    expect(r?.placement).toBe("above");
    expect(r?.y).toBe(440 - 12 - 90);
  });

  test("flips to the side when neither below nor above fits", () => {
    // Tall tile spanning most of the stage: no room above or below.
    const r = resolveFollowAnchor({ stage, tile: box(60, 20, 180, 560), palette });
    expect(r?.placement).toBe("right");
    expect(r?.x).toBe(60 + 180 + 12);
  });

  test("flips to the left when the right side would clip", () => {
    const r = resolveFollowAnchor({ stage, tile: box(440, 20, 180, 560), palette });
    expect(r?.placement).toBe("left");
    expect(r?.x).toBe(440 - 12 - 360);
  });

  test("clamps a centered placement into the stage at the left edge", () => {
    // Tile at x=0 → centered left would be -135; clamps to the margin.
    const r = resolveFollowAnchor({ stage, tile: box(0, 100, 90, 120), palette });
    expect(r?.x).toBe(8);
  });

  test("clamps a centered placement into the stage at the right edge", () => {
    const r = resolveFollowAnchor({ stage, tile: box(710, 100, 90, 120), palette });
    expect(r?.x).toBe(800 - 360 - 8);
  });

  test("returns stage-relative coordinates for an offset stage", () => {
    const r = resolveFollowAnchor({
      stage: box(240, 60, 800, 600),
      tile: box(440, 160, 180, 120),
      palette
    });
    expect(r).toEqual({ x: 110, y: 232, placement: "below" });
  });

  test("falls back to the roomier side when nothing fits, staying on-stage", () => {
    const r = resolveFollowAnchor({ stage, tile: box(0, 0, 800, 600), palette });
    expect(r).not.toBeNull();
    expect(r?.x).toBeGreaterThanOrEqual(8);
    expect(r?.x).toBeLessThanOrEqual(800 - 360 - 8);
    expect(r?.y).toBeGreaterThanOrEqual(8);
    expect(r?.y).toBeLessThanOrEqual(600 - 90 - 8);
  });

  test("returns null for a zero-area stage", () => {
    expect(
      resolveFollowAnchor({ stage: box(0, 0, 0, 0), tile: box(0, 0, 10, 10), palette })
    ).toBeNull();
  });
});
