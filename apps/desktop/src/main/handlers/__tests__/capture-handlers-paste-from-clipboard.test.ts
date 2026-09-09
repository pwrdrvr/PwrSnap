// Unit coverage for `capture:pasteFromClipboard`'s empty, file-URL, and
// Windows Explorer CF_HDROP branches. The no_image case formerly lived in
// `apps/desktop/e2e/clipboard-paste.spec.ts`; file-URL coverage here pins
// the secure byte-read boundary and path-redaction contract without relying
// on host NSPasteboard behavior.
//
// The error branch never touches sharp / persistence / float-over — it
// just reads the clipboard surface, finds no image bytes, no image
// buffers, no image file URL, and returns
// `{ kind: "clipboard", code: "no_image" }`. Driving it through a unit
// test eliminates a launchPwrSnap round-trip for what is structurally
// an envelope-shape assertion.
//
// The native-image happy path (`capture:pasteFromClipboard persists current
// clipboard image`) stays in E2E because it depends on real macOS
// NSPasteboard semantics + the full persistence + render pipeline. The File
// menu wiring test also stays there; this unit only pins its synchronous,
// filesystem-free availability probe.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PASTE_IMAGE_MAX_BYTES } from "@pwrsnap/shared";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isEmpty: vi.fn(() => true),
  toPNG: vi.fn(() => Buffer.alloc(0)),
  getSize: vi.fn(() => ({ width: 1, height: 1 })),
  availableFormats: vi.fn((): string[] => []),
  readBookmark: vi.fn(() => ({ title: "", url: "" })),
  readBuffer: vi.fn(() => Buffer.alloc(0)),
  readText: vi.fn(() => ""),
  readWindowsClipboardImageFile: vi.fn(),
  windowsClipboardFormatsMayContainFiles: vi.fn((_formats: readonly string[]) => false),
  readSafePastedFile: vi.fn(),
  ingestImageBufferToTempPng: vi.fn(),
  writeFirstDecodableClipboardBufferToPng: vi.fn(),
  persistCaptureFromTempV2: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn()
}));

const securityMocks = vi.hoisted(() => {
  class UnsafePastedFileError extends Error {
    readonly code: string;
    readonly sanitizedMessage: string;

    constructor(code: string, sanitizedMessage: string, message: string) {
      super(message);
      this.name = "UnsafePastedFileError";
      this.code = code;
      this.sanitizedMessage = sanitizedMessage;
    }
  }

  return { UnsafePastedFileError };
});

const captureStorageMocks = vi.hoisted(() => {
  class CapturesLocationFallbackError extends Error {
    readonly pwrSnapError: {
      kind: "capture";
      code: string;
      message: string;
    };

    constructor(error: { kind: "capture"; code: string; message: string }) {
      super(error.message);
      this.name = "CapturesLocationFallbackError";
      this.pwrSnapError = error;
    }
  }

  return { CapturesLocationFallbackError };
});

vi.mock("electron", () => ({
  clipboard: {
    readImage: () => ({
      isEmpty: mocks.isEmpty,
      getSize: mocks.getSize,
      toPNG: mocks.toPNG
    }),
    availableFormats: mocks.availableFormats,
    readBookmark: mocks.readBookmark,
    readBuffer: mocks.readBuffer,
    readText: mocks.readText,
    writeText: () => undefined
  },
  screen: {
    getAllDisplays: () => []
  },
  BrowserWindow: {
    getAllWindows: () => []
  }
}));

vi.mock("../../security/assertSafePastedFile", () => ({
  readSafePastedFile: mocks.readSafePastedFile,
  UnsafePastedFileError: securityMocks.UnsafePastedFileError
}));

vi.mock("../../clipboard-image-buffer", () => ({
  clipboardImageBufferFormats: (formats: readonly string[]) =>
    formats.filter((format) => {
      const lower = format.toLowerCase();
      return !lower.includes("url") && lower.includes("png");
    }),
  ingestImageBufferToTempPng: mocks.ingestImageBufferToTempPng,
  writeFirstDecodableClipboardBufferToPng:
    mocks.writeFirstDecodableClipboardBufferToPng
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
    debug: mocks.logDebug
  })
}));

