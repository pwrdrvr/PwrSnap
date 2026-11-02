import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
vi.mock("node:util", () => ({ promisify: () => mocks.run }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("../log", () => ({ getMainLogger: () => mocks }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test("helper failure exposes exit metadata without logging output contents", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  Object.defineProperty(process, "resourcesPath", { value: "/fixture", configurable: true });
  mocks.run.mockRejectedValueOnce(Object.assign(new Error("private stderr"), {
    code: "ETIMEDOUT", signal: "SIGTERM", killed: true,
    stdout: "private title", stderr: "private stderr"
  }));
  const { listWindowsSnapshot } = await import("../capture/window-list");
  expect(await listWindowsSnapshot()).toEqual({ windows: [], frontmostPid: null, frontmostBundleId: null });
  expect(mocks.warn).toHaveBeenCalledWith("window-list helper failed", expect.objectContaining({
    code: "ETIMEDOUT", signal: "SIGTERM", killed: true, timeoutMs: 2000,
    durationMs: expect.any(Number), mainLoopActiveMs: expect.any(Number),
    stdoutBytes: 13, stderrBytes: 14
  }));
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("private");
});
