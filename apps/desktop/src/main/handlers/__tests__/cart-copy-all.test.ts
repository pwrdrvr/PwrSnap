// `cart:copyAll` — the rule: render everything first, then write the
// clipboard ONCE with every image, in cart order. A cancel, or a cart where
// nothing renders, leaves the user's clipboard untouched. Videos / trashed /
// missing captures are left out and counted, like the Zip.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, Result } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (req: unknown, ctx: unknown) => Promise<unknown>>(),
  getCaptureById: vi.fn<(id: string) => CaptureRecord | null>(),
  resolveImagePresetFile: vi.fn<(rec: CaptureRecord, preset: string) => Promise<{ path: string }>>(),
  prepareRenderedFileAlias: vi.fn(async (path: string, name: string) => `/alias/${name}#${path}`),
  writeNamedPngsToPasteboard: vi.fn(async (_args: { items: Array<{ pngPath: string }> }) => true),
  writeFilesToClipboard: vi.fn(async (_paths: readonly string[]) => undefined),
  notifyClipboardChanged: vi.fn(),
  send: vi.fn()
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send: mocks.send } }])
  },
  dialog: { showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  nativeImage: { createFromPath: vi.fn() }
}));
vi.mock("../../command-bus", () => ({
  bus: {
    register: vi.fn((name: string, handler: (req: unknown, ctx: unknown) => Promise<unknown>) => {
      mocks.handlers.set(name, handler);
    })
  }
}));
vi.mock("../../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));
vi.mock("../../persistence/captures-repo", () => ({ getCaptureById: mocks.getCaptureById }));
vi.mock("../../persistence/enrichment-repo", () => ({ getCaptureEnrichment: () => null }));
vi.mock("../../render/image-presets", () => ({ resolveImagePresetFile: mocks.resolveImagePresetFile }));
vi.mock("../../render/file-alias", () => ({ prepareRenderedFileAlias: mocks.prepareRenderedFileAlias }));
vi.mock("../../render/export-filename", () => ({
  buildPastedImageDisplayName: ({ record }: { record: CaptureRecord }) => `PwrSnap-${record.source_app_name}.png`
}));
vi.mock("../../render/cart-drag-icon", () => ({ composeCartDragIcon: vi.fn() }));
vi.mock("../../cart/contact-sheet-bake", () => ({ bakeContactSheet: vi.fn() }));
vi.mock("../../clipboard/named-image-pasteboard", () => ({
  writeNamedPngToPasteboard: vi.fn(),
  writeNamedPngsToPasteboard: mocks.writeNamedPngsToPasteboard
}));
vi.mock("../../clipboard/file-clipboard", () => ({ writeFilesToClipboard: mocks.writeFilesToClipboard }));
vi.mock("../../clipboard/system-clipboard", () => ({ writeClipboardImage: vi.fn() }));
vi.mock("../../clipboard-events", () => ({ notifyClipboardChanged: mocks.notifyClipboardChanged }));
vi.mock("../../window", () => ({ findMainLibraryWindow: () => null }));

import { registerCartCopyAndSheetHandlers } from "../cart-copy-sheet-handlers";
import { exportJobs } from "../../cart/cart-export-jobs";

function record(id: string, over: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id,
    kind: "image",
    source_app_name: id,
    width_px: 100,
    height_px: 100,
    byte_size: 1000,
    edits_version: 0,
    deleted_at: null,
    ...over
  } as unknown as CaptureRecord;
}

/** Every path that reached the clipboard, whichever platform writer ran. */
function clipboardWrites(): string[][] {
  return [
    ...mocks.writeNamedPngsToPasteboard.mock.calls.map(([args]) => args.items.map((i) => i.pngPath)),
    ...mocks.writeFilesToClipboard.mock.calls.map(([paths]) => [...paths])
  ];
}

type CopyRes = { fileCount: number; skipped: number; failed: number };

