import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

let workDir: string;
vi.mock("electron", () => ({
  app: { getPath: () => workDir, isPackaged: false, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] }
}));
vi.mock("../../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
vi.mock("../source-alpha", () => ({ sourceBufferHasAlpha: vi.fn(async () => false) }));
vi.mock("../bundle-filename-settings", () => ({ readBundleFilenameTimestampZone: vi.fn(async () => "utc" as const) }));
vi.mock("../../workers/composite-thumbnail-worker-client", () => ({
  isCompositeThumbnailWorkerAvailable: () => true,
  runCompositeThumbnailWorker: vi.fn()
}));

const { openDatabase, closeDatabase } = await import("../db");
const { persistCaptureFromTempV2, readSourceFromBundle, readBundleDocument, readBundleManifest } = await import("../bundle-store");
const { runExclusiveCapturesRootOperation } = await import("../../capture/capture-storage-gate");
const { getCaptureById } = await import("../captures-repo");
const { listLayerTree } = await import("../layers-repo");
const { getCacheSourcePath } = await import("../paths");
const { sourceBufferHasAlpha } = await import("../source-alpha");
const { readBundleFilenameTimestampZone } = await import("../bundle-filename-settings");
const { runCompositeThumbnailWorker } = await import("../../workers/composite-thumbnail-worker-client");
const { buildCompositeThumbnailInProcess } = await import("../../image/composite-thumbnail");

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
let png: Buffer;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pwrsnap-persist-order-"));
  process.env.PWRSNAP_DATA_ROOT = workDir;
  await mkdir(join(workDir, "captures"), { recursive: true });
  await openDatabase();
  png = await sharp({ create: { width: 32, height: 24, channels: 4,
    background: { r: 20, g: 40, b: 60, alpha: 0.5 } } }).png().toBuffer();
});
afterAll(async () => {
  closeDatabase();
  delete process.env.PWRSNAP_DATA_ROOT;
  await rm(workDir, { recursive: true, force: true });
});
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockReset().mockImplementation(actual.open);
  vi.mocked(sourceBufferHasAlpha).mockReset().mockResolvedValue(true);
  vi.mocked(readBundleFilenameTimestampZone).mockReset().mockResolvedValue("utc");
  vi.mocked(runCompositeThumbnailWorker).mockReset().mockImplementation(buildCompositeThumbnailInProcess);
});
async function input(id: string) {
  const tempPath = join(workDir, `${id}.png`);
  await writeFile(tempPath, png);
  return { captureId: id, tempPath, sourceApp: null };
}

test("thumbnail preparation proceeds while alpha statistics are pending", async () => {
  const alpha = deferred<boolean>();
  const started = deferred<void>();
  vi.mocked(sourceBufferHasAlpha).mockImplementationOnce(() => { started.resolve(); return alpha.promise; });
  const args = await input("alpha-overlap");
  const pending = persistCaptureFromTempV2(args);
  await started.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    expect(runCompositeThumbnailWorker).toHaveBeenCalledOnce();
    expect(getCaptureById(args.captureId)).toBeNull();
    await expect(access(args.tempPath)).resolves.toBeUndefined();
  } finally {
    alpha.resolve(true);
    await pending;
  }
  expect(getCaptureById(args.captureId)?.has_alpha).toBe(true);
});

test("thumbnail preparation proceeds while filename settings are pending", async () => {
  const settings = deferred<"utc">();
  const started = deferred<void>();
  vi.mocked(readBundleFilenameTimestampZone).mockImplementationOnce(() => { started.resolve(); return settings.promise; });
  const args = await input("settings-overlap");
  const pending = persistCaptureFromTempV2(args);
  await started.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    expect(runCompositeThumbnailWorker).toHaveBeenCalledOnce();
    expect(getCaptureById(args.captureId)).toBeNull();
  } finally {
    settings.resolve("utc");
    await pending;
  }
});

test("capture and cache publication wait for both bundle fsyncs", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const fileSync = deferred<void>();
  const directorySync = deferred<void>();
  const releaseFile = deferred<void>();
  const releaseDirectory = deferred<void>();
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    const realSync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (args[1] === "w") { fileSync.resolve(); await releaseFile.promise; }
      else { directorySync.resolve(); await releaseDirectory.promise; }
      await realSync();
    };
    return handle;
  });
  const args = await input("durable-order");
  const pending = persistCaptureFromTempV2(args);
  await fileSync.promise;
  expect(getCaptureById(args.captureId)).toBeNull();
  await expect(access(getCacheSourcePath(args.captureId))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(args.tempPath)).resolves.toEqual(png);
  releaseFile.resolve();
  await directorySync.promise;
  expect(getCaptureById(args.captureId)).toBeNull();
  await expect(access(getCacheSourcePath(args.captureId))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(args.tempPath)).resolves.toEqual(png);
  releaseDirectory.resolve();
  const { record } = await pending;
  expect(listLayerTree(record.id)).toHaveLength(2);
  expect((await readBundleDocument(record.bundle_path!)).layers).toHaveLength(2);
  expect(await readSourceFromBundle(record.bundle_path!, record.sha256)).toEqual(png);
  await expect(access(args.tempPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("failed durable writes retain the temp source, publish no row, and can be retried", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    handle.sync = async () => { throw new Error("fsync failed"); };
    return handle;
  });
  const args = await input("durable-retry");
  await expect(persistCaptureFromTempV2(args)).rejects.toThrow("fsync failed");
  expect(getCaptureById(args.captureId)).toBeNull();
  expect(listLayerTree(args.captureId)).toHaveLength(0);
  await expect(readFile(args.tempPath)).resolves.toEqual(png);
  await expect(access(getCacheSourcePath(args.captureId))).rejects.toMatchObject({ code: "ENOENT" });
  const { record } = await persistCaptureFromTempV2(args);
  expect(listLayerTree(record.id)).toHaveLength(2);
});

