// `cart:contactSheet` / `cart:prepareSheetDrag` and the drag temp prune. The
// rules: a sheet handed to a drag or the clipboard must not be deleted by the
// 10-minute age prune while it is in use — a reused (cached) sheet restarts
// its prune clock, and a COPIED sheet lives outside the pruned folder,
// because the pasteboard keeps pointing at it long after the copy.

import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, Result } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  temp: "",
  handlers: new Map<string, (req: unknown, ctx: unknown) => Promise<unknown>>(),
  getCaptureById: vi.fn<(id: string) => CaptureRecord | null>(),
  bakeContactSheet: vi.fn(),
  writeNamedPngToPasteboard: vi.fn(async (_args: { pngPath: string; fileUrlPath: string }) => true)
}));

vi.mock("electron", () => ({
  app: { getPath: () => mocks.temp },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
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
vi.mock("../../render/image-presets", () => ({
  resolveImagePresetFile: async (rec: CaptureRecord) => ({ path: `/cache/${rec.id}.png` })
}));
vi.mock("../../render/file-alias", () => ({ prepareRenderedFileAlias: vi.fn() }));
vi.mock("../../render/export-filename", () => ({ buildPastedImageDisplayName: () => "x.png" }));
vi.mock("../../render/cart-drag-icon", () => ({
  composeCartDragIcon: vi.fn(async () => {
    throw new Error("no icon in tests");
  })
}));
vi.mock("../../cart/contact-sheet-bake", () => ({ bakeContactSheet: mocks.bakeContactSheet }));
vi.mock("../../clipboard/named-image-pasteboard", () => ({
  resolvePasteboardWriterPath: () => "/test/pasteboard-writer",
  writeNamedPngToPasteboard: mocks.writeNamedPngToPasteboard,
  writeNamedPngsToPasteboard: vi.fn()
}));
vi.mock("../../clipboard/file-clipboard", () => ({ writeFilesToClipboard: vi.fn() }));
vi.mock("../../clipboard/system-clipboard", () => ({ writeClipboardImage: vi.fn() }));
vi.mock("../../clipboard-events", () => ({ notifyClipboardChanged: vi.fn() }));
vi.mock("../../window", () => ({ findMainLibraryWindow: () => null }));

import { registerCartCopyAndSheetHandlers } from "../cart-copy-sheet-handlers";
import { cartClipboardDir, cartDragTempDir, pruneCartDragTemp } from "../../cart/cart-export-jobs";

const LAYOUT = { columns: "auto", spacing: "tight", background: "hatch" } as const;

function record(id: string): CaptureRecord {
  return {
    id,
    kind: "image",
    width_px: 100,
    height_px: 100,
    byte_size: 1000,
    edits_version: 0,
    deleted_at: null
  } as unknown as CaptureRecord;
}

async function call<T>(name: string, req: unknown): Promise<Result<T, { code: string }>> {
  return (await mocks.handlers.get(name)!(req, { signal: new AbortController().signal })) as Result<
    T,
    { code: string }
  >;
}

beforeEach(async () => {
  mocks.temp = await mkdtemp(join(tmpdir(), "pwrsnap-sheet-handler-"));
  vi.clearAllMocks();
  mocks.handlers.clear();
  registerCartCopyAndSheetHandlers();
  mocks.getCaptureById.mockImplementation((id) => record(id));
  mocks.bakeContactSheet.mockImplementation(async ({ destPath }: { destPath: string }) => {
    await writeFile(destPath, "sheet");
    return { plan: { width: 10, height: 10, scaledDown: false } };
  });
});

afterEach(async () => {
  await rm(mocks.temp, { recursive: true, force: true });
});

const tenMinutes = 10 * 60_000;

describe("contact sheet temp files", () => {
  test("a reused sheet restarts its prune clock, so a prune right after the reuse keeps it", async () => {
    const req = { captureIds: ["oat", "bran"], size: "m", layout: LAYOUT, suggestedName: "Cereal" };
    const first = await call<{ path: string }>("cart:prepareSheetDrag", req);
    expect(first.ok).toBe(true);
    const sheetPath = first.ok ? first.value.path : "";
    // Built nine and a half minutes ago.
    const old = new Date(Date.now() - tenMinutes + 30_000);
    await utimes(dirname(sheetPath), old, old);

    const again = await call<{ path: string }>("cart:prepareSheetDrag", req);
    expect(again.ok ? again.value.path : null).toBe(sheetPath);
    expect(mocks.bakeContactSheet).toHaveBeenCalledTimes(1); // the reuse, not a rebuild

    // The next prepare's prune, a minute later, must not take the sheet
    // that was just handed to a drag.
    await pruneCartDragTemp(cartDragTempDir(), tenMinutes - 60_000);
    await expect(stat(sheetPath)).resolves.toBeTruthy();
  });

  test("a copied sheet is outside the pruned folder; only the latest copy is kept", async () => {
    const copy = (captureIds: string[]) =>
      call<{ path: string }>("cart:contactSheet", {
        captureIds,
        size: "s",
        layout: LAYOUT,
        action: "copy",
        jobId: `job-${captureIds.join("-")}`
      });
    const first = await copy(["oat"]);
    expect(first.ok).toBe(true);
    const second = await copy(["oat", "bran", "corn"]);
    const pasted = second.ok ? second.value.path : "";

    expect(dirname(pasted)).toBe(cartClipboardDir());
    expect(mocks.writeNamedPngToPasteboard.mock.calls.at(-1)![0].fileUrlPath).toBe(pasted);
    // Everything under the drag temp dir ages out — the copied sheet stays.
    await pruneCartDragTemp(cartDragTempDir(), -1);
    expect(await readdir(cartDragTempDir())).toEqual([]);
    await expect(stat(pasted)).resolves.toBeTruthy();
    expect(await readdir(cartClipboardDir())).toEqual([pasted.slice(cartClipboardDir().length + 1)]);
  });
});
