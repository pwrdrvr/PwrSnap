// Tests for the `cart:exportZip` handler. Mocks the file/render/dialog
// edges so the SUT is the handler's logic: the skip-filter (video/trashed/
// missing), per-image partial-failure tolerance, zip entry naming +
// collision suffixing, and the cancelled / nothing-to-export results.

import { PassThrough, Readable, Writable } from "node:stream";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, Result } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (req: unknown, ctx: unknown) => Promise<unknown>>(),
  getCaptureById: vi.fn<(id: string) => CaptureRecord | null>(),
  resolveImagePresetFile: vi.fn<(rec: CaptureRecord, preset: string) => Promise<{ path: string }>>(),
  showSaveDialog: vi.fn(),
  showItemInFolder: vi.fn(),
  addFile: vi.fn<(path: string, entry: string) => void>(),
  rename: vi.fn<() => Promise<void>>(),
  rm: vi.fn<() => Promise<void>>(),
  stat: vi.fn<() => Promise<{ size: number }>>(),
  mkdir: vi.fn<() => Promise<void>>(),
  readdir: vi.fn<() => Promise<string[]>>(),
  existsSync: vi.fn<(p: string) => boolean>(),
  composeCartDragIcon: vi.fn<() => Promise<void>>(),
  createWriteStream: vi.fn<() => Writable>(),
  send: vi.fn()
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send: mocks.send } }])
  },
  dialog: { showSaveDialog: mocks.showSaveDialog },
  shell: { showItemInFolder: mocks.showItemInFolder }
}));

