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
    spawnCalls: [] as Array<{ command: string; args: string[] }>,
    binaryPath: "/fake/PwrSnapRecorder",
    stateLog: [] as Array<{ phase: string }>,
    /** Full broadcast log including rect/displayId payloads — used
     *  by the multi-monitor translation test to verify the rect
     *  reaches the HUD in display-local coords. */
    stateLogFull: [] as Array<Record<string, unknown>>,
    currentState: { phase: "idle" } as Record<string, unknown>,
    mkdtempQueue: [] as Array<Promise<string>>,
    pendingTimeouts: [] as Array<() => void>,
    removedRecordingDirs: [] as string[]
  };
});

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killCalled = false;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  exitOnSignal: NodeJS.Signals | null = "SIGTERM";
  killSignals: NodeJS.Signals[] = [];
  constructor() {
    super();
    // Default stream behavior — tests opt-in to emitting "started"/
    // "stopped" lines on stdout to drive the recorder state machine.
    (this.stdout as unknown as { setEncoding: (e: string) => void }).setEncoding = () => undefined;
    (this.stderr as unknown as { setEncoding: (e: string) => void }).setEncoding = () => undefined;
  }
  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    if (eventName === "exit") {
      this.exitCode = args[0] as number | null;
      this.signalCode = args[1] as NodeJS.Signals | null;
    }
    return super.emit(eventName, ...args);
  }
  kill = (signal: NodeJS.Signals = "SIGTERM"): boolean => {
    this.killCalled = true;
    this.killed = true;
    this.killSignals.push(signal);
    if (this.exitOnSignal === signal) {
      // Emit exit so the recorder's `child.on("exit", ...)` reject
      // path can fire — matches real OS behavior.
      setTimeout(() => this.emit("exit", null, signal), 0);
    }
    return true;
  };
  /** Test helper: pump a JSON line into the recorder's stdout
   *  parser to simulate the Swift binary's outbound events. */
  emitLine(payload: object): void {
    this.stdout.emit("data", JSON.stringify(payload) + "\n");
  }
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn((command: string, args: string[] = []) => {
    mocks.spawnCalls.push({ command, args });
    const child = new FakeChild();
    mocks.spawnedChildren.push(child);
    return child;
  })
}));

vi.mock("node:fs", () => ({
  existsSync: () => true
}));

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(async () => {
    const deferred = mocks.mkdtempQueue.shift();
    return deferred === undefined
      ? "/tmp/pwrsnap-recording-fake"
      : await deferred;
  }),
  rm: vi.fn(async (path: string) => {
    mocks.removedRecordingDirs.push(path);
  })
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
      { id: 3, bounds: { x: 1496, y: -473, width: 2560, height: 1440 }, scaleFactor: 1.5 }
    ],
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1496, height: 967 }, scaleFactor: 2 }),
    dipToScreenRect: (_window: unknown, rect: { x: number; y: number; width: number; height: number }) => {
      const displays = [
        { id: 1, bounds: { x: 0, y: 0, width: 1496, height: 967 }, scaleFactor: 2 },
        { id: 3, bounds: { x: 1496, y: -473, width: 2560, height: 1440 }, scaleFactor: 1.5 }
      ];
      const display = displays.find((d) =>
        rect.x >= d.bounds.x &&
        rect.x < d.bounds.x + d.bounds.width &&
        rect.y >= d.bounds.y &&
        rect.y < d.bounds.y + d.bounds.height
      ) ?? displays[0]!;
      const scale = display.scaleFactor;
      return {
        x: Math.round(display.bounds.x + (rect.x - display.bounds.x) * scale),
        y: Math.round(display.bounds.y + (rect.y - display.bounds.y) * scale),
        width: Math.round(rect.width * scale),
        height: Math.round(rect.height * scale)
      };
    }
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

