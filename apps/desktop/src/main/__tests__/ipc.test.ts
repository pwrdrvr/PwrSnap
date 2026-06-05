import { afterEach, describe, expect, test, vi } from "vitest";
import { ok } from "@pwrsnap/shared";

const electronMock = vi.hoisted(() => ({
  handler: null as
    | ((event: unknown, name: string, req: unknown) => Promise<unknown>)
    | null,
  fromWebContents: vi.fn(),
  handle: vi.fn(),
  on: vi.fn(),
  removeAllListeners: vi.fn(),
  removeHandler: vi.fn(),
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => true
    }))
  }
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
    vi.clearAllMocks();
  });

  test("keys renderer-started codex enrichment to capture cancellation", async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    bus.register("codex:enrich", async (_req, ctx) => {
      captured.signal = ctx.signal;
      return ok({ runId: "run_1" });
    });
    registerIpcDispatcher();

    const result = await electronMock.handler?.(
      { sender: { marker: "sender" } },
      "codex:enrich",
      { captureId: "cap_1" }
    );

    expect(result).toEqual({ ok: true, value: { runId: "run_1" } });
    expect(captured.signal?.aborted).toBe(false);
    bus.cancel("cap_1");
    expect(captured.signal?.aborted).toBe(true);
  });

  test("passes the sender BrowserWindow id into command context", async () => {
    const captured: { sourceWindowId: number | undefined } = { sourceWindowId: undefined };
    electronMock.fromWebContents.mockReturnValue({ id: 123 });
    bus.register("settings:open", async (_req, ctx) => {
      captured.sourceWindowId = ctx.sourceWindowId;
      return ok(undefined);
    });
    registerIpcDispatcher();

    await electronMock.handler?.({ sender: { marker: "sender" } }, "settings:open", {});

    expect(electronMock.fromWebContents).toHaveBeenCalledWith({ marker: "sender" });
    expect(captured.sourceWindowId).toBe(123);
  });
});
