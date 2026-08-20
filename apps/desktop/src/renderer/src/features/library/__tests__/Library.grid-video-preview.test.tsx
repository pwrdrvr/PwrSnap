// Grid video-tile previews must stop when the grid pane hides.
//
// The grid stays MOUNTED under `display: none` while Focus (or Reel)
// mode is open — that's deliberate (scroll position + virtualizer
// state). But Chromium keeps DECODING a playing muted <video> at full
// frame rate under a display:none ancestor: element visibility is not
// part of its media-suspension logic, only page visibility, and
// PwrSnap disables backgroundThrottling app-wide so the page always
// reports visible. Opening Focus from a hovered tile (Enter or
// double-click — no mousemove, so Chromium never recomputes :hover or
// fires mouseleave on the hidden cell) previously left the hover
// preview silently decoding a screen recording for the whole Focus
// session. Measured at 30fps decode under display:none — see
// docs/solutions/2026-08-20-hidden-grid-video-decode.md.
//
// The load-bearing assertions: entering Focus pauses a playing
// preview WITHOUT any mouse event, hidden tiles refuse to start
// playing, and returning to grid does not auto-resume a stale hover.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, DraftCart, Settings } from "@pwrsnap/shared";

const dispatchMock = vi.fn();
const subscribeMock = vi.fn((_channel: string, _handler: (payload: unknown) => void) => {
  return () => undefined;
});

vi.mock("../../../lib/pwrsnap", () => ({
  cacheUrl: (id: string) => `pwrsnap-cache://${id}`,
  captureSrcUrl: (id: string) => `pwrsnap-capture://${id}`,
  dispatch: (...args: unknown[]) => dispatchMock(...args),
  perfMark: vi.fn(),
  sizzleOutputUrl: (id: string) => `pwrsnap-sizzle://${id}`,
  subscribe: (...args: unknown[]) =>
    subscribeMock(args[0] as string, args[1] as (payload: unknown) => void)
}));

vi.mock("@tanstack/react-virtual", () => ({
  defaultRangeExtractor: (range: { startIndex: number; endIndex: number }) =>
    Array.from(
      { length: Math.max(0, range.endIndex - range.startIndex + 1) },
      (_, i) => range.startIndex + i
    ),
  useVirtualizer: (options: { count: number }) => ({
    getTotalSize: () => options.count * 120,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * 120
      })),
    measureElement: vi.fn(),
    shouldAdjustScrollPositionOnItemSizeChange: () => false
  })
}));

vi.mock("../../editor/useEditorToolState", () => ({
  useEditorToolState: () => ({
    activeTool: "pointer",
    activeStyle: { tool: "pointer" },
    setActiveTool: vi.fn(),
    isSingleShot: false,
    matchingText: { kind: "idle" },
    onAnnotationPlaced: vi.fn(),
    armMatchingText: vi.fn(),
    dismissMatchingText: vi.fn(),
    updateActiveStyle: vi.fn()
  })
}));

vi.mock("../Stage", () => ({
  Stage: ({ record }: { record: CaptureRecord }): ReactElement => (
    <div data-testid="library-stage" data-capture-id={record.id} />
  )
}));

vi.mock("../DetailRail", () => ({
  DetailRail: ({ record }: { record: CaptureRecord | null }): ReactElement | null =>
    record === null ? null : <aside data-testid="detail-rail" data-capture-id={record.id} />
}));

import { CartProvider } from "../CartContext";
import { Library } from "../Library";

let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;

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
  Element.prototype.scrollIntoView = vi.fn();
  if (typeof globalThis.requestAnimationFrame !== "function") {
    (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (
      cb: FrameRequestCallback
    ) => setTimeout(() => cb(0), 0) as unknown as number;
  }
  // jsdom's HTMLMediaElement stubs `currentTime` with a not-implemented
  // throw; the hover effect assigns it around every play/pause.
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    get(this: { __ct?: number }) {
      return this.__ct ?? 0;
    },
    set(this: { __ct?: number }, value: number) {
      this.__ct = value;
    }
  });
});

const videoRecord: CaptureRecord = {
  id: "cap_video",
  kind: "video",
  captured_at: "2026-05-15T18:24:00.000Z",
  legacy_src_path: "/tmp/cap_video.mp4",
  bundle_path: null,
  flat_png_path: null,
  bundle_modified_at: null,
  bundle_format_version: 1,
  bundle_edits_version: 0,
  width_px: 1200,
  height_px: 800,
  device_pixel_ratio: 2,
  byte_size: 5_000_000,
  sha256: "sha_cap_video",
  source_app_bundle_id: "com.example.app",
  source_app_name: "Example",
  edits_version: 0,
  has_alpha: false,
  deleted_at: null,
  video: {
    durationSec: 12,
    containerFormat: "mp4",
    hasSystemAudio: false,
    hasMicrophoneAudio: false,
    defaultRange: { start: 0, end: 12 },
    previewPath: null,
    previewStatus: "pending"
  }
};

