import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  getSources: vi.fn(),
  getAllDisplays: vi.fn()
}));

vi.mock("electron", () => ({
  desktopCapturer: { getSources: electronMocks.getSources },
  screen: { getAllDisplays: electronMocks.getAllDisplays }
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

const realPlatform = process.platform;

beforeEach(() => {
  electronMocks.getSources.mockReset();
  electronMocks.getAllDisplays.mockReset();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("Windows picker requested-size policy", () => {
  test("pure window mode caps a 4K physical request without changing aspect ratio", async () => {
    const { windowsPickerSourceRequestSize } = await import("../screencapture");
    expect(
      windowsPickerSourceRequestSize({ width: 1_920, height: 1_080 }, 2, "window")
    ).toEqual({ width: 1_920, height: 1_080 });
  });

  test("auto and region keep full trigger-time physical pixels for an exact commit crop", async () => {
    const { windowsPickerSourceRequestSize } = await import("../screencapture");
    expect(windowsPickerSourceRequestSize({ width: 1_920, height: 1_080 }, 2, "auto")).toEqual({
      width: 3_840,
      height: 2_160
    });
    expect(
      windowsPickerSourceRequestSize({ width: 1_920, height: 1_080 }, 2, "region")
    ).toEqual({ width: 3_840, height: 2_160 });
  });

  test("the preview cap never upscales and handles portrait displays deterministically", async () => {
    const { boundedPickerPreviewSize } = await import("../screencapture");
    expect(boundedPickerPreviewSize({ width: 1_200, height: 800 })).toEqual({
      width: 1_200,
      height: 800
    });
    expect(boundedPickerPreviewSize({ width: 1_080, height: 2_400 })).toEqual({
      width: 864,
      height: 1_920
    });
  });
});

describe("captureWindowsPickerSnapshot", () => {
  const display = {
    id: 7,
    bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
    scaleFactor: 2
  };

  test("window mode requests only the capped source and discards full display pixels", async () => {
    const calls: string[] = [];
    const image = {
      isEmpty: () => false,
      getSize: () => {
        calls.push("size");
        return { width: 1_920, height: 1_080 };
      },
      resize: vi.fn(),
      toJPEG: vi.fn(() => {
        calls.push("jpeg");
        return Buffer.from("preview");
      })
    };
    electronMocks.getAllDisplays.mockReturnValue([display]);
    electronMocks.getSources.mockImplementation(async (options) => {
      calls.push("getSources");
      expect(options).toEqual({
        types: ["screen"],
        thumbnailSize: { width: 1_920, height: 1_080 }
      });
      return [{ id: "screen:7:0", display_id: "7", thumbnail: image }];
    });

    const { captureWindowsPickerSnapshot } = await import("../screencapture");
    const result = await captureWindowsPickerSnapshot(7, "window");

    expect(calls).toEqual(["getSources", "size", "jpeg"]);
    expect(image.resize).not.toHaveBeenCalled();
    expect(result.fullImage).toBeNull();
    expect(result.previewBytes).toEqual(Buffer.from("preview"));
    expect(result.timings).toMatchObject({
      requestedSize: { width: 1_920, height: 1_080 },
      sourceSize: { width: 1_920, height: 1_080 },
      previewSize: { width: 1_920, height: 1_080 },
      previewByteSize: 7,
      retainedFullImage: false
    });
  });

  test("auto mode retains the full source but encodes only a capped JPEG preview", async () => {
    const calls: string[] = [];
    const preview = {
      toJPEG: vi.fn(() => {
        calls.push("jpeg");
        return Buffer.from("small-jpeg");
      })
    };
    const fullImage = {
      isEmpty: () => false,
      getSize: () => {
        calls.push("size");
        return { width: 3_840, height: 2_160 };
      },
      resize: vi.fn((options) => {
        calls.push("resize");
        expect(options).toEqual({ width: 1_920, height: 1_080, quality: "good" });
        return preview;
      })
    };
    electronMocks.getAllDisplays.mockReturnValue([display]);
    electronMocks.getSources.mockImplementation(async (options) => {
      calls.push("getSources");
      expect(options).toEqual({
        types: ["screen"],
        thumbnailSize: { width: 3_840, height: 2_160 }
      });
      return [{ id: "screen:7:0", display_id: "7", thumbnail: fullImage }];
    });

    const { captureWindowsPickerSnapshot } = await import("../screencapture");
    const result = await captureWindowsPickerSnapshot(7, "auto");

    expect(calls).toEqual(["getSources", "size", "resize", "jpeg"]);
    expect(result.fullImage).toBe(fullImage);
    expect(result.timings).toMatchObject({
      requestedSize: { width: 3_840, height: 2_160 },
      previewSize: { width: 1_920, height: 1_080 },
      retainedFullImage: true
    });
    expect(result.timings.getSourcesMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.previewEncodeMs).toBeGreaterThanOrEqual(0);
  });
});
