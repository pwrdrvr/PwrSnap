// Pins the racy bits of the recording service that aren't covered
// by the (macOS-only) end-to-end smoke: cancel-during-countdown
// reset, the 15s startedPromise timeout, the concurrent-start
// rejection, and the `cancelled` error surface. The Swift binary
// itself is mocked via a fake child process so the tests run on
// any platform without TCC or ScreenCaptureKit.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted mock state so every imported module sees the same
// instances (and so we can assert + drive them from tests).
const mocks = vi.hoisted(() => {
  return {
    spawnedChildren: [] as FakeChild[],
    binaryPath: "/fake/PwrSnapRecorder",
    stateLog: [] as Array<{ phase: string }>,
    /** Full broadcast log including rect/displayId payloads — used
     *  by the multi-monitor translation test to verify the rect
     *  reaches the HUD in display-local coords. */
    stateLogFull: [] as Array<Record<string, unknown>>,
    pendingTimeouts: [] as Array<() => void>
  };
});

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killCalled = false;
  constructor() {
    super();
    // Default stream behavior — tests opt-in to emitting "started"/
    // "stopped" lines on stdout to drive the recorder state machine.
    (this.stdout as unknown as { setEncoding: (e: string) => void }).setEncoding = () => undefined;
    (this.stderr as unknown as { setEncoding: (e: string) => void }).setEncoding = () => undefined;
  }
  kill = (_signal?: string): boolean => {
    this.killCalled = true;
    // Emit exit so the recorder's `child.on("exit", ...)` reject
    // path can fire — matches real OS behavior.
    setTimeout(() => this.emit("exit", null, "SIGTERM"), 0);
    return true;
  };
  /** Test helper: pump a JSON line into the recorder's stdout
   *  parser to simulate the Swift binary's outbound events. */
  emitLine(payload: object): void {
    this.stdout.emit("data", JSON.stringify(payload) + "\n");
  }
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = new FakeChild();
    mocks.spawnedChildren.push(child);
    return child;
  })
}));

vi.mock("node:fs", () => ({
  existsSync: () => true
}));

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(async () => "/tmp/pwrsnap-recording-fake")
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/fake/appPath",
    getPath: () => "/fake/userData"
  },
  Notification: {
    isSupported: () => false
  },
  // subjectToPhysicalRect now consults screen.getAllDisplays() to
  // translate global → display-local rects. Mock both a primary
  // (id 1, bounds 0,0) and a secondary that has the same kind of
  // off-origin bounds the multi-monitor bug reproduced against.
  screen: {
    getAllDisplays: () => [
      { id: 1, bounds: { x: 0, y: 0, width: 1496, height: 967 }, scaleFactor: 2 },
      { id: 3, bounds: { x: 1496, y: -473, width: 2560, height: 1440 }, scaleFactor: 1 }
    ]
  },
  // BrowserWindow isn't consulted directly anymore — collectOurPids()
  // delegates to recording-controller for the HUD PID. Keep a no-op
  // BrowserWindow export so any other import resolves cleanly.
  BrowserWindow: { getAllWindows: () => [] }
}));

// Mock the recording-controller HUD PID lookup. collectOurPids()
// returns just this PID now (narrowed from "every PwrSnap PID" so
// picking our own Library/Settings window as the recording subject
// doesn't accidentally erase it from the captured frame).
vi.mock("../recording-controller", () => ({
  getRecordingControllerPid: () => 4242,
  applyRecordingStateToController: () => undefined,
  installRecordingController: () => undefined
}));

vi.mock("../recording-state", async () => {
  const real = (await import("../recording-state")) as Record<string, unknown>;
  return {
    ...real,
    setRecordingState: (next: Record<string, unknown>) => {
      mocks.stateLog.push({ phase: next.phase as string });
      mocks.stateLogFull.push(next);
    },
    isRecordingActive: () => false
  };
});

vi.mock("../../float-over", () => ({
  setFloatOverState: vi.fn()
}));

vi.mock("../../events", () => ({
  broadcastCapturesChanged: vi.fn()
}));

vi.mock("../../handlers/codex-handlers", () => ({
  maybeEnqueueCaptureEnrichment: vi.fn()
}));

