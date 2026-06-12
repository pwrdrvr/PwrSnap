// Unit coverage for the `capture:pasteFromClipboard` no_image branch —
// formerly the `capture:pasteFromClipboard returns a structured error
// when clipboard has no image` E2E spec in
// `apps/desktop/e2e/clipboard-paste.spec.ts`.
//
// The error branch never touches sharp / persistence / float-over — it
// just reads the clipboard surface, finds no image bytes, no image
// buffers, no image file URL, and returns
// `{ kind: "clipboard", code: "no_image" }`. Driving it through a unit
// test eliminates a launchPwrSnap round-trip for what is structurally
// an envelope-shape assertion.
//
// The happy-path test (`capture:pasteFromClipboard persists current
// clipboard image`) stays in E2E because it depends on real macOS
// NSPasteboard semantics + the full persistence + render pipeline. The
// menu-availability test (`File menu exposes New -> Paste from
// Clipboard`) also stays — it reads the real Electron Menu.

import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isEmpty: vi.fn(() => true),
  toPNG: vi.fn(() => Buffer.alloc(0)),
  availableFormats: vi.fn((): string[] => []),
  readBookmark: vi.fn(() => ({ title: "", url: "" })),
  readBuffer: vi.fn(() => Buffer.alloc(0)),
  readText: vi.fn(() => ""),
  pickRegion: vi.fn(),
  hideSelector: vi.fn(),
  activateApp: vi.fn()
}));

vi.mock("electron", () => ({
  clipboard: {
    readImage: () => ({
      isEmpty: mocks.isEmpty,
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
  pickRegion: mocks.pickRegion,
  getLastWindowListSnapshot: () => [],
  hideSelector: mocks.hideSelector
}));

vi.mock("../../capture/screencapture", () => ({
  captureRegion: async () => ({ ok: false, reason: "validation", message: "stub" }),
  captureWindow: async () => ({ ok: false, reason: "validation", message: "stub" })
}));

vi.mock("../../capture/screen-snapshot", () => ({
  releaseSnapshot: async () => undefined
}));

vi.mock("../../capture/window-list", () => ({
  activateApp: mocks.activateApp,
  findWindowAt: () => null
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

vi.mock("../codex-handlers", () => ({
  maybeEnqueueCaptureEnrichment: () => undefined
}));

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: () => null,
  insertOrFindCapture: () => ({ record: null, isNew: false })
}));

vi.mock("../../persistence/source-store", () => ({
  ensureEffectiveSrcPath: async () => "",
  putCaptureSource: async () => ({})
}));

vi.mock("../../persistence/bundle-store", () => ({
  persistCaptureFromTempV2: async () => ({ record: null, isDedup: false })
}));

vi.mock("../../render/coordinator", () => ({
  renderViaCoordinator: async () => ({ cachePath: "", byteSize: 0, fromCache: false })
}));

vi.mock("../../render/file-alias", () => ({
  prepareRenderedFileAlias: async () => ""
}));

const { bus } = await import("../../command-bus");
const { registerCaptureHandlers } = await import("../capture-handlers");

registerCaptureHandlers();

beforeEach(() => {
  mocks.isEmpty.mockReturnValue(true);
  mocks.toPNG.mockReturnValue(Buffer.alloc(0));
  mocks.availableFormats.mockReturnValue([]);
  mocks.readBookmark.mockReturnValue({ title: "", url: "" });
  mocks.readBuffer.mockReturnValue(Buffer.alloc(0));
  mocks.readText.mockReturnValue("");
  mocks.pickRegion.mockResolvedValue({
    ok: false,
    reason: "cancelled",
    previousAppPid: 42
  });
  mocks.hideSelector.mockClear();
  mocks.activateApp.mockClear();
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
});

describe("capture:interactive focus policy", () => {
  test("does not activate apps or run Library/Dock recovery on cancel", async () => {
    const result = await bus.dispatch(
      "capture:interactive",
      { mode: "auto" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected cancel");
    expect(result.error.code).toBe("cancelled");
    expect(mocks.pickRegion).toHaveBeenCalledWith({
      mode: "auto",
      keepPwrSnapChrome: true
    });
    expect(mocks.hideSelector).toHaveBeenCalledTimes(1);
    expect(mocks.activateApp).not.toHaveBeenCalled();
  });
});
