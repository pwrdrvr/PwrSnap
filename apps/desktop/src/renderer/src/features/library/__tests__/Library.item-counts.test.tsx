// Item counts across the sidebar, the day headers, and the topbar.
//
// The Library grid renders Sizzle Reels projects INLINE with captures —
// they are cells in the same day buckets, and the day header counts
// them. So every count that labels the grid has to count them too.
//
// The regression this pins: the sidebar's Today badge counted only
// captures, while the grid it opens (and the topbar count above it)
// counted captures + projects. Create a reel today and the sidebar said
// 7 while the view said 8. `library:counts` cannot fix this on its own —
// projects live outside the captures table entirely, so the bus number
// is captures-only by construction and the renderer has to add them.
//
// What is protected here:
//   1. Today badge == the Today day-header count == the topbar count.
//   2. All Captures == Images + Videos + Projects (the sidebar sums).
//   3. A project created on an older day does NOT inflate Today.

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


// ── Fixtures ────────────────────────────────────────────────────────
//
// "Today" has to be computed relative to the clock the component reads,
// not hard-coded, because the day bucket is a LOCAL-day comparison.

function isoAt(daysAgo: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function imageRecord(id: string, capturedAt: string): CaptureRecord {
  return {
    id,
    kind: "image",
    captured_at: capturedAt,
    legacy_src_path: `/tmp/${id}.png`,
    bundle_path: null,
    flat_png_path: null,
    bundle_modified_at: null,
    bundle_format_version: 2,
    bundle_edits_version: 0,
    width_px: 1200,
    height_px: 800,
    device_pixel_ratio: 2,
    byte_size: 100_000,
    sha256: `sha_${id}`,
    source_app_bundle_id: "com.example.app",
    source_app_name: "Example",
    edits_version: 0,
    has_alpha: false,
    deleted_at: null
  };
}

function project(id: string, createdAt: string) {
  return {
    id,
    name: `Reel ${id}`,
    createdAt,
    modifiedAt: createdAt,
    deletedAt: null,
    scenes: [],
    sequence: [],
    audio: null,
    render: null
  };
}

// Two captures today, one yesterday, one dated tomorrow; one reel today
// and one last week. So: Today = 2 captures + 1 reel = 3 (the future
// capture is NOT today). All = 4 captures + 2 reels = 6.
const TODAY_CAPTURES = [
  imageRecord("cap_today_a", isoAt(0, 9)),
  imageRecord("cap_today_b", isoAt(0, 11))
];
const OLDER_CAPTURES = [imageRecord("cap_older", isoAt(1, 9))];
// Dated into the future — a clock skew or an imported bundle. The grid
// buckets it under tomorrow's day header, so no Today count may include
// it. Present specifically to catch a Today predicate that has a lower
// bound and no upper one.
const FUTURE_CAPTURES = [imageRecord("cap_future", isoAt(-1, 9))];
const ALL_CAPTURES = [...FUTURE_CAPTURES, ...TODAY_CAPTURES, ...OLDER_CAPTURES];
const PROJECTS = [project("proj_today", isoAt(0, 10)), project("proj_older", isoAt(7, 10))];

/** Stand-in for `countCaptures`, honoring the fields this spec exercises. */
function countSeeded(req: {
  scope?: "live" | "trash";
  kinds?: Array<"image" | "video">;
  capturedAtStart?: string;
  capturedAtEnd?: string;
}): number {
  if (req.scope === "trash") return 0;
  let rows = ALL_CAPTURES;
  if (req.kinds !== undefined) rows = rows.filter((r) => req.kinds?.includes(r.kind) ?? false);
  if (req.capturedAtStart !== undefined) {
    const start = req.capturedAtStart;
    rows = rows.filter((r) => r.captured_at >= start);
  }
  // Exclusive, matching countCaptures. Honoring this is what lets the
  // future-dated fixture below catch a start-only Today predicate.
  if (req.capturedAtEnd !== undefined) {
    const end = req.capturedAtEnd;
    rows = rows.filter((r) => r.captured_at < end);
  }
  return rows.length;
}

beforeEach(() => {
  vi.useFakeTimers();
  dispatchMock.mockImplementation(async (name: string, req: unknown) => {
    if (name === "library:list") {
      return ok({
        rows: ALL_CAPTURES,
        nextCursor: null,
        appStats: [
          { bundleId: "com.example.app", count: ALL_CAPTURES.length, sourceAppName: "Example" }
        ],
        totalLive: ALL_CAPTURES.length,
        kindStats: [{ kind: "image", count: ALL_CAPTURES.length }],
        trashTotal: 0
      });
    }
    if (name === "library:counts") {
      return ok({ total: countSeeded(req as Parameters<typeof countSeeded>[0]) });
    }
    if (name === "settings:read") return ok(settings);
    if (name === "settings:refreshCodexDiscovery") {
      return ok({ resolvedPath: null, auth: null, candidates: [] });
    }
    if (name === "storage:summary") {
      return ok({
        capturedAt: isoAt(0, 12),
        sourceCaptures: { bytes: 400_000, captureCount: ALL_CAPTURES.length }
      });
    }
    if (name === "sizzle:list") return ok({ projects: PROJECTS });
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
    await Promise.resolve();
  });
}

/** The trailing count on a sidebar row, looked up by its visible label. */
function navCount(label: string): number {
  const row = Array.from(container?.querySelectorAll<HTMLElement>(".psl__nav") ?? []).find(
    (el) => el.querySelector(".psl__nav-label")?.textContent === label
  );
  if (row === undefined) throw new Error(`sidebar row not found: ${label}`);
  const text = row.querySelector(".psl__nav-count")?.textContent ?? "";
  if (text === "") throw new Error(`sidebar row has no count: ${label}`);
  return Number(text);
}

async function clickNav(label: string): Promise<void> {
  const row = Array.from(container?.querySelectorAll<HTMLElement>(".psl__nav") ?? []).find(
    (el) => el.querySelector(".psl__nav-label")?.textContent === label
  );
  if (row === undefined) throw new Error(`sidebar row not found: ${label}`);
  await act(async () => {
    row.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** `{ Today: 3, Yesterday: 1 }` — what the grid's day banners claim. */
function dayHeaderCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const hdr of container?.querySelectorAll<HTMLElement>(".psl__day-hdr") ?? []) {
    const day = hdr.querySelector(".psl__day-hdr-label")?.textContent ?? "";
    const meta = hdr.querySelector(".psl__day-hdr-meta")?.textContent ?? "";
    const n = /(\d+)\s+captures/.exec(meta);
    if (n?.[1] !== undefined) out[day] = Number(n[1]);
  }
  return out;
}

/** Leading integer of the topbar badge — "3 of 5" and "5 captures". */
function topbarCount(): number {
  const text = container?.querySelector(".psl__count")?.textContent ?? "";
  const n = /(\d+)/.exec(text);
  if (n?.[1] === undefined) throw new Error(`topbar count not numeric: "${text}"`);
  return Number(n[1]);
}

describe("Library item counts", () => {
  test("the Today badge counts reels created today, like the grid it opens", async () => {
    // The reported bug: 2 captures + 1 reel today, sidebar said 2.
    await renderLibrary();
    expect(navCount("Today")).toBe(3);
  });

  test("Today badge, day header, and topbar agree once Today is selected", async () => {
    await renderLibrary();
    await clickNav("Today");

    const badge = navCount("Today");
    expect(badge).toBe(3);
    expect(dayHeaderCounts().Today).toBe(badge);
    expect(topbarCount()).toBe(badge);
  });

  test("a reel created on an older day does not inflate Today", async () => {
    // `proj_older` is 7 days back; only `proj_today` may count.
    await renderLibrary();
    expect(navCount("Today")).toBe(3);
    expect(dayHeaderCounts().Today).toBe(3);
  });

  test("a capture dated into the future is not counted as Today", async () => {
    // Today is a half-open [start, end) interval. With a lower bound
    // only, `cap_future` would inflate the badge to 4 while the Today
    // day header stayed at 3 — the same badge-vs-grid contradiction
    // the reel bug produced, from the other direction.
    await renderLibrary();
    await clickNav("Today");

    expect(navCount("Today")).toBe(3);
    expect(dayHeaderCounts().Today).toBe(3);
    expect(topbarCount()).toBe(3);
  });

  test("All Captures counts every item the unfiltered grid shows", async () => {
    await renderLibrary();
    expect(navCount("All Captures")).toBe(6);
    expect(topbarCount()).toBe(6);
  });

  test("the Types rows sum to All Captures", async () => {
    // If they don't, one of the four numbers is measuring a different
    // universe than the others — which is exactly how this bug read.
    await renderLibrary();
    expect(navCount("Images") + navCount("Videos") + navCount("Projects")).toBe(
      navCount("All Captures")
    );
  });
});
