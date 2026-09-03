// Routing coverage for the Snap-vs-Record chooser (issue #75) inside
// `capture:interactive`.
//
// This is the one seam where the chooser stops being UI: a committed
// selection either goes down the still pipeline that has always been
// here, or gets handed — frozen, un-re-picked — to the recording
// continuation the dedicated Video Capture hotkey uses. Getting the
// branch wrong is not a cosmetic bug: the wrong side of it either
// silently drops the user's Record, or persists nothing while they wait
// for a screenshot that never arrives.
//
// The still pipeline is deliberately stubbed to die at its first step
// (`screen.getAllDisplays()` returns nothing, so the display lookup
// fails). Everything past the branch is covered elsewhere, and that
// failure is a precise branch signal: the record path never touches
// displays and always answers ok, so a `capture` error can only mean
// the still pipeline ran.
//
// MAINTENANCE: capture-handlers.ts imports a lot at module load. If you
// add an import with load-time side effects, mock it here too — vi.mock
// only matches what is imported, so a missing mock fails silently by
// resolving the real module.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createCaptureInvocation, type QuickCaptureAction } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  pickRegion: vi.fn(),
  captureRegion: vi.fn(),
  startRecordingFromSelection: vi.fn(),
  readDesktopSettings: vi.fn(),
  getRecordingState: vi.fn(),
  isRecordingActive: vi.fn()
}));

const COMMITTED = {
  ok: true as const,
  rect: { x: 10, y: 20, w: 400, h: 300 },
  displayId: 1,
  screenSnapshotPath: "/tmp/snapshot.png",
  screenSnapshotId: "snapshot-1",
  previousAppPid: 4242
};

function settingsWith(quickCaptureAction: QuickCaptureAction) {
  return {
    recording: {
      quickCaptureAction,
      includeSystemAudio: true,
      includeMicrophone: false,
      videoCaptureCursor: false,
      imageCaptureCursor: false,
      lastRoutedPermissionFingerprint: "",
      screenCapturePrompted: true
    }
  };
}

vi.mock("electron", () => ({
  clipboard: {
    readImage: () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      toPNG: () => Buffer.alloc(0)
    }),
    availableFormats: () => [] as string[],
    readBookmark: () => ({ title: "", url: "" }),
    readBuffer: () => Buffer.alloc(0),
    readText: () => "",
    writeText: () => undefined
  },
  screen: { getAllDisplays: () => [] },
  BrowserWindow: { getAllWindows: () => [] }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined
  })
}));

vi.mock("../../capture/region-selector", () => ({
  pickRegion: mocks.pickRegion,
  getLastWindowListSnapshot: () => [],
  hideSelector: () => undefined
}));

vi.mock("../../capture/screencapture", () => ({
  captureRegion: mocks.captureRegion,
  captureScreen: async () => ({ ok: false, reason: "validation", message: "stub" }),
  captureWindow: async () => ({ ok: false, reason: "validation", message: "stub" })
}));

vi.mock("../../capture/screen-permission-gate", () => ({
  guardScreenCapture: async () => null
}));

vi.mock("../../recording/record-from-selection", () => ({
  startRecordingFromSelection: mocks.startRecordingFromSelection,
  FALLBACK_RECORDING_DEFAULTS: {
    includeSystemAudio: false,
    includeMicrophone: false,
    videoCaptureCursor: true
  }
}));

vi.mock("../../recording/recording-state", () => ({
  getRecordingState: mocks.getRecordingState,
  isRecordingActive: mocks.isRecordingActive
}));

vi.mock("../settings-handlers", () => ({
  readDesktopSettings: mocks.readDesktopSettings,
  getActiveExportStrategy: async () => "legacy"
}));

vi.mock("../../capture/capture-storage-gate", () => {
  class CapturesLocationFallbackError extends Error {
    readonly pwrSnapError = {
      kind: "capture" as const,
      code: "stub",
      message: "stub"
    };
  }
  return {
    CapturesLocationFallbackError,
    ensureCapturesDirReady: async () => null,
    runWithCapturesDirFallback: async (op: (dir: string) => Promise<unknown>) =>
      await op("/test/captures")
  };
});

vi.mock("../../capture/screen-snapshot", () => ({
  releaseSnapshot: async () => undefined
}));

vi.mock("../../capture/window-list", () => ({
  activateApp: async () => undefined,
  findWindowAt: () => null,
  resolveWindowListHelperPath: () => null
}));

