// Regression tests for the video clipboard handlers.
//
// `clipboard:copyVideoFile` routes the friendly export alias through the
// platform file-clipboard abstraction (`public.file-url` on macOS, native
// CF_HDROP on Windows) and never co-writes text. `clipboard:copyVideoPath`
// remains the distinct plain-text-path action.
//
// `clipboard:copyVideoPath` writes `writeText(path)` only — same
// behavior the image `clipboard:copy-path` handler ships.

import { describe, expect, test, vi, beforeEach } from "vitest";

// ── Clipboard call recorder ───────────────────────────────────────────

type ClipboardCall =
  | { kind: "writeBuffer"; format: string; data: Buffer }
  | { kind: "writeText"; text: string }
  | { kind: "write"; data: unknown };

const clipboardCalls: ClipboardCall[] = [];
const fileClipboardCalls: string[] = [];
let fileClipboardFailure: Error | null = null;

vi.mock("electron", () => ({
  clipboard: {
    writeBuffer: (format: string, data: Buffer) => {
      clipboardCalls.push({ kind: "writeBuffer", format, data });
    },
    writeText: (text: string) => {
      clipboardCalls.push({ kind: "writeText", text });
    },
    write: (data: unknown) => {
      clipboardCalls.push({ kind: "write", data });
    }
  },
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => false }),
    createFromPath: () => ({ isEmpty: () => false }),
    createEmpty: () => ({ isEmpty: () => true })
  }
}));

// ── Stubs for the rest of the handler chain ──────────────────────────

const resolveResult = {
  ok: true as const,
  value: {
    result: {
      path: "/cache/video/cap_1/r0-10.med.silent.mp4",
      byteSize: 12345,
      durationSec: 10,
      widthPx: 1080,
      heightPx: 550,
      fromCache: false
    },
    record: { id: "cap_1", source_app_name: "Safari" },
    video: {
      durationSec: 10,
      containerFormat: "mp4",
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      defaultRange: { start: 0, end: 10 },
      previewPath: null,
      previewStatus: "ready"
    }
  }
};

const resolveVideoExportMock = vi.hoisted(() => vi.fn());

vi.mock("../../recording/video-export-resolver", () => ({
  resolveVideoExport: resolveVideoExportMock,
  mapVideoResolveError: (_e: unknown, verb: string, captureId: string) => ({
    kind: "validation" as const,
    code: "not_found",
    message: `${verb}: capture not found: ${captureId}`
  })
}));

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: () => null
}));

vi.mock("../../persistence/source-store", () => ({
  ensureEffectiveSrcPath: async () => "/tmp/src.png"
}));

vi.mock("../../persistence/bundle-store", () => ({
  readSourceFromBundle: async () => undefined,
  scheduleRepack: () => undefined
}));

vi.mock("../../render/coordinator", () => ({
  renderViaCoordinator: async () => ({
    cachePath: "/tmp/cache.png",
    fromCache: false
  })
}));

vi.mock("../../persistence/layers-repo", () => ({
  insertLayerTreeForCapture: () => undefined,
  listLayerTree: () => []
}));

vi.mock("../../persistence/paths", () => ({
  getCacheSourcePath: () => "/tmp/source.png"
}));

vi.mock("../../persistence/enrichment-repo", () => ({
  getCaptureEnrichment: () => ({
    acceptedFilenameStem: null,
    suggestedFilenameStem: "quarterly-roadmap-demo"
  })
}));

vi.mock("../../render/file-alias", () => ({
  prepareRenderedFileAlias: async (_path: string, displayName: string) =>
    `/cache/video/cap_1/clipboard/r0-10.med.silent/${displayName}`
}));

vi.mock("../../clipboard/named-image-pasteboard", () => ({
  writeNamedPngToPasteboard: async () => false
}));

vi.mock("../../clipboard/file-clipboard", () => ({
  writeFileToClipboard: async (path: string) => {
    fileClipboardCalls.push(path);
    if (fileClipboardFailure !== null) throw fileClipboardFailure;
  }
}));

vi.mock("../../clipboard-events", () => ({
  notifyClipboardChanged: () => undefined
}));

const { bus } = await import("../../command-bus");
const { registerClipboardHandlers } = await import("../clipboard-handlers");

resolveVideoExportMock.mockResolvedValue(resolveResult);
registerClipboardHandlers();

