import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, type CaptureRecord, type DraftCart, type Settings } from "@pwrsnap/shared";

type CaptureFallback = {
  readonly undo: () => void;
  readonly redo: () => void;
  readonly canUndo: () => boolean;
  readonly canRedo: () => boolean;
};

type MutationResult =
  | { readonly ok: true; readonly value: undefined }
  | {
      readonly ok: false;
      readonly error: { readonly kind: string; readonly code: string; readonly message: string };
    };

type RefreshResult =
  | {
      readonly ok: true;
      readonly value: { readonly totalLive: number; readonly trashTotal: number };
    }
  | MutationResult;

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn(),
  subscribers: new Map<string, Set<(payload: unknown) => void>>(),
  useLibrary: vi.fn(),
  refreshLibrary: vi.fn<() => Promise<RefreshResult>>(async () => ({
    ok: true,
    value: { totalLive: 0, trashTotal: 0 }
  })),
  registerCaptureUndoFallback: vi.fn(),
  fallback: null as CaptureFallback | null,
  cartIds: [] as string[]
}));

vi.mock("../../../lib/pwrsnap", () => ({
  cacheUrl: (id: string) => `pwrsnap-cache://${id}`,
  captureSrcUrl: (id: string) => `pwrsnap-capture://${id}`,
  dispatch: (...args: unknown[]) => mocks.dispatch(...args),
  perfMark: vi.fn(),
  sizzleOutputUrl: (id: string) => `pwrsnap-sizzle://${id}`,
  subscribe: (...args: unknown[]) =>
    mocks.subscribe(args[0] as string, args[1] as (payload: unknown) => void)
}));

vi.mock("../../../lib/useLibrary", () => ({
  useLibrary: () => mocks.useLibrary()
}));

vi.mock("../../../lib/editMenuBridge", () => ({
  registerCaptureUndoFallback: (fallback: CaptureFallback) => {
    mocks.fallback = fallback;
    mocks.registerCaptureUndoFallback(fallback);
    return () => {
      if (mocks.fallback === fallback) mocks.fallback = null;
    };
  }
}));

vi.mock("@tanstack/react-virtual", () => ({
  defaultRangeExtractor: (range: { startIndex: number; endIndex: number }) =>
    Array.from(
      { length: Math.max(0, range.endIndex - range.startIndex + 1) },
      (_, index) => range.startIndex + index
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
  Stage: ({
    record,
    dispatch,
    prevRecordId,
    nextRecordId
  }: {
    record: CaptureRecord;
    dispatch: (action: { type: "NAVIGATE"; recordId: string }) => void;
    prevRecordId: string | null;
    nextRecordId: string | null;
  }): ReactElement => (
    <section data-testid="library-stage" data-capture-id={record.id}>
      <button
        type="button"
        data-testid="stage-prev"
        disabled={prevRecordId === null}
        onClick={() => {
          if (prevRecordId !== null) dispatch({ type: "NAVIGATE", recordId: prevRecordId });
        }}
      >
        Previous
      </button>
      <button
        type="button"
        data-testid="stage-next"
        disabled={nextRecordId === null}
        onClick={() => {
          if (nextRecordId !== null) dispatch({ type: "NAVIGATE", recordId: nextRecordId });
        }}
      >
        Next
      </button>
    </section>
  )
}));

vi.mock("../DetailRail", () => ({
  DetailRail: (props: {
    record: CaptureRecord | null;
    onTrash?: (id: string) => void;
    onRestore?: (id: string) => void;
    onPurge?: (id: string) => void;
    onCartTrashAll?: (ids: string[]) => void;
  }): ReactElement => (
    <aside data-testid="detail-rail" data-capture-id={props.record?.id ?? "none"}>
      <button
        type="button"
        data-testid="rail-trash"
        disabled={props.record === null}
        onClick={() => {
          if (props.record !== null) props.onTrash?.(props.record.id);
        }}
      >
        Trash selected
      </button>
      <button
        type="button"
        data-testid="rail-restore"
        disabled={props.record === null}
        onClick={() => {
          if (props.record !== null) props.onRestore?.(props.record.id);
        }}
      >
        Restore selected
      </button>
      <button
        type="button"
        data-testid="rail-purge"
        disabled={props.record === null}
        onClick={() => {
          if (props.record !== null) props.onPurge?.(props.record.id);
        }}
      >
        Purge selected
      </button>
      <button
        type="button"
        data-testid="rail-trash-cart"
        onClick={() => props.onCartTrashAll?.([...mocks.cartIds])}
      >
        Trash cart
      </button>
    </aside>
  )
}));

import { CartProvider } from "../CartContext";
import { Library } from "../Library";

function record(id: string, minute: number, deletedAt: string | null = null): CaptureRecord {
  return {
    id,
    kind: "image",
    captured_at: `2026-05-15T18:${String(minute).padStart(2, "0")}:00.000Z`,
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
    source_window_title: null,
    edits_version: 0,
    has_alpha: false,
    deleted_at: deletedAt
  };
}

const capA = record("cap_a", 30);
const capB = record("cap_b", 20);
const capC = record("cap_c", 10);
const liveRows = [capA, capB, capC];
const deletedAt = "2026-05-15T19:00:00.000Z";

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
  ai: { enabled: false, consentAcceptedAt: null, defaults: { enrichment: {} } },
  library: {
    confirmBeforeTrash: false,
    detailRail: { pinned: true, lastSelectedTab: "info" }
  }
} as unknown as Settings;

