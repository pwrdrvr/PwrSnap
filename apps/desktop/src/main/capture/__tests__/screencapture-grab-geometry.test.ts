// Pins the PRODUCTION wiring of the grab-geometry gate, not the pure
// helper's default. `grab-geometry.test.ts` already covers the arithmetic;
// what matters here is that the non-darwin grab path actually consults it,
// on every branch of the source-selection ladder, and turns a mismatch into
// a refusal instead of pixels.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  png: Buffer.from("png-fixture"),
  getSources: vi.fn(),
  mkdtemp: vi.fn(),
  writeFile: vi.fn(),
  logged: [] as Array<{ level: string; message: string; fields: unknown }>
}));

vi.mock("node:fs/promises", () => ({
  mkdtemp: mocks.mkdtemp,
  writeFile: mocks.writeFile
}));

vi.mock("electron", () => ({
  desktopCapturer: { getSources: mocks.getSources },
  // One opaque red pixel — what `electronBitmapPixelFormat()` probes with
  // before it will hand back a raw bitmap. RGBA8 layout.
  nativeImage: {
    createFromDataURL: () => ({ toBitmap: () => Buffer.from([0xff, 0x00, 0x00, 0xff]) })
  },
  screen: {
    getAllDisplays: () => [
      { id: 42, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      { id: 43, bounds: { x: 1920, y: 0, width: 1200, height: 1920 }, scaleFactor: 1 }
    ]
  }
}));

vi.mock("sharp", () => ({ default: vi.fn() }));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: (message: string, fields: unknown) =>
      mocks.logged.push({ level: "debug", message, fields }),
    info: (message: string, fields: unknown) =>
      mocks.logged.push({ level: "info", message, fields }),
    warn: (message: string, fields: unknown) =>
      mocks.logged.push({ level: "warn", message, fields }),
    error: (message: string, fields: unknown) =>
      mocks.logged.push({ level: "error", message, fields })
  })
}));

vi.mock("../permissions", () => ({ classifyCaptureError: () => "error" }));

const originalPlatform = process.platform;

function thumbnail(width: number, height: number) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => mocks.png
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.logged.length = 0;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  vi.spyOn(Date, "now").mockReturnValue(1234);
  mocks.mkdtemp.mockResolvedValue("/tmp/pwrsnap-screen-test");
  mocks.writeFile.mockResolvedValue(undefined);
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  vi.restoreAllMocks();
});

describe("non-darwin screen grab is checked against the display it claims", () => {
  test("a matching grab still succeeds", async () => {
    mocks.getSources.mockResolvedValue([
      { id: "screen:0:0", name: "Entire screen", display_id: "42", thumbnail: thumbnail(1920, 1080) }
    ]);
    const { captureScreen } = await import("../screencapture");
    await expect(captureScreen(42)).resolves.toMatchObject({ ok: true, displayId: 42 });
  });

  test("the portal shape — one opaque source, no display_id — is no longer trusted blindly", async () => {
    // This is the branch the Wayland bug takes. It is `single_source`, NOT
    // the warned index fallback, so the log line a triage grep would look
    // for ("no source matched display_id") is never emitted: the selection
    // is silent by design. The geometry check is what makes it audible.
    mocks.getSources.mockResolvedValue([
      { id: "screen:0:0", name: "Screen 1", display_id: "", thumbnail: thumbnail(3840, 1080) }
    ]);
    const { captureScreen } = await import("../screencapture");
    const result = await captureScreen(42);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("error");
      expect(result.message).toContain("something other than this display");
      expect(result.message).toContain("single_source");
    }
    expect(
      mocks.logged.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message.includes("no source matched display_id")
      )
    ).toBe(false);
    expect(
      mocks.logged.some(
        (entry) =>
          entry.level === "error" &&
          entry.message.includes("does not match the display it was asked for")
      )
    ).toBe(true);
  });

  test("the index fallback cannot hand back a differently-shaped monitor", async () => {
    // Display 43 is portrait; the index fallback would take sources[1] for
    // it. Here sources[1] is landscape, so it is some other screen.
    mocks.getSources.mockResolvedValue([
      { id: "screen:0:0", name: "Screen 1", display_id: "", thumbnail: thumbnail(1920, 1080) },
      { id: "screen:1:0", name: "Screen 2", display_id: "", thumbnail: thumbnail(1920, 1080) }
    ]);
    const { captureScreen } = await import("../screencapture");
    const result = await captureScreen(43);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("display_index");
  });

  test("the Windows raw-bitmap fast path goes through the same gate", async () => {
    mocks.getSources.mockResolvedValue([
      { id: "screen:0:0", name: "Screen 1", display_id: "", thumbnail: thumbnail(1024, 768) }
    ]);
    const { captureDisplayBitmap } = await import("../screencapture");
    await expect(
      captureDisplayBitmap({
        id: 42,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1
      } as never)
    ).rejects.toThrow(/something other than this display/);
  });

  test("a mismatched grab writes no file", async () => {
    mocks.getSources.mockResolvedValue([
      { id: "screen:0:0", name: "Screen 1", display_id: "", thumbnail: thumbnail(1024, 768) }
    ]);
    const { captureScreen } = await import("../screencapture");
    await captureScreen(42);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
