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
import type { AppRuntimeIdentity, CaptureRecord, Settings } from "@pwrsnap/shared";

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
  startCaptureDrag: vi.fn(),
  startVideoDrag: vi.fn(),
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
  // Keep the Library rail from auto-collapsing: jsdom's default viewport
  // is often 1024px (`narrow` in useToolbarTier). Tests that assert the
  // 360px pinned column need a wide window; the occupancy test below
  // overrides innerWidth to cover ≤1024px.
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  window.matchMedia = ((query: string) => {
    const maxWidth = /\(max-width:\s*(\d+)px\)/.exec(query);
    const matches =
      maxWidth !== null ? window.innerWidth <= Number(maxWidth[1]) : false;
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false
    };
  }) as typeof window.matchMedia;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let appVersionInfo: {
  version: string;
  runtimeIdentity?: AppRuntimeIdentity;
};

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
  appVersionInfo = { version: "0.0.0-test" };
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
    if (name === "app:version") return ok(appVersionInfo);
    if (name === "clipboard:copy") return ok(undefined);
    if (name === "clipboard:copy-path") return ok(undefined);
    if (name === "capture:presetMetrics") return ok({ metrics: [] });
    return ok(undefined);
  });
  subscribeMock.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

describe("Library runtime footer", () => {
  test("shows the Git branch for a development checkout", async () => {
    appVersionInfo = {
      version: "0.0.0-test",
      runtimeIdentity: {
        branch: "agent/show-dev-git-branch",
        cwd: "/repo/PwrSnap"
      }
    };

    await act(async () => {
      root?.render(createElement(Library));
      await Promise.resolve();
      await Promise.resolve();
    });

    const label = container?.querySelector<HTMLElement>(".psl__runtime-label");
    expect(label?.textContent).toBe("agent/show-dev-git-branch");
    expect(label?.title).toBe("agent/show-dev-git-branch");
  });

  test("keeps showing the package version without a development checkout", async () => {
    await act(async () => {
      root?.render(createElement(Library));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.querySelector(".psl__runtime-label")?.textContent).toBe("v0.0.0-test");
  });
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
    // Default pinned Grid auto-selects the first tile. Use the unpinned
    // path so this case still has a genuine empty selection.
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:list") {
        return ok({
          rows: [imageRecord],
          nextCursor: null,
          appStats: [],
          totalLive: 1
        });
      }
      if (name === "settings:read") {
        return ok({
          ...settings,
          library: {
            ...settings.library,
            detailRail: { pinned: false, lastSelectedTab: "info" }
          }
        });
      }
      if (name === "settings:refreshCodexDiscovery") {
        return ok({ resolvedPath: null, auth: null, candidates: [] });
      }
      if (name === "storage:summary") {
        return ok({
          capturedAt: "2026-05-15T18:24:00.000Z",
          sourceCaptures: { bytes: imageRecord.byte_size, captureCount: 1 }
        });
      }
      if (name === "sizzle:list") return ok({ projects: [] });
      if (name === "app:version") return ok({ version: "0.0.0-test" });
      return ok(undefined);
    });
    await renderLibrary();
    expect(cellEl()?.classList.contains("is-selected")).toBe(false);
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
    // Pinned Grid default-selects the first (only) tile on open.
    expect(cellEl()?.classList.contains("is-selected")).toBe(true);

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

