// The search chip in the composed-query row.
//
// Search used to live ONLY in the top-right search box, while every
// sidebar facet got a removable chip above the grid — so a query that
// hid 3600 captures was the least visible narrowing on screen, and the
// row's "Clear" cleared the facets while silently leaving the query in
// place (chips vanish, grid stays narrowed: the button reads broken).
//
// What's protected here:
//   1. An active search renders a chip in the row, ahead of the facets.
//   2. The chip's × clears the search box.
//   3. "Clear" clears the search AND the facets.
//   4. No query ⇒ no chip (the neutral Library gains no chrome).

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
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
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  window.matchMedia = ((query: string) => {
    const maxWidth = /\(max-width:\s*(\d+)px\)/.exec(query);
    const matches = maxWidth !== null ? window.innerWidth <= Number(maxWidth[1]) : false;
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
  source_window_title: null,
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
  dispatchMock.mockImplementation(async (name: string) => {
    if (name === "library:list") {
      return ok({
        rows: [imageRecord],
        nextCursor: null,
        appStats: [],
        totalLive: 1
      });
    }
    if (name === "library:search") {
      return ok({ rows: [{ record: imageRecord }] });
    }
    if (name === "settings:read") return ok(settings);
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
    if (name === "capture:presetMetrics") return ok({ metrics: [] });
    return ok(undefined);
  });
  subscribeMock.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  dispatchMock.mockReset();
});

async function renderLibrary(): Promise<void> {
  await act(async () => {
    root?.render(createElement(Library));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function searchInput(): HTMLInputElement {
  const el = container?.querySelector<HTMLInputElement>(".psl__search");
  if (el === null || el === undefined) throw new Error("search input not rendered");
  return el;
}

/** React tracks the last value it wrote on the DOM node, so a plain
 *  `el.value = x` + input event is swallowed as a no-op. Go through the
 *  native setter the way React's own test utils do. */
async function typeSearch(value: string): Promise<void> {
  const input = searchInput();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  await act(async () => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

function chips(): { kind: string; label: string }[] {
  return Array.from(container?.querySelectorAll<HTMLElement>(".psl__chip") ?? []).map((el) => ({
    kind: el.dataset.chipKind ?? "",
    label: el.querySelector(".psl__chip-label")?.textContent ?? ""
  }));
}

async function clickTypeRow(label: string): Promise<void> {
  const row = Array.from(
    container?.querySelectorAll<HTMLElement>(".psl__facet-row") ?? []
  ).find((el) => el.querySelector(".psl__nav-label")?.textContent === label);
  if (row === undefined) throw new Error(`type row not found: ${label}`);
  await act(async () => {
    row?.click();
    await Promise.resolve();
  });
}

describe("Library search chip", () => {
  test("no chip row with no query and no facets", async () => {
    await renderLibrary();
    expect(container?.querySelector(".psl__chips")).toBeNull();
  });

  test("an active search renders a chip in the row", async () => {
    await renderLibrary();
    await typeSearch("star map");

    expect(chips()).toEqual([{ kind: "search", label: "star map" }]);
  });

  test("the search chip's × clears the query", async () => {
    await renderLibrary();
    await typeSearch("star map");

    const x = container?.querySelector<HTMLButtonElement>(
      '.psl__chip[data-chip-kind="search"] .psl__chip-x'
    );
    expect(x).not.toBeNull();
    await act(async () => {
      x?.click();
      await Promise.resolve();
    });

    expect(searchInput().value).toBe("");
    expect(container?.querySelector(".psl__chips")).toBeNull();
  });

  test("Clear clears the search as well as the facets", async () => {
    await renderLibrary();
    await clickTypeRow("Images");
    await typeSearch("star map");

    expect(chips().map((c) => c.kind)).toEqual(["search", "type"]);

    const clear = container?.querySelector<HTMLButtonElement>(".psl__chips-clear");
    await act(async () => {
      clear?.click();
      await Promise.resolve();
    });

    expect(searchInput().value).toBe("");
    expect(container?.querySelector(".psl__chips")).toBeNull();
  });
});