const settings = {
  hotkeys: {
    quickCapture: "",
    region: "",
    window: "",
    fullScreen: "",
    allScreens: "",
    timed: "",
    videoCapture: "",
    reshowFloatOver: ""
  },
  ai: {
    enabled: false,
    consentAcceptedAt: null,
    defaults: { enrichment: {} }
  },
  library: {
    confirmBeforeTrash: true,
    detailRail: {
      pinned: true,
      lastSelectedTab: "info"
    }
  }
} as unknown as Settings;

function ok<T>(value: T) {
  return { ok: true as const, value };
}

const emptyCart: DraftCart = {
  name: "Untitled draft",
  captureIds: [],
  createdAt: "2026-05-15T18:00:00.000Z",
  modifiedAt: "2026-05-15T18:00:00.000Z"
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  playSpy = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(async function (this: HTMLMediaElement) {
      /* pretend playback started */
    }) as unknown as ReturnType<typeof vi.spyOn>;
  pauseSpy = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(function (this: HTMLMediaElement) {
      /* pretend playback stopped */
    }) as unknown as ReturnType<typeof vi.spyOn>;
  dispatchMock.mockImplementation(async (name: string) => {
    if (name === "library:list") {
      return ok({
        rows: [videoRecord],
        nextCursor: null,
        appStats: [],
        totalLive: 1
      });
    }
    if (name === "settings:read") return ok(settings);
    if (name === "settings:refreshCodexDiscovery") {
      return ok({ resolvedPath: null, auth: null, candidates: [] });
    }
    if (name === "storage:summary") {
      return ok({
        capturedAt: "2026-05-15T18:24:00.000Z",
        sourceCaptures: { bytes: videoRecord.byte_size, captureCount: 1 }
      });
    }
    if (name === "sizzle:list") return ok({ projects: [] });
    if (name === "app:version") return ok({ version: "0.0.0-test" });
    if (name === "cart:get" || name === "cart:toggle") return ok(emptyCart);
    return ok(undefined);
  });
  subscribeMock.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  dispatchMock.mockReset();
  playSpy.mockRestore();
  pauseSpy.mockRestore();
});

async function renderLibrary(): Promise<void> {
  await act(async () => {
    root?.render(createElement(CartProvider, null, createElement(Library)));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function cellEl(): HTMLElement {
  const cell = container?.querySelector<HTMLElement>('[data-cell-id="cap_video"]');
  expect(cell).not.toBeNull();
  return cell as HTMLElement;
}

function gridTileVideo(): HTMLVideoElement {
  // The tile video lives inside the cell; the Stage is mocked, so this
  // is the only <video> in the tree.
  const video = cellEl().querySelector<HTMLVideoElement>("video");
  expect(video).not.toBeNull();
  return video as HTMLVideoElement;
}

function libraryMode(): string | null {
  return container?.querySelector(".psl")?.getAttribute("data-mode") ?? null;
}

async function hoverCell(): Promise<void> {
  await act(async () => {
    cellEl().dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await Promise.resolve();
  });
}

async function openFocusViaDblclick(): Promise<void> {
  await act(async () => {
    cellEl().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  expect(libraryMode()).toBe("focus");
}

async function closeFocusViaEscape(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
  expect(libraryMode()).toBe("grid");
}

describe("grid video preview vs hidden grid", () => {
  test("hovering a video tile in grid mode starts the preview", async () => {
    await renderLibrary();
    expect(libraryMode()).toBe("grid");
    gridTileVideo();

    await hoverCell();
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  test("opening Focus pauses a playing preview without any mouse event", async () => {
    await renderLibrary();
    await hoverCell();
    expect(playSpy).toHaveBeenCalledTimes(1);
    pauseSpy.mockClear();

    // Double-click opens Focus. No mouseleave is dispatched — exactly the
    // real-world sequence where Chromium leaves :hover latched on the now
    // display:none cell and the preview would keep decoding.
    await openFocusViaDblclick();
    expect(pauseSpy).toHaveBeenCalled();
    // And the pause is the FINAL word — no play call sneaks in after it.
    const lastPlay = playSpy.mock.invocationCallOrder.at(-1) ?? 0;
    const lastPause = pauseSpy.mock.invocationCallOrder.at(-1) ?? 0;
    expect(lastPause).toBeGreaterThan(lastPlay);
  });

  test("a hidden tile refuses to start playing", async () => {
    await renderLibrary();
    await openFocusViaDblclick();
    playSpy.mockClear();

    // Synthetic hover while the grid is display:none (e.g. stray enter
    // events). Playback must not start.
    await hoverCell();
    expect(playSpy).not.toHaveBeenCalled();
  });

  test("returning to grid does not auto-resume the stale hover preview", async () => {
    await renderLibrary();
    await hoverCell();
    await openFocusViaDblclick();
    playSpy.mockClear();

    await closeFocusViaEscape();
    // The hover latch was dropped on hide; only a fresh mouseenter may
    // start playback again.
    expect(playSpy).not.toHaveBeenCalled();

    await hoverCell();
    expect(playSpy).toHaveBeenCalledTimes(1);
  });
});