const emptyCart: DraftCart = {
  name: "Untitled draft",
  captureIds: [],
  createdAt: "2026-05-15T18:00:00.000Z",
  modifiedAt: "2026-05-15T18:00:00.000Z"
};

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function mutationOk(): MutationResult {
  return ok(undefined);
}

function mutationErr(message: string): MutationResult {
  return {
    ok: false,
    error: { kind: "io", code: "mutation_failed", message }
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {
      // no-op
    }
    unobserve(): void {
      // no-op
    }
    disconnect(): void {
      // no-op
    }
  };
  Element.prototype.scrollIntoView = vi.fn();
  if (typeof globalThis.requestAnimationFrame !== "function") {
    (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (
      callback: FrameRequestCallback
    ) => setTimeout(() => callback(0), 0) as unknown as number;
  }
});

let container: HTMLDivElement | null = null;
let toastStack: HTMLDivElement | null = null;
let root: Root | null = null;
let rows: CaptureRecord[] = liveRows;
let trashTotal = 0;
let deleteResult: (id: string) => MutationResult | Promise<MutationResult>;
let restoreResult: (id: string) => MutationResult | Promise<MutationResult>;
let purgeResult: (id: string) => MutationResult | Promise<MutationResult>;
let cartRemoveResult: (id: string) => MutationResult | Promise<MutationResult>;
let purgeAllResult: MutationResult | Promise<MutationResult>;
let byIdResult: (id: string) => ReturnType<typeof ok<CaptureRecord | null>>;
let editorOpenResult: MutationResult | Promise<MutationResult>;