async function copyAll(captureIds: string[], signal = new AbortController().signal): Promise<Result<CopyRes, { code: string }>> {
  const handler = mocks.handlers.get("cart:copyAll")!;
  return (await handler({ captureIds, preset: "med", jobId: "job-1" }, { signal })) as Result<CopyRes, { code: string }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  registerCartCopyAndSheetHandlers();
  const records: Record<string, CaptureRecord> = {
    granola: record("granola"),
    oat: record("oat"),
    bran: record("bran"),
    twin: record("twin", { source_app_name: "granola" }),
    clip: record("clip", { kind: "video" }),
    gone: record("gone", { deleted_at: "2026-11-01T00:00:00.000Z" })
  };
  mocks.getCaptureById.mockImplementation((id) => records[id] ?? null);
  mocks.resolveImagePresetFile.mockImplementation(async (rec) => ({ path: `/cache/${rec.id}.png` }));
});

describe("cart:copyAll", () => {
  test("one clipboard write carrying every image, in cart order; videos and trashed are left out", async () => {
    const r = await copyAll(["bran", "clip", "granola", "gone", "oat", "missing"]);
    expect(r).toEqual({ ok: true, value: { fileCount: 3, skipped: 3, failed: 0 } });
    const writes = clipboardWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.map((p) => p.split("#")[1])).toEqual([
      "/cache/bran.png",
      "/cache/granola.png",
      "/cache/oat.png"
    ]);
    expect(mocks.notifyClipboardChanged).toHaveBeenCalledTimes(1);
  });

  test("two snaps with the same name paste as two files, not one replacing the other", async () => {
    await copyAll(["granola", "twin"]);
    const names = clipboardWrites()[0]!.map((p) => p.split("#")[0]);
    expect(names).toEqual(["/alias/PwrSnap-granola.png", "/alias/PwrSnap-granola (2).png"]);
  });

  test("a render failure is left out and counted; the rest still copy", async () => {
    mocks.resolveImagePresetFile.mockImplementation(async (rec) => {
      if (rec.id === "oat") throw new Error("corrupt source");
      return { path: `/cache/${rec.id}.png` };
    });
    const r = await copyAll(["granola", "oat", "bran"]);
    expect(r).toEqual({ ok: true, value: { fileCount: 2, skipped: 0, failed: 1 } });
    expect(clipboardWrites()).toHaveLength(1);
  });

  test("nothing rendered → the clipboard is not touched", async () => {
    mocks.resolveImagePresetFile.mockRejectedValue(new Error("corrupt"));
    const r = await copyAll(["granola", "oat"]);
    expect(r.ok).toBe(false);
    expect(clipboardWrites()).toHaveLength(0);
    expect(mocks.notifyClipboardChanged).not.toHaveBeenCalled();
  });

  test("Cancel during rendering → cancelled, and the clipboard is not touched", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.resolveImagePresetFile.mockImplementation(async (rec) => {
      await gate;
      return { path: `/cache/${rec.id}.png` };
    });
    const pending = copyAll(["granola", "oat", "bran"]);
    // `cart:exportZip:cancel` aborts whatever is registered under the jobId.
    exportJobs.get("job-1")!.abort();
    release();
    const r = await pending;
    expect(r.ok ? null : r.error.code).toBe("cancelled");
    expect(clipboardWrites()).toHaveLength(0);
    expect(exportJobs.has("job-1")).toBe(false);
  });

  test("a cart of only videos is nothing to export", async () => {
    const r = await copyAll(["clip"]);
    expect(r.ok ? null : r.error.code).toBe("nothing_to_export");
    expect(clipboardWrites()).toHaveLength(0);
  });

  test("progress ends with a done beat whatever happened", async () => {
    await copyAll(["granola"]);
    const phases = mocks.send.mock.calls.map(([, ev]) => (ev as { phase: string }).phase);
    expect(phases.at(-1)).toBe("done");
    expect(phases).toContain("rendering");
  });
});