vi.mock("../../events", () => ({ broadcastCapturesChanged: () => undefined }));
vi.mock("../../float-over", () => ({ setFloatOverState: () => undefined }));
vi.mock("../../tray", () => ({
  hideTrayPopoverIfVisible: () => undefined,
  setTrayCountdown: () => undefined
}));
vi.mock("../../window", () => ({
  findMainLibraryWindow: () => null,
  reclaimDockIconIfLibraryAlive: () => undefined,
  scheduleDockReclaim: () => undefined
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
  persistCaptureFromTempV2: async () => ({})
}));
vi.mock("../../persistence/enrichment-repo", () => ({
  getCaptureEnrichment: () => null
}));
vi.mock("../../render/coordinator", () => ({
  renderViaCoordinator: async () => ({ cachePath: "", byteSize: 0, fromCache: false })
}));
vi.mock("../../render/file-alias", () => ({ prepareRenderedFileAlias: async () => "" }));

const { bus } = await import("../../command-bus");
const { registerCaptureHandlers } = await import("../capture-handlers");

registerCaptureHandlers();

async function interactive() {
  // `capture:interactive` requires a real invocation trace (the picker
  // latency instrument); the handler rejects the dispatch without one.
  return await bus.dispatch(
    "capture:interactive",
    {
      mode: "auto",
      invocation: createCaptureInvocation({
        id: "record-handoff-test",
        origin: "global_hotkey.quick_capture",
        monotonicNow: () => 0
      })
    },
    { principal: "ipc" }
  );
}

beforeEach(() => {
  mocks.pickRegion.mockReset();
  mocks.captureRegion.mockReset();
  mocks.startRecordingFromSelection.mockReset();
  mocks.readDesktopSettings.mockReset();
  mocks.pickRegion.mockResolvedValue({ ...COMMITTED, action: "record" });
  mocks.captureRegion.mockResolvedValue({
    ok: false,
    reason: "validation",
    message: "stub"
  });
  mocks.startRecordingFromSelection.mockResolvedValue(undefined);
  mocks.readDesktopSettings.mockResolvedValue(settingsWith("ask"));
  mocks.getRecordingState.mockReset();
  mocks.isRecordingActive.mockReset();
  mocks.getRecordingState.mockReturnValue({ phase: "idle" });
  mocks.isRecordingActive.mockReturnValue(false);
});

