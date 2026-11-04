import fs, { type ReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Writable } from "node:stream";
import yauzl from "yauzl";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CaptureRecord, Result } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (req: unknown, ctx: unknown) => Promise<unknown>>(),
  root: "",
  source: "",
  sink: null as Writable | null,
  reveal: vi.fn()
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs") & { default: typeof import("node:fs") }>();
  return {
    ...actual,
    // The mutable default is also what the real CJS yazl requires. Both the
    // old addFile path and explicit lazy inputs pass through the same spy.
    createReadStream: (...args: Parameters<typeof fs.createReadStream>) => actual.default.createReadStream(...args),
    createWriteStream: (...args: Parameters<typeof fs.createWriteStream>) => mocks.sink ?? actual.default.createWriteStream(...args)
  };
});
vi.mock("electron", () => ({
  app: { getPath: () => mocks.root },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: join(mocks.root, "export.zip") }) },
  shell: { showItemInFolder: mocks.reveal }
}));
vi.mock("../../command-bus", () => ({ bus: {
  register: (name: string, handler: (req: unknown, ctx: unknown) => Promise<unknown>) => mocks.handlers.set(name, handler)
} }));
vi.mock("../../cart/cart-store", () => ({ getCartStore: () => ({}) }));
vi.mock("../../sizzle/sizzle-store", () => ({ getSizzleStore: () => ({}), SizzleProjectNotFoundError: class extends Error {} }));
vi.mock("../../persistence/captures-repo", () => ({ getCaptureById: (id: string) => ({ id, kind: "image", deleted_at: null }) as CaptureRecord }));
vi.mock("../../persistence/enrichment-repo", () => ({ getCaptureEnrichment: () => null }));
vi.mock("../../render/export-filename", () => ({ exportFilenameStem: () => "same" }));
vi.mock("../../render/image-presets", () => ({ resolveImagePresetFile: async () => ({ path: mocks.source }) }));
vi.mock("../../render/cart-drag-icon", () => ({ composeCartDragIcon: async () => undefined }));
vi.mock("../../window", () => ({ findMainLibraryWindow: () => null }));
import { registerCartHandlers } from "../cart-handlers";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const context = { signal: new AbortController().signal };
const checkpoint = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
// Node exposes the live fd slot at runtime; its ReadStream declaration omits
// it. Assert the actual descriptor is cleared, in addition to stream closure.
type InputStream = ReadStream & { fd: number | null };
const inputs: Array<{ stream: InputStream; closed: Promise<void> }> = [];

function callExport(jobId: string): Promise<Result<{ path: string; fileCount: number }>> {
  return mocks.handlers.get("cart:exportZip")!({ captureIds: ["first", "second"], preset: "low", jobId }, context) as Promise<Result<{ path: string; fileCount: number }>>;
}

beforeEach(async () => {
  mocks.root = await mkdtemp(join(tmpdir(), "pwrsnap-cart-zip-inputs-"));
  mocks.source = join(mocks.root, "source.png");
  await writeFile(mocks.source, Buffer.alloc(16 * 1024 * 1024, 0x5a), { mode: 0o600 });
  mocks.handlers.clear();
  mocks.sink = null;
  mocks.reveal.mockReset();
  inputs.length = 0;
  registerCartHandlers();
});
afterEach(async () => {
  for (const { stream } of inputs) stream.destroy();
  await Promise.all(inputs.map(({ closed }) => closed));
  vi.restoreAllMocks();
  await rm(mocks.root, { force: true, recursive: true });
});

