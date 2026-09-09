import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import sharp from "sharp";

const captureMocks = vi.hoisted(() => ({
  captureDisplayBitmap: vi.fn(),
  captureScreen: vi.fn()
}));
const mappingMocks = vi.hoisted(() => ({
  createWindowsSharedSnapshot: vi.fn(),
  read: vi.fn(),
  release: vi.fn()
}));

vi.mock("electron", () => ({
  screen: {
    getAllDisplays: () => [
      {
        id: 7,
        bounds: { x: 0, y: 0, width: 2, height: 1 },
        scaleFactor: 1
      }
    ]
  }
}));

vi.mock("../screencapture", () => ({
  captureDisplayBitmap: captureMocks.captureDisplayBitmap,
  captureScreen: captureMocks.captureScreen
}));

vi.mock("../windows-shared-snapshot", () => ({
  createWindowsSharedSnapshot: mappingMocks.createWindowsSharedSnapshot
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

const realPlatform = process.platform;
let snapshots: typeof import("../screen-snapshot") | null = null;

beforeEach(async () => {
  vi.resetModules();
  captureMocks.captureDisplayBitmap.mockReset();
  captureMocks.captureScreen.mockReset();
  mappingMocks.createWindowsSharedSnapshot.mockReset();
  mappingMocks.read.mockReset();
  mappingMocks.release.mockReset();
  const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);
  captureMocks.captureDisplayBitmap.mockResolvedValue({
    bitmap: pixels,
    width: 2,
    height: 1,
    sourcePixelFormat: "rgba8"
  });
  mappingMocks.read.mockImplementation(async () => Buffer.from(pixels));
  mappingMocks.release.mockResolvedValue(undefined);
  mappingMocks.createWindowsSharedSnapshot.mockResolvedValue({
    header: {
      version: 1,
      width: 2,
      height: 1,
      stride: 8,
      pixelFormat: 1,
      byteLength: 8,
      totalByteLength: 72,
      nonceHex: "00112233445566778899aabbccddeeff"
    },
    read: mappingMocks.read,
    release: mappingMocks.release
  });
  snapshots = await import("../screen-snapshot");
  // Stub only after module import so sharp loads this host's native binary;
  // captureAndRegister reads process.platform at call time.
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
});

afterEach(async () => {
  await snapshots?.releaseAllSnapshots();
  snapshots = null;
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("screen snapshot registry Windows transport", () => {
  test("falls back to the PNG transport when the raw bitmap is malformed", async () => {
    captureMocks.captureDisplayBitmap.mockResolvedValueOnce({
      bitmap: Buffer.alloc(4), width: 2, height: 1, sourcePixelFormat: "rgba8"
    });
    captureMocks.captureScreen.mockResolvedValue({
      ok: true,
      tempPath: "/tmp/pwrsnap-test-shared-snapshot-fallback/snapshot.png",
      displayId: 7
    });

    const snapshot = await snapshots!.captureAndRegister(7);

    expect(snapshot).toMatchObject({
      displayId: 7,
      transport: "png-file",
      acquisition: {
        mappingWriteBytes: 0,
        fullScreenPngEncodeCount: 1
      }
    });
    expect(captureMocks.captureScreen).toHaveBeenCalledWith(7, undefined);
  });

  test("paint and crop lease the retained buffer without invoking a mapping helper", async () => {
    const snapshot = await snapshots!.captureAndRegister(7);

    expect(snapshot).toMatchObject({
      displayId: 7,
      transport: "raw-rgba",
      selectorDescriptor: {
        transport: "raw-rgba",
        version: 1,
        width: 2,
        height: 1,
        byteLength: 8
      },
      acquisition: {
        sourceBitmapBytes: 8,
        mappingWriteBytes: 0,
        retainedBitmapBytes: 8,
        fullScreenPngEncodeCount: 0,
        fullScreenTempFileWriteBytes: 0
      }
    });
    expect(snapshot.selectorDescriptor).not.toHaveProperty("nonceHex");
    expect(snapshot.selectorDescriptor).not.toHaveProperty("mappingName");
    expect(captureMocks.captureScreen).not.toHaveBeenCalled();

    const renderer = await snapshots!.readSnapshotForRenderer(snapshot.id);
    expect(renderer).toMatchObject({ ok: true, header: { width: 2, height: 1 } });
    if (!renderer.ok) throw new Error("renderer mapping read unexpectedly failed");
    expect([...renderer.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);

    const crop = await snapshots!.acquireSnapshotRaster(snapshot.id, "crop");
    expect(crop?.source).toMatchObject({ kind: "rgba8", width: 2, height: 1 });
    if (crop?.source.kind !== "rgba8") throw new Error("raw crop missing");
    expect(crop.source.data).toBe(renderer.data);
    expect(mappingMocks.createWindowsSharedSnapshot).not.toHaveBeenCalled();
    expect(mappingMocks.read).not.toHaveBeenCalled();
    await crop?.release();
    await snapshots!.releaseSnapshot(snapshot.id);
    expect(mappingMocks.release).not.toHaveBeenCalled();
  });

  test("creates the PNG protocol fallback lazily from the retained pixels", async () => {
    const snapshot = await snapshots!.captureAndRegister(7);
    expect(mappingMocks.read).not.toHaveBeenCalled();

    const first = await snapshots!.getSnapshotPngPath(snapshot.id);
    const second = await snapshots!.getSnapshotPngPath(snapshot.id);

    expect(first).toMatch(/\.png$/);
    expect(second).toBe(first);
    expect(mappingMocks.read).not.toHaveBeenCalled();
    const pixels = await sharp(first!).ensureAlpha().raw().toBuffer();
    expect([...pixels]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    expect(captureMocks.captureScreen).not.toHaveBeenCalled();
  });

  test("release waits for an admitted crop lease and a new capture cannot replace its bytes", async () => {
    const snapshot = await snapshots!.captureAndRegister(7);
    const crop = await snapshots!.acquireSnapshotRaster(snapshot.id, "crop");
    if (crop === null) throw new Error("crop lease unexpectedly missing");

    let released = false;
    const release = snapshots!.releaseSnapshot(snapshot.id).then(() => {
      released = true;
    });
    let repeatedReleaseResolved = false;
    const repeatedRelease = snapshots!.releaseSnapshot(snapshot.id).then(() => {
      repeatedReleaseResolved = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(repeatedReleaseResolved).toBe(false);
    expect(mappingMocks.release).not.toHaveBeenCalled();
    expect(await snapshots!.acquireSnapshotRaster(snapshot.id, "renderer")).toBeNull();
    captureMocks.captureDisplayBitmap.mockResolvedValueOnce({
      bitmap: Buffer.from([0, 0, 255, 0, 255, 0, 0, 0]),
      width: 2, height: 1, sourcePixelFormat: "rgba8"
    });
    const next = await snapshots!.captureAndRegister(7);
    const nextPixels = await snapshots!.readSnapshotForRenderer(next.id);
    if (!nextPixels.ok || crop.source.kind !== "rgba8") throw new Error("raw source missing");
    expect([...nextPixels.data]).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
    expect([...crop.source.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);

    await crop.release();
    await Promise.all([release, repeatedRelease]);
    expect(released).toBe(true);
    expect(repeatedReleaseResolved).toBe(true);
    expect(mappingMocks.release).not.toHaveBeenCalled();
  });

  test("normalizes BGRA channels and opaque alpha once in place before publication", async () => {
    const bitmap = Buffer.from([10, 20, 30, 0, 40, 50, 60, 128]);
    captureMocks.captureDisplayBitmap.mockResolvedValueOnce({
      bitmap, width: 2, height: 1, sourcePixelFormat: "bgra8"
    });
    const snapshot = await snapshots!.captureAndRegister(7);
    for (let i = 0; i < 2; i += 1) {
      const read = await snapshots!.readSnapshotForRenderer(snapshot.id);
      if (!read.ok) throw new Error("raw source missing");
      expect(read.data).toBe(bitmap);
      expect([...read.data]).toEqual([30, 20, 10, 255, 60, 50, 40, 255]);
    }
  });
});