test("preparation leaves the root lock available and selects the root at commit time", async () => {
  const alpha = deferred<boolean>();
  const started = deferred<void>();
  vi.mocked(sourceBufferHasAlpha).mockImplementationOnce(() => { started.resolve(); return alpha.promise; });
  const args = await input("root-lock");
  let root = join(workDir, "old-root");
  const guard = vi.fn((operation: (outputDir: string) => ReturnType<typeof persistCaptureFromTempV2>) =>
    runExclusiveCapturesRootOperation(() => operation(root))
  );
  const pending = persistCaptureFromTempV2(args, guard);
  await started.promise;
  try {
    expect(guard).not.toHaveBeenCalled();
    await runExclusiveCapturesRootOperation(async () => { root = join(workDir, "new-root"); });
  } finally { alpha.resolve(true); }
  const { record } = await pending;
  expect(record.bundle_path).toContain(`${root}/`);
  expect(guard).toHaveBeenCalledOnce();
});

test("root retry reuses preparation and retains input until the fallback commit succeeds", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const deniedRoot = join(workDir, "denied");
  const fallbackRoot = join(workDir, "fallback");
  vi.mocked(open).mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(deniedRoot)) {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    }
    return actual.open(...args);
  });
  const args = await input("root-retry");
  const { record } = await persistCaptureFromTempV2(args, async (operation) => {
    await expect(operation(deniedRoot)).rejects.toMatchObject({ code: "EPERM" });
    expect(getCaptureById(args.captureId)).toBeNull();
    await expect(readFile(args.tempPath)).resolves.toEqual(png);
    return operation(fallbackRoot);
  });
  expect(sourceBufferHasAlpha).toHaveBeenCalledOnce();
  expect(runCompositeThumbnailWorker).toHaveBeenCalledOnce();
  expect(record.bundle_path).toContain(`${fallbackRoot}/`);
  const manifest = await readBundleManifest(record.bundle_path!);
  expect(manifest.paired_png_filename).toBe(basename(record.bundle_path!).replace(/\.pwrsnap$/, ".png"));
  expect(await readSourceFromBundle(record.bundle_path!, record.sha256)).toEqual(png);
});

test("preparation failure observes a later sibling rejection and publishes nothing", async () => {
  const thumbnail = deferred<Buffer>();
  vi.mocked(sourceBufferHasAlpha).mockRejectedValueOnce(new Error("alpha preparation failed"));
  vi.mocked(runCompositeThumbnailWorker).mockReturnValueOnce(thumbnail.promise);
  const args = await input("prepare-rejection");
  await expect(persistCaptureFromTempV2(args)).rejects.toThrow("alpha preparation failed");
  thumbnail.reject(new Error("late thumbnail failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(getCaptureById(args.captureId)).toBeNull();
  await expect(readFile(args.tempPath)).resolves.toEqual(png);
  await expect(access(getCacheSourcePath(args.captureId))).rejects.toMatchObject({ code: "ENOENT" });
});

test("cursor preparation paints the thumbnail input while keeping source bytes immutable", async () => {
  const cursor = await sharp({ create: { width: 2, height: 2, channels: 4,
    background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
  const args = await input("cursor-thumbnail");
  const { record } = await persistCaptureFromTempV2({ ...args, cursorLayer: {
    pngBytes: cursor, xPx: 4, yPx: 4, drawWidthPx: 2, drawHeightPx: 2
  } });
  const thumbnailInput = vi.mocked(runCompositeThumbnailWorker).mock.calls[0]?.[0];
  expect(thumbnailInput).toBeDefined();
  const { data, info } = await sharp(thumbnailInput!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (4 * info.width + 4) * info.channels;
  expect([...data.subarray(offset, offset + 4)]).toEqual([255, 255, 255, 255]);
  expect(await readSourceFromBundle(record.bundle_path!, record.sha256)).toEqual(png);
  expect(await readFile(getCacheSourcePath(record.id))).toEqual(png);
  expect(listLayerTree(record.id).filter((layer) => layer.kind === "raster")).toHaveLength(2);
});
