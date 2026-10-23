import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSources: vi.fn(),
  mkdtemp: vi.fn(),
  writeFile: vi.fn(),
  execFile: vi.fn(),
  classifyCaptureError: vi.fn(() => "error" as const),
  releaseWindowCaptureTemp: vi.fn(),
  info: vi.fn(),
  warn: vi.fn()
}));

vi.mock("electron", () => ({
  desktopCapturer: { getSources: mocks.getSources },
  screen: {
    getAllDisplays: () => [],
    getDisplayNearestPoint: () => ({ id: 1 })
  }
}));

vi.mock("node:fs/promises", () => ({
  mkdtemp: mocks.mkdtemp,
  writeFile: mocks.writeFile
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

vi.mock("../permissions", () => ({
  classifyCaptureError: mocks.classifyCaptureError
}));

vi.mock("../window-capture-temp", () => ({
  releaseWindowCaptureTemp: mocks.releaseWindowCaptureTemp
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: vi.fn(),
    info: mocks.info,
    warn: mocks.warn,
    error: vi.fn()
  })
}));

const originalPlatform = process.platform;
const mockTempDirectory = join(tmpdir(), "pwrsnap-window-failure-test");
const { captureWindow } = await import("../screencapture");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSources.mockResolvedValue([]);
  mocks.mkdtemp.mockResolvedValue(mockTempDirectory);
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.releaseWindowCaptureTemp.mockResolvedValue(undefined);
  mocks.execFile.mockImplementation(
    (
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (cause: Error) => void
    ) => {
      callback(Object.assign(new Error("fallback failed"), { code: 1 }));
    }
  );
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe("captureWindow failed-capture temp ownership", () => {
  test("win32 returns the desktopCapturer failure without invoking the macOS fallback", async () => {
    setPlatform("win32");

    const result = await captureWindow(42);

    expect(result).toEqual({
      ok: false,
      reason: "error",
      message: "The requested window could not be captured"
    });
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.releaseWindowCaptureTemp).toHaveBeenCalledTimes(1);
    const cleanedPath = mocks.releaseWindowCaptureTemp.mock.calls[0]?.[0] as string;
    expect(dirname(cleanedPath)).toBe(mockTempDirectory);
    expect(basename(cleanedPath)).toMatch(/^\d+\.png$/);
  });

  test("darwin cleans its temp directory when the native fallback also fails", async () => {
    setPlatform("darwin");

    const result = await captureWindow(42);

    expect(result).toMatchObject({
      ok: false,
      reason: "error",
      message: "The requested window could not be captured"
    });
    expect(mocks.execFile).toHaveBeenCalledWith(
      "/usr/sbin/screencapture",
      expect.arrayContaining(["-l", "42"]),
      { timeout: 5_000 },
      expect.any(Function)
    );
    expect(mocks.releaseWindowCaptureTemp).toHaveBeenCalledTimes(1);
  });

  test("cleanup failure is observable without replacing the typed capture failure", async () => {
    setPlatform("win32");
    mocks.releaseWindowCaptureTemp.mockRejectedValue(new Error("cleanup failed"));

    const result = await captureWindow(42);

    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(mocks.warn).toHaveBeenCalledWith(
      "failed to clean unsuccessful window-capture temp directory",
      { errorName: "Error" }
    );
  });

  test("does not log source names, source ids, or private temp paths", async () => {
    setPlatform("win32");
    const privateSourceName = "Payroll - Secret Compensation";
    const privateSourceId = "window:42:private-session";
    mocks.getSources.mockResolvedValue([
      {
        id: privateSourceId,
        name: privateSourceName,
        thumbnail: {
          getSize: () => ({ width: 800, height: 600 }),
          isEmpty: () => false,
          toPNG: () => Buffer.from("private-png")
        }
      }
    ]);

    const result = await captureWindow(42);

    expect(result).toMatchObject({ ok: true });
    const serializedLogs = JSON.stringify([
      ...mocks.info.mock.calls,
      ...mocks.warn.mock.calls
    ]);
    expect(serializedLogs).not.toContain(privateSourceName);
    expect(serializedLogs).not.toContain(privateSourceId);
    expect(serializedLogs).not.toContain(mockTempDirectory);
  });
});