beforeEach(() => {
  rows = liveRows;
  trashTotal = 0;
  mocks.cartIds = [];
  mocks.fallback = null;
  mocks.subscribers.clear();
  mocks.refreshLibrary.mockReset();
  mocks.refreshLibrary.mockImplementation(async () => ({
    ok: true,
    value: {
      totalLive: rows.filter((candidate) => candidate.deleted_at === null).length,
      trashTotal
    }
  }));
  mocks.registerCaptureUndoFallback.mockClear();
  deleteResult = () => mutationOk();
  restoreResult = () => mutationOk();
  purgeResult = () => mutationOk();
  cartRemoveResult = () => mutationOk();
  purgeAllResult = mutationOk();
  byIdResult = (id) => ok(rows.find((candidate) => candidate.id === id) ?? null);
  editorOpenResult = mutationOk();

  mocks.subscribe.mockImplementation(
    (channel: string, handler: (payload: unknown) => void) => {
      const handlers = mocks.subscribers.get(channel) ?? new Set();
      handlers.add(handler);
      mocks.subscribers.set(channel, handlers);
      return () => handlers.delete(handler);
    }
  );

  mocks.useLibrary.mockImplementation(() => ({
    rows,
    error: null,
    hasMore: false,
    isLoadingMore: false,
    loading: false,
    loadMore: vi.fn(async () => undefined),
    refresh: mocks.refreshLibrary,
    totalLive: rows.filter((candidate) => candidate.deleted_at === null).length,
    appStats: [],
    kindStats: [],
    trashTotal
  }));

  mocks.dispatch.mockImplementation(async (name: string, payload?: unknown) => {
    if (name === "settings:read") return ok(settings);
    if (name === "settings:refreshCodexDiscovery") {
      return ok({ resolvedPath: null, auth: null, candidates: [] });
    }
    if (name === "storage:summary") {
      return ok({
        capturedAt: "2026-05-15T18:30:00.000Z",
        sourceCaptures: { bytes: 300_000, captureCount: 3 }
      });
    }
    if (name === "sizzle:list") return ok({ projects: [] });
    if (name === "app:version") return ok({ version: "0.0.0-test" });
    if (name === "library:counts") return ok({ total: rows.length });
    if (name === "cart:get") return ok({ ...emptyCart, captureIds: [...mocks.cartIds] });
    if (name === "cart:remove") {
      return cartRemoveResult((payload as { captureId: string }).captureId);
    }
    if (name === "library:delete") {
      return deleteResult((payload as { id: string }).id);
    }
    if (name === "library:restore") {
      return restoreResult((payload as { id: string }).id);
    }
    if (name === "library:purge") {
      return purgeResult((payload as { id: string }).id);
    }
    if (name === "library:purgeAll") return purgeAllResult;
    if (name === "library:byId") return byIdResult((payload as { id: string }).id);
    if (name === "editor:open") return editorOpenResult;
    return ok(undefined);
  });

  vi.stubGlobal("confirm", vi.fn(() => true));
  container = document.createElement("div");
  toastStack = document.createElement("div");
  toastStack.className = "app-toast-stack";
  document.body.append(container, toastStack);
  root = createRoot(container);
});

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  root = null;
  container?.remove();
  toastStack?.remove();
  container = null;
  toastStack = null;
  mocks.dispatch.mockReset();
  mocks.subscribe.mockClear();
  mocks.subscribers.clear();
  mocks.useLibrary.mockReset();
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function renderLibrary(): Promise<void> {
  await act(async () => {
    root?.render(createElement(CartProvider, null, createElement(Library)));
    await flush();
  });
}

async function rerenderLibrary(): Promise<void> {
  await act(async () => {
    root?.render(createElement(CartProvider, null, createElement(Library)));
    await flush();
  });
}

async function openFocus(id = "cap_a"): Promise<void> {
  const cell = container?.querySelector<HTMLElement>(`[data-cell-id="${id}"]`);
  expect(cell).not.toBeNull();
  await act(async () => {
    cell?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await flush();
  });
  expect(stageId()).toBe(id);
}

async function click(testId: string): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(button, testId).not.toBeNull();
  await act(async () => {
    button?.click();
    await flush();
  });
}

function stageId(): string | null {
  return container
    ?.querySelector<HTMLElement>('[data-testid="library-stage"]')
    ?.getAttribute("data-capture-id") ?? null;
}

function toastText(): string | null {
  return toastStack?.querySelector('[role="status"]')?.textContent ?? null;
}

function alertText(): string | null {
  return toastStack?.querySelector('[role="alert"]')?.textContent ?? null;
}

function commandIds(command: string): string[] {
  return mocks.dispatch.mock.calls
    .filter(([name]) => name === command)
    .map(([, payload]) => {
      if (command === "cart:remove") return (payload as { captureId: string }).captureId;
      return (payload as { id: string }).id;
    });
}

