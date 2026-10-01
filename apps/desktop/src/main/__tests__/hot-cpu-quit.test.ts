import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSettings: vi.fn(),
  createSession: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  config: vi.fn()
}));
vi.mock("electron", () => ({ app: { getVersion: () => "1.0.0" } }));
vi.mock("../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));
vi.mock("../settings/desktop-settings-store", () => ({
  getDesktopSettingsStore: () => ({ read: mocks.readSettings })
}));
vi.mock("../diagnostics/hot-cpu-profile-paths", () => ({ hotCpuDiagnosticsRoot: () => "/unused" }));
vi.mock("../diagnostics/hot-cpu-profile-config", () => ({ resolveHotCpuProfileConfig: mocks.config }));
vi.mock("../diagnostics/hot-cpu-profile-session", () => ({ createHotCpuProfileSession: mocks.createSession }));
vi.mock("../diagnostics/hot-cpu-profiler", () => ({
  HotCpuProfiler: class {
    start = mocks.start;
    stop = mocks.stop;
  }
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  mocks.readSettings.mockResolvedValue({ general: {} });
  mocks.createSession.mockResolvedValue({ ok: true, session: {} });
  mocks.start.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.config.mockReturnValue({ enabled: true, startDelayMs: 0 });
});
afterEach(() => vi.clearAllMocks());

test("production main profiler shutdown waits for the stop and prevents settings from restarting it", async () => {
  const stopping = deferred<void>();
  mocks.stop.mockReturnValue(stopping.promise);
  const w = await import("../window");
  w.installMainProcessHotCpuMonitor();
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
  const done = vi.fn();
  const shutdown = w.stopHotCpuProfilers().then(done);
  await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledWith("app-quit"));
  expect(done).not.toHaveBeenCalled();
  w.syncHotCpuProfilersFromSettings("settings-changed");
  stopping.resolve();
  await shutdown;
  expect(mocks.start).toHaveBeenCalledOnce();
});

test("quit during a settings read prevents a profiler from starting after the flush", async () => {
  const settings = deferred<{ general: object }>();
  mocks.readSettings.mockReturnValue(settings.promise);
  const w = await import("../window");
  w.installMainProcessHotCpuMonitor();
  await vi.waitFor(() => expect(mocks.readSettings).toHaveBeenCalledOnce());
  const shutdown = w.stopHotCpuProfilers();
  settings.resolve({ general: {} });
  await shutdown;
  expect(mocks.createSession).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});

test("quit joins a profiler still creating its session", async () => {
  const session = deferred<{ ok: boolean; session: object }>();
  const stopping = deferred<void>();
  mocks.createSession.mockReturnValue(session.promise);
  mocks.stop.mockReturnValue(stopping.promise);
  const w = await import("../window");
  w.installMainProcessHotCpuMonitor();
  await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalledOnce());
  const done = vi.fn();
  const shutdown = w.stopHotCpuProfilers().then(done);
  session.resolve({ ok: true, session: {} });
  await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
  expect(done).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
  stopping.resolve();
  await shutdown;
});

test("quit joins a stop already started by a settings change", async () => {
  const stopping = deferred<void>();
  mocks.stop.mockReturnValue(stopping.promise);
  const w = await import("../window");
  w.installMainProcessHotCpuMonitor();
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
  mocks.config.mockReturnValue({ enabled: false });
  w.syncHotCpuProfilersFromSettings("settings-changed");
  await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
  const done = vi.fn();
  const shutdown = w.stopHotCpuProfilers().then(done);
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  stopping.resolve();
  await shutdown;
  expect(mocks.start).toHaveBeenCalledOnce();
});

test("a monitor with profiling off is not pending quit work; a running profiler is", async () => {
  mocks.config.mockReturnValue({ enabled: false });
  const w = await import("../window");
  // Installed at boot for every role, enabled or not.
  w.installMainProcessHotCpuMonitor();
  await vi.waitFor(() => expect(mocks.config).toHaveBeenCalled());
  expect(w.hasActiveHotCpuProfilers()).toBe(false);

  mocks.config.mockReturnValue({ enabled: true, startDelayMs: 0 });
  w.syncHotCpuProfilersFromSettings("settings-changed");
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
  expect(w.hasActiveHotCpuProfilers()).toBe(true);
});
