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
    nextSpawnError: null as Error | null,
    binaryPath: "/fake/PwrSnapRecorder",
    binaryExists: true,
    isPackaged: false,
    stateLog: [] as Array<{ phase: string }>,
    /** Full broadcast log including rect/displayId payloads — used
     *  by the multi-monitor translation test to verify the rect
     *  reaches the HUD in display-local coords. */
    stateLogFull: [] as Array<Record<string, unknown>>,
    currentState: { phase: "idle" } as Record<string, unknown>,
    infoLogs: [] as Array<{
      message: string;
      context: Record<string, unknown> | undefined;
    }>,
    pendingTimeouts: [] as Array<() => void>,
    liveWindows: [] as Array<{
      windowId: number;
      pid: number;
      title: unknown;
    }>
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
  spawn: vi.fn((command: string, args: string[] = []) => {
    mocks.spawnCalls.push({ command, args });
    if (mocks.nextSpawnError !== null) {
      const error = mocks.nextSpawnError;
      mocks.nextSpawnError = null;
      throw error;
    }
    const child = new FakeChild();
    mocks.spawnedChildren.push(child);
    return child;
  })
}));

vi.mock("node:fs", () => ({
  existsSync: () => mocks.binaryExists
}));

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(async () => "/tmp/pwrsnap-recording-fake")
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mocks.isPackaged;
    },
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

