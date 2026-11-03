// Unit coverage for `capture:saveAs` — the verb behind the grid tile
// context menu's "Save File…" row.
//
// Three contracts worth pinning:
//   1. Cancelling the native sheet is `ok({ path: null })`, NOT an
//      error. The renderer fires this and forgets; if a cancel came
//      back as `err` every "actually, never mind" would look like a
//      failed write.
//   2. Video is refused up front. The Low/Med/High preset model is
//      image-only (see `capture:presetMetrics`), and recordings have
//      their own six-card export panel.
//   3. On save, the RENDERED PRESET FILE is what gets copied to the
//      chosen path, with no publication until both rendering and the
//      native sheet have completed successfully.
//
// Mock surface mirrors capture-handlers-paste-from-clipboard.test.ts.
// MAINTENANCE: a new side-effecting import in `capture-handlers.ts`
// needs a `vi.mock` here too — a missing mock resolves to the real
// module and will try to spawn a helper or load better-sqlite3.

import { describe, expect, test, vi, beforeEach } from "vitest";
import { join } from "node:path";
import type { CaptureRecord } from "@pwrsnap/shared";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
  getCaptureById: vi.fn((): CaptureRecord | null => null),
  showSaveDialog: vi.fn(),
  findWindowById: vi.fn(),
  copyFile: vi.fn(async (_source: string, _destination: string) => undefined),
  rename: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  resolveImagePresetFile: vi.fn(async () => ({
    path: "/cache/cap_1-high.png",
    byteSize: 4096,
    fromCache: true
  }))
}));

vi.mock("electron", () => ({
  clipboard: {
    readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
    availableFormats: () => [],
    readBookmark: () => ({ title: "", url: "" }),
    readBuffer: () => Buffer.alloc(0),
    readText: () => "",
    writeText: () => undefined
  },
  screen: { getAllDisplays: () => [] },
  BrowserWindow: {
    fromId: mocks.findWindowById,
    getAllWindows: () => [],
    getFocusedWindow: () => null
  },
  dialog: { showSaveDialog: mocks.showSaveDialog }
}));

vi.mock("node:fs/promises", () => ({
  copyFile: mocks.copyFile,
  rename: mocks.rename,
  rm: mocks.rm,
  mkdtemp: async () => "/Users/me/Desktop/.pwrsnap-save-test",
  readFile: async () => Buffer.alloc(0),
  unlink: async () => undefined,
  writeFile: async () => undefined
}));

vi.mock("../../capture/region-selector", () => ({
  pickRegion: async () => ({ ok: false, reason: "cancelled" }),
  getLastWindowListSnapshot: () => [],
  hideSelector: () => undefined
}));

vi.mock("../../capture/screencapture", () => ({
  captureRegion: async () => ({ ok: false, reason: "validation", message: "stub" }),
  captureScreen: async () => ({ ok: false, reason: "validation", message: "stub" }),
  captureWindow: async () => ({ ok: false, reason: "validation", message: "stub" })
}));

vi.mock("../../capture/screen-snapshot", () => ({
  releaseSnapshot: async () => undefined
}));

vi.mock("../../capture/window-list", () => ({
  activateApp: async () => undefined,
  findWindowAt: () => null,
  resolveWindowListHelperPath: () => null
}));

vi.mock("../../events", () => ({
  broadcastCapturesChanged: () => undefined
}));

vi.mock("../../float-over", () => ({
  releaseFloatOverDock: () => undefined,
  setFloatOverState: () => undefined
}));

vi.mock("../../tray", () => ({
  hideTrayPopoverIfVisible: () => undefined,
  setTrayCountdown: () => undefined
}));

vi.mock("../../window", () => ({
  findMainLibraryWindow: () => null,
  scheduleDockReclaim: () => undefined,
  reclaimDockIconIfLibraryAlive: () => undefined
}));

vi.mock("../codex-handlers", () => ({
  maybeEnqueueCaptureEnrichment: () => undefined
}));

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: mocks.getCaptureById,
  insertCapture: () => undefined,
  insertOrFindCapture: () => ({ record: null, isNew: false })
}));