describe("capture:interactive — Record handoff", () => {
  test("hands the committed selection to the recording continuation", async () => {
    const result = await interactive();

    expect(mocks.startRecordingFromSelection).toHaveBeenCalledTimes(1);
    // THE point of routing here rather than re-entering the video
    // hotkey: the user's selection is reused, not re-asked.
    expect(mocks.startRecordingFromSelection.mock.calls[0]?.[0]).toMatchObject({
      rect: COMMITTED.rect,
      displayId: COMMITTED.displayId,
      screenSnapshotId: COMMITTED.screenSnapshotId
    });
    // Persisted audio + cursor defaults come from the settings this
    // handler already read to configure the picker — not a second parse.
    expect(mocks.startRecordingFromSelection.mock.calls[0]?.[1]).toMatchObject({
      includeSystemAudio: true,
      videoCaptureCursor: false
    });
    // No still was taken — the still pipeline would have failed on the
    // stub display list and answered an error.
    expect(result).toEqual({ ok: true, value: { kind: "recording" } });
  });

  test("does not wait for the countdown before answering", async () => {
    // Fire-and-forget, like `capture:videoInteractive`: the recording
    // lifecycle surfaces on `events:recording:*`, so holding the
    // dispatch open across a cancellable 3-second countdown buys the
    // caller nothing.
    let release = (): void => undefined;
    mocks.startRecordingFromSelection.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      })
    );

    await expect(interactive()).resolves.toEqual({
      ok: true,
      value: { kind: "recording" }
    });
    release();
  });

  test("a rejected handoff is logged, not thrown at the caller", async () => {
    mocks.startRecordingFromSelection.mockRejectedValue(new Error("recorder exploded"));
    await expect(interactive()).resolves.toMatchObject({ ok: true });
  });

  test("the snap policy refuses a record the selector never offered", async () => {
    // No Record button rendered and no `R` was bound under this policy,
    // so a "record" echo can only be a bug or a hand-rolled IPC message.
    mocks.readDesktopSettings.mockResolvedValue(settingsWith("snap"));

    const result = await interactive();

    expect(mocks.startRecordingFromSelection).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { kind: "capture" } });
  });

  test("the record policy still snaps when the user pressed S", async () => {
    // `S` is the escape hatch under a Record-primary policy. Resolving
    // the policy instead of the keystroke would eat it.
    mocks.readDesktopSettings.mockResolvedValue(settingsWith("record"));
    mocks.pickRegion.mockResolvedValue({ ...COMMITTED });

    expect(await interactive()).toMatchObject({ ok: false, error: { kind: "capture" } });
    expect(mocks.startRecordingFromSelection).not.toHaveBeenCalled();
  });

  test("a commit with no action is a snap under every policy", async () => {
    mocks.pickRegion.mockResolvedValue({ ...COMMITTED });

    expect(await interactive()).toMatchObject({ ok: false, error: { kind: "capture" } });
    expect(mocks.startRecordingFromSelection).not.toHaveBeenCalled();
  });

  test("configures the selector with the policy and the cursor seed", async () => {
    // Both have to be in the mode signal BEFORE the selector shows —
    // there is no second chance once the chooser is on screen.
    mocks.readDesktopSettings.mockResolvedValue(settingsWith("record"));

    await interactive();

    expect(mocks.pickRegion.mock.calls[0]?.[0]).toMatchObject({
      mode: "auto",
      quickCaptureAction: "record",
      cursorDefault: false
    });
  });

  test("a settings read failure fails CLOSED, not open", async () => {
    // The two directions are not symmetric. Falling back to "ask" costs
    // a user who chose Snap a screen recording they had switched off —
    // started by a stray `R`, with the cursor baked in because this same
    // branch cannot read `videoCaptureCursor` either. Falling back to
    // "snap" costs a user who chose Record one keyboard shortcut for
    // one capture. This branch IS reachable: `ensureServices()` calls
    // `app.getPath("userData")` before `read()` is entered.
    mocks.readDesktopSettings.mockRejectedValue(new Error("disk gone"));

    const result = await interactive();

    expect(mocks.pickRegion.mock.calls[0]?.[0]).toMatchObject({
      quickCaptureAction: "snap"
    });
    expect(mocks.pickRegion.mock.calls[0]?.[0]).not.toHaveProperty("cursorDefault");
    // The selector never offered Record, so the stale "record" echo on
    // the canned commit is refused and the still pipeline runs.
    expect(mocks.startRecordingFromSelection).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { kind: "capture" } });
  });

  test("a recording awaiting Retry or Dismiss falls back to a still", async () => {
    // `recording:start` answers `failure_action_required` in this phase,
    // and the handoff's own error path stays SILENT while a failure is
    // pending (it was written for a caller that had already bailed).
    // Reaching it from here spent the user's selection on nothing at
    // all: no still, no recording, no notification, `ok` on the wire.
    mocks.getRecordingState.mockReturnValue({ phase: "failed" });

    const result = await interactive();

    expect(mocks.startRecordingFromSelection).not.toHaveBeenCalled();
    // Fell through to the still pipeline — which is what ⌘⇧C did in
    // this state before the chooser existed.
    expect(result).toMatchObject({ ok: false, error: { kind: "capture" } });
  });

  test("a recording already in flight falls back to a still", async () => {
    // `recording:start` refuses with `already_recording`. That at least
    // notifies, but it still throws away the capture the user framed.
    mocks.isRecordingActive.mockReturnValue(true);

    const result = await interactive();

    expect(mocks.startRecordingFromSelection).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { kind: "capture" } });
  });

  test("the preflight only gates the record branch", async () => {
    // A busy recorder must not cost a plain snap anything.
    mocks.getRecordingState.mockReturnValue({ phase: "failed" });
    mocks.pickRegion.mockResolvedValue({ ...COMMITTED });

    expect(await interactive()).toMatchObject({ ok: false, error: { kind: "capture" } });
    expect(mocks.startRecordingFromSelection).not.toHaveBeenCalled();
  });

  test("a cancelled pick never reaches either pipeline", async () => {
    mocks.pickRegion.mockResolvedValue({ ok: false, reason: "cancelled" });

    const result = await interactive();

    expect(mocks.startRecordingFromSelection).not.toHaveBeenCalled();
    expect(mocks.captureRegion).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });
});
