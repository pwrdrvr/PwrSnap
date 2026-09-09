// Grid tile affordances — the capture-tile context menu and the
// cart "selection mode" flag.
//
// Both exist because the tile's own controls are small and
// hover-gated: the context menu is the second door to every tile
// action, and selection mode is what makes the cart checkbox visible
// at rest once the user has collected anything.
//
// The load-bearing assertion is that the menu does NOT introduce a
// parallel copy path — its Low/Med/High rows must dispatch
// `clipboard:copy` (image BYTES via `copyImagePreset`), the same thing
// the DetailRail cards, the tray, the float-over and ⌘1/2/3 put on the
// clipboard. PR #232 drifted two surfaces onto `clipboard:copy-file`
// exactly by hand-rolling per-surface dispatch calls.

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
  // jsdom doesn't implement rAF-driven focus scheduling deterministically
  // under fake timers; the menu focuses itself on the next frame.
  if (typeof globalThis.requestAnimationFrame !== "function") {
    (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (
      cb: FrameRequestCallback
    ) => setTimeout(() => cb(0), 0) as unknown as number;
  }
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
    // The menu's Move to Trash row must honor this the same way the
    // tile's DeleteConfirm popover does.
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

/** Cart the mocked `cart:get` resolves with. Mutated per-test so a
 *  suite can boot the Library straight into selection mode. */
let cartState: DraftCart = emptyCart;

/** jsdom's window.confirm is a "not implemented" stub, so the menu's
 *  destructive rows need it mocked. Defaults to "yes". */
const confirmMock = vi.fn(() => true);

/** What the mocked `capture:saveAs` resolves with. Defaults to the
 *  CANCELLED shape (`ok({ path: null })`) — the handler distinguishes a
 *  dismissed save sheet from a real failure, and only the latter should
 *  reach the user. */
let saveAsResult: { ok: true; value: { path: string | null } } | { ok: false; error: unknown } = {
  ok: true,
  value: { path: null }
};

beforeEach(() => {
  window.pwrsnapApi = {
    platform: "darwin"
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  cartState = emptyCart;
  saveAsResult = { ok: true, value: { path: null } };
  confirmMock.mockReset();
  confirmMock.mockReturnValue(true);
  vi.stubGlobal("confirm", confirmMock);
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
    if (name === "cart:get" || name === "cart:toggle") return ok(cartState);
    if (name === "capture:saveAs") return saveAsResult;
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
  vi.unstubAllGlobals();
});

async function renderLibrary(): Promise<void> {
  await act(async () => {
    root?.render(createElement(CartProvider, null, createElement(Library)));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function cellEl(): HTMLElement | null {
  return container?.querySelector<HTMLElement>('[data-cell-id="cap_image"]') ?? null;
}

async function openMenu(): Promise<HTMLElement> {
  await act(async () => {
    cellEl()?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 120
      })
    );
    await Promise.resolve();
  });
  const menu = container?.querySelector<HTMLElement>('[role="menu"]');
  expect(menu).not.toBeNull();
  return menu as HTMLElement;
}

function rowByLabel(menu: HTMLElement, label: string): HTMLElement {
  const row = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (el) => el.textContent?.trim() === label
  );
  expect(row, `context menu row "${label}"`).not.toBeUndefined();
  return row as HTMLElement;
}

describe("capture tile context menu", () => {
  test("right-click on a capture tile opens the menu with every tile action", async () => {
    await renderLibrary();
    const menu = await openMenu();

    const labels = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) =>
      el.textContent?.trim()
    );
    expect(labels).toEqual([
      "Edit",
      "Copy Low",
      "Copy Med",
      "Copy High",
      "Save File…",
      "Reveal in Finder",
      "Add to Cart",
      "Move to Trash"
    ]);
  });

  test("Copy Med dispatches clipboard:copy (image bytes), never clipboard:copy-file", async () => {
    await renderLibrary();
    const menu = await openMenu();

    await act(async () => {
      rowByLabel(menu, "Copy Med").click();
      await Promise.resolve();
    });

    expect(dispatchMock).toHaveBeenCalledWith("clipboard:copy", {
      captureId: "cap_image",
      preset: "med"
    });
    expect(dispatchMock.mock.calls.some(([name]) => name === "clipboard:copy-file")).toBe(
      false
    );
  });

  test("Save File… dispatches capture:saveAs at the High preset", async () => {
    await renderLibrary();
    const menu = await openMenu();

    await act(async () => {
      rowByLabel(menu, "Save File…").click();
      await Promise.resolve();
    });

    expect(dispatchMock).toHaveBeenCalledWith("capture:saveAs", {
      captureId: "cap_image",
      preset: "high"
    });
  });

  test("a failed Save File… surfaces the error instead of failing silently", async () => {
    saveAsResult = {
      ok: false,
      error: { kind: "io", code: "write_failed", message: "disk is full" }
    };
    await renderLibrary();
    const menu = await openMenu();

    await act(async () => {
      rowByLabel(menu, "Save File…").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Action errors portal into the app toast stack so they stay visible
    // above Focus/Reel as well as Grid. This isolated harness has no stack,
    // so Library falls back to document.body.
    const alert = document.querySelector('[role="alert"].psl__error');
    expect(alert?.textContent).toContain("disk is full");
  });

  test("a cancelled Save File… stays silent", async () => {
    // The handler reports a dismissed save sheet as `ok({ path: null })`,
    // NOT as an error — cancelling must not raise a banner.
    await renderLibrary();
    const menu = await openMenu();

    await act(async () => {
      rowByLabel(menu, "Save File…").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.querySelector('[role="alert"].psl__error')).toBeNull();
  });

  test("Reveal in Finder dispatches capture:reveal", async () => {
    await renderLibrary();
    const menu = await openMenu();

    await act(async () => {
      rowByLabel(menu, "Reveal in Finder").click();
      await Promise.resolve();
    });

    expect(dispatchMock).toHaveBeenCalledWith("capture:reveal", { captureId: "cap_image" });
  });

  test("Add to Cart dispatches cart:toggle — the same verb the tile checkbox uses", async () => {
    await renderLibrary();
    const menu = await openMenu();

    await act(async () => {
      rowByLabel(menu, "Add to Cart").click();
      await Promise.resolve();
    });

    expect(dispatchMock).toHaveBeenCalledWith("cart:toggle", { captureId: "cap_image" });
  });

  test("the cart row reads Remove from Cart when the capture is already collected", async () => {
    cartState = { ...emptyCart, captureIds: ["cap_image"] };
    await renderLibrary();
    const menu = await openMenu();

    expect(
      Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent?.trim())
    ).toContain("Remove from Cart");
  });

  test("Edit opens the editor — the same intent as the hover Edit CTA", async () => {
    await renderLibrary();
    const menu = await openMenu();

    await act(async () => {
      rowByLabel(menu, "Edit").click();
      await Promise.resolve();
    });

    expect(container?.querySelector('[data-testid="library-stage"]')).not.toBeNull();
  });

  test("Move to Trash confirms first, then dispatches library:delete", async () => {
    await renderLibrary();
    const menu = await openMenu();

    await act(async () => {
      rowByLabel(menu, "Move to Trash").click();
      await Promise.resolve();
    });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("library:delete", { id: "cap_image" });
  });

  test("declining the Move to Trash confirm leaves the capture alone", async () => {
    // The menu is a second door to soft-delete, so it must honor
    // `library.confirmBeforeTrash` exactly like the tile's DeleteConfirm
    // popover does — otherwise the menu is a confirm-free bypass.
    confirmMock.mockReturnValue(false);
    await renderLibrary();
    const menu = await openMenu();

    await act(async () => {
      rowByLabel(menu, "Move to Trash").click();
      await Promise.resolve();
    });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls.some(([name]) => name === "library:delete")).toBe(false);
  });

  test("picking a row closes the menu", async () => {
    await renderLibrary();
    const menu = await openMenu();

    await act(async () => {
      rowByLabel(menu, "Reveal in Finder").click();
      await Promise.resolve();
    });

    expect(container?.querySelector('[role="menu"]')).toBeNull();
  });

  test("Escape closes the menu", async () => {
    await renderLibrary();
    await openMenu();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
      await Promise.resolve();
    });

    expect(container?.querySelector('[role="menu"]')).toBeNull();
  });

  test("scrolling the grid closes the menu", async () => {
    // `.psl__context-menu` is position:fixed at the right-click point, so
    // it does not travel with its tile. Left open across a scroll it ends
    // up hovering a DIFFERENT capture while its rows still act on the
    // original one — and in Trash view one of those rows is the
    // irreversible "Delete Permanently". Scroll events don't bubble, so
    // the listener has to be capture-phase on window.
    await renderLibrary();
    await openMenu();

    const scroller = container?.querySelector<HTMLElement>(".psl__grid-wrap") ?? container;
    await act(async () => {
      (scroller ?? document).dispatchEvent(new Event("scroll", { bubbles: false }));
      await Promise.resolve();
    });

    expect(container?.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("cart selection mode", () => {
  test("an empty cart leaves data-selecting off the library root", async () => {
    await renderLibrary();
    const shell = container?.querySelector<HTMLElement>(".psl");
    expect(shell).not.toBeNull();
    expect(shell?.getAttribute("data-selecting")).toBeNull();
  });

  test("a non-empty cart flips the library root into selection mode", async () => {
    // `.psl[data-selecting="cart"] .psl__cell-cart { opacity: .9 }` is
    // what makes EVERY tile's checkbox visible at rest once anything is
    // collected — the "Photos / Drive" behavior. The attribute is fed by
    // the cart's empty↔non-empty edge, so this is the whole contract.
    cartState = { ...emptyCart, captureIds: ["cap_image"] };
    await renderLibrary();

    const shell = container?.querySelector<HTMLElement>(".psl");
    expect(shell?.getAttribute("data-selecting")).toBe("cart");
  });
});