vi.mock("../recording-state", async () => {
  const real = (await import("../recording-state")) as Record<string, unknown>;
  return {
    ...real,
    setRecordingState: (next: Record<string, unknown>) => {
      mocks.currentState = next;
      mocks.stateLog.push({ phase: next.phase as string });
      mocks.stateLogFull.push(next);
    },
    getRecordingState: () => mocks.currentState,
    isRecordingActive: () =>
      ["preflight", "countdown", "starting", "recording", "stopping", "processing"].includes(
        mocks.currentState.phase as string
      )
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

vi.mock("../../capture/window-list", () => ({
  listWindows: vi.fn(async () => mocks.liveWindows)
}));

vi.mock("../../persistence/captures-repo", () => {
  const SOURCE_WINDOW_TITLE_MAX_CODE_POINTS = 512;
  const normalizeSourceWindowTitle = (
    value: string | null | undefined
  ): string | null => {
    if (value === null || value === undefined) return null;
    const safeFormatCharacters = value.replace(
      /\p{Default_Ignorable_Code_Point}/gu,
      (character) =>
        /[\u200c\u200d\ufe00-\ufe0f]/u.test(character) ? character : ""
    );
    const normalized = safeFormatCharacters
      .replace(/[\p{White_Space}\p{Cc}]+/gu, " ")
      .trim();
    if (normalized.replace(/\p{Default_Ignorable_Code_Point}/gu, "").length === 0) {
      return null;
    }
    return [...normalized]
      .slice(0, SOURCE_WINDOW_TITLE_MAX_CODE_POINTS)
      .join("")
      .trimEnd();
  };

  return {
    SOURCE_WINDOW_TITLE_MAX_CODE_POINTS,
    normalizeSourceWindowTitle,
    insertCapture: vi.fn(() => ({
      record: { id: "cap-1", kind: "video" }
    })),
    getCaptureById: vi.fn(() => ({ id: "cap-1", kind: "video", video: {} }))
  };
});

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
    info: (message: string, context?: Record<string, unknown>) => {
      mocks.infoLogs.push({ message, context });
    },
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
  mocks.nextSpawnError = null;
  mocks.binaryExists = true;
  mocks.isPackaged = false;
  mocks.stateLog.length = 0;
  mocks.stateLogFull.length = 0;
  mocks.currentState = { phase: "idle" };
  mocks.infoLogs.length = 0;
  mocks.pendingTimeouts.length = 0;
  mocks.liveWindows.length = 0;
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

describe("RecordingService unavailable packaged recorder", () => {
  test.each([
    { platform: "darwin", expectedCommand: "native" },
    { platform: "win32", expectedCommand: "ffmpeg" }
  ])("marks a missing packaged $expectedCommand backend as non-retryable", async ({
    platform
  }) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    (process as { resourcesPath?: string }).resourcesPath =
      platform === "win32" ? "C:\\fake" : "/fake";
    mocks.binaryExists = false;
    mocks.isPackaged = true;
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    await expect(
      service.start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 })
    ).rejects.toThrow();

    expect(mocks.currentState).toMatchObject({
      phase: "failed",
      code: "recorder_unavailable",
      canRetry: false
    });
    await expect(
      Promise.resolve().then(() =>
        service.retryCapabilities(mocks.currentState.sessionId as string)
      )
    ).rejects.toThrow("stale_failure");
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
    subject: import("@pwrsnap/shared").RecordingSubject,
    liveTitle?: unknown,
    livePid = 700
  ): Promise<Record<string, unknown>> {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const startPromise = service.start({
      subject,
      capabilities: CAPS,
      countdownSeconds: 0
    });
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
    const started = await startPromise;

    if (subject.kind === "window" && liveTitle !== undefined) {
      mocks.liveWindows.splice(0, mocks.liveWindows.length, {
        windowId: subject.windowId,
        pid: livePid,
        title: liveTitle
      });
      expect(
        service.attachTrustedWindowIdentity?.(started.sessionId, {
          windowId: subject.windowId,
          pid: 700
        })
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
    }

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

  test("trusted live title observed after start lands on the capture row", async () => {
    const row = await runFullCapture(
      {
        kind: "window",
        windowId: 12345,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        displayId: 1,
        appName: "Microsoft Edge",
        appBundleId: "com.microsoft.edgemac"
      },
      "設計レビュー — Edge 🚀"
    );
    expect(row.source_app_name).toBe("Microsoft Edge");
    expect(row.source_app_bundle_id).toBe("com.microsoft.edgemac");
    expect(row.source_window_title).toBe("設計レビュー — Edge 🚀");
  });

  test("normalizes controls and bounds a very long window title before insert", async () => {
    const row = await runFullCapture(
      {
        kind: "window",
        windowId: 12345,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        displayId: 1
      },
      `\u0000  Quarterly\tPlan\n${"🚀".repeat(600)}  \u0007`
    );
    const persistedTitle = row.source_window_title;
    expect(typeof persistedTitle).toBe("string");
    expect(persistedTitle).toMatch(/^Quarterly Plan 🚀/u);
    expect(persistedTitle).not.toMatch(/[\p{White_Space}\p{Cc}]$/u);
    expect([...(persistedTitle as string)]).toHaveLength(512);
  });

  test("window subject with no app fields and a control-only live title writes null", async () => {
    const row = await runFullCapture(
      {
        kind: "window",
        windowId: 12345,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        displayId: 1
      },
      "\u0000\t\n\u0007"
    );
    expect(row.source_app_name).toBeNull();
    expect(row.source_app_bundle_id).toBeNull();
    expect(row.source_window_title).toBeNull();
  });

  test("vanished or reused window identity persists null", async () => {
    const vanished = await runFullCapture({
      kind: "window",
      windowId: 12345,
      rect: { x: 0, y: 0, w: 100, h: 100 },
      displayId: 1
    });
    expect(vanished.source_window_title).toBeNull();

    const reused = await runFullCapture(
      {
        kind: "window",
        windowId: 12345,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        displayId: 1
      },
      "Wrong process title",
      701
    );
    expect(reused.source_window_title).toBeNull();
  });

  test("malformed native title cannot fail stop after the durable file is ready", async () => {
    const row = await runFullCapture(
      {
        kind: "window",
        windowId: 12345,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        displayId: 1
      },
      42
    );
    const sourceStore = await import("../../persistence/source-store");
    expect(sourceStore.adoptExistingFileAsSource).toHaveBeenCalled();
    expect(row.source_window_title).toBeNull();
  });

  test("region subject writes null app metadata (no single source app)", async () => {
    const row = await runFullCapture({
      kind: "region",
      rect: { x: 0, y: 0, w: 100, h: 100 },
      displayId: 1
    });
    expect(row.source_app_name).toBeNull();
    expect(row.source_app_bundle_id).toBeNull();
    expect(row.source_window_title).toBeNull();
  });
});

describe("RecordingService trusted window-title timing", () => {
  const windowSubject: import("@pwrsnap/shared").RecordingSubject = {
    kind: "window",
    windowId: 12345,
    rect: { x: 0, y: 0, w: 100, h: 100 },
    displayId: 1,
    appName: "Example",
    appBundleId: "com.example"
  };

  async function finishNativeStop(
    service: import("../recording-service").RecordingService,
    child: FakeChild
  ): Promise<Record<string, unknown>> {
    const stopPromise = service.stop();
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
    const captures = await import("../../persistence/captures-repo");
    const calls = (captures.insertCapture as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    return calls.at(-1)![0] as Record<string, unknown>;
  }

  test("resolves the changed title only after the countdown and actual start", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();
    mocks.liveWindows.push({ windowId: 12345, pid: 700, title: "Selector title" });

    const startPromise = service.start({
      subject: windowSubject,
      capabilities: CAPS,
      countdownSeconds: 3
    });
    await vi.advanceTimersByTimeAsync(1_000);
    mocks.liveWindows[0]!.title = "Changed during countdown — 東京 🚀";
    await vi.advanceTimersByTimeAsync(2_100);
    const child = mocks.spawnedChildren[0]!;
    child.emitLine({
      event: "started",
      physicalRect: { x: 0, y: 0, w: 100, h: 100 }
    });
    await vi.advanceTimersByTimeAsync(0);
    const started = await startPromise;
    expect(
      service.attachTrustedWindowIdentity?.(started.sessionId, {
        windowId: 12345,
        pid: 700
      })
    ).toBe(true);

    const row = await finishNativeStop(service, child);
    expect(row.source_window_title).toBe("Changed during countdown — 東京 🚀");
  });

  test("persists null when the selected window disappears during countdown", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();
    mocks.liveWindows.push({ windowId: 12345, pid: 700, title: "Closing window" });

    const startPromise = service.start({
      subject: windowSubject,
      capabilities: CAPS,
      countdownSeconds: 3
    });
    await vi.advanceTimersByTimeAsync(1_000);
    mocks.liveWindows.length = 0;
    await vi.advanceTimersByTimeAsync(2_100);
    const child = mocks.spawnedChildren[0]!;
    child.emitLine({
      event: "started",
      physicalRect: { x: 0, y: 0, w: 100, h: 100 }
    });
    await vi.advanceTimersByTimeAsync(0);
    const started = await startPromise;
    expect(
      service.attachTrustedWindowIdentity?.(started.sessionId, {
        windowId: 12345,
        pid: 700
      })
    ).toBe(true);

    const row = await finishNativeStop(service, child);
    expect(row.source_window_title).toBeNull();
  });

  test("restart re-resolves the title for the new actual start", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();
    mocks.liveWindows.push({ windowId: 12345, pid: 700, title: "First start" });

    const firstStartPromise = service.start({
      subject: windowSubject,
      capabilities: CAPS,
      countdownSeconds: 0
    });
    await vi.advanceTimersByTimeAsync(0);
    const firstChild = mocks.spawnedChildren[0]!;
    firstChild.emitLine({
      event: "started",
      physicalRect: { x: 0, y: 0, w: 100, h: 100 }
    });
    await vi.advanceTimersByTimeAsync(0);
    const firstStarted = await firstStartPromise;
    expect(
      service.attachTrustedWindowIdentity?.(firstStarted.sessionId, {
        windowId: 12345,
        pid: 700
      })
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    const restartPromise = service.restart();
    firstChild.emitLine({
      event: "stopped",
      durationSec: 0.5,
      containerFormat: "mp4",
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      outputPath: "/tmp/discarded.mp4"
    });
    await vi.advanceTimersByTimeAsync(1_000);
    mocks.liveWindows[0]!.title = "Restarted title";
    await vi.advanceTimersByTimeAsync(2_100);
    const restartedChild = mocks.spawnedChildren[1]!;
    restartedChild.emitLine({
      event: "started",
      physicalRect: { x: 0, y: 0, w: 100, h: 100 }
    });
    await vi.advanceTimersByTimeAsync(0);
    await restartPromise;

    const row = await finishNativeStop(service, restartedChild);
    expect(row.source_window_title).toBe("Restarted title");
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

  test("native recorder exit after start becomes a durable safe failure", async () => {
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const started = service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      countdownSeconds: 0
    });
    await vi.advanceTimersByTimeAsync(0);
    const child = mocks.spawnedChildren[0]!;
    child.emitLine({ event: "started", physicalRect: SUBJECT.rect });
    await started;

    child.emit("exit", 7, null);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(service.isActive()).toBe(false);
    expect(mocks.currentState).toMatchObject({
      phase: "failed",
      code: "recorder_exited",
      canRetry: true,
      displayId: 1
    });
    expect(mocks.currentState).not.toHaveProperty("message");
  });
});

describe("Windows FFmpeg recorder", () => {
  function argAfter(args: string[], flag: string): string {
    const index = args.indexOf(flag);
    expect(index).toBeGreaterThanOrEqual(0);
    return args[index + 1]!;
  }

  async function loadWindowsService() {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    return getRecordingService();
  }

  async function cancelAndExit(
    service: import("../recording-service").RecordingService,
    child: FakeChild
  ): Promise<void> {
    const cancelPromise = service.cancel();
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await cancelPromise;
  }

  test.each([
    { label: "explicit true", captureCursor: true, drawMouse: "1" },
    { label: "explicit false", captureCursor: false, drawMouse: "0" },
    { label: "omitted default", captureCursor: undefined, drawMouse: "1" }
  ])("wires $label to gdigrab and logs the effective choice", async ({
    captureCursor,
    drawMouse
  }) => {
    const service = await loadWindowsService();

    if (captureCursor === undefined) {
      await service.start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 });
    } else {
      await service.start({
        subject: SUBJECT,
        capabilities: CAPS,
        captureCursor,
        countdownSeconds: 0
      });
    }

    const call = mocks.spawnCalls[0]!;
    expect(argAfter(call.args, "-draw_mouse")).toBe(drawMouse);
    const startLog = mocks.infoLogs.find(
      ({ message }) => message === "starting Windows ffmpeg recorder"
    );
    expect(startLog?.context).toMatchObject({ captureCursor: drawMouse === "1" });
    expect(startLog?.context).not.toHaveProperty("args");
    expect(startLog?.context).not.toHaveProperty("subject");

    await cancelAndExit(service, mocks.spawnedChildren[0]!);
  });

  test.each([
    { label: "explicit cursor-on", captureCursor: true, drawMouse: "1" },
    { label: "explicit cursor-off", captureCursor: false, drawMouse: "0" },
    { label: "default cursor-on", captureCursor: undefined, drawMouse: "1" }
  ])("restart preserves the $label choice", async ({ captureCursor, drawMouse }) => {
    const service = await loadWindowsService();
    if (captureCursor === undefined) {
      await service.start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 });
    } else {
      await service.start({
        subject: SUBJECT,
        capabilities: CAPS,
        captureCursor,
        countdownSeconds: 0
      });
    }

    const firstChild = mocks.spawnedChildren[0]!;
    const restartPromise = service.restart();
    firstChild.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(3_100);
    await restartPromise;

    expect(mocks.spawnCalls).toHaveLength(2);
    expect(argAfter(mocks.spawnCalls[1]!.args, "-draw_mouse")).toBe(drawMouse);

    await cancelAndExit(service, mocks.spawnedChildren[1]!);
  });

  test("cancel clears cursor-off state before a new default session", async () => {
    const service = await loadWindowsService();
    await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      captureCursor: false,
      countdownSeconds: 0
    });
    await cancelAndExit(service, mocks.spawnedChildren[0]!);
    await expect(service.restart()).rejects.toThrow("not_recording");

    await service.start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 });

    expect(mocks.spawnCalls).toHaveLength(2);
    expect(argAfter(mocks.spawnCalls[1]!.args, "-draw_mouse")).toBe("1");

    await cancelAndExit(service, mocks.spawnedChildren[1]!);
  });

  test("cancel during countdown clears cursor state before FFmpeg spawns", async () => {
    const service = await loadWindowsService();
    let startOutcome: Error | "ok" | null = null;
    const firstStart = service
      .start({
        subject: SUBJECT,
        capabilities: CAPS,
        captureCursor: false,
        countdownSeconds: 3
      })
      .then(() => (startOutcome = "ok"))
      .catch((error: Error) => (startOutcome = error));
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.spawnCalls).toHaveLength(0);
    await service.cancel();
    await vi.advanceTimersByTimeAsync(1_100);
    await firstStart;

    expect(startOutcome).toBeInstanceOf(Error);
    expect((startOutcome as unknown as Error).message).toBe("cancelled");
    await expect(service.restart()).rejects.toThrow("not_recording");

    await service.start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 });
    expect(argAfter(mocks.spawnCalls[0]!.args, "-draw_mouse")).toBe("1");

    await cancelAndExit(service, mocks.spawnedChildren[0]!);
  });

  test("a synchronous spawn failure stays actionable and retry preserves cursor state", async () => {
    const service = await loadWindowsService();
    mocks.nextSpawnError = new Error("synthetic spawn failure");

    await expect(
      service.start({
        subject: SUBJECT,
        capabilities: CAPS,
        captureCursor: false,
        countdownSeconds: 0
      })
    ).rejects.toThrow("synthetic spawn failure");
    expect(service.isActive()).toBe(false);
    await expect(service.restart()).rejects.toThrow("not_recording");
    expect(mocks.currentState).toMatchObject({
      phase: "failed",
      code: "recorder_spawn_failed",
      canRetry: true,
      displayId: 1
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.currentState).toMatchObject({ phase: "failed" });

    mocks.nextSpawnError = new Error("C:\\private\\secret retry --token=hidden");
    await expect(service.retry(mocks.currentState.sessionId as string)).rejects.toThrow(
      "secret retry"
    );
    expect(mocks.currentState).toMatchObject({
      phase: "failed",
      code: "recorder_spawn_failed"
    });
    expect(mocks.currentState).not.toHaveProperty("message");

    await service.retry(mocks.currentState.sessionId as string);
    expect(argAfter(mocks.spawnCalls[2]!.args, "-draw_mouse")).toBe("0");

    await cancelAndExit(service, mocks.spawnedChildren[0]!);
  });

  test("an unexpected exit remains failed until the matching session is dismissed", async () => {
    const service = await loadWindowsService();
    await service.start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 });

    mocks.spawnedChildren[0]!.emit("exit", 9, null);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(service.isActive()).toBe(false);
    expect(mocks.currentState).toMatchObject({
      phase: "failed",
      code: "recorder_exited",
      canRetry: true,
      displayId: 1
    });
    expect(mocks.currentState).not.toHaveProperty("message");
    await expect(service.dismissFailure("stale-session")).rejects.toThrow("stale_failure");

    await service.dismissFailure(mocks.currentState.sessionId as string);
    expect(mocks.currentState).toEqual({ phase: "idle" });
  });

  test("an asynchronous spawn failure blocks a fresh start until session retry", async () => {
    const service = await loadWindowsService();
    await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      captureCursor: false,
      countdownSeconds: 0
    });

    mocks.spawnedChildren[0]!.emit("error", new Error("synthetic async spawn failure"));
    await vi.advanceTimersByTimeAsync(0);

    expect(service.isActive()).toBe(false);
    await expect(service.restart()).rejects.toThrow("not_recording");
    await expect(
      service.start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 })
    ).rejects.toThrow("failure_action_required");

    const failedSessionId = mocks.currentState.sessionId as string;
    const retryPromise = service.retry(failedSessionId);
    await expect(service.dismissFailure(failedSessionId)).rejects.toThrow("stale_failure");
    await retryPromise;
    expect(argAfter(mocks.spawnCalls[1]!.args, "-draw_mouse")).toBe("0");

    await cancelAndExit(service, mocks.spawnedChildren[1]!);
  });

  test("successful stop clears cursor state before a new default session", async () => {
    const service = await loadWindowsService();
    await service.start({
      subject: SUBJECT,
      capabilities: CAPS,
      captureCursor: false,
      countdownSeconds: 0
    });

    const firstChild = mocks.spawnedChildren[0]!;
    const stopPromise = service.stop();
    firstChild.emit("exit", 0, null);
    await stopPromise;
    await expect(service.restart()).rejects.toThrow("not_recording");

    await service.start({ subject: SUBJECT, capabilities: CAPS, countdownSeconds: 0 });
    expect(argAfter(mocks.spawnCalls[1]!.args, "-draw_mouse")).toBe("1");

    await cancelAndExit(service, mocks.spawnedChildren[1]!);
  });

  test("spawns gdigrab and persists the stopped MP4", async () => {
    const service = await loadWindowsService();

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

    const captures = await import("../../persistence/captures-repo");
    const calls = (captures.insertCapture as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const row = calls.at(-1)![0] as Record<string, unknown>;
    expect(row.source_window_title).toBeNull();
  });

  test("persists source_window_title for a window subject", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (process as { resourcesPath?: string }).resourcesPath = "C:\\fake";
    const { __setRecordingServiceForTests, getRecordingService } = await import(
      "../recording-service"
    );
    __setRecordingServiceForTests(null);
    const service = getRecordingService();

    const started = await service.start({
      subject: {
        kind: "window",
        windowId: 133048,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        displayId: 1,
        appName: "slack",
        appBundleId: "C:\\Program Files\\Slack\\slack.exe"
      },
      capabilities: CAPS,
      countdownSeconds: 0
    });
    mocks.liveWindows.push({
      windowId: 133048,
      pid: 900,
      title: "项目状态 — Café 🚀"
    });
    expect(
      service.attachTrustedWindowIdentity?.(started.sessionId, {
        windowId: 133048,
        pid: 900
      })
    ).toBe(true);

    const child = mocks.spawnedChildren[0]!;
    const stopPromise = service.stop();
    child.emit("exit", 0, null);
    await stopPromise;

    const captures = await import("../../persistence/captures-repo");
    const calls = (captures.insertCapture as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const row = calls.at(-1)![0] as Record<string, unknown>;
    expect(row.source_window_title).toBe("项目状态 — Café 🚀");
  });

  test("converts selected DIP rects to physical pixels before gdigrab", async () => {
    const service = await loadWindowsService();

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
    const service = await loadWindowsService();

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
});