vi.mock("../../persistence/source-store", () => ({
  ensureEffectiveSrcPath: async () => "/src/cap_1.png"
}));

vi.mock("../../persistence/bundle-store", () => ({
  persistCaptureFromTempV2: async () => ({ record: null, isDedup: false })
}));

vi.mock("../../persistence/enrichment-repo", () => ({
  getCaptureEnrichment: () => null
}));

vi.mock("../../render/coordinator", () => ({
  renderViaCoordinator: async () => ({ cachePath: "", byteSize: 0, fromCache: false })
}));

vi.mock("../../render/file-alias", () => ({
  prepareRenderedFileAlias: async () => ""
}));

vi.mock("../../render/image-presets", () => ({
  resolveImagePresetFile: mocks.resolveImagePresetFile,
  targetWidthForImagePreset: () => 1200
}));

vi.mock("../settings-handlers", () => ({
  getActiveExportStrategy: async () => "balanced",
  readDesktopSettings: () => ({})
}));

const { bus } = await import("../../command-bus");
const { registerCaptureHandlers } = await import("../capture-handlers");

registerCaptureHandlers();

const imageRecord = {
  id: "cap_1",
  kind: "image",
  width_px: 1200,
  height_px: 800,
  byte_size: 100_000,
  source_app_name: "Example",
  deleted_at: null
} as unknown as CaptureRecord;

const videoRecord = { ...imageRecord, kind: "video" } as unknown as CaptureRecord;
const stagingPath = join("/Users/me/Desktop/.pwrsnap-save-test", "image.png");

beforeEach(() => {
  mocks.getCaptureById.mockReset();
  mocks.showSaveDialog.mockReset();
  mocks.findWindowById.mockReset();
  mocks.findWindowById.mockReturnValue(null);
  mocks.copyFile.mockReset();
  mocks.copyFile.mockResolvedValue(undefined);
  mocks.rename.mockReset();
  mocks.rm.mockReset();
  mocks.resolveImagePresetFile.mockReset();
  mocks.resolveImagePresetFile.mockResolvedValue({
    path: "/cache/cap_1-high.png", byteSize: 4096, fromCache: true
  });
});

