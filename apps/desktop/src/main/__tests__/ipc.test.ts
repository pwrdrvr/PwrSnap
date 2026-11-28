import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { IPC_CART_ZIP_DRAG_START, IPC_VIDEO_DRAG_START, ok } from "@pwrsnap/shared";

const electronMock = vi.hoisted(() => ({
  handler: null as
    | ((
        event: unknown,
        name: string,
        req: unknown,
        documentId?: unknown
      ) => Promise<unknown>)
    | null,
  fromWebContents: vi.fn(),
  handle: vi.fn(),
  on: vi.fn(),
  removeAllListeners: vi.fn(),
  removeHandler: vi.fn(),
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => true
    })),
    createEmpty: vi.fn(() => ({ isEmpty: () => true }))
  }
}));

const relayMock = vi.hoisted(() => ({
  cancel: vi.fn()
}));

vi.mock("../process-split/event-relay", () => ({
  relayCancellationToPeer: relayMock.cancel
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: electronMock.fromWebContents
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: typeof electronMock.handler) => {
      electronMock.handle(channel, handler);
      electronMock.handler = handler;
    }),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      electronMock.on(channel, listener);
    }),
    removeHandler: vi.fn((channel: string) => {
      electronMock.removeHandler(channel);
      electronMock.handler = null;
    }),
    removeAllListeners: vi.fn((channel: string) => {
      electronMock.removeAllListeners(channel);
    })
  },
  nativeImage: electronMock.nativeImage
}));

const { bus } = await import("../command-bus");
const { disposeIpcDispatcher, registerIpcDispatcher } = await import("../ipc");

describe("IPC dispatcher", () => {
  afterEach(() => {
    disposeIpcDispatcher();
    bus.unregister("codex:enrich");
    bus.unregister("settings:open");
    bus.unregister("video:export");
    bus.unregister("video:prepareDrag");
    vi.clearAllMocks();
  });

  test("keys renderer-started codex enrichment to capture cancellation", async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    bus.register("codex:enrich", async (_req, ctx) => {
      captured.signal = ctx.signal;
      return ok({ runId: "run_1" });
    });
    registerIpcDispatcher();
    const mainFrame = { processId: 17, routingId: 29 };
    const sender = {
      id: 9,
      isDestroyed: () => false,
      mainFrame
    };

    const result = await electronMock.handler?.(
      { sender, senderFrame: mainFrame },
      "codex:enrich",
      { captureId: "cap_1" },
      "documentepoch0001"
    );

    expect(result).toEqual({ ok: true, value: { runId: "run_1" } });
    expect(captured.signal?.aborted).toBe(false);
    bus.cancel("cap_1");
    expect(captured.signal?.aborted).toBe(true);
  });

  test("passes the sender window and renderer-document ids into command context", async () => {
    const captured: {
      sourceWindowId: number | undefined;
      sourceDocumentId: string | undefined;
    } = { sourceWindowId: undefined, sourceDocumentId: undefined };
    const mainFrame = { processId: 17, routingId: 29 };
    const sender = {
      id: 9,
      marker: "sender",
      isDestroyed: () => false,
      mainFrame
    };
    electronMock.fromWebContents.mockReturnValue({ id: 123 });
    bus.register("settings:open", async (_req, ctx) => {
      captured.sourceWindowId = ctx.sourceWindowId;
      captured.sourceDocumentId = ctx.sourceDocumentId;
      return ok(undefined);
    });
    registerIpcDispatcher();

    await electronMock.handler?.(
      { sender, senderFrame: mainFrame, processId: 17, frameId: 29 },
      "settings:open",
      {},
      "documentepoch0001"
    );

    expect(electronMock.fromWebContents).toHaveBeenCalledWith(sender);
    expect(captured.sourceWindowId).toBe(123);
    expect(captured.sourceDocumentId).toBe("documentepoch0001");
  });

  test("does not admit an epoch sent by a document that is no longer the current main frame", async () => {
    const captured: { sourceDocumentId: string | undefined } = {
      sourceDocumentId: undefined
    };
    const mainFrame = { processId: 17, routingId: 30 };
    const staleFrame = { processId: 17, routingId: 29 };
    const sender = {
      id: 9,
      isDestroyed: () => false,
      mainFrame
    };
    electronMock.fromWebContents.mockReturnValue({ id: 123 });
    bus.register("settings:open", async (_req, ctx) => {
      captured.sourceDocumentId = ctx.sourceDocumentId;
      return ok(undefined);
    });
    registerIpcDispatcher();

    await electronMock.handler?.(
      { sender, senderFrame: staleFrame, processId: 17, frameId: 29 },
      "settings:open",
      {},
      "documentepoch0001"
    );

    expect(captured.sourceDocumentId).toBeUndefined();
  });

  test("window teardown aborts a run-scoped video export locally and on the peer", async () => {
    const sender = Object.assign(new EventEmitter(), {
      id: 9,
      isDestroyed: () => false,
      mainFrame: null
    });
    const observed: { signal: AbortSignal | null } = { signal: null };
    bus.register("video:export", async (_req, ctx) => {
      observed.signal = ctx.signal;
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return ok({
        path: "/cache/export.mp4",
        byteSize: 1,
        durationSec: 1,
        widthPx: 2,
        heightPx: 2,
        fromCache: false
      });
    });
    registerIpcDispatcher();

    const pending = electronMock.handler?.(
      { sender },
      "video:export",
      { captureId: "cap_1", format: "mp4", preset: "low", runId: "run-window" }
    );
    await new Promise((resolve) => setImmediate(resolve));
    sender.emit("destroyed");
    await pending;

    expect(observed.signal?.aborted).toBe(true);
    expect(relayMock.cancel).toHaveBeenCalledWith("video-export:run-window");
    expect(sender.listenerCount("destroyed")).toBe(0);
  });
});

