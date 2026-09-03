import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureInvocation } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => {
  const png = Buffer.from("png-fixture");
  return {
    png,
    getSources: vi.fn(),
    mkdtemp: vi.fn(),
    writeFile: vi.fn()
  };
});

vi.mock("node:fs/promises", () => ({
  mkdtemp: mocks.mkdtemp,
  writeFile: mocks.writeFile
}));

vi.mock("electron", () => ({
  desktopCapturer: { getSources: mocks.getSources },
  screen: {
    getAllDisplays: () => [
      {
        id: 42,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1.5
      }
    ]
  }
}));

vi.mock("sharp", () => ({ default: vi.fn() }));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

vi.mock("../permissions", () => ({
  classifyCaptureError: () => "error"
}));

type LogEntry = {
  message: string;
  fields: Record<string, unknown>;
};

const invocation: CaptureInvocation = {
  id: "trace-windows-screen-1",
  origin: "global_hotkey.window",
  triggerMonotonicMs: 100,
  dispatchMonotonicMs: 100,
  triggerWallTime: "2026-09-03T12:00:00.000Z"
};

const originalPlatform = process.platform;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  vi.spyOn(Date, "now").mockReturnValue(1234);
  mocks.mkdtemp.mockResolvedValue("C:\\Temp\\pwrsnap-screen-test");
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.getSources.mockResolvedValue([
    {
      display_id: "42",
      thumbnail: {
        getSize: () => ({ width: 2880, height: 1620 }),
        toPNG: () => mocks.png
      }
    }
  ]);
});

afterEach(() => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true
  });
  vi.restoreAllMocks();
});

describe("captureScreen latency instrumentation", () => {
  test("decomposes the Windows frozen-frame path without changing its bytes", async () => {
    const entries: LogEntry[] = [];
    const ticks = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111];
    const { CaptureLatencyTrace } = await import("../capture-latency-trace");
    const trace = new CaptureLatencyTrace(invocation, "window", {
      monotonicNow: () => ticks.shift() ?? 111,
      wallNow: () => "2026-09-03T12:00:01.000Z",
      logger: {
        debug: (message, fields) => entries.push({ message, fields }),
        info: (message, fields) => entries.push({ message, fields })
      }
    });
    const { captureScreen } = await import("../screencapture");

    const result = await captureScreen(42, trace);
    trace.finish("presented");

    expect(result).toEqual({
      ok: true,
      tempPath: "C:\\Temp\\pwrsnap-screen-test/1234.png",
      displayId: 42
    });
    expect(mocks.getSources).toHaveBeenCalledWith({
      types: ["screen"],
      thumbnailSize: { width: 2880, height: 1620 }
    });
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "C:\\Temp\\pwrsnap-screen-test/1234.png",
      mocks.png
    );

    const stages = entries
      .filter((entry) => entry.fields.event === "capture_latency_stage")
      .filter((entry) => String(entry.fields.stage).startsWith("screen_"))
      .map((entry) => entry.fields);
    expect(stages.map((entry) => entry.stage)).toEqual([
      "screen_temp_allocation",
      "screen_get_sources",
      "screen_source_selection",
      "screen_to_png",
      "screen_file_write"
    ]);
    expect(stages.map((entry) => entry.durationMs)).toEqual([1, 1, 1, 1, 1]);
    expect(stages[1]).toMatchObject({
      sourceCount: 1,
      requestedWidthPx: 2880,
      requestedHeightPx: 1620
    });
    expect(stages[2]).toMatchObject({ strategy: "display_id", sourceCount: 1 });
    expect(stages[3]).toMatchObject({
      byteSize: mocks.png.length
    });
    expect(stages[4]).toMatchObject({ byteSize: mocks.png.length });
    expect(stages.every((stage) => stage.invocationId === invocation.id)).toBe(true);
  });
});
