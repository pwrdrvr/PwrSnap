import { afterEach, describe, expect, test, vi } from "vitest";
import { ok } from "@pwrsnap/shared";

const electronMock = vi.hoisted(() => ({
  handler: null as
    | ((event: unknown, name: string, req: unknown) => Promise<unknown>)
    | null,
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
    vi.clearAllMocks();
  });

  test("keys renderer-started codex enrichment to capture cancellation", async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    bus.register("codex:enrich", async (_req, ctx) => {
      captured.signal = ctx.signal;
      return ok({ runId: "run_1" });
    });
    registerIpcDispatcher();

    const result = await electronMock.handler?.(null, "codex:enrich", { captureId: "cap_1" });

    expect(result).toEqual({ ok: true, value: { runId: "run_1" } });
    expect(captured.signal?.aborted).toBe(false);
    bus.cancel("cap_1");
    expect(captured.signal?.aborted).toBe(true);
  });
});