vi.mock("../recording-state", () => ({
  getRecordingState: () => mocks.currentState,
  setRecordingState: (next: Record<string, unknown>) => {
    mocks.currentState = next;
    mocks.stateLog.push({ phase: next.phase as string });
    mocks.stateLogFull.push(next);
  },
  setRecordingFailureState: (failure: Record<string, unknown>) => {
    const next = { phase: "failed", ...failure };
    mocks.currentState = next;
    mocks.stateLog.push({ phase: "failed" });
    mocks.stateLogFull.push(next);
  },
  isRecordingActive: () =>
    ["preflight", "countdown", "starting", "recording", "stopping", "processing"].includes(
      String(mocks.currentState.phase)
    )
}));

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
  mocks.spawnCalls.length = 0;
  mocks.stateLog.length = 0;
  mocks.stateLogFull.length = 0;
  mocks.currentState = { phase: "idle" };
  mocks.mkdtempQueue.length = 0;
  mocks.pendingTimeouts.length = 0;
  mocks.removedRecordingDirs.length = 0;
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function latestFailureState(): Record<string, unknown> {
  const failed = [...mocks.stateLogFull].reverse().find((state) => state.phase === "failed");
  expect(failed).toBeDefined();
  return failed!;
}

function expectSafeFailureState(
  state: Record<string, unknown>,
  expected: { sessionId: string; code: string; canRetry?: boolean },
  forbiddenFragments: string[] = []
): void {
  expect(state).toMatchObject({
    phase: "failed",
    sessionId: expected.sessionId,
    code: expected.code,
    canRetry: expected.canRetry ?? true,
    displayId: 1
  });
  expect(state).not.toHaveProperty("message");
  const serialized = JSON.stringify(state);
  for (const fragment of forbiddenFragments) {
    expect(serialized).not.toContain(fragment);
  }
}

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

    // Cancel from another caller (e.g. tray Cancel Recording). Both the
    // process-exit wait and the countdown delay are explicitly released;
    // no anonymous one-second timer is allowed to survive teardown.
    const cancelDone = service.cancel();
    await vi.advanceTimersByTimeAsync(0);
    await cancelDone;
    await startPromise;
    expect(vi.getTimerCount()).toBe(0);

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

  test("cancel sees an atomically claimed session while temp preparation is pending", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const tempDir = deferred<string>();
    mocks.mkdtempQueue.push(tempDir.promise);
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    let startOutcome: Error | "ok" | null = null;
    const startPromise = service
      .start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 })
      .then(() => (startOutcome = "ok"))
      .catch((cause: Error) => (startOutcome = cause));

    expect(service.isActive()).toBe(true);
    expect(mocks.currentState).toMatchObject({ phase: "preflight" });
    expect(mocks.spawnedChildren).toHaveLength(0);

    await service.cancel();
    expect(service.isActive()).toBe(false);
    expect(mocks.currentState).toEqual({ phase: "idle" });

    tempDir.resolve("/tmp/pwrsnap-recording-cancelled-prepare");
    await startPromise;
    expect(startOutcome).toBeInstanceOf(Error);
    expect((startOutcome as unknown as Error).message).toBe("cancelled");
    expect(mocks.spawnedChildren).toHaveLength(0);
    expect(mocks.stateLog.map((state) => state.phase)).not.toContain("failed");
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
    expect(mocks.removedRecordingDirs).toEqual(["/tmp/pwrsnap-recording-fake"]);
    expect(mocks.removedRecordingDirs).not.toContain("/fake/captures/src-1.mp4");

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
  test("recorder that never acks `started` is killed and leaves a durable safe failure", async () => {
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
    const sessionId = mocks.currentState.sessionId as string;

    // Recorder never emits `started`. Advance 15s past the timeout.
    await vi.advanceTimersByTimeAsync(15_500);
    await startPromise;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as unknown as Error).message).toBe("recorder_start_timeout");

    // We SIGTERM'd the wedged child.
    expect(child.killCalled).toBe(true);
    const failed = latestFailureState();
    expectSafeFailureState(
      failed,
      {
        sessionId,
        code: "recorder_start_timeout"
      },
      ["/tmp/pwrsnap-recording-fake", mocks.binaryPath]
    );

    // Failure is terminal UI state, not a transient toast. Advancing
    // well beyond the old 1.5s reset must not make it disappear.
    const failureIndex = mocks.stateLogFull.indexOf(failed);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.currentState).toEqual(failed);
    expect(mocks.stateLogFull.slice(failureIndex + 1).map((state) => state.phase)).not.toContain(
      "idle"
    );
  });
});

