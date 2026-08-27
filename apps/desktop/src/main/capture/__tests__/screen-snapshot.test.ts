import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureScreen: vi.fn(),
  captureWindowsPickerSnapshot: vi.fn(),
  mkdtemp: vi.fn(),
  writeFile: vi.fn(),
  rm: vi.fn(),
  nextId: 0
}));

vi.mock("../screencapture", () => ({
  captureScreen: mocks.captureScreen,
  captureWindowsPickerSnapshot: mocks.captureWindowsPickerSnapshot
}));

vi.mock("node:fs/promises", () => ({
  mkdtemp: mocks.mkdtemp,
  writeFile: mocks.writeFile,
  rm: mocks.rm
}));

vi.mock("nanoid", () => ({
  nanoid: () => `snapshot-${++mocks.nextId}`
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

const realPlatform = process.platform;
const timingFixture = {
  getSourcesMs: 12,
  previewResizeMs: 2,
  previewEncodeMs: 3,
  totalMs: 17,
  requestedSize: { width: 3_840, height: 2_160 },
  sourceSize: { width: 3_840, height: 2_160 },
  previewSize: { width: 1_920, height: 1_080 },
  previewByteSize: 4,
  retainedFullImage: true
};

beforeEach(() => {
  vi.resetModules();
  mocks.captureScreen.mockReset();
  mocks.captureWindowsPickerSnapshot.mockReset();
  mocks.mkdtemp.mockReset();
  mocks.writeFile.mockReset();
  mocks.rm.mockReset();
  mocks.nextId = 0;
  mocks.mkdtemp.mockResolvedValue("/tmp/pwrsnap-owned");
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

function pickerCapture(fullImage: unknown, retainedFullImage = true) {
  return {
    previewBytes: Buffer.from("jpeg"),
    previewMimeType: "image/jpeg" as const,
    fullImage,
    displayId: 9,
    displayBounds: { x: -1_280, y: 0, width: 1_280, height: 720 },
    timings: { ...timingFixture, retainedFullImage }
  };
}

describe("in-memory Windows screen snapshots", () => {
  test("registers preview bytes and stage timings without creating a temp preview file", async () => {
    mocks.captureWindowsPickerSnapshot.mockResolvedValue(pickerCapture(null, false));
    const {
      captureAndRegister,
      getSnapshot,
      getSnapshotPath,
      getSnapshotPreview,
      getSnapshotProtocolSource
    } = await import("../screen-snapshot");

    const snapshot = await captureAndRegister(9, { mode: "window" });

    expect(snapshot).toMatchObject({
      kind: "memory",
      id: "snapshot-1",
      displayId: 9,
      mode: "window",
      timing: { getSourcesMs: 12, previewEncodeMs: 3 }
    });
    expect(getSnapshotPreview("snapshot-1")).toEqual({
      bytes: Buffer.from("jpeg"),
      mimeType: "image/jpeg"
    });
    expect(getSnapshotPath("snapshot-1")).toBeNull();
    expect(getSnapshotProtocolSource("snapshot-1")).toEqual({
      kind: "memory",
      bytes: Buffer.from("jpeg"),
      mimeType: "image/jpeg"
    });
    expect(getSnapshot("snapshot-1")).toEqual(snapshot);
    expect(mocks.mkdtemp).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  test("materializes the selected physical PNG once, then drops full display pixels", async () => {
    const png = Buffer.from("selected-png");
    const cropped = { toPNG: vi.fn(() => png) };
    const fullImage = {
      getSize: vi.fn(() => ({ width: 2_560, height: 1_440 })),
      crop: vi.fn(() => cropped)
    };
    mocks.captureWindowsPickerSnapshot.mockResolvedValue(pickerCapture(fullImage));
    const {
      captureAndRegister,
      cropRegisteredSnapshot,
      getSnapshotPreview
    } = await import("../screen-snapshot");
    const snapshot = await captureAndRegister(9, { mode: "region" });

    const result = await cropRegisteredSnapshot(
      snapshot.id,
      { x: -1_180, y: 50, w: 300, h: 200 },
      9
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(fullImage.crop).toHaveBeenCalledWith({ x: 200, y: 100, width: 600, height: 400 });
    expect(cropped.toPNG).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/^[/\\]tmp[/\\]pwrsnap-owned[/\\]\d+\.png$/),
      png
    );
    expect(result.timings).toMatchObject({
      outputByteSize: png.length,
      physicalRect: { x: 200, y: 100, width: 600, height: 400 }
    });
    // Preview remains usable until the selector releases the interaction.
    expect(getSnapshotPreview(snapshot.id)?.bytes).toEqual(Buffer.from("jpeg"));
    // Full pixels are single-consumer and no longer retained after durability.
    await expect(
      cropRegisteredSnapshot(snapshot.id, { x: -1_180, y: 50, w: 300, h: 200 }, 9)
    ).resolves.toMatchObject({ ok: false, reason: "error" });
  });

  test("maps a crop ending exactly at the right/bottom edge without overrunning", async () => {
    const cropped = { toPNG: vi.fn(() => Buffer.from("edge")) };
    const fullImage = {
      getSize: vi.fn(() => ({ width: 2_560, height: 1_440 })),
      crop: vi.fn(() => cropped)
    };
    mocks.captureWindowsPickerSnapshot.mockResolvedValue(pickerCapture(fullImage));
    const { captureAndRegister, cropRegisteredSnapshot } = await import("../screen-snapshot");
    const snapshot = await captureAndRegister(9, { mode: "region" });

    const result = await cropRegisteredSnapshot(
      snapshot.id,
      { x: -1, y: 719, w: 1, h: 1 },
      9
    );

    expect(result.ok).toBe(true);
    expect(fullImage.crop).toHaveBeenCalledWith({
      x: 2_558,
      y: 1_438,
      width: 2,
      height: 2
    });
  });

  test("clips left/top overhang before mapping the intersection to physical pixels", async () => {
    const cropped = { toPNG: vi.fn(() => Buffer.from("overhang")) };
    const fullImage = {
      getSize: vi.fn(() => ({ width: 2_560, height: 1_440 })),
      crop: vi.fn(() => cropped)
    };
    mocks.captureWindowsPickerSnapshot.mockResolvedValue(pickerCapture(fullImage));
    const { captureAndRegister, cropRegisteredSnapshot } = await import("../screen-snapshot");
    const snapshot = await captureAndRegister(9, { mode: "auto" });

    const result = await cropRegisteredSnapshot(
      snapshot.id,
      { x: -1_380, y: -50, w: 300, h: 200 },
      9
    );

    expect(result.ok).toBe(true);
    expect(fullImage.crop).toHaveBeenCalledWith({ x: 0, y: 0, width: 400, height: 300 });
  });

  test("clips a rect spanning beyond every display edge to the full retained image", async () => {
    const cropped = { toPNG: vi.fn(() => Buffer.from("spanning")) };
    const fullImage = {
      getSize: vi.fn(() => ({ width: 2_560, height: 1_440 })),
      crop: vi.fn(() => cropped)
    };
    mocks.captureWindowsPickerSnapshot.mockResolvedValue(pickerCapture(fullImage));
    const { captureAndRegister, cropRegisteredSnapshot } = await import("../screen-snapshot");
    const snapshot = await captureAndRegister(9, { mode: "region" });

    const result = await cropRegisteredSnapshot(
      snapshot.id,
      { x: -1_400, y: -100, w: 1_600, h: 1_000 },
      9
    );

    expect(result.ok).toBe(true);
    expect(fullImage.crop).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 2_560,
      height: 1_440
    });
  });

  test("rejects a rect with an empty intersection, including one merely touching an edge", async () => {
    const cropped = { toPNG: vi.fn(() => Buffer.from("later-valid")) };
    const fullImage = {
      getSize: vi.fn(() => ({ width: 2_560, height: 1_440 })),
      crop: vi.fn(() => cropped)
    };
    mocks.captureWindowsPickerSnapshot.mockResolvedValue(pickerCapture(fullImage));
    const { captureAndRegister, cropRegisteredSnapshot } = await import("../screen-snapshot");
    const snapshot = await captureAndRegister(9, { mode: "auto" });

    await expect(
      cropRegisteredSnapshot(snapshot.id, { x: 0, y: 100, w: 200, h: 200 }, 9)
    ).resolves.toMatchObject({
      ok: false,
      reason: "validation",
      message: expect.stringContaining("does not intersect")
    });
    expect(fullImage.getSize).not.toHaveBeenCalled();
    expect(fullImage.crop).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();

    // Validation did not consume the interaction; a later intersecting commit
    // can still materialize the same trigger-time image.
    await expect(
      cropRegisteredSnapshot(snapshot.id, { x: -1_280, y: 0, w: 10, h: 10 }, 9)
    ).resolves.toMatchObject({ ok: true });
  });

  test("window previews cannot accidentally be used as full-resolution commit pixels", async () => {
    mocks.captureWindowsPickerSnapshot.mockResolvedValue(pickerCapture(null, false));
    const { captureAndRegister, cropRegisteredSnapshot } = await import("../screen-snapshot");
    const snapshot = await captureAndRegister(9, { mode: "window" });
    await expect(
      cropRegisteredSnapshot(snapshot.id, { x: -1_280, y: 0, w: 100, h: 100 }, 9)
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      message: "screen snapshot full image was not retained or was already consumed"
    });
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  test("a failed commit write is cleaned up and leaves trigger pixels retryable", async () => {
    const cropped = { toPNG: vi.fn(() => Buffer.from("png")) };
    const fullImage = {
      getSize: vi.fn(() => ({ width: 2_560, height: 1_440 })),
      crop: vi.fn(() => cropped)
    };
    mocks.captureWindowsPickerSnapshot.mockResolvedValue(pickerCapture(fullImage));
    mocks.writeFile.mockRejectedValueOnce(new Error("disk full"));
    const { captureAndRegister, cropRegisteredSnapshot } = await import("../screen-snapshot");
    const snapshot = await captureAndRegister(9, { mode: "auto" });

    await expect(
      cropRegisteredSnapshot(snapshot.id, { x: -1_280, y: 0, w: 100, h: 100 }, 9)
    ).resolves.toMatchObject({ ok: false, reason: "error", message: "disk full" });
    expect(mocks.rm).toHaveBeenCalledWith("/tmp/pwrsnap-owned", {
      recursive: true,
      force: true
    });

    mocks.writeFile.mockResolvedValue(undefined);
    await expect(
      cropRegisteredSnapshot(snapshot.id, { x: -1_280, y: 0, w: 100, h: 100 }, 9)
    ).resolves.toMatchObject({ ok: true });
    expect(fullImage.crop).toHaveBeenCalledTimes(2);
  });

  test("release invalidates memory preview and retained pixels without filesystem cleanup", async () => {
    const fullImage = { getSize: vi.fn(), crop: vi.fn() };
    mocks.captureWindowsPickerSnapshot.mockResolvedValue(pickerCapture(fullImage));
    const {
      captureAndRegister,
      cropRegisteredSnapshot,
      getSnapshot,
      getSnapshotPreview,
      releaseSnapshot
    } = await import("../screen-snapshot");
    const snapshot = await captureAndRegister(9, { mode: "auto" });

    await releaseSnapshot(snapshot.id);

    expect(getSnapshot(snapshot.id)).toBeNull();
    expect(getSnapshotPreview(snapshot.id)).toBeNull();
    await expect(
      cropRegisteredSnapshot(snapshot.id, { x: -1_280, y: 0, w: 100, h: 100 }, 9)
    ).resolves.toMatchObject({ ok: false, reason: "error" });
    expect(mocks.rm).not.toHaveBeenCalled();
  });
});

describe("legacy file screen snapshots", () => {
  test("macOS/Linux callers retain the existing file lifecycle even with picker options", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    mocks.captureScreen.mockResolvedValue({
      ok: true,
      tempPath: "/tmp/pwrsnap-screen-old/screen.png",
      displayId: 4
    });
    const {
      captureAndRegister,
      getSnapshotPath,
      getSnapshotPreview,
      releaseSnapshot
    } = await import("../screen-snapshot");

    const snapshot = await captureAndRegister(4, { mode: "region" });

    expect(snapshot).toEqual({
      kind: "file",
      id: "snapshot-1",
      filePath: "/tmp/pwrsnap-screen-old/screen.png",
      displayId: 4,
      timing: null
    });
    expect(getSnapshotPath(snapshot.id)).toBe("/tmp/pwrsnap-screen-old/screen.png");
    expect(getSnapshotPreview(snapshot.id)).toBeNull();
    expect(mocks.captureWindowsPickerSnapshot).not.toHaveBeenCalled();

    await releaseSnapshot(snapshot.id);
    expect(mocks.rm).toHaveBeenCalledWith("/tmp/pwrsnap-screen-old", {
      recursive: true,
      force: true
    });
  });
});