vi.mock("../../command-bus", () => ({
  bus: {
    register: vi.fn((name: string, handler: (req: unknown, ctx: unknown) => Promise<unknown>) => {
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
vi.mock("../../render/cart-drag-icon", () => ({ composeCartDragIcon: mocks.composeCartDragIcon }));
vi.mock("../../window", () => ({ findMainLibraryWindow: () => null }));
// A Writable that swallows writes and auto-destroys (→ 'close') after the
// pipe ends it. A PassThrough here would never drain its readable side, so
// it would never emit 'close' and the handler's await would hang.
vi.mock("node:fs", () => ({
  createReadStream: (path: string) => Object.assign(Readable.from([]), { path }),
  createWriteStream: mocks.createWriteStream,
  existsSync: mocks.existsSync
}));
vi.mock("node:fs/promises", () => ({
  rename: mocks.rename,
  rm: mocks.rm,
  stat: mocks.stat,
  mkdir: mocks.mkdir,
  readdir: mocks.readdir
}));
// yazl is CJS; the handler does `import yazl from "yazl"` then
// `new yazl.ZipFile()`, so the default export is the whole module object.
// Inline the class in the factory — a separately-declared class would be in
// the temporal dead zone when this hoisted factory runs.
vi.mock("yazl", () => ({
  default: {
    ZipFile: class {
      outputStream = new PassThrough();
      addReadStreamLazy(entry: string, _options: unknown, open: (callback: (error: unknown, input: Readable & { path: string }) => void) => void): void {
        open((_error, input) => {
          mocks.addFile(input.path, entry);
          input.resume();
        });
      }
      on(): this { return this; }
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

// The bus passes (req, ctx); the handler reads ctx.signal. A never-aborting
// signal is the renderer-originated default (cart export carries no
// cancellationKey), so cancellation rides the per-job controller instead.
const neverAborts = { signal: new AbortController().signal } as unknown;

async function callExportZip(req: Record<string, unknown>): Promise<Result<ZipRes>> {
  const handler = mocks.handlers.get("cart:exportZip");
  if (handler === undefined) throw new Error("handler not registered");
  const withJob = "jobId" in req ? req : { ...req, jobId: "job-1" };
  return (await handler(withJob, neverAborts)) as Result<ZipRes>;
}

async function callCancel(jobId: string): Promise<Result<{ cancelled: boolean }>> {
  const handler = mocks.handlers.get("cart:exportZip:cancel");
  if (handler === undefined) throw new Error("cancel handler not registered");
  return (await handler({ jobId }, neverAborts)) as Result<{ cancelled: boolean }>;
}

type DragRes = { path: string; fileCount: number; iconPath: string | null };
async function callPrepareDrag(req: Record<string, unknown>): Promise<Result<DragRes>> {
  const handler = mocks.handlers.get("cart:prepareZipDrag");
  if (handler === undefined) throw new Error("prepareZipDrag handler not registered");
  return (await handler(req, neverAborts)) as Result<DragRes>;
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
  mocks.mkdir.mockReset();
  mocks.readdir.mockReset();
  mocks.existsSync.mockReset();
  mocks.composeCartDragIcon.mockReset();
  mocks.send.mockReset();
  mocks.createWriteStream.mockReset();
  mocks.createWriteStream.mockImplementation(() => new Writable({
    write(_chunk, _encoding, callback): void { callback(); }
  }));
  mocks.readdir.mockResolvedValue([]); // nothing to prune by default
  mocks.existsSync.mockReturnValue(false); // no cached drag zip by default
  mocks.composeCartDragIcon.mockResolvedValue(undefined);
  mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: "/out/export.zip" });
  mocks.resolveImagePresetFile.mockResolvedValue({ path: "/cache/img.png" });
  mocks.rename.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
  mocks.stat.mockResolvedValue({ size: 4242, isFile: () => true, mtime: new Date(0), mode: 0o100644 } as unknown as { size: number });
  mocks.mkdir.mockResolvedValue(undefined);
  registerCartHandlers();
});

describe("cart:exportZip", () => {
  test.each(["export", "drag"] as const)("%s admits two renders and applies backpressure while preserving archive and collision order", async (mode) => {
    const releases = new Map<string, (file: { path: string }) => void>();
    mocks.getCaptureById.mockImplementation((id) => ({ ...imageRecord(id), source_app_name: "same" }));
    mocks.resolveImagePresetFile.mockImplementation((rec) => new Promise((resolve) => { releases.set(rec.id, resolve); }));
    const ids = ["a", "b", "c", "d", "e"];
    const pending = mode === "export"
      ? callExportZip({ captureIds: ids, preset: "low" })
      : callPrepareDrag({ captureIds: ids, preset: "low" });
    try {
      await vi.waitFor(() => expect(releases.size).toBeGreaterThan(0));
      expect([...releases.keys()]).toEqual(["a", "b"]);
      releases.get("b")!({ path: "/cache/b.png" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect([...releases.keys()]).toEqual(["a", "b"]);
      expect(mocks.createWriteStream).not.toHaveBeenCalled();
      releases.get("a")!({ path: "/cache/a.png" });
      await vi.waitFor(() => expect(releases.has("c")).toBe(true));
      expect([...releases.keys()]).toEqual(["a", "b", "c", "d"]);
      releases.get("d")!({ path: "/cache/d.png" });
      releases.get("c")!({ path: "/cache/c.png" });
      await vi.waitFor(() => expect(releases.has("e")).toBe(true));
      releases.get("e")!({ path: "/cache/e.png" });
      expect((await pending).ok).toBe(true);
      expect(mocks.addFile.mock.calls).toEqual(ids.map((id, i) => [
        `/cache/${id}.png`, `same-low${i === 0 ? "" : `-${i + 1}`}.png`
      ]));
      if (mode === "drag") expect(mocks.composeCartDragIcon).toHaveBeenCalledWith(
        expect.objectContaining({ imagePath: "/cache/a.png", count: 5 })
      );
      else expect(mocks.send.mock.calls.map((call) => call[1]).filter((event) => event.phase === "rendering").map((event) => event.completed)).toEqual([0, 1, 2, 3, 4, 5]);
    } finally {
      // Also drain the serial implementation when the admission assertion fails.
      mocks.resolveImagePresetFile.mockResolvedValue({ path: "/cache/cleanup.png" });
      for (const release of releases.values()) release({ path: "/cache/cleanup.png" });
      await pending;
    }
  });

  test("cancel drains admitted renders, handles a late rejection, and never starts another batch or publishes", async () => {
    let finishFirst!: (file: { path: string }) => void;
    let failSecond!: (cause: Error) => void;
    mocks.getCaptureById.mockImplementation(imageRecord);
    mocks.resolveImagePresetFile
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failSecond = reject; }));
    let settled = false;
    const pending = callExportZip({ captureIds: ["a", "b", "c"], preset: "low", jobId: "drain" })
      .finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(mocks.resolveImagePresetFile).toHaveBeenCalled());
      expect(mocks.resolveImagePresetFile).toHaveBeenCalledTimes(2);
      await callCancel("drain");
      finishFirst({ path: "/cache/a.png" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      failSecond(new Error("late corrupt source"));
      expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(mocks.resolveImagePresetFile).toHaveBeenCalledTimes(2);
      expect(mocks.createWriteStream).not.toHaveBeenCalled();
      expect(mocks.rename).not.toHaveBeenCalled();
    } finally {
      await callCancel("drain");
      finishFirst?.({ path: "/cache/a.png" });
      failSecond?.(new Error("cleanup"));
      await pending;
    }
  });

  test("cancel during ZIP output never replaces the destination", async () => {
    mocks.getCaptureById.mockImplementation(imageRecord);
    let finishWrite: (() => void) | undefined;
    mocks.createWriteStream.mockImplementation(() => new Writable({
      write(_chunk, _encoding, callback): void { callback(); },
      final(callback): void { finishWrite = callback; }
    }));
    const pending = callExportZip({ captureIds: ["a"], preset: "low", jobId: "zip-cancel" });
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    await callCancel("zip-cancel");
    finishWrite!();
    expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

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

  test("all render failures produce no ZIP output", async () => {
    mocks.getCaptureById.mockImplementation(imageRecord);
    mocks.resolveImagePresetFile.mockRejectedValue(new Error("corrupt sources"));
    expect(await callExportZip({ captureIds: ["a", "b", "c"], preset: "low" }))
      .toMatchObject({ ok: false, error: { code: "export_failed" } });
    expect(mocks.resolveImagePresetFile).toHaveBeenCalledTimes(3);
    expect(mocks.createWriteStream).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  test("ZIP output failure closes the stream and removes staging without publication", async () => {
    mocks.getCaptureById.mockImplementation(imageRecord);
    const output = new Writable({ final(callback): void { callback(new Error("disk full")); } });
    mocks.createWriteStream.mockReturnValue(output);
    expect(await callExportZip({ captureIds: ["a", "b"], preset: "low" }))
      .toMatchObject({ ok: false, error: { code: "export_failed" } });
    expect(output.closed).toBe(true);
    expect(mocks.rm).toHaveBeenCalledWith(expect.stringContaining(".tmp-"), { force: true });
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  test("colliding stems get a numeric suffix (no overwrite)", async () => {
    // Two captures with the same source_app_name → same stem.
    mocks.getCaptureById.mockImplementation((_id) => imageRecord("samestem"));
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

  test("cancelling mid-render bails with cancelled and writes no zip", async () => {
    mocks.getCaptureById.mockImplementation((id) => imageRecord(id));
    let rendered = 0;
    mocks.resolveImagePresetFile.mockImplementation(async () => {
      rendered++;
      // Abort the job while the first image is rendering. The loop's
      // next-iteration checkpoint should bail before image 2.
      if (rendered === 1) await callCancel("job-cancel");
      return { path: "/cache/img.png" };
    });
    const r = await callExportZip({
      captureIds: ["a", "b", "c"],
      preset: "low",
      jobId: "job-cancel"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("cancelled");
    expect(rendered).toBeLessThan(3); // stopped early
    expect(mocks.rename).not.toHaveBeenCalled(); // no archive moved into place
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

  test("cancelling an unknown / finished job → cancelled: false", async () => {
    const r = await callCancel("no-such-job");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.cancelled).toBe(false);
  });

  test("missing jobId → validation error (no dialog)", async () => {
    mocks.getCaptureById.mockImplementation((id) => imageRecord(id));
    const handler = mocks.handlers.get("cart:exportZip");
    if (handler === undefined) throw new Error("handler not registered");
    const r = (await handler({ captureIds: ["a"], preset: "low" }, neverAborts)) as Result<ZipRes>;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("jobId_invalid");
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
  });
});

describe("cart:prepareZipDrag (drag-out)", () => {
  test("zips to a temp path and returns the path + first-image icon", async () => {
    mocks.getCaptureById.mockImplementation((id) => imageRecord(id));
    const r = await callPrepareDrag({ captureIds: ["a", "b"], preset: "med" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fileCount).toBe(2);
      expect(r.value.path).toContain("pwrsnap-cart-export");
      // `<base>-<preset>-<8 hex content hash>.zip`
      expect(r.value.path).toMatch(/-med-[0-9a-f]{8}\.zip$/);
      // Drag icon is the composed badge thumbnail, not the raw render.
      expect(r.value.iconPath).toMatch(/-med-[0-9a-f]{8}-drag\.png$/);
    }
    // Composed with the right image-count badge (2 images in the zip).
    expect(mocks.composeCartDragIcon).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: "/cache/img.png", count: 2 })
    );
    // No save dialog on the drag path.
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(mocks.mkdir).toHaveBeenCalled();
  });

  test("reuses a cached zip for the identical cart+preset (no re-render)", async () => {
    mocks.getCaptureById.mockImplementation((id) => imageRecord(id));
    mocks.existsSync.mockReturnValue(true); // zip + icon already on disk
    const r = await callPrepareDrag({ captureIds: ["a", "b"], preset: "med" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.path).toMatch(/-med-[0-9a-f]{8}\.zip$/);
      expect(r.value.iconPath).toMatch(/-med-[0-9a-f]{8}-drag\.png$/);
    }
    // The whole point: no render, no zip, no re-compose on a cache hit.
    expect(mocks.resolveImagePresetFile).not.toHaveBeenCalled();
    expect(mocks.addFile).not.toHaveBeenCalled();
    expect(mocks.composeCartDragIcon).not.toHaveBeenCalled();
  });

  test("prunes stale drag temp files before building", async () => {
    mocks.getCaptureById.mockImplementation((id) => imageRecord(id));
    mocks.readdir.mockResolvedValue(["old-low-deadbeef.zip"]);
    // Old enough to prune (mtime way in the past).
    mocks.stat.mockResolvedValue({ size: 10, mtimeMs: 0, isFile: () => true, mtime: new Date(0), mode: 0o100644 } as unknown as { size: number });
    await callPrepareDrag({ captureIds: ["a"], preset: "low" });
    expect(mocks.readdir).toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledWith(
      expect.stringContaining("old-low-deadbeef.zip"),
      expect.objectContaining({ force: true })
    );
  });

  test("falls back to the raw image when the badge compose throws", async () => {
    mocks.getCaptureById.mockImplementation((id) => imageRecord(id));
    mocks.composeCartDragIcon.mockRejectedValue(new Error("sharp boom"));
    const r = await callPrepareDrag({ captureIds: ["a"], preset: "low" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.iconPath).toBe("/cache/img.png"); // raw first render
  });

  test("all filtered out → nothing_to_export", async () => {
    mocks.getCaptureById.mockReturnValue(null);
    const r = await callPrepareDrag({ captureIds: ["x"], preset: "low" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("nothing_to_export");
  });

  test("rejects a missing preset before doing any work", async () => {
    mocks.getCaptureById.mockImplementation((id) => imageRecord(id));
    const r = await callPrepareDrag({ captureIds: ["a"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("preset_invalid");
    expect(mocks.mkdir).not.toHaveBeenCalled();
  });
});