async function emit(channel: string, payload: unknown): Promise<void> {
  await act(async () => {
    for (const handler of mocks.subscribers.get(channel) ?? []) handler(payload);
    await flush();
  });
}

describe("Library Result-gated capture mutations", () => {
  test("keeps Focus and success state unchanged until a delete Result succeeds", async () => {
    const pending = deferred<MutationResult>();
    deleteResult = () => pending.promise;
    await renderLibrary();
    await openFocus();

    await click("rail-trash");

    expect(stageId()).toBe("cap_a");
    expect(toastText()).toBeNull();
    expect(mocks.fallback?.canUndo()).toBe(false);

    await act(async () => {
      pending.resolve(mutationOk());
      await flush();
    });

    expect(stageId()).toBe("cap_b");
    expect(toastText()).toContain("Moved to Trash");
    expect(mocks.fallback?.canUndo()).toBe(true);
  });

  test("retains selection on failure and retries the failed single capture", async () => {
    deleteResult = () => mutationErr("source file is busy");
    await renderLibrary();
    await openFocus();

    await click("rail-trash");

    expect(stageId()).toBe("cap_a");
    expect(toastText()).toBeNull();
    expect(mocks.fallback?.canUndo()).toBe(false);
    expect(alertText()).toContain("cap_a");
    expect(alertText()).toContain("source file is busy");

    deleteResult = () => mutationOk();
    await clickErrorAction("Retry move");

    expect(commandIds("library:delete")).toEqual(["cap_a", "cap_a"]);
    expect(stageId()).toBe("cap_b");
    expect(toastText()).toContain("Moved to Trash");
    expect(alertText()).toBeNull();
  });

  test("does not close Focus for the only capture until its delete succeeds", async () => {
    rows = [capA];
    const pending = deferred<MutationResult>();
    deleteResult = () => pending.promise;
    await renderLibrary();
    await openFocus();

    await click("rail-trash");
    expect(stageId()).toBe("cap_a");
    expect(toastText()).toBeNull();

    await act(async () => {
      pending.resolve(mutationErr("trash is unavailable"));
      await flush();
    });
    expect(stageId()).toBe("cap_a");

    deleteResult = () => mutationOk();
    await clickErrorAction("Retry move");
    expect(stageId()).toBeNull();
    expect(toastText()).toContain("Moved to Trash");
  });

  test("does not overwrite navigation performed while delete is pending", async () => {
    const pending = deferred<MutationResult>();
    deleteResult = () => pending.promise;
    await renderLibrary();
    await openFocus();

    await click("rail-trash");
    await click("stage-prev");
    expect(stageId()).toBe("cap_c");

    await act(async () => {
      pending.resolve(mutationOk());
      await flush();
    });

    expect(stageId()).toBe("cap_c");
    expect(toastText()).toContain("Moved to Trash");
  });

  test("retains the focused record when an early refresh observes deletion before Result", async () => {
    const pending = deferred<MutationResult>();
    deleteResult = () => pending.promise;
    await renderLibrary();
    await openFocus();

    await click("rail-trash");
    rows = [record("cap_a", 30, deletedAt), capB, capC];
    trashTotal = 1;
    await rerenderLibrary();

    expect(stageId()).toBe("cap_a");
    expect(toastText()).toBeNull();
    const navRows = Array.from(container?.querySelectorAll<HTMLElement>(".psl__nav") ?? []);
    expect(navRows.find((row) => row.textContent?.includes("All Captures"))?.textContent).toContain(
      "3"
    );
    expect(navRows.find((row) => row.textContent?.includes("Trash"))?.textContent).toContain("0");

    await act(async () => {
      pending.resolve(mutationOk());
      await flush();
    });

    expect(stageId()).toBe("cap_b");
    expect(toastText()).toContain("Moved to Trash");
  });

  test("holds a Focus-only externally opened record through an early deletion broadcast", async () => {
    const external = record("cap_external", 40);
    byIdResult = (id) => ok(id === external.id ? external : null);
    await renderLibrary();
    await emit(EVENT_CHANNELS.libraryOpenCapture, { captureId: external.id });
    expect(stageId()).toBe(external.id);

    const pending = deferred<MutationResult>();
    deleteResult = () => pending.promise;
    await click("rail-trash");

    byIdResult = (id) =>
      ok(id === external.id ? { ...external, deleted_at: deletedAt } : null);
    await emit(EVENT_CHANNELS.capturesChanged, { changedIds: [external.id] });

    expect(stageId()).toBe(external.id);
    expect(toastText()).toBeNull();

    await act(async () => {
      pending.resolve(mutationOk());
      await flush();
    });
    expect(stageId()).not.toBe(external.id);
    expect(toastText()).toContain("Moved to Trash");
  });

  test("queues a different capture action behind an in-flight mutation", async () => {
    const pendingDelete = deferred<MutationResult>();
    deleteResult = () => pendingDelete.promise;
    await renderLibrary();
    await openFocus("cap_a");

    await click("rail-trash");
    await click("stage-next");
    expect(stageId()).toBe("cap_b");
    await click("rail-restore");

    expect(commandIds("library:delete")).toEqual(["cap_a"]);
    expect(commandIds("library:restore")).toEqual([]);

    await act(async () => {
      pendingDelete.resolve(mutationOk());
      await flush();
    });

    expect(commandIds("library:restore")).toEqual(["cap_b"]);
    expect(stageId()).toBe("cap_b");
  });

  test("recomputes navigation across queued deletes and closes after the last capture", async () => {
    rows = [capA, capB];
    const pendingA = deferred<MutationResult>();
    deleteResult = (id) => (id === "cap_a" ? pendingA.promise : mutationOk());
    await renderLibrary();
    await openFocus("cap_a");

    await click("rail-trash");
    await click("stage-next");
    expect(stageId()).toBe("cap_b");
    await click("rail-trash");
    expect(commandIds("library:delete")).toEqual(["cap_a"]);

    await act(async () => {
      pendingA.resolve(mutationOk());
      await flush();
    });

    expect(commandIds("library:delete")).toEqual(["cap_a", "cap_b"]);
    expect(stageId()).toBeNull();
  });

  test("does not let a queued toast Undo restore a newer delete batch", async () => {
    await renderLibrary();
    await openFocus("cap_a");
    await click("rail-trash");
    expect(toastText()).toContain("Moved to Trash");

    const pendingB = deferred<MutationResult>();
    deleteResult = (id) => (id === "cap_b" ? pendingB.promise : mutationOk());
    await click("rail-trash");

    const undoWhileBusy = toastStack?.querySelector<HTMLButtonElement>(
      ".ps-undo-toast__undo"
    );
    expect(undoWhileBusy?.disabled).toBe(true);
    await act(async () => {
      undoWhileBusy?.click();
      await flush();
    });
    expect(commandIds("library:restore")).toEqual([]);

    await act(async () => {
      pendingB.resolve(mutationOk());
      await flush();
    });
    const undoB = toastStack?.querySelector<HTMLButtonElement>(".ps-undo-toast__undo");
    expect(undoB?.disabled).toBe(false);
    await act(async () => {
      undoB?.click();
      await flush();
    });
    expect(commandIds("library:restore")).toEqual(["cap_b"]);

    await act(async () => {
      mocks.fallback?.undo();
      await flush();
    });
    expect(commandIds("library:restore")).toEqual(["cap_b", "cap_a"]);
  });

  test("never queues Empty Trash and requires a fresh confirmation after mutation", async () => {
    const trashedB = record("cap_b", 20, deletedAt);
    rows = [capA, trashedB];
    trashTotal = 1;
    const pendingA = deferred<MutationResult>();
    deleteResult = () => pendingA.promise;
    await renderLibrary();
    await openFocus("cap_a");
    await click("rail-trash");

    const trashNav = Array.from(
      container?.querySelectorAll<HTMLButtonElement>(".psl__nav") ?? []
    ).find((button) => button.textContent?.includes("Trash"));
    await act(async () => {
      trashNav?.click();
      await flush();
    });
    vi.mocked(window.confirm).mockClear();
    const emptyTrash = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? []
    ).find((button) => button.textContent?.trim() === "Empty Trash");
    await act(async () => {
      emptyTrash?.click();
      await flush();
    });

    expect(window.confirm).not.toHaveBeenCalled();
    expect(mocks.dispatch.mock.calls.some(([name]) => name === "library:purgeAll")).toBe(false);
    expect(alertText()).toContain("was not queued");

    await act(async () => {
      pendingA.resolve(mutationOk());
      await flush();
    });
    rows = [record("cap_a", 30, deletedAt), trashedB];
    trashTotal = 2;
    await rerenderLibrary();
    await clickErrorAction("Empty Trash");

    expect(window.confirm).toHaveBeenCalledOnce();
    expect(window.confirm).toHaveBeenCalledWith(
      "Permanently delete 2 captures? This cannot be undone."
    );
    expect(
      mocks.dispatch.mock.calls.filter(([name]) => name === "library:purgeAll")
    ).toHaveLength(1);
  });

  test("partial cart failure removes and records only successful capture ids", async () => {
    mocks.cartIds = ["cap_a", "cap_b", "cap_c"];
    deleteResult = (id) =>
      id === "cap_b" ? mutationErr("permission denied") : mutationOk();
    await renderLibrary();
    await act(async () => {
      container?.querySelector<HTMLElement>('[data-cell-id="cap_b"]')?.click();
      await flush();
    });

    await click("rail-trash-cart");

    expect(commandIds("library:delete")).toEqual(["cap_a", "cap_b", "cap_c"]);
    expect(commandIds("cart:remove")).toEqual(["cap_a", "cap_c"]);
    expect(mocks.dispatch.mock.calls.some(([name]) => name === "cart:clear")).toBe(false);
    expect(toastText()).toContain("Moved 2 to Trash");
    expect(alertText()).toContain("cap_b");
    expect(alertText()).toContain("permission denied");
    expect(container?.querySelector('.psl__cell.is-selected')?.getAttribute("data-cell-id")).toBe(
      "cap_b"
    );

    mocks.dispatch.mockClear();
    deleteResult = () => mutationOk();
    await clickErrorAction("Retry failed");

    expect(commandIds("library:delete")).toEqual(["cap_b"]);
    expect(commandIds("cart:remove")).toEqual(["cap_b"]);
    expect(mocks.dispatch.mock.calls.some(([name]) => name === "cart:clear")).toBe(false);
  });

  test("all-failed cart trash retains every item and records no success", async () => {
    mocks.cartIds = ["cap_a", "cap_b", "cap_c"];
    deleteResult = (id) => mutationErr(`cannot delete ${id}`);
    await renderLibrary();

    await click("rail-trash-cart");

    expect(commandIds("cart:remove")).toEqual([]);
    expect(mocks.dispatch.mock.calls.some(([name]) => name === "cart:clear")).toBe(false);
    expect(toastText()).toBeNull();
    expect(mocks.fallback?.canUndo()).toBe(false);
    expect(alertText()).toContain("cap_a, cap_b, cap_c");
    expect(container?.querySelector('.psl__cell.is-selected')?.getAttribute("data-cell-id")).toBe(
      "cap_a"
    );
  });

  test("cart cleanup retry never re-deletes a capture whose delete succeeded", async () => {
    mocks.cartIds = ["cap_a", "cap_b"];
    cartRemoveResult = (id) =>
      id === "cap_a" ? mutationErr("cart database is busy") : mutationOk();
    await renderLibrary();

    await click("rail-trash-cart");

    expect(commandIds("library:delete")).toEqual(["cap_a", "cap_b"]);
    expect(commandIds("cart:remove")).toEqual(["cap_a", "cap_b"]);
    expect(toastText()).toContain("Moved 2 to Trash");
    expect(alertText()).toContain("Remove from cart failed for 1 capture");
    expect(alertText()).toContain("cap_a");

    mocks.dispatch.mockClear();
    cartRemoveResult = () => mutationOk();
    await clickErrorAction("Retry failed");

    expect(commandIds("library:delete")).toEqual([]);
    expect(commandIds("cart:remove")).toEqual(["cap_a"]);
  });

  test("partial undo retains failures and retry restores only failed ids", async () => {
    mocks.cartIds = ["cap_a", "cap_b", "cap_c"];
    await renderLibrary();
    await click("rail-trash-cart");

    restoreResult = (id) =>
      id === "cap_b" ? mutationErr("restore collision") : mutationOk();
    await act(async () => {
      mocks.fallback?.undo();
      await flush();
    });

    expect(commandIds("library:restore")).toEqual(["cap_a", "cap_b", "cap_c"]);
    expect(alertText()).toContain("cap_b");
    expect(mocks.fallback?.canUndo()).toBe(true);
    expect(mocks.fallback?.canRedo()).toBe(true);

    mocks.dispatch.mockClear();
    restoreResult = () => mutationOk();
    await clickErrorAction("Retry undo");

    expect(commandIds("library:restore")).toEqual(["cap_b"]);
    expect(mocks.fallback?.canUndo()).toBe(false);
    expect(mocks.fallback?.canRedo()).toBe(true);
  });

  test("partial redo reports only successes and leaves failures redoable", async () => {
    mocks.cartIds = ["cap_a", "cap_b", "cap_c"];
    await renderLibrary();
    await click("rail-trash-cart");
    await act(async () => {
      mocks.fallback?.undo();
      await flush();
    });
    expect(toastText()).toBeNull();

    mocks.dispatch.mockClear();
    deleteResult = (id) =>
      id === "cap_b" ? mutationErr("redo blocked") : mutationOk();
    await act(async () => {
      mocks.fallback?.redo();
      await flush();
    });

    expect(commandIds("library:delete")).toEqual(["cap_a", "cap_b", "cap_c"]);
    expect(toastText()).toContain("Moved 2 to Trash");
    expect(alertText()).toContain("cap_b");
    expect(mocks.fallback?.canRedo()).toBe(true);

    mocks.dispatch.mockClear();
    deleteResult = () => mutationOk();
    await clickErrorAction("Retry redo");
    expect(commandIds("library:delete")).toEqual(["cap_b"]);
    expect(mocks.fallback?.canRedo()).toBe(false);
  });

  test("a second Undo while restore is pending does not consume another batch", async () => {
    await renderLibrary();
    mocks.cartIds = ["cap_a"];
    await click("rail-trash-cart");
    mocks.cartIds = ["cap_b"];
    await click("rail-trash-cart");

    const pending = deferred<MutationResult>();
    restoreResult = () => pending.promise;
    mocks.dispatch.mockClear();
    await act(async () => {
      mocks.fallback?.undo();
      mocks.fallback?.undo();
      await flush();
    });
    expect(commandIds("library:restore")).toEqual(["cap_b"]);

    await act(async () => {
      pending.resolve(mutationOk());
      await flush();
    });
    restoreResult = () => mutationOk();
    await act(async () => {
      mocks.fallback?.undo();
      await flush();
    });
    expect(commandIds("library:restore")).toEqual(["cap_b", "cap_a"]);
  });

  test("editor-open retry keeps reporting repeat Result failures", async () => {
    await renderLibrary();
    await openFocus("cap_a");
    await click("rail-trash");
    editorOpenResult = mutationErr("editor unavailable");

    await act(async () => {
      mocks.fallback?.undo();
      await flush();
    });
    expect(alertText()).toContain("editor unavailable");

    editorOpenResult = mutationErr("editor still unavailable");
    await clickErrorAction("Open capture");

    expect(
      mocks.dispatch.mock.calls.filter(([name]) => name === "editor:open")
    ).toHaveLength(2);
    expect(alertText()).toContain("editor still unavailable");
    expect(alertText()).toContain("Open capture");
  });

  test("restore, purge, and Empty Trash failures remain visible and retryable", async () => {
    rows = [
      record("cap_a", 30, deletedAt),
      record("cap_b", 20, deletedAt),
      record("cap_c", 10, deletedAt)
    ];
    trashTotal = 3;
    restoreResult = () => mutationErr("restore failed");
    purgeResult = () => mutationErr("purge failed");
    purgeAllResult = mutationErr("trash scan failed");
    await renderLibrary();

    const trashNav = Array.from(container?.querySelectorAll<HTMLButtonElement>(".psl__nav") ?? []).find(
      (button) => button.textContent?.includes("Trash")
    );
    expect(trashNav).not.toBeUndefined();
    await act(async () => {
      trashNav?.click();
      await flush();
    });

    expect(container?.querySelector('.psl__cell.is-selected')?.getAttribute("data-cell-id")).toBe(
      "cap_a"
    );
    await click("rail-restore");
    expect(alertText()).toContain("Restore failed for 1 capture");
    expect(alertText()).toContain("cap_a");
    expect(container?.querySelector('.psl__cell.is-selected')?.getAttribute("data-cell-id")).toBe(
      "cap_a"
    );

    await click("rail-purge");
    expect(alertText()).toContain("Permanently delete failed for 1 capture");
    expect(alertText()).toContain("cap_a");

    const emptyTrash = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (button) => button.textContent?.trim() === "Empty Trash"
    );
    expect(emptyTrash).not.toBeUndefined();
    await act(async () => {
      emptyTrash?.click();
      await flush();
    });
    expect(mocks.refreshLibrary).toHaveBeenCalledTimes(2);
    expect(alertText()).toContain("Couldn’t empty Trash");
    expect(alertText()).toContain("trash scan failed");

    purgeAllResult = mutationOk();
    await clickErrorAction("Retry empty Trash");
    expect(mocks.dispatch.mock.calls.filter(([name]) => name === "library:purgeAll")).toHaveLength(
      2
    );
    expect(mocks.refreshLibrary).toHaveBeenCalledTimes(4);
    expect(alertText()).toBeNull();
  });

  test("surfaces a successful Empty Trash with failed refresh and retries only the refresh", async () => {
    rows = [record("cap_a", 30, deletedAt)];
    trashTotal = 1;
    mocks.refreshLibrary
      .mockResolvedValueOnce({ ok: true, value: { totalLive: 0, trashTotal: 1 } })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "io", code: "list_failed", message: "database read failed" }
      });
    await renderLibrary();

    const trashNav = Array.from(
      container?.querySelectorAll<HTMLButtonElement>(".psl__nav") ?? []
    ).find((button) => button.textContent?.includes("Trash"));
    await act(async () => {
      trashNav?.click();
      await flush();
    });
    const emptyTrash = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? []
    ).find((button) => button.textContent?.trim() === "Empty Trash");
    await act(async () => {
      emptyTrash?.click();
      await flush();
    });

    expect(alertText()).toContain("Trash was emptied");
    expect(alertText()).toContain("database read failed");
    expect(alertText()).toContain("Retry refresh");

    mocks.refreshLibrary.mockResolvedValueOnce({
      ok: true,
      value: { totalLive: 0, trashTotal: 0 }
    });
    await clickErrorAction("Retry refresh");

    expect(
      mocks.dispatch.mock.calls.filter(([name]) => name === "library:purgeAll")
    ).toHaveLength(1);
    expect(mocks.refreshLibrary).toHaveBeenCalledTimes(3);
    expect(alertText()).toBeNull();
  });
});

async function clickErrorAction(label: string): Promise<void> {
  const button = Array.from(
    toastStack?.querySelectorAll<HTMLButtonElement>('[role="alert"] button') ?? []
  ).find((candidate) => candidate.textContent?.trim() === label);
  expect(button, label).not.toBeUndefined();
  await act(async () => {
    button?.click();
    await flush();
  });
}