test.each(["cancel", "output failure", "input failure"])("%s closes and drains a blocked real yazl input before the handler settles, including repeated exports", async (scenario) => {
  const createReadStream = fs.createReadStream;
  for (let iteration = 0; iteration < 3; iteration++) {
    const blocked = deferred();
    const closing = deferred();
    const allowClose = deferred();
    const beganAt = inputs.length;
    const spy = vi.spyOn(fs, "createReadStream").mockImplementation((...args) => {
      const stream = createReadStream(...args) as InputStream;
      const closed = new Promise<void>((resolve) => { stream.once("close", resolve); });
      inputs.push({ stream, closed });
      const destroy = stream._destroy.bind(stream);
      stream._destroy = (error, callback) => {
        destroy(error, (cause) => {
          closing.resolve();
          void allowClose.promise.then(() => callback(cause));
        });
      };
      return stream;
    });
    mocks.sink = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback): void {
        if (inputs.slice(beganAt).some(({ stream }) => stream.bytesRead > 0)) blocked.resolve();
        else callback();
      }
    });
    const jobId = `lifecycle-${iteration}`;
    let settled = false;
    const pending = callExport(jobId).finally(() => { settled = true; });
    try {
      await blocked.promise;
      expect(inputs.slice(beganAt)).toHaveLength(1);
      expect(inputs[beganAt]!.stream.fd).not.toBeNull();
      if (scenario === "cancel") await mocks.handlers.get("cart:exportZip:cancel")!({ jobId }, context);
      else if (scenario === "output failure") mocks.sink.destroy(new Error("disk full"));
      else inputs[beganAt]!.stream.destroy(new Error("source read failed"));
      // A correct implementation reaches input destruction first. The leaked
      // implementation returns while that source is still paused and open.
      await Promise.race([closing.promise, pending.then(() => undefined)]);
      expect(inputs[beganAt]!.stream.destroyed).toBe(true);
      expect(settled).toBe(false);
      expect(inputs[beganAt]!.stream.closed).toBe(false);
      allowClose.resolve();
      expect(await pending).toMatchObject({ ok: false, error: { code: scenario === "cancel" ? "cancelled" : "export_failed" } });
      await checkpoint();
      for (const { stream } of inputs) {
        expect(stream.closed).toBe(true);
        expect(stream.fd).toBeNull();
      }
      // No queued source was opened after cancellation/error, and no archive
      // replaced the destination or remained under its staging name.
      expect(inputs.slice(beganAt)).toHaveLength(1);
      expect(await readdir(mocks.root)).toEqual(["source.png"]);
      expect(mocks.reveal).not.toHaveBeenCalled();
    } finally {
      allowClose.resolve();
      mocks.sink.destroy();
      for (const { stream } of inputs.slice(beganAt)) stream.destroy();
      await Promise.all(inputs.slice(beganAt).map(({ closed }) => closed));
      await pending;
      spy.mockRestore();
    }
  }
});

test("successful real archives preserve entry order, bytes, metadata, and close all input descriptors", async () => {
  const createReadStream = fs.createReadStream;
  vi.spyOn(fs, "createReadStream").mockImplementation((...args) => {
    const stream = createReadStream(...args) as InputStream;
    inputs.push({ stream, closed: new Promise<void>((resolve) => stream.once("close", resolve)) });
    return stream;
  });
  const result = await callExport("success");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.fileCount).toBe(2);
  expect(inputs).toHaveLength(2);
  expect(inputs.every(({ stream }) => stream.closed && stream.fd === null)).toBe(true);
  const sourceStat = await stat(mocks.source);
  type EntryContents = { name: string; bytes: Buffer; mode: number; mtime: number };
  const entries = await new Promise<EntryContents[]>((resolve, reject) => {
    yauzl.open(result.value.path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error); return; }
      const found: EntryContents[] = [];
      zip.on("error", reject);
      zip.on("end", () => resolve(found));
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (cause, input) => {
          if (cause || !input) { reject(cause); return; }
          const chunks: Buffer[] = [];
          input.on("data", (chunk: Buffer) => chunks.push(chunk));
          input.on("error", reject);
          input.on("end", () => {
            found.push({ name: entry.fileName, bytes: Buffer.concat(chunks), mode: entry.externalFileAttributes >>> 16, mtime: entry.getLastModDate().getTime() });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
  expect(entries.map(({ name }) => name)).toEqual(["same-low.png", "same-low-2.png"]);
  const sourceBytes = await readFile(mocks.source);
  for (const entry of entries) {
    expect(entry.bytes.equals(sourceBytes)).toBe(true);
    expect(entry.mode).toBe(sourceStat.mode);
    expect(entry.mtime).toBe(Math.floor(sourceStat.mtimeMs / 1000) * 1000);
  }
  expect(basename(result.value.path)).toBe("export.zip");
});
