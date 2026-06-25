// Tests for the `cart:exportZip` handler. Mocks the file/render/dialog
// edges so the SUT is the handler's logic: the skip-filter (video/trashed/
// missing), per-image partial-failure tolerance, zip entry naming +
// collision suffixing, and the cancelled / nothing-to-export results.

import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, Result } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (req: unknown) => Promise<unknown>>(),
  getCaptureById: vi.fn<(id: string) => CaptureRecord | null>(),
  resolveImagePresetFile: vi.fn<(rec: CaptureRecord, preset: string) => Promise<{ path: string }>>(),
  showSaveDialog: vi.fn(),
  showItemInFolder: vi.fn(),
  addFile: vi.fn<(path: string, entry: string) => void>(),
  rename: vi.fn<() => Promise<void>>(),
  rm: vi.fn<() => Promise<void>>(),
  stat: vi.fn<() => Promise<{ size: number }>>()
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => [])
  },
  dialog: { showSaveDialog: mocks.showSaveDialog },
  shell: { showItemInFolder: mocks.showItemInFolder }
}));

vi.mock("../../command-bus", () => ({
  bus: {
    register: vi.fn((name: string, handler: (req: unknown) => Promise<unknown>) => {
      mocks.handlers.set(name, handler);
    })
  }
}));

vi.mock("../../cart/cart-store", () => ({ getCartStore: () => ({}) }));
vi.mock("../../sizzle/sizzle-store", () => ({
  getSizzleStore: () => ({}),
  SizzleProjectNotFoundError: class extends Error {}
}));
vi.mock("../../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));
vi.mock("../../persistence/captures-repo", () => ({ getCaptureById: mocks.getCaptureById }));
vi.mock("../../persistence/enrichment-repo", () => ({ getCaptureEnrichment: () => null }));
vi.mock("../../render/export-filename", () => ({
  // Stem from the capture's source app name — enough to exercise the
  // collision-suffix path without dragging in the real filename builder.
  exportFilenameStem: (rec: CaptureRecord) => rec.source_app_name ?? "snap"
}));
vi.mock("../../render/image-presets", () => ({
  resolveImagePresetFile: mocks.resolveImagePresetFile
}));
vi.mock("../../window", () => ({ findMainLibraryWindow: () => null }));
// A Writable that swallows writes and auto-destroys (→ 'close') after the
// pipe ends it. A PassThrough here would never drain its readable side, so
// it would never emit 'close' and the handler's await would hang.
vi.mock("node:fs", () => ({
  createWriteStream: () =>
    new Writable({
      write(_chunk: unknown, _enc: unknown, cb: () => void): void {
        cb();
      }
    })
}));
vi.mock("node:fs/promises", () => ({ rename: mocks.rename, rm: mocks.rm, stat: mocks.stat }));
// yazl is CJS; the handler does `import yazl from "yazl"` then
// `new yazl.ZipFile()`, so the default export is the whole module object.
// Inline the class in the factory — a separately-declared class would be in
// the temporal dead zone when this hoisted factory runs.
vi.mock("yazl", () => ({
  default: {
    ZipFile: class {
      outputStream = new PassThrough();
      addFile(path: string, entry: string): void {
        mocks.addFile(path, entry);
      }
      end(): void {
        this.outputStream.end();
      }
    }
  }
}));

import { registerCartHandlers } from "../cart-handlers";

function imageRecord(id: string, deleted = false): CaptureRecord {
  return {
    id,
    kind: "image",
    source_app_name: id,
    width_px: 100,
    height_px: 100,
    byte_size: 1000,
    deleted_at: deleted ? "2026-01-01T00:00:00.000Z" : null
  } as unknown as CaptureRecord;
}
function videoRecord(id: string): CaptureRecord {
  return { ...imageRecord(id), kind: "video" } as unknown as CaptureRecord;
}

type ZipRes = { path: string; fileCount: number; byteSize: number; skipped: number; failed: number };

async function callExportZip(req: unknown): Promise<Result<ZipRes>> {
  const handler = mocks.handlers.get("cart:exportZip");
  if (handler === undefined) throw new Error("handler not registered");
  return (await handler(req)) as Result<ZipRes>;
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.getCaptureById.mockReset();
  mocks.resolveImagePresetFile.mockReset();
  mocks.showSaveDialog.mockReset();
  mocks.showItemInFolder.mockReset();
  mocks.addFile.mockReset();
  mocks.rename.mockReset();
  mocks.rm.mockReset();
  mocks.stat.mockReset();
  mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: "/out/export.zip" });
  mocks.resolveImagePresetFile.mockResolvedValue({ path: "/cache/img.png" });
  mocks.rename.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
  mocks.stat.mockResolvedValue({ size: 4242 });
  registerCartHandlers();
});

describe("cart:exportZip", () => {
  test("zips images, skips videos/trashed/missing", async () => {
    mocks.getCaptureById.mockImplementation((id) =>
      id === "img1" ? imageRecord("img1")
      : id === "vid" ? videoRecord("vid")
      : id === "gone-trash" ? imageRecord("gone-trash", true)
      : null // "missing"
    );
    const r = await callExportZip({
      captureIds: ["img1", "vid", "gone-trash", "missing"],
      preset: "med"
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fileCount).toBe(1);
      expect(r.value.skipped).toBe(3); // video + trashed + missing
      expect(r.value.failed).toBe(0);
      expect(r.value.byteSize).toBe(4242);
    }
    expect(mocks.showItemInFolder).toHaveBeenCalledWith("/out/export.zip");
  });

  test("one unrenderable image is counted as failed, not fatal", async () => {
    mocks.getCaptureById.mockImplementation((id) => imageRecord(id));
    mocks.resolveImagePresetFile.mockImplementation(async (rec) => {
      if (rec.id === "bad") throw new Error("corrupt source");
      return { path: "/cache/img.png" };
    });
    const r = await callExportZip({ captureIds: ["good", "bad"], preset: "low" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fileCount).toBe(1);
      expect(r.value.failed).toBe(1);
    }
  });

  test("colliding stems get a numeric suffix (no overwrite)", async () => {
    // Two captures with the same source_app_name → same stem.
    mocks.getCaptureById.mockImplementation((id) => imageRecord("samestem"));
    await callExportZip({ captureIds: ["a", "b"], preset: "high" });
    const entries = mocks.addFile.mock.calls.map((c) => c[1]);
    expect(entries).toEqual(["samestem-high.png", "samestem-high-2.png"]);
  });

  test("all captures filtered out → nothing_to_export error (no dialog)", async () => {
    mocks.getCaptureById.mockReturnValue(null);
    const r = await callExportZip({ captureIds: ["x"], preset: "low" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("nothing_to_export");
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
  });

  test("cancelled save dialog → cancelled error", async () => {
    mocks.getCaptureById.mockImplementation((id) => imageRecord(id));
    mocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
    const r = await callExportZip({ captureIds: ["a"], preset: "med" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("cancelled");
  });
});