describe("capture:saveAs", () => {
  test("failed publication never copies into the destination and cleans up staging", async () => {
    mocks.getCaptureById.mockReturnValue(imageRecord);
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: "/chosen.png" });
    mocks.copyFile.mockRejectedValue(new Error("partial copy"));
    const result = await bus.dispatch("capture:saveAs", { captureId: "cap_1", preset: "high" }, { principal: "ipc" });
    expect(result).toMatchObject({ ok: false, error: { message: "partial copy" } });
    expect(mocks.copyFile.mock.calls[0]?.[1]).not.toBe("/chosen.png");
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalled();
  });

  test("opens the parented sheet while rendering is pending and publishes only afterward", async () => {
    const render = deferred<{ path: string; byteSize: number; fromCache: boolean }>();
    const sheet = deferred<{ canceled: boolean; filePath: string }>();
    const libraryWindow = { id: 42 };
    mocks.getCaptureById.mockReturnValue(imageRecord);
    mocks.findWindowById.mockReturnValue(libraryWindow);
    mocks.resolveImagePresetFile.mockReturnValue(render.promise);
    mocks.showSaveDialog.mockReturnValue(sheet.promise);

    const pending = bus.dispatch("capture:saveAs", { captureId: "cap_1", preset: "high" },
      { principal: "ipc", sourceWindowId: 42 });
    // Flush the handler's settings/import continuations, with rendering held.
    await vi.waitFor(() => expect(mocks.showSaveDialog).toHaveBeenCalledWith(
      libraryWindow, expect.any(Object)
    ));
    sheet.resolve({ canceled: false, filePath: "/chosen.png" });
    await Promise.resolve();
    expect(mocks.copyFile).not.toHaveBeenCalled();
    render.resolve({ path: "/rendered.png", byteSize: 10, fromCache: false });
    expect(await pending).toMatchObject({ ok: true, value: { path: "/chosen.png" } });
    expect(mocks.copyFile).toHaveBeenCalledWith("/rendered.png", stagingPath);
    expect(mocks.rename).toHaveBeenCalledWith(stagingPath, "/chosen.png");
  });

  test("cancellation returns before rendering settles and consumes its later rejection", async () => {
    const render = deferred<{ path: string; byteSize: number; fromCache: boolean }>();
    mocks.getCaptureById.mockReturnValue(imageRecord);
    mocks.resolveImagePresetFile.mockReturnValue(render.promise);
    mocks.showSaveDialog.mockResolvedValue({ canceled: true });
    const pending = bus.dispatch("capture:saveAs", { captureId: "cap_1", preset: "high" }, { principal: "ipc" });
    await expect(pending).resolves.toMatchObject({ ok: true, value: { path: null } });
    render.reject(new Error("late render failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  test("a render rejection while the sheet is open is consumed and reported on Save", async () => {
    const render = deferred<{ path: string; byteSize: number; fromCache: boolean }>();
    const sheet = deferred<{ canceled: boolean; filePath: string }>();
    mocks.getCaptureById.mockReturnValue(imageRecord);
    mocks.resolveImagePresetFile.mockReturnValue(render.promise);
    mocks.showSaveDialog.mockReturnValue(sheet.promise);
    const pending = bus.dispatch("capture:saveAs", { captureId: "cap_1", preset: "high" }, { principal: "ipc" });
    await vi.waitFor(() => expect(mocks.showSaveDialog).toHaveBeenCalled());
    render.reject(new Error("render failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    sheet.resolve({ canceled: false, filePath: "/chosen.png" });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "save_as_failed", message: "render failed" } });
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  test("sheet rejection consumes an in-flight render rejection and publishes nothing", async () => {
    const render = deferred<{ path: string; byteSize: number; fromCache: boolean }>();
    mocks.getCaptureById.mockReturnValue(imageRecord);
    mocks.resolveImagePresetFile.mockReturnValue(render.promise);
    mocks.showSaveDialog.mockRejectedValue(new Error("sheet failed"));
    const pending = bus.dispatch("capture:saveAs", { captureId: "cap_1", preset: "high" }, { principal: "ipc" });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { message: "sheet failed" } });
    render.reject(new Error("late render failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  test("writes the rendered preset file to the chosen path", async () => {
    mocks.getCaptureById.mockReturnValue(imageRecord);
    mocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: "/Users/me/Desktop/example.png"
    });

    const result = await bus.dispatch(
      "capture:saveAs",
      { captureId: "cap_1", preset: "high" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.path).toBe("/Users/me/Desktop/example.png");
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "/cache/cap_1-high.png",
      stagingPath
    );
    expect(mocks.rename).toHaveBeenCalledWith(
      stagingPath, "/Users/me/Desktop/example.png"
    );
  });

  test("parents the native sheet to the calling Library window", async () => {
    const libraryWindow = { id: 42 };
    mocks.getCaptureById.mockReturnValue(imageRecord);
    mocks.findWindowById.mockReturnValue(libraryWindow);
    mocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });

    await bus.dispatch(
      "capture:saveAs",
      { captureId: "cap_1", preset: "high" },
      { principal: "ipc", sourceWindowId: 42 }
    );

    expect(mocks.showSaveDialog).toHaveBeenCalledWith(
      libraryWindow,
      expect.objectContaining({ defaultPath: expect.any(String) })
    );
  });

  test("a cancelled sheet resolves ok with path=null and writes nothing", async () => {
    mocks.getCaptureById.mockReturnValue(imageRecord);
    mocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });

    const result = await bus.dispatch(
      "capture:saveAs",
      { captureId: "cap_1", preset: "high" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.path).toBeNull();
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  test("refuses video captures without opening a sheet", async () => {
    mocks.getCaptureById.mockReturnValue(videoRecord);

    const result = await bus.dispatch(
      "capture:saveAs",
      { captureId: "cap_1", preset: "high" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("unsupported_kind");
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
  });

  test("returns not_found for an unknown capture", async () => {
    mocks.getCaptureById.mockReturnValue(null);

    const result = await bus.dispatch(
      "capture:saveAs",
      { captureId: "nope", preset: "high" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("not_found");
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
  });
});