// The handler module imports many siblings at module load — most are
// never reached on the no_image path, but their imports still need to
// resolve. Mock the heavy ones (native binaries, screen-capture
// pipeline) so they don't try to spawn helpers or load
// better-sqlite3 in the test runner.
//
// MAINTENANCE: if you add a new import to `capture-handlers.ts` that
// runs side-effects at module load (registers a handler, opens a file,
// spawns a child), add a `vi.mock` for it here. vi.mock only matches
// what's actually imported, so a missing mock fails silently — the
// import would resolve to the real module and either spawn something
// the test runner can't handle (sharp, ffmpeg, the Swift recorder) or
// leak state across test files via a singleton.
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

vi.mock("../../capture/capture-storage-gate", () => {
  return {
    CapturesLocationFallbackError:
      captureStorageMocks.CapturesLocationFallbackError,
    ensureCapturesDirReady: async () => null,
    runWithCapturesDirFallback: async (
      operation: (outputDir: string) => Promise<unknown>
    ) => await operation("/test/captures")
  };
});

vi.mock("../../capture/screen-snapshot", () => ({
  releaseSnapshot: async () => undefined
}));

vi.mock("../../capture/window-list", () => ({
  activateApp: async () => undefined,
  findWindowAt: () => null,
  // cursor-sample.ts (imported by capture-handlers) resolves the helper
  // path through here; null = "helper unavailable" so sampleCursor
  // degrades to no-cursor-layer in any future spec that reaches it.
  resolveWindowListHelperPath: () => null
}));

vi.mock("../../clipboard/windows-file-clipboard-reader", () => ({
  readWindowsClipboardImageFile: () => mocks.readWindowsClipboardImageFile(),
  isSupportedClipboardImagePath: (path: string) =>
    /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(path),
  windowsClipboardFormatsMayContainFiles: (formats: readonly string[]) =>
    mocks.windowsClipboardFormatsMayContainFiles(formats)
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
  reclaimDockIconIfLibraryAlive: () => undefined
}));

vi.mock("../codex-handlers", () => ({
  maybeEnqueueCaptureEnrichment: () => undefined
}));

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: () => null,
  insertCapture: () => ({})
}));

vi.mock("../../persistence/source-store", () => ({
  ensureEffectiveSrcPath: async () => "",
  putCaptureSource: async () => ({})
}));

vi.mock("../../persistence/bundle-store", () => ({
  persistCaptureFromTempV2: mocks.persistCaptureFromTempV2
}));

vi.mock("../../render/coordinator", () => ({
  renderViaCoordinator: async () => ({ cachePath: "", byteSize: 0, fromCache: false })
}));

vi.mock("../../render/file-alias", () => ({
  prepareRenderedFileAlias: async () => ""
}));

const { bus } = await import("../../command-bus");
const { clipboardHasPasteableImage, registerCaptureHandlers } = await import(
  "../capture-handlers"
);

registerCaptureHandlers();

const persistedRecord = {
  id: "clipboard-capture-id",
  kind: "image" as const,
  captured_at: "2026-08-23T12:00:00.000Z",
  legacy_src_path: null,
  bundle_path: "/test/captures/clipboard-capture-id.pwrsnap",
  flat_png_path: "/test/captures/clipboard-capture-id.png",
  bundle_modified_at: "2026-08-23T12:00:00.000Z",
  bundle_format_version: 2,
  bundle_edits_version: 0,
  width_px: 320,
  height_px: 180,
  device_pixel_ratio: 2,
  byte_size: 1234,
  sha256: "a".repeat(64),
  source_app_bundle_id: "com.pwrsnap.clipboard",
  source_app_name: "Clipboard",
  edits_version: 0,
  deleted_at: null,
  has_alpha: false
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isEmpty.mockReturnValue(true);
  mocks.getSize.mockReturnValue({ width: 1, height: 1 });
  mocks.toPNG.mockReturnValue(Buffer.alloc(0));
  mocks.availableFormats.mockReturnValue([]);
  mocks.readBookmark.mockReturnValue({ title: "", url: "" });
  mocks.readBuffer.mockReturnValue(Buffer.alloc(0));
  mocks.readText.mockReturnValue("");
  mocks.readWindowsClipboardImageFile.mockResolvedValue({ ok: true, path: null });
  mocks.windowsClipboardFormatsMayContainFiles.mockReturnValue(false);
  mocks.readSafePastedFile.mockResolvedValue(Buffer.from("safe image bytes"));
  mocks.ingestImageBufferToTempPng.mockResolvedValue({
    tempPath: "/test/tmp/clipboard.png",
    devicePixelRatio: 2
  });
  mocks.writeFirstDecodableClipboardBufferToPng.mockResolvedValue({
    ok: false,
    failures: []
  });
  mocks.persistCaptureFromTempV2.mockResolvedValue({
    record: persistedRecord,
    isDedup: false
  });
});