vi.mock("../../persistence/captures-repo", () => ({
  insertCapture: vi.fn(() => ({
    record: { id: "cap-1", kind: "video" }
  })),
  getCaptureById: vi.fn(() => ({ id: "cap-1", kind: "video", video: {} }))
}));

vi.mock("../../persistence/source-store", () => ({
  adoptExistingFileAsSource: vi.fn(async () => ({
    id: "src-1",
    srcPath: "/fake/captures/src-1.mp4",
    sha256: "deadbeef",
    byteSize: 1024,
    widthPx: 0,
    heightPx: 0
  })),
  statSource: vi.fn(async () => ({ byteSize: 1024 }))
}));

vi.mock("../../persistence/video-repo", () => ({
  insertVideoMetadata: vi.fn()
}));

vi.mock("../../persistence/video-filename-maintenance", () => ({
  renameVideoSourceToEffectiveFilename: vi.fn(async () => "renamed")
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

// Resolve the real binary path resolver to a fixed fake string by
// stubbing existsSync (above) to true — the first candidate
// `process.resourcesPath/PwrSnapRecorder` exists in the test world.

const originalPlatform = process.platform;
const originalResourcesPath = (process as { resourcesPath?: string }).resourcesPath;

beforeEach(() => {
  vi.resetModules();
  mocks.spawnedChildren.length = 0;
  mocks.stateLog.length = 0;
  mocks.stateLogFull.length = 0;
  mocks.pendingTimeouts.length = 0;
  // resolveRecorderBinary() returns null off-darwin AND probes
  // `process.resourcesPath/PwrSnapRecorder` via path.join — neither
  // works in a plain Node test runner. Stub both so the binary-
  // present branch fires and we can drive the spawned child.
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  (process as { resourcesPath?: string }).resourcesPath = "/fake";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  if (originalResourcesPath === undefined) {
    delete (process as { resourcesPath?: string }).resourcesPath;
  } else {
    (process as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  }
});

const SUBJECT = {
  kind: "region" as const,
  rect: { x: 0, y: 0, w: 100, h: 100 },
  displayId: 1
};
const CAPS = { systemAudio: false, microphone: false };

describe("RecordingService.start cancel-during-countdown", () => {
  test("cancel mid-countdown bails the loop without re-asserting countdown state", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    // Use `.then(_, err => err)` so the rejection is observed
    // immediately and we can assert on it without the
    // `await expect.rejects` microtask-ordering race that fights
    // Vitest's fake timer / unhandled-rejection detector.
    let startOutcome: Error | "ok" | null = null;
    const startPromise = service
      .start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 3 })
      .then(() => (startOutcome = "ok"))
      .catch((err: Error) => (startOutcome = err));

    // Let the spawn-and-prepare phase settle. The microtask queue
    // needs to run so the countdown loop reaches its first setTimeout.
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.stateLog.map((s) => s.phase)).toContain("preflight");
    expect(mocks.stateLog.map((s) => s.phase)).toContain("countdown");

    // Tick into the SECOND countdown iteration so we're mid-loop.
    await vi.advanceTimersByTimeAsync(1100);

    // Cancel from another caller (e.g. tray Cancel Recording).
    // cancel() internally awaits `Promise.race([stoppedPromise,
    // setTimeout(500)])`; with fake timers we have to advance past
    // that 500ms grace before the await resolves. THEN we have to
    // advance another second so the countdown loop's in-flight
    // `setTimeout(1000)` fires — only then does the loop iterate
    // to the bail check and throw "cancelled".
    const cancelDone = service.cancel();
    await vi.advanceTimersByTimeAsync(600);
    await cancelDone;
    await vi.advanceTimersByTimeAsync(1100);
    await startPromise;

    // The countdown loop should HAVE BAILED. Drain remaining
    // timers — the loop must NOT push another `countdown` state.
    const stateLogAfterCancel = mocks.stateLog.length;
    await vi.advanceTimersByTimeAsync(5000);

    // The only post-cancel state should be the cancel's own `idle`
    // transition (already counted above). No new countdown states.
    const newStates = mocks.stateLog.slice(stateLogAfterCancel);
    expect(newStates.filter((s) => s.phase === "countdown")).toHaveLength(0);

    // start() rejected with "cancelled" so the handler can surface
    // the typed validation error.
    expect(startOutcome).toBeInstanceOf(Error);
    expect((startOutcome as unknown as Error).message).toBe("cancelled");
  });

  test("cancel works even when no child has spawned (stuck state)", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    // No start() called — cancel from idle is a no-op that always
    // resets state to idle (the unconditional-reset contract).
    await expect(service.cancel()).resolves.toBeUndefined();
    expect(mocks.stateLog.at(-1)?.phase).toBe("idle");
  });
});

