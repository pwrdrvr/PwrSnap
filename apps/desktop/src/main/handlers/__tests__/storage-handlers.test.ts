import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (req: unknown) => Promise<unknown>>(),
  maintainRenderCache: vi.fn(),
  send: vi.fn()
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: () => false,
        webContents: { send: mocks.send }
      }
    ])
  },
  session: {
    defaultSession: {
      clearCache: vi.fn(async () => undefined),
      clearCodeCaches: vi.fn(async () => undefined)
    }
  }
}));

vi.mock("../../command-bus", () => ({
  bus: {
    register: vi.fn((name: string, handler: (req: unknown) => Promise<unknown>) => {
      mocks.handlers.set(name, handler);
    })
  }
}));

vi.mock("../../storage/accounting", () => ({
  getStorageSnapshot: vi.fn(async () => ({
    capturedAt: new Date(0).toISOString(),
    totalBytes: 0,
    sourceCaptures: {
      bytes: 0,
      fileCount: 0,
      captureCount: 0,
      documentsBytes: 0,
      appSupportBytes: 0
    },
    renderCache: { bytes: 0, fileCount: 0 },
    chromiumHttpCache: { bytes: 0, fileCount: 0, reportedBytes: 0, limitBytes: 0 },
    chromiumCodeCache: { bytes: 0, fileCount: 0 },
    chromiumGpuCaches: { bytes: 0, fileCount: 0 },
    database: { bytes: 0, walBytes: 0, shmBytes: 0, pageCount: 0, pageSize: 4096, freelistCount: 0 },
    otherAppSupport: { bytes: 0, fileCount: 0 }
  })),
  getStorageSummary: vi.fn(() => ({
    capturedAt: new Date(0).toISOString(),
    sourceCaptures: { bytes: 0, captureCount: 0 }
  })),
  maintainRenderCache: mocks.maintainRenderCache,
  onStorageSnapshotUpdated: vi.fn((listener: (payload: unknown) => void) => {
    listener({ snapshot: { capturedAt: new Date(0).toISOString() }, scanning: true });
    return vi.fn();
  })
}));

beforeEach(() => {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.maintainRenderCache.mockReset();
  mocks.send.mockReset();
});

describe("storage handlers", () => {
  test("rejects invalid render-cache maintenance modes before touching files", async () => {
    const { registerStorageHandlers } = await import("../storage-handlers");
    registerStorageHandlers();

    const handler = mocks.handlers.get("storage:maintainRenderCache");
    expect(handler).toBeDefined();
    const result = await handler!({ mode: "delete" });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "validation",
        code: "invalid_render_cache_mode",
        message: "storage:maintainRenderCache mode must be 'trim' or 'clear'"
      }
    });
    expect(mocks.maintainRenderCache).not.toHaveBeenCalled();
  });
});