describe("clipboard:copyVideoFile", () => {
  beforeEach(() => {
    clipboardCalls.length = 0;
    fileClipboardCalls.length = 0;
    fileClipboardFailure = null;
    resolveVideoExportMock.mockReset();
    resolveVideoExportMock.mockResolvedValue(resolveResult);
  });

  test("writes the native file flavor once and does NOT co-write text", async () => {
    const result = await bus.dispatch(
      "clipboard:copyVideoFile",
      { captureId: "cap_1", format: "mp4", preset: "med" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);

    const texts = clipboardCalls.filter((c) => c.kind === "writeText");

    expect(fileClipboardCalls).toEqual([
      "/cache/video/cap_1/clipboard/r0-10.med.silent/quarterly-roadmap-demo-med.mp4"
    ]);
    expect(clipboardCalls.filter((c) => c.kind === "writeBuffer")).toHaveLength(0);
    expect(texts).toHaveLength(0);
  });

  test("copies the enrichment-based alias rather than the opaque cache filename", async () => {
    const result = await bus.dispatch(
      "clipboard:copyVideoFile",
      { captureId: "cap_1", format: "mp4", preset: "med" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.path).toBe(
      "/cache/video/cap_1/clipboard/r0-10.med.silent/quarterly-roadmap-demo-med.mp4"
    );

    expect(fileClipboardCalls).toEqual([result.value.path]);
    expect(fileClipboardCalls[0]).not.toContain("r0-10.med.silent.mp4");
  });

  test("returns a visible clipboard error when the native write/readback fails", async () => {
    fileClipboardFailure = new Error("CF_HDROP readback path mismatch");

    const result = await bus.dispatch(
      "clipboard:copyVideoFile",
      { captureId: "cap_1", format: "mp4", preset: "med" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected clipboard failure");
    expect(result.error.kind).toBe("clipboard");
    expect(result.error.code).toBe("video_clipboard_failed");
    expect(result.error.message).toContain("CF_HDROP readback");
  });

  test("maps a missing/failed transcoder to video_export_failed", async () => {
    resolveVideoExportMock.mockRejectedValueOnce(
      new Error("FFmpeg not found; packaged PwrSnapFFmpeg.exe is unavailable")
    );

    const result = await bus.dispatch(
      "clipboard:copyVideoFile",
      { captureId: "cap_1", format: "mp4", preset: "med" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected export failure");
    expect(result.error.kind).toBe("render");
    expect(result.error.code).toBe("video_export_failed");
    expect(result.error.message).toContain("PwrSnapFFmpeg.exe");
    expect(fileClipboardCalls).toHaveLength(0);
  });
});

// Bus-boundary validation. `resolveVideoExport` is stubbed to always
// succeed above, so a rejection here can only have come from the
// validator running BEFORE the resolver — which is the point: the
// caller-supplied `range` rides all the way to the export cache key
// and to ffmpeg's `-ss` / `-t`, and `normalizeRange` is a clamp, not
// a sanitizer.
describe("video clipboard verbs validate the caller-supplied range", () => {
  beforeEach(() => {
    clipboardCalls.length = 0;
    fileClipboardCalls.length = 0;
    resolveVideoExportMock.mockReset();
    resolveVideoExportMock.mockResolvedValue(resolveResult);
  });

  for (const verb of ["clipboard:copyVideoFile", "clipboard:copyVideoPath"] as const) {
    test(`${verb} rejects a NaN range without touching the clipboard`, async () => {
      const result = await bus.dispatch(
        verb,
        {
          captureId: "cap_1",
          format: "mp4",
          preset: "med",
          range: { start: Number.NaN, end: Number.NaN }
        },
        { principal: "ipc" }
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a validation rejection");
      expect(result.error.kind).toBe("validation");
      expect(result.error.code).toBe("invalid_range");
      expect(result.error.message).toContain(verb);
      // No encode was kicked off and nothing landed on the pasteboard.
      expect(clipboardCalls).toHaveLength(0);
    });

    test(`${verb} rejects an inverted range`, async () => {
      const result = await bus.dispatch(
        verb,
        { captureId: "cap_1", format: "mp4", preset: "med", range: { start: 9, end: 2 } },
        { principal: "ipc" }
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a validation rejection");
      expect(result.error.code).toBe("invalid_range");
      expect(clipboardCalls).toHaveLength(0);
    });

    test(`${verb} still accepts a well-formed range`, async () => {
      const result = await bus.dispatch(
        verb,
        { captureId: "cap_1", format: "mp4", preset: "med", range: { start: 1, end: 4 } },
        { principal: "ipc" }
      );
      expect(result.ok).toBe(true);
      expect(clipboardCalls.length + fileClipboardCalls.length).toBeGreaterThan(0);
    });
  }
});

describe("clipboard:copyVideoPath", () => {
  beforeEach(() => {
    clipboardCalls.length = 0;
    fileClipboardCalls.length = 0;
    resolveVideoExportMock.mockReset();
    resolveVideoExportMock.mockResolvedValue(resolveResult);
  });

  test("writes writeText ONLY — no writeBuffer", async () => {
    const result = await bus.dispatch(
      "clipboard:copyVideoPath",
      { captureId: "cap_1", format: "mp4", preset: "med" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);

    const buffers = clipboardCalls.filter((c) => c.kind === "writeBuffer");
    const texts = clipboardCalls.filter((c) => c.kind === "writeText");

    expect(buffers).toHaveLength(0);
    expect(fileClipboardCalls).toHaveLength(0);
    expect(texts).toHaveLength(1);
    expect(texts[0]?.text).toBe("/cache/video/cap_1/r0-10.med.silent.mp4");
  });
});