describe("RecordingService.start concurrent guard", () => {
  test("second start while a session is in flight throws already_recording", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    let firstOutcome: Error | "ok" | null = null;
    const first = service
      .start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 3 })
      .then(() => (firstOutcome = "ok"))
      .catch((err: Error) => (firstOutcome = err));
    await vi.advanceTimersByTimeAsync(0);

    let secondOutcome: Error | "ok" | null = null;
    const second = service
      .start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 3 })
      .then(() => (secondOutcome = "ok"))
      .catch((err: Error) => (secondOutcome = err));
    await second;
    expect(secondOutcome).toBeInstanceOf(Error);
    expect((secondOutcome as unknown as Error).message).toBe("already_recording");

    // Don't leak the first promise — cancel it cleanly so the test
    // doesn't hang on the 15s startedPromise timeout. cancel()'s
    // own 500ms grace needs timer advancement under fake timers.
    const cancelDone = service.cancel();
    await vi.advanceTimersByTimeAsync(600);
    await cancelDone;
    // Drain the pending countdown setTimeout so the loop bails.
    await vi.advanceTimersByTimeAsync(1100);
    await first;
    expect(firstOutcome).toBeInstanceOf(Error);
  });
});

describe("RecordingService.start excludePids", () => {
  test("start command excludes ONLY the recording-controller HUD pid", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    let outcome: Error | "ok" | null = null;
    const startPromise = service
      .start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 })
      .then(() => (outcome = "ok"))
      .catch((err: Error) => (outcome = err));
    await vi.advanceTimersByTimeAsync(0);

    const child = mocks.spawnedChildren[0]!;
    const startCmd = JSON.parse(child.stdin.write.mock.calls[0]![0].trim());
    // Narrowed exclusion: just the HUD overlay PID, not the main
    // process or any other PwrSnap renderer. This is what lets users
    // record their own Library/Settings window without it being
    // erased from the captured frame.
    expect(startCmd.excludePids).toEqual([4242]);
    expect(startCmd.excludePids).not.toContain(process.pid);

    // Don't leak the in-flight start.
    const cancelDone = service.cancel();
    await vi.advanceTimersByTimeAsync(600);
    await cancelDone;
    await vi.advanceTimersByTimeAsync(16_000);
    await startPromise;
    expect(outcome).toBeInstanceOf(Error);
  });
});

describe("RecordingService.start showsCursor (cursor capture)", () => {
  test("captureCursor:false writes showsCursor:false to the recorder", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const startPromise = service
      .start({ subject: SUBJECT, capabilities: CAPS, captureCursor: false, countdownSeconds: 0 })
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    const child = mocks.spawnedChildren[0]!;
    const startCmd = JSON.parse(child.stdin.write.mock.calls[0]![0].trim());
    expect(startCmd.showsCursor).toBe(false);

    const cancelDone = service.cancel();
    await vi.advanceTimersByTimeAsync(600);
    await cancelDone;
    await vi.advanceTimersByTimeAsync(16_000);
    await startPromise;
  });

  test("omitting captureCursor omits showsCursor (recorder defaults to true)", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const startPromise = service
      .start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 })
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    const child = mocks.spawnedChildren[0]!;
    const startCmd = JSON.parse(child.stdin.write.mock.calls[0]![0].trim());
    // JSON.stringify drops `undefined`, so the key is absent and the
    // Swift side falls back to `cfg.showsCursor = req.showsCursor ?? true`.
    expect("showsCursor" in startCmd).toBe(false);

    const cancelDone = service.cancel();
    await vi.advanceTimersByTimeAsync(600);
    await cancelDone;
    await vi.advanceTimersByTimeAsync(16_000);
    await startPromise;
  });

  test("restart preserves the cursor choice across the cancel→start", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const first = service
      .start({ subject: SUBJECT, capabilities: CAPS, captureCursor: false, countdownSeconds: 3 })
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawnedChildren).toHaveLength(1);

    const restartPromise = service.restart().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(1100);

    expect(mocks.spawnedChildren).toHaveLength(2);
    const newStartCmd = JSON.parse(
      mocks.spawnedChildren[1]!.stdin.write.mock.calls[0]![0].trim()
    );
    expect(newStartCmd.showsCursor).toBe(false);

    const cancelDone = service.cancel();
    await vi.advanceTimersByTimeAsync(600);
    await cancelDone;
    await vi.advanceTimersByTimeAsync(1100);
    await first;
    await restartPromise;
  });
});

