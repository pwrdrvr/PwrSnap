import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  registerArtifact: vi.fn(),
  appendEvent: vi.fn(),
  createSession: vi.fn()
}));
vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.0", getAppMetrics: () => [] },
  contentTracing: mocks
}));
vi.mock("../../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn() })
}));
vi.mock("../content-trace-session", () => ({ createContentTraceSession: mocks.createSession }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.startRecording.mockResolvedValue(undefined);
  mocks.stopRecording.mockResolvedValue(undefined);
  mocks.registerArtifact.mockResolvedValue(undefined);
  mocks.appendEvent.mockResolvedValue(undefined);
  mocks.createSession.mockResolvedValue({
    ok: true,
    session: {
      directoryPath: "/trace",
      createTracePath: () => "/trace/trace-0001.json",
      registerArtifact: mocks.registerArtifact,
      appendEvent: mocks.appendEvent
    }
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function recorder(autoStartDelay = "0") {
  const recorder = await import("../content-trace-recorder");
  recorder.installContentTraceHook({
    env: { PWRSNAP_TRACE: "1", PWRSNAP_TRACE_AUTOSTART_DELAY_MS: autoStartDelay },
    outputRoot: "/trace"
  });
  return recorder;
}

test("quit joins trace startup, writes its manifest, and disarms future triggers", async () => {
  const starting = deferred();
  mocks.startRecording.mockReturnValue(starting.promise);
  const r = await recorder("20000");
  const start = r.startContentTrace("test");
  await vi.advanceTimersByTimeAsync(0);
  const shutdown = r.shutdownContentTrace();
  const finished = vi.fn();
  void shutdown.then(finished);
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).not.toHaveBeenCalled();
  starting.resolve();
  await start;
  await shutdown;
  expect(mocks.stopRecording).toHaveBeenCalledExactlyOnceWith("/trace/trace-0001.json");
  expect(mocks.registerArtifact).toHaveBeenCalledExactlyOnceWith("trace-0001.json");
  expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "trace-stop" }));
  await r.startContentTrace("after-quit");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mocks.startRecording).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("quit joins an already stopping trace through its manifest write", async () => {
  const writing = deferred();
  mocks.registerArtifact.mockReturnValue(writing.promise);
  const r = await recorder();
  await r.startContentTrace("test");
  const stop = r.stopContentTrace("duration-elapsed");
  const shutdown = r.shutdownContentTrace();
  const finished = vi.fn();
  void shutdown.then(finished);
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).not.toHaveBeenCalled();
  writing.resolve();
  await Promise.all([stop, shutdown]);
  expect(mocks.stopRecording).toHaveBeenCalledOnce();
  expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "trace-stop" }));
});

test.each([
  { reason: "sigusr2", stayArmed: true },
  { reason: "autostart", stayArmed: true },
  { reason: "sigusr2", stayArmed: false },
  { reason: "autostart", stayArmed: false }
])("$reason takes priority and only rearms when rolling tracing stays enabled ($stayArmed)", async ({ reason, stayArmed }) => {
  const { ChromiumTrace } = await import("../chromium-trace");
  const calls: string[] = [];
  const flush = deferred();
  const rollingStart = vi.fn(async () => { calls.push("rolling start"); });
  const rollingStop = vi.fn(async (raw: string) => {
    calls.push("rolling stop");
    await flush.promise;
    return raw;
  });
  const rolling = new ChromiumTrace(() => ({
    startRecording: rollingStart, stopRecording: rollingStop
  }), vi.fn(), { workerModule: new URL("../chromium-trace-worker.ts", import.meta.url) });
  mocks.startRecording.mockImplementation(async () => { calls.push("explicit start"); });
  mocks.stopRecording.mockImplementation(async () => { calls.push("explicit stop"); });
  const r = await recorder(reason === "autostart" ? "5" : "0");
  try {
    await rolling.setArmed(true);
    if (reason === "sigusr2") process.emit("SIGUSR2");
    await vi.advanceTimersByTimeAsync(5);
    expect(calls).toEqual(["rolling start", "rolling stop"]);
    flush.resolve();
    await r.startContentTrace("duplicate");
    expect(calls).toEqual(["rolling start", "rolling stop", "explicit start"]);
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "trace-start", detail: expect.objectContaining({ reason })
    }));
    if (!stayArmed) await rolling.setArmed(false);
    await r.stopContentTrace("test");
    const completed = ["rolling start", "rolling stop", "explicit start", "explicit stop"];
    if (stayArmed) {
      await vi.waitFor(() => expect(calls).toEqual([...completed, "rolling start"]));
    } else {
      expect(calls).toEqual(completed);
      expect(rolling.hasPendingWork).toBe(false);
    }
  } finally {
    flush.resolve();
    await r.shutdownContentTrace();
    await rolling.shutdown(100);
  }
});