describe("Native recorder post-start failure", () => {
  test("a pre-start child error rejects with its cause and publishes a safe failure", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    let outcome: Error | "ok" | null = null;
    const startPromise = service
      .start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 })
      .then(() => (outcome = "ok"))
      .catch((cause: Error) => (outcome = cause));
    await vi.advanceTimersByTimeAsync(0);
    const child = mocks.spawnedChildren[0]!;
    const sessionId = mocks.currentState.sessionId as string;
    child.emit(
      "error",
      new Error(
        "spawn /Users/alice/Private Tools/PwrSnapRecorder --token native-spawn-secret ENOENT"
      )
    );
    await vi.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as unknown as Error).message).not.toBe("cancelled");
    expectSafeFailureState(
      latestFailureState(),
      { sessionId, code: "recorder_spawn_failed" },
      [
        "/Users/alice",
        "Private Tools",
        "--token",
        "native-spawn-secret",
        "ENOENT",
        mocks.binaryPath
      ]
    );
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(service.isActive()).toBe(false);
    expect(mocks.removedRecordingDirs).toEqual(["/tmp/pwrsnap-recording-fake"]);
  });

  test("cancel suppresses an in-flight pre-start failure instead of publishing it later", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    let outcome: Error | "ok" | null = null;
    const startPromise = service
      .start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 })
      .then(() => (outcome = "ok"))
      .catch((cause: Error) => (outcome = cause));
    await vi.advanceTimersByTimeAsync(0);
    const child = mocks.spawnedChildren[0]!;
    child.exitOnSignal = "SIGKILL";
    child.emit("error", new Error("pre-start process failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(child.killSignals).toEqual(["SIGTERM"]);

    const cancelPromise = service.cancel();
    await vi.advanceTimersByTimeAsync(500);
    await vi.runOnlyPendingTimersAsync();
    await cancelPromise;
    await startPromise;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as unknown as Error).message).toBe("cancelled");
    expect(mocks.currentState).toEqual({ phase: "idle" });
    expect(mocks.stateLog.map((state) => state.phase)).not.toContain("failed");
    expect(service.isActive()).toBe(false);
  });

  test("coalesced started and error lines cannot reassert recording", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    let outcome: Error | "ok" | null = null;
    const startPromise = service
      .start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 })
      .then(() => (outcome = "ok"))
      .catch((cause: Error) => (outcome = cause));
    await vi.advanceTimersByTimeAsync(0);
    const child = mocks.spawnedChildren[0]!;
    const sessionId = mocks.currentState.sessionId as string;
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        event: "started",
        physicalRect: { x: 0, y: 0, w: 100, h: 100 }
      })}\n${JSON.stringify({
        event: "error",
        code: "capture_failed",
        message: "/Users/alice/Secret Project/clip.mp4 --token coalesced-secret"
      })}\n`
    );
    await vi.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as unknown as Error).message).toContain("capture_failed");
    expect((outcome as unknown as Error).message).not.toBe("cancelled");
    expectSafeFailureState(
      latestFailureState(),
      { sessionId, code: "recorder_exited" },
      ["/Users/alice", "Secret Project", "--token", "coalesced-secret"]
    );
    expect(mocks.stateLog.map((state) => state.phase)).not.toContain("recording");
    expect(service.isActive()).toBe(false);
  });

  test("unexpected child exit cleans up and remains visible without broadcasting stderr", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const startPromise = service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      countdownSeconds: 0
    });
    await vi.advanceTimersByTimeAsync(0);
    const child = mocks.spawnedChildren[0]!;
    child.emitLine({
      event: "started",
      physicalRect: { x: 0, y: 0, w: 100, h: 100 }
    });
    await vi.advanceTimersByTimeAsync(0);
    const started = await startPromise;

    child.stderr.emit(
      "data",
      "/Users/alice/Secret Project/recording.mp4 --access-token native-super-secret"
    );
    child.emit("exit", 17, null);
    await vi.advanceTimersByTimeAsync(0);

    const failed = latestFailureState();
    expectSafeFailureState(failed, { sessionId: started.sessionId, code: "recorder_exited" }, [
      "/Users/alice",
      "Secret Project",
      "--access-token",
      "native-super-secret",
      "/tmp/pwrsnap-recording-fake",
      mocks.binaryPath
    ]);
    expect(child.killCalled).toBe(false);
    expect(service.isActive()).toBe(false);

    await expect(
      service.start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 })
    ).rejects.toThrow("failure_action_required");
    await expect(service.cancel()).rejects.toThrow("failure_action_required");
    await expect(service.restart()).rejects.toThrow("failure_action_required");
    expect(mocks.spawnedChildren).toHaveLength(1);
    expect(mocks.currentState).toEqual(failed);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.currentState).toEqual(failed);
  });

  test("post-adoption persistence failure removes only the recorder temp container", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const captures = await import("../../persistence/captures-repo");
    vi.mocked(captures.insertCapture).mockImplementationOnce(() => {
      throw new Error("database insert failed after durable adoption");
    });
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();
    const started = await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      countdownSeconds: 0
    });
    const child = mocks.spawnedChildren[0]!;
    const stopPromise = service.stop();
    child.emit("exit", 0, null);

    await expect(stopPromise).rejects.toThrow("database insert failed");
    expectSafeFailureState(latestFailureState(), {
      sessionId: started.sessionId,
      code: "processing_failed",
      canRetry: false
    });
    expect(mocks.removedRecordingDirs).toEqual(["/tmp/pwrsnap-recording-fake"]);
    expect(mocks.removedRecordingDirs).not.toContain("/fake/captures/src-1.mp4");
  });
});

describe("Windows FFmpeg recorder", () => {
  function argAfter(args: string[], flag: string): string {
    const index = args.indexOf(flag);
    expect(index).toBeGreaterThanOrEqual(0);
    return args[index + 1]!;
  }

  test("spawns gdigrab and persists the stopped MP4", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    await service.start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 });

    expect(mocks.spawnCalls).toHaveLength(1);
    const call = mocks.spawnCalls[0]!;
    expect(call.command).toContain("PwrSnapFFmpeg.exe");
    expect(call.args).toContain("gdigrab");
    expect(call.args).toContain("-video_size");
    expect(call.args).toContain("200x200");
    expect(call.args).toContain("h264_mf");
    expect(mocks.stateLog.map((s) => s.phase)).toEqual([
      "preflight",
      "starting",
      "recording"
    ]);

    const child = mocks.spawnedChildren[0]!;
    const stopPromise = service.stop();
    expect(child.stdin.write).toHaveBeenCalledWith("q");
    child.emit("exit", 0, null);
    const stopped = await stopPromise;

    expect(stopped.captureId).toBe("cap-1");
    expect(mocks.stateLog.map((s) => s.phase)).toContain("processing");
    expect(mocks.stateLog.map((s) => s.phase)).toContain("ready");
  });

  test("converts selected DIP rects to physical pixels before gdigrab", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    await service.start({
      subject: {
        kind: "region",
        rect: { x: 1496 + 20, y: -473 + 10, w: 100, h: 80 },
        displayId: 3
      },
      capabilities: CAPS,
      countdownSeconds: 0
    });

    const call = mocks.spawnCalls[0]!;
    expect(argAfter(call.args, "-offset_x")).toBe("1526");
    expect(argAfter(call.args, "-offset_y")).toBe("-458");
    expect(argAfter(call.args, "-video_size")).toBe("150x120");

    const cancelPromise = service.cancel();
    await vi.advanceTimersByTimeAsync(600);
    await cancelPromise;
  });

  test("does not persist when ffmpeg only exits after stop timeout kill", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    await service.start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 });
    const child = mocks.spawnedChildren[0]!;

    let stopOutcome: Error | { captureId: string } | null = null;
    const stopPromise = service
      .stop()
      .then((result) => (stopOutcome = result))
      .catch((err: Error) => (stopOutcome = err));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.killCalled).toBe(true);
    child.emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    await stopPromise;

    const observedStopOutcome: unknown = stopOutcome;
    expect(observedStopOutcome).toBeInstanceOf(Error);
    if (!(observedStopOutcome instanceof Error)) {
      throw new Error("expected stop to fail");
    }
    expect(observedStopOutcome.message).toContain("ffmpeg recorder exited unexpectedly");
    expect(mocks.stateLog.map((s) => s.phase)).toContain("failed");
    expect(mocks.stateLog.map((s) => s.phase)).not.toContain("processing");
    expect(mocks.stateLog.map((s) => s.phase)).not.toContain("ready");
  });

  test("processing failure remains durable without broadcasting the capture path", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const sourceStore = await import("../../persistence/source-store");
    vi.mocked(sourceStore.adoptExistingFileAsSource).mockRejectedValueOnce(
      new Error(
        "EPERM opening C:\\Users\\alice\\Documents\\Private Captures\\client-demo.mp4 --storage-key processing-secret"
      )
    );
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const started = await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      countdownSeconds: 0
    });
    const child = mocks.spawnedChildren[0]!;
    let stopOutcome: Error | { captureId: string } | null = null;
    const stopPromise = service
      .stop()
      .then((result) => (stopOutcome = result))
      .catch((cause: Error) => (stopOutcome = cause));
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await stopPromise;

    expect(stopOutcome).toBeInstanceOf(Error);
    const failed = latestFailureState();
    expectSafeFailureState(
      failed,
      { sessionId: started.sessionId, code: "processing_failed", canRetry: false },
      [
        "alice",
        "Private Captures",
        "client-demo.mp4",
        "--storage-key",
        "processing-secret",
        "/tmp/pwrsnap-recording-fake"
      ]
    );
    expect(mocks.stateLog.map((state) => state.phase)).toContain("processing");
    expect(mocks.stateLog.map((state) => state.phase)).not.toContain("ready");
    expect(service.isActive()).toBe(false);
    // Adoption never moved the only complete clip, so the recorder-owned
    // directory is intentionally detached for manual recovery.
    expect(mocks.removedRecordingDirs).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.currentState).toEqual(failed);
  });

  test("unexpected exit publishes a durable safe failure and cleans up ffmpeg", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const started = await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      countdownSeconds: 0
    });
    const child = mocks.spawnedChildren[0]!;
    child.stderr.emit(
      "data",
      "C:\\Users\\alice\\Secret Project\\clip.mp4 --api-key windows-super-secret"
    );
    child.emit("exit", 23, null);
    await vi.advanceTimersByTimeAsync(0);

    const failed = latestFailureState();
    expectSafeFailureState(failed, { sessionId: started.sessionId, code: "recorder_exited" }, [
      "alice",
      "Secret Project",
      "--api-key",
      "windows-super-secret",
      "/tmp/pwrsnap-recording-fake",
      "PwrSnapFFmpeg.exe",
      "-video_size",
      "gdigrab"
    ]);
    expect(child.killCalled).toBe(false);
    expect(service.isActive()).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.currentState).toEqual(failed);
  });

  test("asynchronous spawn error publishes only the allowlisted code and stays failed", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const started = await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      countdownSeconds: 0
    });
    const child = mocks.spawnedChildren[0]!;
    child.emit(
      "error",
      new Error(
        "spawn C:\\Users\\alice\\Private Tools\\PwrSnapFFmpeg.exe --token windows-spawn-secret ENOENT"
      )
    );
    await vi.advanceTimersByTimeAsync(0);

    const failed = latestFailureState();
    expectSafeFailureState(
      failed,
      { sessionId: started.sessionId, code: "recorder_spawn_failed" },
      [
        "alice",
        "Private Tools",
        "--token",
        "windows-spawn-secret",
        "ENOENT",
        "/tmp/pwrsnap-recording-fake",
        "-video_size",
        "gdigrab"
      ]
    );
    expect(child.killCalled).toBe(true);
    expect(service.isActive()).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.currentState).toEqual(failed);
  });

  test("waits for TERM then KILL process exit before publishing a retryable failure", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const started = await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      countdownSeconds: 0
    });
    const child = mocks.spawnedChildren[0]!;
    child.exitOnSignal = "SIGKILL";
    child.emit(
      "error",
      new Error("spawn C:\\Users\\alice\\Private Recorder.exe --token barrier-secret")
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(mocks.currentState).toMatchObject({
      phase: "recording",
      sessionId: started.sessionId
    });
    expect(mocks.stateLog.map((state) => state.phase)).not.toContain("failed");

    await vi.advanceTimersByTimeAsync(499);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(mocks.stateLog.map((state) => state.phase)).not.toContain("failed");

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.runOnlyPendingTimersAsync();
    expectSafeFailureState(
      latestFailureState(),
      { sessionId: started.sessionId, code: "recorder_spawn_failed" },
      ["alice", "Private Recorder.exe", "--token", "barrier-secret"]
    );
    expect(service.isActive()).toBe(false);
  });

  test("keeps a recorder that ignores TERM and KILL non-retryable until shutdown cleans it", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const started = await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      countdownSeconds: 0
    });
    const child = mocks.spawnedChildren[0]!;
    child.exitOnSignal = null;
    child.emit(
      "error",
      new Error("spawn C:\\Users\\alice\\Private Recorder.exe --token stubborn-secret")
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expectSafeFailureState(
      latestFailureState(),
      {
        sessionId: started.sessionId,
        code: "recorder_spawn_failed",
        canRetry: false
      },
      ["alice", "Private Recorder.exe", "--token", "stubborn-secret"]
    );
    expect(mocks.currentState.phase).toBe("failed");
    await expect(service.retry(started.sessionId)).rejects.toThrow(
      "failure_not_retryable"
    );
    await expect(service.stop()).rejects.toThrow("no_active_recording");
    expect(mocks.currentState.phase).toBe("failed");

    // A queued normal Cancel from the old HUD is rejected: only the
    // session-scoped failure commands own this state. App shutdown uses its
    // distinct cleanup path and retries the bounded process barrier.
    await expect(service.cancel()).rejects.toThrow("failure_action_required");
    await expect(service.restart()).rejects.toThrow("failure_action_required");
    expect(mocks.currentState).toMatchObject({
      phase: "failed",
      sessionId: started.sessionId,
      canRetry: false
    });
    child.exitOnSignal = "SIGTERM";
    const shutdown = service.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    await shutdown;
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM"]);
    expect(service.isActive()).toBe(false);
    expect(mocks.currentState).toEqual({ phase: "idle" });
  });

  test("deduplicates concurrent Stop calls before persistence", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const sourceStore = await import("../../persistence/source-store");
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      countdownSeconds: 0
    });
    const child = mocks.spawnedChildren[0]!;
    const firstStop = service.stop();
    await expect(service.stop()).rejects.toThrow("stop_in_progress");
    child.emit("exit", 0, null);
    await expect(firstStop).resolves.toEqual({ captureId: "cap-1" });
    expect(sourceStore.adoptExistingFileAsSource).toHaveBeenCalledTimes(1);
  });

  test("claims a deferred retry atomically and rejects duplicate retry or stale dismiss", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const first = await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      countdownSeconds: 0
    });
    mocks.spawnedChildren[0]!.emit("exit", 7, null);
    await vi.advanceTimersByTimeAsync(0);
    expectSafeFailureState(latestFailureState(), {
      sessionId: first.sessionId,
      code: "recorder_exited"
    });

    const retryTmpDir = deferred<string>();
    mocks.mkdtempQueue.push(retryTmpDir.promise);
    const retryPromise = service.retry(first.sessionId);

    expect(mocks.currentState).toMatchObject({ phase: "preflight" });
    const retrySessionId = mocks.currentState.sessionId as string;
    expect(retrySessionId).not.toBe(first.sessionId);
    expect(service.isActive()).toBe(true);
    expect(mocks.spawnedChildren).toHaveLength(1);
    await expect(service.retry(first.sessionId)).rejects.toThrow("failure_not_retryable");
    await expect(service.dismissFailure(first.sessionId)).rejects.toThrow("stale_failure");
    expect(mocks.currentState).toMatchObject({
      phase: "preflight",
      sessionId: retrySessionId
    });

    retryTmpDir.resolve("/tmp/pwrsnap-recording-retry");
    await vi.advanceTimersByTimeAsync(0);
    const retried = await retryPromise;
    expect(retried.sessionId).toBe(retrySessionId);
    expect(mocks.spawnedChildren).toHaveLength(2);
    expect(mocks.currentState).toMatchObject({
      phase: "recording",
      sessionId: retrySessionId
    });

    const cancelPromise = service.cancel();
    await vi.advanceTimersByTimeAsync(0);
    await cancelPromise;
  });

  test("shutdown waits for processing while normal close-cancel is rejected", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const sourceStore = await import("../../persistence/source-store");
    const adoption = deferred<
      Awaited<ReturnType<typeof sourceStore.adoptExistingFileAsSource>>
    >();
    vi.mocked(sourceStore.adoptExistingFileAsSource).mockImplementationOnce(
      async () => await adoption.promise
    );
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const first = await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      countdownSeconds: 0
    });
    const firstChild = mocks.spawnedChildren[0]!;
    const stopPromise = service.stop();
    firstChild.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.currentState).toMatchObject({
      phase: "processing",
      sessionId: first.sessionId
    });

    let shutdownSettled = false;
    const shutdownPromise = service.shutdown().then(() => {
      shutdownSettled = true;
    });
    await expect(service.cancel()).rejects.toThrow("finalization_in_progress");
    await expect(service.restart()).rejects.toThrow("finalization_in_progress");
    await vi.advanceTimersByTimeAsync(0);
    expect(shutdownSettled).toBe(false);
    expect(mocks.currentState).toMatchObject({
      phase: "processing",
      sessionId: first.sessionId
    });
    await expect(
      service.start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 })
    ).rejects.toThrow("already_recording");

    adoption.resolve({
      id: "src-finalized-on-quit",
      srcPath: "/fake/captures/src-finalized-on-quit.mp4",
      sha256: "finalized-on-quit-sha",
      byteSize: 2048,
      widthPx: 0,
      heightPx: 0
    });
    await expect(stopPromise).resolves.toEqual({ captureId: "cap-1" });
    await shutdownPromise;

    expect(vi.mocked(sourceStore.statSource)).toHaveBeenCalledWith(
      "/fake/captures/src-finalized-on-quit.mp4"
    );
    expect(firstChild.killCalled).toBe(false);
    expect(mocks.spawnedChildren).toHaveLength(1);
    expect(service.isActive()).toBe(false);
    expect(mocks.currentState).toMatchObject({
      phase: "ready",
      sessionId: first.sessionId,
      captureId: "cap-1"
    });
  });

  test.each(["insertCapture", "insertVideoMetadata", "pre-broadcast"] as const)(
    "joins shutdown triggered at the %s finalization boundary",
    async (boundary) => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
      const captures = await import("../../persistence/captures-repo");
      const videos = await import("../../persistence/video-repo");
      const events = await import("../../events");
      const { __setRecordingServiceForTests, getRecordingService } = await import(
        "../recording-service"
      );
      __setRecordingServiceForTests(null);
      const service = getRecordingService();
      let shutdownPromise: Promise<void> | null = null;
      let shutdownSettled = false;
      let shutdownWasPendingAtBoundary = false;
      let cancelOutcome: Promise<string> | null = null;
      const triggerShutdown = (): void => {
        shutdownPromise = service.shutdown().then(() => {
          shutdownSettled = true;
        });
        cancelOutcome = service.cancel().then(
          () => "unexpected_success",
          (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
        );
        shutdownWasPendingAtBoundary = !shutdownSettled;
      };

      if (boundary === "insertCapture") {
        vi.mocked(captures.insertCapture).mockImplementationOnce(() => {
          triggerShutdown();
          return { record: { id: "cap-1", kind: "video" } } as never;
        });
      } else if (boundary === "insertVideoMetadata") {
        vi.mocked(videos.insertVideoMetadata).mockImplementationOnce(() => {
          triggerShutdown();
        });
      } else {
        vi.mocked(captures.getCaptureById).mockImplementationOnce(() => {
          triggerShutdown();
          return { id: "cap-1", kind: "video", video: {} } as never;
        });
      }

      const started = await service.start({
        subject: SUBJECT,
        capabilities: CAPS,
        countdownSeconds: 0
      });
      const child = mocks.spawnedChildren[0]!;
      const stopPromise = service.stop();
      child.emit("exit", 0, null);
      await expect(stopPromise).resolves.toEqual({ captureId: "cap-1" });

      expect(shutdownPromise).not.toBeNull();
      expect(shutdownWasPendingAtBoundary).toBe(true);
      await expect(cancelOutcome).resolves.toBe("finalization_in_progress");
      await shutdownPromise;
      expect(shutdownSettled).toBe(true);
      expect(captures.insertCapture).toHaveBeenCalledTimes(1);
      expect(videos.insertVideoMetadata).toHaveBeenCalledTimes(1);
      expect(events.broadcastCapturesChanged).toHaveBeenCalledTimes(1);
      expect(mocks.removedRecordingDirs).toEqual(["/tmp/pwrsnap-recording-fake"]);
      expect(mocks.removedRecordingDirs).not.toContain("/fake/captures/src-1.mp4");
      expect(child.killCalled).toBe(false);
      expect(mocks.currentState).toMatchObject({
        phase: "ready",
        sessionId: started.sessionId,
        captureId: "cap-1"
      });
    }
  );

  test("retry starts a fresh session and a stale dismiss cannot cancel it", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const first = await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      captureCursor: false,
      countdownSeconds: 0
    });
    mocks.spawnedChildren[0]!.emit("exit", 9, null);
    await vi.advanceTimersByTimeAsync(0);
    expectSafeFailureState(latestFailureState(), {
      sessionId: first.sessionId,
      code: "recorder_exited"
    });

    await expect(
      service.start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 })
    ).rejects.toThrow("failure_action_required");
    expect(mocks.spawnedChildren).toHaveLength(1);

    const retried = await service.retry(first.sessionId);
    expect(retried.sessionId).not.toBe(first.sessionId);
    expect(mocks.spawnedChildren).toHaveLength(2);
    expect(mocks.currentState).toMatchObject({
      phase: "recording",
      sessionId: retried.sessionId
    });
    expect(argAfter(mocks.spawnCalls[0]!.args, "-draw_mouse")).toBe("0");
    expect(argAfter(mocks.spawnCalls[1]!.args, "-draw_mouse")).toBe("0");

    await expect(service.dismissFailure(first.sessionId)).rejects.toThrow("stale_failure");
    expect(service.isActive()).toBe(true);
    expect(mocks.spawnedChildren[1]!.killCalled).toBe(false);

    const cancelPromise = service.cancel();
    mocks.spawnedChildren[1]!.emit("exit", 0, null);
    await cancelPromise;
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.currentState).toEqual({ phase: "idle" });
    expect(mocks.removedRecordingDirs).toEqual([
      "/tmp/pwrsnap-recording-fake",
      "/tmp/pwrsnap-recording-fake"
    ]);
  });

  test("normal Windows Restart preserves the cursor snapshot", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      captureCursor: false,
      countdownSeconds: 0
    });
    const restartPromise = service.restart();
    await vi.advanceTimersByTimeAsync(3_100);
    const restarted = await restartPromise;

    expect(restarted.sessionId).not.toBe("");
    expect(mocks.spawnCalls).toHaveLength(2);
    expect(argAfter(mocks.spawnCalls[0]!.args, "-draw_mouse")).toBe("0");
    expect(argAfter(mocks.spawnCalls[1]!.args, "-draw_mouse")).toBe("0");

    const cancelPromise = service.cancel();
    await vi.advanceTimersByTimeAsync(0);
    await cancelPromise;
  });

  test("failed retry can be dismissed and clears its process and retry snapshot", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const first = await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      countdownSeconds: 0
    });
    mocks.spawnedChildren[0]!.emit("exit", 5, null);
    await vi.advanceTimersByTimeAsync(0);

    const retry = await service.retry(first.sessionId);
    const retryChild = mocks.spawnedChildren[1]!;
    retryChild.emit(
      "error",
      new Error("spawn C:\\Users\\alice\\private-recorder.exe --password retry-secret")
    );
    await vi.advanceTimersByTimeAsync(0);

    const failedRetry = latestFailureState();
    expectSafeFailureState(
      failedRetry,
      { sessionId: retry.sessionId, code: "recorder_spawn_failed" },
      [
        "alice",
        "private-recorder.exe",
        "--password",
        "retry-secret",
        "/tmp/pwrsnap-recording-fake",
        "-video_size",
        "gdigrab"
      ]
    );
    expect(retryChild.killCalled).toBe(true);
    expect(service.isActive()).toBe(false);

    await service.dismissFailure(retry.sessionId);
    expect(mocks.currentState).toEqual({ phase: "idle" });
    await expect(service.retry(retry.sessionId)).rejects.toThrow("failure_not_retryable");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.currentState).toEqual({ phase: "idle" });
  });
});