describe("RecordingService.start multi-monitor rect translation", () => {
  test("subject on secondary display gets translated to display-local before reaching recorder + HUD", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    // Subject mimics what region-selector resolves for a window on
    // display 3 (bounds.x=1496, bounds.y=-473): rect is in GLOBAL
    // logical coords (selector translates window-local → global at
    // resolve time). Display-local equivalent is x=247, y=185.
    const globalSubject = {
      kind: "region" as const,
      rect: { x: 1496 + 247, y: -473 + 185, w: 800, h: 600 },
      displayId: 3
    };

    let outcome: Error | "ok" | null = null;
    const startPromise = service
      .start({ subject: globalSubject, capabilities: CAPS, countdownSeconds: 0 })
      .then(() => (outcome = "ok"))
      .catch((err: Error) => (outcome = err));
    await vi.advanceTimersByTimeAsync(0);

    // Inspect the JSON that landed on the recorder's stdin — the
    // Swift binary's ScreenCaptureKit `sourceRect` is relative to
    // the captured display, so we need DISPLAY-LOCAL coords here.
    const child = mocks.spawnedChildren[0]!;
    const startCmd = JSON.parse(child.stdin.write.mock.calls[0]![0].trim());
    expect(startCmd.rect).toEqual({ x: 247, y: 185, w: 800, h: 600 });

    // And the broadcast state carries the same display-local rect
    // for the HUD's `fillRect` (which then ADDS display.bounds back
    // to position the BrowserWindow in global coords). If the rect
    // here were still global, the HUD would be offset twice.
    const preflight = mocks.stateLogFull.find((s) => s.phase === "preflight") as
      | { rect?: { x: number; y: number } }
      | undefined;
    expect(preflight?.rect).toEqual({ x: 247, y: 185, w: 800, h: 600 });

    // Don't leak the in-flight start — fake timers + advance.
    const cancelDone = service.cancel();
    await vi.advanceTimersByTimeAsync(600);
    await cancelDone;
    await vi.advanceTimersByTimeAsync(16_000);
    await startPromise;
    expect(outcome).toBeInstanceOf(Error);
  });
});

describe("RecordingService.restart", () => {
  test("restart from idle (no active session) throws not_recording", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();
    await expect(service.restart()).rejects.toThrow("not_recording");
  });

  test("restart during an active session cancels the old child and spawns a new one", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    let firstOutcome: Error | "ok" | null = null;
    const first = service
      .start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 3 })
      .then(() => (firstOutcome = "ok"))
      .catch((err: Error) => (firstOutcome = err));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawnedChildren).toHaveLength(1);

    let restartOutcome: { sessionId: string } | Error | null = null;
    const restartPromise = service
      .restart()
      .then((res) => (restartOutcome = res))
      .catch((err: Error) => (restartOutcome = err));

    // Drive cancel's 500ms grace + restart's spawn microtask.
    await vi.advanceTimersByTimeAsync(700);
    // Drain the original countdown setTimeout so the first start
    // rejects with "cancelled" cleanly.
    await vi.advanceTimersByTimeAsync(1100);

    expect(mocks.spawnedChildren).toHaveLength(2);
    // The new spawn sent the same subject. Inspect the JSON.
    const newStartCmd = JSON.parse(
      mocks.spawnedChildren[1]!.stdin.write.mock.calls[0]![0].trim()
    );
    expect(newStartCmd.rect).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(newStartCmd.captureAtMs).toBeGreaterThan(Date.now());

    // Tidy: cancel the restarted session.
    const cancelDone = service.cancel();
    await vi.advanceTimersByTimeAsync(600);
    await cancelDone;
    await vi.advanceTimersByTimeAsync(1100);
    await first;
    await restartPromise;
    expect(firstOutcome).toBeInstanceOf(Error);
    // restartOutcome is either the new session payload OR a
    // cancelled error from our cleanup. Either way, the
    // assertion that the second spawn happened is the load-
    // bearing part.
    void restartOutcome;
  });
});

