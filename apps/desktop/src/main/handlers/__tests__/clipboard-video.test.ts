// Regression tests for the video clipboard handlers.
//
// `clipboard:copyVideoFile` writes `public.file-url` only — NOT
// also `writeText(path)`. The earlier v1 of this handler did both,
// which was discovered to silently overwrite the file-url on macOS
// because each Electron `clipboard.write*` call wraps a
// `ScopedClipboardWriter` that calls `[pasteboard clearContents]`.
// Result: iMessage / Slack paste landed the path text instead of
// the file binary (commit `db71a078`). This file locks the fix.
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

vi.mock("../../recording/video-export-resolver", () => ({
  resolveVideoExport: async () => resolveResult,
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

vi.mock("../../clipboard-events", () => ({
  notifyClipboardChanged: () => undefined
}));

const { bus } = await import("../../command-bus");
const { registerClipboardHandlers } = await import("../clipboard-handlers");

registerClipboardHandlers();

describe("clipboard:copyVideoFile", () => {
  beforeEach(() => {
    clipboardCalls.length = 0;
  });

  test("writes public.file-url ONCE and does NOT call writeText", async () => {
    // Regression for db71a078 — `writeText` after `writeBuffer` on
    // macOS wipes the file-url and iMessage pastes the text path
    // instead of the file binary.
    const result = await bus.dispatch(
      "clipboard:copyVideoFile",
      { captureId: "cap_1", format: "mp4", preset: "med" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);

    const buffers = clipboardCalls.filter((c) => c.kind === "writeBuffer");
    const texts = clipboardCalls.filter((c) => c.kind === "writeText");

    expect(buffers).toHaveLength(1);
    expect(buffers[0]?.format).toBe("public.file-url");
    expect(texts).toHaveLength(0);
  });

  test("file-url contains the cache path as a percent-encoded file:// URL", async () => {
    await bus.dispatch(
      "clipboard:copyVideoFile",
      { captureId: "cap_1", format: "mp4", preset: "med" },
      { principal: "ipc" }
    );
    const buffer = clipboardCalls.find((c) => c.kind === "writeBuffer");
    if (buffer === undefined || buffer.kind !== "writeBuffer") {
      throw new Error("expected a writeBuffer call");
    }
    const url = buffer.data.toString("utf8");
    expect(url.startsWith("file:///cache/video/")).toBe(true);
    // The path components after `file://` should NOT have raw
    // shell-special characters that would break NSURL parsing.
    expect(url).toMatch(/^file:\/\/\/[\w%./-]+$/);
  });
});

describe("clipboard:copyVideoPath", () => {
  beforeEach(() => {
    clipboardCalls.length = 0;
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
    expect(texts).toHaveLength(1);
    expect(texts[0]?.text).toBe("/cache/video/cap_1/r0-10.med.silent.mp4");
  });
});