describe("capture:pasteFromClipboard", () => {
  test("returns kind=clipboard, code=no_image when the clipboard is empty", async () => {
    // Default vi.hoisted state already simulates the empty-clipboard
    // path: no image bytes, no buffers, no bookmark url, no file URL
    // in text. Each `readClipboard*` call returns its empty form.
    const result = await bus.dispatch(
      "capture:pasteFromClipboard",
      {},
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("clipboard");
    expect(result.error.code).toBe("no_image");
    expect(result.error.message).toMatch(/clipboard/i);
  });

  test("refuses huge decoded NativeImage dimensions before toPNG", async () => {
    mocks.isEmpty.mockReturnValue(false);
    mocks.getSize.mockReturnValue({ width: 6_000, height: 6_000 });

    const result = await bus.dispatch(
      "capture:pasteFromClipboard",
      {},
      { principal: "ipc" }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "clipboard",
        code: "paste_failed",
        message: "Unable to paste the clipboard image"
      }
    });
    expect(mocks.toPNG).not.toHaveBeenCalled();
    expect(mocks.persistCaptureFromTempV2).not.toHaveBeenCalled();
  });

  test("routes a percent-encoded file URL through the bounded secure reader", async () => {
    const safePath = join(tmpdir(), "PwrSnap safe image.png");
    const safeUrl = pathToFileURL(safePath).href;
    const safeBytes = Buffer.from("bytes returned by secure open");
    expect(safeUrl).toContain("PwrSnap%20safe%20image.png");
    mocks.readBookmark.mockReturnValue({ title: "PwrSnap safe image.png", url: safeUrl });
    mocks.readSafePastedFile.mockResolvedValue(safeBytes);

    const result = await bus.dispatch(
      "capture:pasteFromClipboard",
      {},
      { principal: "ipc" }
    );

    expect(mocks.readSafePastedFile).toHaveBeenCalledWith(safePath, {
      maxBytes: PASTE_IMAGE_MAX_BYTES
    });
    expect(mocks.ingestImageBufferToTempPng).toHaveBeenCalledWith(
      safeBytes,
      expect.any(Function)
    );
    expect(mocks.persistCaptureFromTempV2).toHaveBeenCalledWith(
      expect.objectContaining({
        tempPath: "/test/tmp/clipboard.png",
        devicePixelRatio: 2
      })
    );
    expect(result).toEqual({ ok: true, value: persistedRecord });
  });

  test.each([
    "C:\\Users\\Ada\\Pictures\\copied image.png",
    "\\\\server\\share\\Pictures\\copied image.png"
  ])("routes a native CF_HDROP candidate through the same safe byte snapshot: %s", async (path) => {
    const safeBytes = Buffer.from("bytes returned by one verified open");
    mocks.readWindowsClipboardImageFile.mockResolvedValue({ ok: true, path });
    mocks.readSafePastedFile.mockResolvedValue(safeBytes);

    const result = await bus.dispatch(
      "capture:pasteFromClipboard",
      {},
      { principal: "ipc" }
    );

    expect(mocks.readSafePastedFile).toHaveBeenCalledWith(path, {
      maxBytes: PASTE_IMAGE_MAX_BYTES
    });
    expect(mocks.ingestImageBufferToTempPng).toHaveBeenCalledWith(
      safeBytes,
      expect.any(Function)
    );
    expect(result).toEqual({ ok: true, value: persistedRecord });
  });

  test("rejects multiple Windows Explorer files with a specific clipboard error", async () => {
    mocks.readWindowsClipboardImageFile.mockResolvedValue({
      ok: false,
      error: {
        code: "multiple_files",
        message: "PwrSnap can paste one image file at a time; the clipboard contains 2 files.",
        terminal: true
      }
    });

    const result = await bus.dispatch(
      "capture:pasteFromClipboard",
      {},
      { principal: "ipc" }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "clipboard", code: "multiple_files" }
    });
    expect(mocks.readSafePastedFile).not.toHaveBeenCalled();
    expect(mocks.readBuffer).not.toHaveBeenCalledWith("CF_HDROP");
  });

  test("rejects a non-image Explorer file instead of reporting no_image", async () => {
    mocks.readWindowsClipboardImageFile.mockResolvedValue({
      ok: false,
      error: {
        code: "not_image_file",
        message: "The copied file is not a supported image: demo.mp4",
        terminal: true
      }
    });

    const result = await bus.dispatch(
      "capture:pasteFromClipboard",
      {},
      { principal: "ipc" }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "clipboard", code: "not_image_file" }
    });
    expect(mocks.readSafePastedFile).not.toHaveBeenCalled();
  });

  test("keeps the synchronous menu probe filesystem-free for file URLs", () => {
    const safeUrl = pathToFileURL(join(tmpdir(), "menu probe.png")).href;
    mocks.readBookmark.mockReturnValue({ title: "menu probe.png", url: safeUrl });

    expect(clipboardHasPasteableImage()).toBe(true);
    expect(mocks.readSafePastedFile).not.toHaveBeenCalled();
    expect(mocks.ingestImageBufferToTempPng).not.toHaveBeenCalled();
  });

  test("keeps the synchronous menu probe filesystem-free for native file formats", () => {
    mocks.windowsClipboardFormatsMayContainFiles.mockReturnValue(true);
    mocks.availableFormats.mockReturnValue(["text/uri-list"]);

    expect(clipboardHasPasteableImage()).toBe(true);
    expect(mocks.readWindowsClipboardImageFile).not.toHaveBeenCalled();
    expect(mocks.readSafePastedFile).not.toHaveBeenCalled();
  });

  test("returns a sanitized stable error when the secure file gate refuses the URL", async () => {
    const privatePath = join(tmpdir(), "private credentials", "secret.png");
    mocks.readBookmark.mockReturnValue({
      title: "secret.png",
      url: pathToFileURL(privatePath).href
    });
    mocks.readSafePastedFile.mockRejectedValue(
      new securityMocks.UnsafePastedFileError(
        "privileged_path",
        "Invalid file",
        `refusing pasted file inside privileged dir: ${privatePath}`
      )
    );

    const result = await bus.dispatch(
      "capture:pasteFromClipboard",
      {},
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toMatchObject({
      kind: "clipboard",
      code: "clipboard_file_unavailable",
      message: "Invalid file"
    });
    expect(JSON.stringify(result)).not.toContain(privatePath);
    expect(mocks.ingestImageBufferToTempPng).not.toHaveBeenCalled();
    expect(mocks.persistCaptureFromTempV2).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("clipboard image file unavailable", {
      code: "privileged_path"
    });
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain(privatePath);
  });

  test("redacts a rejected CF_HDROP candidate without reopening its pathname", async () => {
    const privatePath = "C:\\Users\\Ada\\Pictures\\junction\\secret.png";
    mocks.readWindowsClipboardImageFile.mockResolvedValue({
      ok: true,
      path: privatePath
    });
    mocks.readSafePastedFile.mockRejectedValue(
      new securityMocks.UnsafePastedFileError(
        "symlink",
        "Invalid file",
        `refusing to follow a junction at ${privatePath}`
      )
    );

    const result = await bus.dispatch(
      "capture:pasteFromClipboard",
      {},
      { principal: "ipc" }
    );

    expect(mocks.readSafePastedFile).toHaveBeenCalledWith(privatePath, {
      maxBytes: PASTE_IMAGE_MAX_BYTES
    });
    expect(mocks.ingestImageBufferToTempPng).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "clipboard",
        code: "clipboard_file_unavailable",
        message: "Invalid file"
      }
    });
    expect(JSON.stringify(result)).not.toContain(privatePath);
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain(privatePath);
  });

  test("sanitizes an approved clipboard file's decoder failure", async () => {
    const privatePath = join(tmpdir(), "private folder", "broken image.png");
    mocks.readBookmark.mockReturnValue({
      title: "broken image.png",
      url: pathToFileURL(privatePath).href
    });
    mocks.ingestImageBufferToTempPng.mockRejectedValue(
      new Error(`decoder rejected ${privatePath}`)
    );

    const result = await bus.dispatch(
      "capture:pasteFromClipboard",
      {},
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("clipboard");
    expect(result.error.code).toBe("unsupported_image");
    expect(result.error.message).toBe(
      "Could not decode clipboard image formats: clipboard file"
    );
    expect(result.error.cause).toEqual([
      { source: "clipboard file", cause: { code: "decode_failed" } }
    ]);
    expect(JSON.stringify(result)).not.toContain(privatePath);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "clipboard image file decode failed",
      { code: "decode_failed" }
    );
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain(privatePath);
  });

  test("sanitizes a thrown clipboard persistence failure", async () => {
    const privatePath = join(tmpdir(), "private folder", "source image.png");
    mocks.readBookmark.mockReturnValue({
      title: "source image.png",
      url: pathToFileURL(privatePath).href
    });
    mocks.persistCaptureFromTempV2.mockRejectedValue(
      new Error(`persistence failed for ${privatePath}`)
    );

    const result = await bus.dispatch(
      "capture:pasteFromClipboard",
      {},
      { principal: "ipc" }
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "clipboard",
        code: "paste_failed",
        message: "Unable to paste the clipboard image"
      }
    });
    expect(JSON.stringify(result)).not.toContain(privatePath);
    expect(mocks.logError).toHaveBeenCalledWith("clipboard paste failed", {
      code: "persist_failed"
    });
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain(privatePath);
  });

  test("preserves the actionable path-free captures fallback failure", async () => {
    mocks.readBookmark.mockReturnValue({
      title: "clipboard.png",
      url: pathToFileURL(join(tmpdir(), "clipboard.png")).href
    });
    const fallbackError = {
      kind: "capture" as const,
      code: "captures_fallback_failed",
      message:
        "PwrSnap couldn't remember its fallback captures folder, so it did not risk splitting your library across two locations."
    };
    mocks.persistCaptureFromTempV2.mockRejectedValue(
      new captureStorageMocks.CapturesLocationFallbackError(fallbackError)
    );

    const result = await bus.dispatch(
      "capture:pasteFromClipboard",
      {},
      { principal: "ipc" }
    );

    expect(result).toEqual({ ok: false, error: fallbackError });
    expect(mocks.logError).toHaveBeenCalledWith("capture persist failed", {
      code: "captures_fallback_failed"
    });
    expect(mocks.logError).not.toHaveBeenCalledWith(
      "clipboard paste failed",
      expect.anything()
    );
  });

  test("sanitizes a decoder/temp failure thrown before persistence", async () => {
    const privatePath = join(tmpdir(), "private source", "clipboard.png");
    mocks.writeFirstDecodableClipboardBufferToPng.mockRejectedValue(
      new Error(`temp write failed for ${privatePath}`)
    );

    const result = await bus.dispatch(
      "capture:pasteFromClipboard",
      {},
      { principal: "ipc" }
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "clipboard",
        code: "paste_failed",
        message: "Unable to paste the clipboard image"
      }
    });
    expect(mocks.persistCaptureFromTempV2).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(privatePath);
    expect(mocks.logError).toHaveBeenCalledWith(
      "clipboard paste decode failed",
      { code: "decode_failed" }
    );
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain(privatePath);
  });
});