describe("RecordingService.stop source-app metadata → capture row", () => {
  // The Library renders `record.source_app_name ?? "Unknown app"`,
  // so the recording-service has to populate those fields whenever
  // the subject knows them. The window-subject path resolves app
  // info from the window-list helper at selection time; region and
  // display subjects don't have a single source app so they
  // legitimately write null. These tests pin that contract — a
  // future refactor that drops the optional fields off
  // RecordingSubject (or stops reading them in stop()) will fail
  // here long before it ships to the Library.

  async function runFullCapture(
    subject: import("@pwrsnap/shared").RecordingSubject
  ): Promise<Record<string, unknown>> {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const startPromise = service
      .start({ subject, capabilities: CAPS, countdownSeconds: 0 })
      .catch(() => undefined);
    // Let the spawn + start command write land.
    await vi.advanceTimersByTimeAsync(0);
    const child = mocks.spawnedChildren.at(-1)!;
    // Ack "started" so the recorder transitions out of starting and
    // start() resolves cleanly.
    child.emitLine({
      event: "started",
      physicalRect: { x: 0, y: 0, w: 100, h: 100 }
    });
    await vi.advanceTimersByTimeAsync(0);
    await startPromise;

    // Now stop and pump the "stopped" event so the post-stop
    // pipeline (adoptExistingFileAsSource → insertCapture)
    // runs to completion.
    const stopPromise = service.stop();
    await vi.advanceTimersByTimeAsync(0);
    child.emitLine({
      event: "stopped",
      durationSec: 2.5,
      containerFormat: "mp4",
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      outputPath: "/fake/captures/src-1.mp4"
    });
    await vi.advanceTimersByTimeAsync(0);
    await stopPromise;

    // Pull the row that landed on insertCapture. The mock at
    // the top of this file returns a fixed record; we want the
    // FIRST positional arg of the LAST call.
    const captures = await import("../../persistence/captures-repo");
    const calls = (captures.insertCapture as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    return calls.at(-1)![0] as Record<string, unknown>;
  }

  test("window subject with appName + appBundleId lands both on the capture row", async () => {
    const row = await runFullCapture({
      kind: "window",
      windowId: 12345,
      rect: { x: 0, y: 0, w: 100, h: 100 },
      displayId: 1,
      appName: "Microsoft Edge",
      appBundleId: "com.microsoft.edgemac"
    });
    expect(row.source_app_name).toBe("Microsoft Edge");
    expect(row.source_app_bundle_id).toBe("com.microsoft.edgemac");
  });

  test("window subject without optional app fields writes null (Library falls back to 'Unknown app')", async () => {
    const row = await runFullCapture({
      kind: "window",
      windowId: 12345,
      rect: { x: 0, y: 0, w: 100, h: 100 },
      displayId: 1
      // appName + appBundleId intentionally omitted — protocol
      // marks them optional for callers that lack the helper.
    });
    expect(row.source_app_name).toBeNull();
    expect(row.source_app_bundle_id).toBeNull();
  });

  test("region subject writes null app metadata (no single source app)", async () => {
    const row = await runFullCapture({
      kind: "region",
      rect: { x: 0, y: 0, w: 100, h: 100 },
      displayId: 1
    });
    expect(row.source_app_name).toBeNull();
    expect(row.source_app_bundle_id).toBeNull();
  });
});

describe("RecordingService.start startedPromise timeout", () => {
  test("recorder that never acks `started` is killed after 15s and state goes to failed", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    let outcome: Error | "ok" | null = null;
    const startPromise = service
      .start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 })
      .then(() => (outcome = "ok"))
      .catch((err: Error) => (outcome = err));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawnedChildren).toHaveLength(1);
    const child = mocks.spawnedChildren[0]!;

    // Recorder never emits `started`. Advance 15s past the timeout.
    await vi.advanceTimersByTimeAsync(15_500);
    await startPromise;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as unknown as Error).message).toBe("recorder_start_timeout");

    // We SIGTERM'd the wedged child.
    expect(child.killCalled).toBe(true);
    // State path includes a `failed` transition for the HUD/tray.
    expect(mocks.stateLog.map((s) => s.phase)).toContain("failed");
  });
});