describe("Library grid selection does not reflow the inspector column", () => {
  async function renderLibrary(pinned: boolean): Promise<void> {
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:list") {
        return ok({
          rows: [imageRecord],
          nextCursor: null,
          appStats: [],
          totalLive: 1
        });
      }
      if (name === "settings:read") {
        return ok({
          ...settings,
          library: {
            ...settings.library,
            detailRail: { pinned, lastSelectedTab: "info" }
          }
        });
      }
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
      if (name === "clipboard:copy-path") return ok(undefined);
      if (name === "capture:presetMetrics") return ok({ metrics: [] });
      return ok(undefined);
    });
    await act(async () => {
      root?.render(createElement(Library));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function psl(): HTMLElement | null {
    return container?.querySelector<HTMLElement>(".psl") ?? null;
  }

  function cellEl(): HTMLElement | null {
    return container?.querySelector<HTMLElement>('[data-cell-id="cap_image"]') ?? null;
  }

  test("pinned: opening Grid default-selects the first visible capture", async () => {
    await renderLibrary(true);
    expect(cellEl()?.classList.contains("is-selected")).toBe(true);
    expect(psl()?.getAttribute("data-right")).toBe("pinned");
    expect(container?.querySelector('[data-testid="library-stage"]')).toBeNull();
  });

  test("pinned: selecting a tile updates in place and does not change data-right", async () => {
    await renderLibrary(true);
    const before = psl()?.getAttribute("data-right") ?? null;
    expect(before).toBe("pinned");
    expect(cellEl()?.classList.contains("is-selected")).toBe(true);
    expect(container?.querySelector('[data-testid="psl-grid-copy-palette"]')).toBeNull();

    await act(async () => {
      cellEl()?.click();
      await Promise.resolve();
    });

    expect(cellEl()?.classList.contains("is-selected")).toBe(true);
    expect(psl()?.getAttribute("data-right") ?? null).toBe(before);
    expect(container?.querySelector('[data-testid="library-stage"]')).toBeNull();
    // Footer lives on the inspector; the overlay stays out of the way.
    expect(container?.querySelector('[data-testid="psl-grid-copy-palette"]')).toBeNull();
  });

  test("unpinned: selecting a tile does not open the sidebar or change data-right", async () => {
    await renderLibrary(false);
    const before = psl()?.getAttribute("data-right") ?? null;
    expect(before).toBeNull();
    expect(cellEl()?.classList.contains("is-selected")).toBe(false);

    await act(async () => {
      cellEl()?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(cellEl()?.classList.contains("is-selected")).toBe(true);
    expect(psl()?.getAttribute("data-right") ?? null).toBeNull();
    expect(container?.querySelector('[data-testid="library-stage"]')).toBeNull();
    expect(container?.querySelector('[data-testid="psl-grid-copy-palette"]')).not.toBeNull();
  });

  test("unpinned: palette copy + ⌘2 use clipboard:copy for the selected tile", async () => {
    await renderLibrary(false);

    await act(async () => {
      cellEl()?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const med = Array.from(
      container?.querySelectorAll<HTMLButtonElement>(".fo__copy-btn") ?? []
    )[1];
    expect(med).not.toBeUndefined();
    dispatchMock.mockClear();

    await act(async () => {
      med?.click();
      await Promise.resolve();
    });
    expect(dispatchMock).toHaveBeenCalledWith("clipboard:copy", {
      captureId: "cap_image",
      preset: "med"
    });

    dispatchMock.mockClear();
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
  });

  test("layout toggle still opens the inspector after a closed-sidebar select", async () => {
    await renderLibrary(false);

    await act(async () => {
      cellEl()?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container?.querySelector('[data-testid="psl-grid-copy-palette"]')).not.toBeNull();

    const toggle = container?.querySelector<HTMLButtonElement>(
      '[data-testid="psl-layout-toggle-secondary"]'
    );
    expect(toggle).not.toBeNull();

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(psl()?.getAttribute("data-right")).toBe("pinned");
    expect(container?.querySelector('[data-testid="psl-grid-copy-palette"]')).toBeNull();
    expect(container?.querySelector('[data-testid="detail-rail"]')).not.toBeNull();
  });

  test("pinned narrow Grid keeps the collapsed spine and default-selects", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    try {
      await renderLibrary(true);
      expect(cellEl()?.classList.contains("is-selected")).toBe(true);
      // Pin intent still occupies the column; width is the 38px hover-pop
      // spine, not a hidden rail and not a 360px reflow.
      expect(psl()?.getAttribute("data-right")).toBe("collapsed");
      expect(container?.querySelector('[data-testid="detail-rail"]')).not.toBeNull();
      expect(container?.querySelector('[data-testid="library-stage"]')).toBeNull();
      // Collapsed footer is hidden, so the floating copy palette stays up.
      expect(container?.querySelector('[data-testid="psl-grid-copy-palette"]')).not.toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    }
  });
});