describe("video drag-out bridge", () => {
  afterEach(() => {
    disposeIpcDispatcher();
    bus.unregister("video:prepareDrag");
    vi.clearAllMocks();
  });

  async function drag(payload: unknown): Promise<unknown[]> {
    const seen: unknown[] = [];
    bus.register("video:prepareDrag", async (req) => {
      seen.push(req);
      return { ok: false, error: { kind: "validation", code: "stop", message: "stop" } };
    });
    registerIpcDispatcher();
    const call = electronMock.on.mock.calls.find(([channel]) => channel === IPC_VIDEO_DRAG_START);
    const listener = call?.[1] as ((event: unknown, req: unknown) => void) | undefined;
    if (listener === undefined) throw new Error("no video drag listener registered");
    listener({ sender: { isDestroyed: () => false, startDrag: vi.fn() } }, payload);
    await new Promise((resolve) => setImmediate(resolve));
    return seen;
  }

  const base = { captureId: "cap_1", format: "mp4", preset: "high" };

  test("carries the grid's MP4 audio choice through to video:prepareDrag", async () => {
    const audio = { includeSystemAudio: true, includeMicrophone: false };
    expect(await drag({ ...base, audio })).toEqual([{ ...base, audio }]);
  });

  test("an omitted audio choice stays omitted, so main applies the saved preference", async () => {
    const [req] = await drag(base);
    expect(req).toEqual(base);
    expect(req).not.toHaveProperty("audio");
  });

  // A malformed range falls back to the default range; a malformed audio
  // choice is not guessed at when the question is whether to ship a mic.
  test.each([
    ["a string", "none"],
    ["null", null],
    ["a non-boolean toggle", { includeSystemAudio: true, includeMicrophone: "no" }]
  ])("refuses the drag when audio is %s", async (_label, audio) => {
    expect(await drag({ ...base, audio })).toEqual([]);
  });
});

describe("cart drag-out bridge", () => {
  afterEach(() => {
    disposeIpcDispatcher();
    bus.unregister("cart:prepareZipDrag");
    bus.unregister("cart:prepareFilesDrag");
    bus.unregister("cart:prepareSheetDrag");
    vi.clearAllMocks();
  });

  async function drag(payload: unknown): Promise<{ verb: string | null; startDrag: ReturnType<typeof vi.fn> }> {
    let verb: string | null = null;
    bus.register("cart:prepareZipDrag", async () => {
      verb = "zip";
      return ok({ path: "/tmp/cart.zip", fileCount: 2, iconPath: null });
    });
    bus.register("cart:prepareFilesDrag", async () => {
      verb = "files";
      return ok({ paths: ["/tmp/a.png", "/tmp/b.png"], iconPath: null });
    });
    bus.register("cart:prepareSheetDrag", async () => {
      verb = "sheet";
      return ok({ path: "/tmp/sheet.png", iconPath: null });
    });
    registerIpcDispatcher();
    const call = electronMock.on.mock.calls.find(([channel]) => channel === IPC_CART_ZIP_DRAG_START);
    const listener = call?.[1] as ((event: unknown, req: unknown) => void) | undefined;
    if (listener === undefined) throw new Error("no cart drag listener registered");
    const startDrag = vi.fn();
    listener({ sender: { isDestroyed: () => false, startDrag } }, payload);
    await new Promise((resolve) => setImmediate(resolve));
    return { verb, startDrag };
  }

  const ids = ["cap_1", "cap_2"];

  test("a payload without a kind is the Zip, dragged as one file", async () => {
    const { verb, startDrag } = await drag({ captureIds: ids, preset: "med" });
    expect(verb).toBe("zip");
    expect(startDrag.mock.calls[0]?.[0]).toMatchObject({ file: "/tmp/cart.zip" });
    expect(startDrag.mock.calls[0]?.[0]).not.toHaveProperty("files");
  });

  test("Copy all's chip drags every image as its own file", async () => {
    const { verb, startDrag } = await drag({ kind: "files", captureIds: ids, preset: "high" });
    expect(verb).toBe("files");
    expect(startDrag.mock.calls[0]?.[0]).toMatchObject({ files: ["/tmp/a.png", "/tmp/b.png"] });
  });

  test("the sheet chip drags the sheet", async () => {
    const { verb, startDrag } = await drag({
      kind: "sheet",
      captureIds: ids,
      size: "m",
      layout: { columns: "auto", spacing: "tight", background: "hatch" }
    });
    expect(verb).toBe("sheet");
    expect(startDrag.mock.calls[0]?.[0]).toMatchObject({ file: "/tmp/sheet.png" });
  });

  test.each([
    ["an unknown kind", { kind: "pdf", captureIds: ids, preset: "med" }],
    ["a sheet without a size", { kind: "sheet", captureIds: ids, layout: {} }],
    ["files without a preset", { kind: "files", captureIds: ids }],
    ["no ids", { captureIds: [], preset: "med" }]
  ])("refuses %s before any prepare", async (_label, payload) => {
    const { verb, startDrag } = await drag(payload);
    expect(verb).toBeNull();
    expect(startDrag).not.toHaveBeenCalled();
  });
});
