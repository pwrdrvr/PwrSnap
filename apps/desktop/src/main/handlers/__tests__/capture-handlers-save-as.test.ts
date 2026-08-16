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
//      chosen path — the render happens before the sheet opens, so a
//      slow render can't strand a half-written file at the
//      user's path.
//
// Mock surface mirrors capture-handlers-paste-from-clipboard.test.ts.
// MAINTENANCE: a new side-effecting import in `capture-handlers.ts`
// needs a `vi.mock` here too — a missing mock resolves to the real
// module and will try to spawn a helper or load better-sqlite3.

import { describe, expect, test, vi, beforeEach } from "vitest";
import type { CaptureRecord } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  getCaptureById: vi.fn((): CaptureRecord | null => null),
  showSaveDialog: vi.fn(),
  findWindowById: vi.fn(),
  copyFile: vi.fn(async () => undefined),
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
  mkdtemp: async () => "/tmp/pwrsnap-test",
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
  ensureEffectiveSrcPath: async () => "/src/cap_1.png",
  putCaptureSource: async () => ({})
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

beforeEach(() => {
  mocks.getCaptureById.mockReset();
  mocks.showSaveDialog.mockReset();
  mocks.findWindowById.mockReset();
  mocks.findWindowById.mockReturnValue(null);
  mocks.copyFile.mockReset();
  mocks.copyFile.mockResolvedValue(undefined);
});

describe("capture:saveAs", () => {
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
      "/Users/me/Desktop/example.png"
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
