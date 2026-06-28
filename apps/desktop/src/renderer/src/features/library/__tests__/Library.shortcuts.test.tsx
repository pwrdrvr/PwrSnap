import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from "vitest";
import type { CaptureRecord, Settings } from "@pwrsnap/shared";

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

import { Library } from "../Library";

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
  deleted_at: null
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
    detailRail: {
      pinned: true,
      lastSelectedTab: "info"
    }
  }
} as unknown as Settings;

function ok<T>(value: T) {
  return { ok: true as const, value };
}

beforeEach(() => {
  vi.useFakeTimers();
  dispatchMock.mockImplementation(async (name: string) => {
    if (name === "library:list") {
      return ok({
        rows: [imageRecord],
        nextCursor: null,
        appStats: [],
        totalLive: 1
      });
    }
    if (name === "settings:read") return ok(settings);
    if (name === "settings:refreshCodexDiscovery") {
      return ok({
        resolvedPath: null,
        auth: null,
        candidates: []
      });
    }
    if (name === "storage:summary") {
      return ok({
        capturedAt: "2026-05-15T18:24:00.000Z",
        sourceCaptures: { bytes: imageRecord.byte_size, captureCount: 1 }
      });
    }
    if (name === "sizzle:list") return ok({ projects: [] });
    if (name === "app:version") return ok({ version: "0.0.0-test" });
    if (name === "clipboard:copy") return ok(undefined);
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
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  dispatchMock.mockReset();
});

describe("Library keyboard shortcuts", () => {
  test("copies image shortcut presets as image bytes (clipboard:copy), matching the card body", async () => {
    await act(async () => {
      root?.render(createElement(Library));
      await Promise.resolve();
      await Promise.resolve();
    });

    const cell = container?.querySelector<HTMLElement>('[data-cell-id="cap_image"]');
    expect(cell).not.toBeNull();

    // Double-click to open the editor (single-click now only selects), so
    // the ⌘1/2/3 copy shortcuts — gated to focus/reel — are live.
    await act(async () => {
      cell?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(container?.querySelector('[data-testid="library-stage"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "2",
          metaKey: true,
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });

    expect(dispatchMock).toHaveBeenCalledWith("clipboard:copy", {
      captureId: "cap_image",
      preset: "med"
    });
    expect(dispatchMock.mock.calls.some(([name]) => name === "clipboard:copy-file")).toBe(false);
  });
});

describe("Library grid select vs edit", () => {
  async function renderLibrary(): Promise<void> {
    await act(async () => {
      root?.render(createElement(Library));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function cellEl(): HTMLElement | null {
    return container?.querySelector<HTMLElement>('[data-cell-id="cap_image"]') ?? null;
  }

  function hasStage(): boolean {
    return container?.querySelector('[data-testid="library-stage"]') !== null;
  }

  test("single click selects the tile without opening the editor", async () => {
    await renderLibrary();
    expect(cellEl()).not.toBeNull();

    await act(async () => {
      cellEl()?.click();
      await Promise.resolve();
    });

    // No takeover…
    expect(hasStage()).toBe(false);
    // …but the tile is selected (the inspector-feeding ring).
    expect(cellEl()?.classList.contains("is-selected")).toBe(true);
  });

  test("double-click opens the editor", async () => {
    await renderLibrary();

    await act(async () => {
      cellEl()?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(hasStage()).toBe(true);
  });

  test("the real click→click→dblclick sequence lands in the editor", async () => {
    // Browsers fire click, click, dblclick for a double-click: the first
    // click SELECTs (history:replace), the dblclick EDITs. Verify the
    // sequence ends in the editor rather than getting stuck on select.
    await renderLibrary();

    await act(async () => {
      cellEl()?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      cellEl()?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      cellEl()?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(hasStage()).toBe(true);
  });

  test("Enter on the selected tile opens the editor", async () => {
    await renderLibrary();

    await act(async () => {
      cellEl()?.click();
      await Promise.resolve();
    });
    expect(hasStage()).toBe(false);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      );
      await Promise.resolve();
    });

    expect(hasStage()).toBe(true);
  });

  test("Enter with nothing selected is a no-op", async () => {
    await renderLibrary();
    expect(hasStage()).toBe(false);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      );
      await Promise.resolve();
    });

    expect(hasStage()).toBe(false);
  });

  test("an arrow key in grid moves the selection (and doesn't open the editor)", async () => {
    await renderLibrary();
    expect(cellEl()?.classList.contains("is-selected")).toBe(false);

    // Nothing selected yet → the first arrow enters from an end and
    // selects a tile, staying in grid.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })
      );
      await Promise.resolve();
    });

    expect(cellEl()?.classList.contains("is-selected")).toBe(true);
    expect(hasStage()).toBe(false);
  });

  test("the hover Edit CTA opens the editor", async () => {
    await renderLibrary();
    const editBtn = container?.querySelector<HTMLElement>(".psl__cell-edit");
    expect(editBtn).not.toBeNull();

    await act(async () => {
      editBtn?.click();
      await Promise.resolve();
    });

    expect(hasStage()).toBe(true);
  });
});
