// Contract: one user's take owns every live recorder and original; cancelling
// settles that request, terminal events settle Stop, and only Stop may adopt a
// finalized original once. The model knows issued commands, not service fields.
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RecordingService } from "../recording-service";

type Mode = "idle" | "starting" | "recording" | "failed";
type Stage = "allocation" | "camera" | "starting" | "recording";
type Terminal = "ack" | "exit" | "error" | "silence";
type Original = { request: number; finalized: boolean; adopted: boolean };
type Outcome<T> = { settled: boolean; value?: T; error?: Error };
const world = vi.hoisted(() => ({
  scheduler: null as fc.Scheduler | null,
  platform: "darwin",
  issuing: 0,
  nextRequest: 0,
  nextId: 0,
  state: { phase: "idle" } as Record<string, unknown>,
  children: [] as RecorderProcess[],
  directories: new Map<string, { request: number; removed: boolean }>(),
  originals: new Map<string, Original>(),
  adopted: new Map<string, number>(),
  rows: new Set<string>(),
  published: new Set<string>(),
  callbackErrors: [] as unknown[],
  terminal: "ack" as Terminal,
  cleanupRejects: false,
  onStarting: null as (() => void) | null
}));
function scheduled<T>(task: Promise<T>, label: string): Promise<T> {
  return world.scheduler!.schedule(task, label);
}
function deliver(action: () => void, label: string): void {
  // Delayed child stdout/exit is intentionally deliverable after process death:
  // OS pipe buffers can outlive a cancelled take. It must not affect its heir.
  void scheduled(Promise.resolve(), label).then(action).catch(error => { world.callbackErrors.push(error); });
}
function original(path: string): Original {
  const value = world.originals.get(path);
  if (!value) throw new Error(`Unknown recording original: ${path}`);
  return value;
}
function availableOriginal(path: string): Original {
  const file = original(path);
  const directory = world.directories.get(dirname(path));
  if (!directory || directory.removed || file.adopted) {
    throw new Error(`Recording original is unavailable: ${path}`);
  }
  return file;
}
class RecorderProcess extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  alive = true;
  outputPath = "";
  request = 0;
  readonly stdin = { write: (line: string) => {
    if (!this.alive) throw new Error("Recorder stdin is closed");
    if (line === "q" || JSON.parse(line).type === "stop") this.stop();
    else this.open((JSON.parse(line) as { outputPath: string }).outputPath);
    return true;
  } };
  open(path: string): void {
    const directory = world.directories.get(dirname(path));
    if (!directory || directory.removed) throw new Error("Recorder needs its owned directory");
    this.outputPath = path;
    this.request = directory.request;
    if (world.originals.has(path)) throw new Error("Original cannot be overwritten");
    world.originals.set(path, { request: this.request, finalized: false, adopted: false });
  }
  line(payload: object): void { this.stdout.emit("data", JSON.stringify(payload) + "\n"); }
  exit(code: number | null, signal: string | null = null): void {
    this.alive = false;
    this.emit("exit", code, signal);
  }
  kill(): boolean {
    this.alive = false;
    if (world.terminal !== "silence") deliver(() => this.exit(null, "SIGTERM"), "killed recorder exit");
    return true;
  }
  private stop(): void {
    const terminal = world.terminal;
    if (terminal === "silence") return;
    if (terminal === "error") {
      deliver(() => this.emit("error", new Error("Recorder stop failed")), "recorder error");
    } else if (terminal === "exit") {
      deliver(() => this.exit(7), "recorder exits without acknowledgement");
    } else {
      if (world.platform === "darwin") {
        deliver(() => {
          original(this.outputPath).finalized = true;
          this.line({ event: "stopped", outputPath: this.outputPath,
            durationSec: 2, containerFormat: "mp4", hasSystemAudio: false, hasMicrophoneAudio: false });
        }, "stop acknowledgement");
      }
      // Scheduler may deliver exit before buffered native stopped output.
      deliver(() => { original(this.outputPath).finalized = true; this.exit(0); }, "normal recorder exit");
    }
  }
}
vi.mock("node:child_process", () => ({ spawn: (_binary: string, args: string[]) => {
  const child = new RecorderProcess();
  world.children.push(child);
  if (world.platform === "win32") child.open(args.at(-1)!);
  return child;
} }));
vi.mock("node:fs", () => ({ existsSync: () => true, statSync: () => ({ mtime: new Date(0), size: 1 }) }));
vi.mock("node:fs/promises", () => ({
  mkdtemp: (prefix: string) => {
    // Backend selection via process.platform does not change node:path's host
    // semantics. Preserve the caller's prefix as the real mkdtemp does.
    const dir = `${prefix}${world.issuing}-${world.directories.size}`;
    world.directories.set(dir, { request: world.issuing, removed: false });
    return scheduled(Promise.resolve(dir), `allocate request ${world.issuing}`);
  },
  rm: async (path: string) => {
    const dir = world.directories.get(path);
    if (!dir) throw new Error("Directory is not owned");
    if (dir.removed) return; // rm(force: true) is idempotent.
    if (world.children.some(c => c.alive && dirname(c.outputPath) === path && !original(c.outputPath).finalized)) {
      const error = new Error("Removed an original while its recorder is still writing");
      world.callbackErrors.push(error);
      throw error;
    }
    dir.removed = true;
  }
}));
vi.mock("nanoid", () => ({ nanoid: () => `session-${++world.nextId}` }));
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/fake/app" },
  Notification: { isSupported: () => false },
  screen: {
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }],
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }),
    dipToScreenRect: (_window: unknown, rect: object) => rect
  }
}));
vi.mock("../recording-state", () => ({
  getRecordingState: () => world.state,
  isRecordingActive: () => ["preflight", "countdown", "starting", "recording", "stopping", "processing"].includes(world.state.phase as string),
  setRecordingState: (state: Record<string, unknown>) => {
    world.state = state;
    if (state.phase === "starting") world.onStarting?.();
  }
}));
vi.mock("../camera-recording", () => ({
  beginCameraRecording: () => scheduled(Promise.resolve(), "camera startup"),
  cancelCameraRecording: () => {
    const rejects = world.cleanupRejects;
    world.cleanupRejects = false;
    return scheduled(Promise.resolve(), "camera cleanup").then(() => {
      if (rejects) throw new Error("Camera file cleanup failed");
    });
  },
  finishCameraRecording: () => scheduled(Promise.resolve(null), "camera finish"),
  markCameraScreenStart() {}, markCameraScreenStartUtc() {}, prepareCameraPreview() {}, confirmCameraPreviewExclusion() {}
}));
vi.mock("../recording-controller", () => ({ getRecordingControllerPid: () => null }));
vi.mock("../ffmpeg-resolver", () => ({ resolveFfmpegPath: () => "/fake/ffmpeg" }));
vi.mock("../../capture/window-list", () => ({ listWindows: async () => [] }));
vi.mock("../../capture/capture-storage-gate", () => ({ runWithCapturesDirFallback: (write: (path: string) => unknown) => write("/captures") }));
vi.mock("../../persistence/source-store", () => ({
  prepareExistingFileAsSource: (path: string) => {
    if (!availableOriginal(path).finalized) throw new Error("Preparing an unfinished original");
    return scheduled(Promise.resolve({ tempPath: path, sha256: "sha", byteSize: 1 }), "prepare original");
  },
  adoptExistingFileAsSource: async (source: { tempPath: string }) => {
    await scheduled(Promise.resolve(), "adopt original");
    const file = availableOriginal(source.tempPath);
    if (!file.finalized || file.adopted) throw new Error("Only one adoption of a finalized original is allowed");
    file.adopted = true;
    const id = `capture-${file.request}`;
    world.adopted.set(id, file.request);
    return { id, srcPath: `/captures/${id}.mp4`, sha256: "sha" };
  },
  statSource: async () => ({ byteSize: 1 })
}));
vi.mock("../../persistence/captures-repo", () => ({
  normalizeSourceWindowTitle: () => null,
  insertCapture: (row: { id: string; kind: string }) => {
    if (row.kind !== "video" || !world.adopted.has(row.id) || world.rows.has(row.id)) throw new Error("Invalid or duplicate capture insert");
    world.rows.add(row.id);
    return { record: row };
  },
  getCaptureById: (id: string) => ({ id })
}));
vi.mock("../../persistence/video-repo", () => ({ insertVideoMetadata() {}, setVideoCamera() {} }));
vi.mock("../../persistence/video-filename-maintenance", () => ({ renameVideoSourceToEffectiveFilename: async () => undefined }));
vi.mock("../../float-over", () => ({ setFloatOverState: (state: { captureId: string }) => {
  if (!world.rows.has(state.captureId) || world.published.has(state.captureId)) throw new Error("Publication must follow one durable capture insert");
  world.published.add(state.captureId);
} }));
vi.mock("../../events", () => ({ broadcastCapturesChanged() {} }));
vi.mock("../../handlers/codex-handlers", () => ({ maybeEnqueueCaptureEnrichment() {} }));
vi.mock("../../log", () => ({ getMainLogger: () => ({ info() {}, warn() {}, error() {} }) }));

interface Model {
  mode: Mode;
  owner: number | null;
  terminal: "idle" | "ready";
  saved: Set<number>;
  retryable: boolean;
}
interface Real {
  service: RecordingService;
  scheduler: fc.Scheduler;
  starts: Outcome<{ sessionId: string }>[];
}
function observe<T>(promise: Promise<T>): Outcome<T> {
  const out: Outcome<T> = { settled: false };
  void promise.then(value => { out.value = value; out.settled = true; },
    (error: Error) => { out.error = error; out.settled = true; });
  return out;
}
async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function drain(real: Real): Promise<void> { await real.scheduler.waitIdle(); await flush(); }
function checkOracle(model: Model): void {
  expect(world.callbackErrors, "all scheduled recorder callbacks satisfy the strict fake").toEqual([]);
  const live = world.children.filter(child => child.alive);
  expect(live.length, "at most one physical recorder may remain live").toBeLessThanOrEqual(1);
  expect(live.every(child => child.request === model.owner), "a retired request cannot own a live recorder").toBe(true);
  expect(new Set(world.adopted.values()), "adoption follows user Stop exactly once").toEqual(model.saved);
  expect(world.rows.size).toBe(model.saved.size);
  expect(world.published.size).toBe(model.saved.size);
  if (model.mode === "idle") {
    expect(live).toHaveLength(0);
    expect(world.state.phase).toBe(model.terminal);
  } else if (model.mode === "recording" || model.mode === "failed") expect(world.state.phase).toBe(model.mode);
  if (model.mode === "failed") expect(world.state.canRetry).toBe(model.retryable);
}
const options = { subject: { kind: "region" as const, displayId: 1, rect: { x: 0, y: 0, w: 100, h: 100 } },
  capabilities: { systemAudio: false, microphone: false }, countdownSeconds: 0 };
async function makeRecording(model: Model, real: Real): Promise<void> {
  await drain(real);
  if (world.platform === "darwin") {
    const child = world.children.find(c => c.alive && c.request === model.owner)!;
    deliver(() => child.line({ event: "started" }), "start acknowledgement");
    await drain(real);
  }
  model.mode = "recording";
  expect(real.starts[0]).toMatchObject({ settled: true, value: { sessionId: expect.any(String) } });
}
class Begin implements fc.AsyncCommand<Model, Real> {
  constructor(readonly stage: Stage, readonly batch: number) {}
  check = (m: Readonly<Model>) => m.mode === "idle";
  async run(m: Model, r: Real): Promise<void> {
    const previousDirectories = new Set(world.directories.keys());
    m.owner = ++world.nextRequest;
    m.mode = "starting";
    r.starts = [];
    for (let i = 0; i < this.batch; i++) {
      world.issuing = i === 0 ? m.owner : ++world.nextRequest;
      r.starts.push(observe(r.service.start({ ...options,
        capabilities: this.stage === "camera" ? { ...options.capabilities, camera: { deviceId: "camera" } } : options.capabilities })));
    }
    await flush();
    // External allocations, not the service's admission flag, are the oracle.
    // Failed takes deliberately retain recovery directories. Only allocations
    // caused by this new batch participate in its admission check.
    expect([...world.directories].filter(([path]) => !previousDirectories.has(path))
      .every(([, dir]) => dir.request === m.owner), "only the first issued Start may allocate").toBe(true);
    for (const denied of r.starts.slice(1)) expect(denied.error?.message).toBe("already_recording");
    if (this.stage === "camera") { await r.scheduler.waitNext(1); await flush(); }
    if (this.stage === "starting") {
      await drain(r);
      if (world.platform === "win32") m.mode = "recording";
    }
    if (this.stage === "recording") await makeRecording(m, r);
    checkOracle(m);
  }
  toString = () => `Start(${this.stage}, ${this.batch} callers)`;
}
class Acknowledge implements fc.AsyncCommand<Model, Real> {
  check = (m: Readonly<Model>) => m.mode === "starting";
  async run(m: Model, r: Real): Promise<void> { await makeRecording(m, r); checkOracle(m); }
  toString = () => "AcknowledgeStart";
}
class Cancel implements fc.AsyncCommand<Model, Real> {
  constructor(readonly repeats: number, readonly cleanupRejects: boolean) {}
  check = (m: Readonly<Model>) => m.mode === "starting" || m.mode === "recording";
  async run(m: Model, r: Real): Promise<void> {
    const pendingStart = m.mode === "starting";
    world.terminal = "ack";
    world.cleanupRejects = this.cleanupRejects;
    const cancellations = Array.from({ length: this.repeats }, () => observe(r.service.cancel()));
    await drain(r);
    await vi.advanceTimersByTimeAsync(600);
    await drain(r);
    m.mode = "idle"; m.owner = null; m.terminal = "idle";
    checkOracle(m);
    for (const out of cancellations) expect(out).toEqual({ settled: true, value: undefined });
    if (pendingStart) expect(r.starts[0]?.error?.message).toBe("cancelled");
  }
  toString = () => `Cancel(${this.repeats} callers, cleanup rejects=${this.cleanupRejects})`;
}
class CancelAtStarting implements fc.AsyncCommand<Model, Real> {
  constructor(readonly queued: boolean) {}
  check = (m: Readonly<Model>) => m.mode === "idle";
  async run(m: Model, r: Real): Promise<void> {
    m.owner = ++world.nextRequest; world.issuing = m.owner;
    let cancelled: Outcome<void> | undefined;
    world.terminal = "ack";
    world.onStarting = () => {
      world.onStarting = null;
      const cancel = () => { cancelled = observe(r.service.cancel()); };
      if (this.queued) void Promise.resolve().then(cancel);
      else cancel();
    };
    r.starts = [observe(r.service.start(options))];
    await drain(r);
    await vi.advanceTimersByTimeAsync(600);
    await drain(r);
    m.mode = "idle"; m.owner = null; m.terminal = "idle";
    checkOracle(m);
    expect(cancelled).toEqual({ settled: true, value: undefined });
    expect(r.starts[0]?.error?.message).toBe("cancelled");
  }
  toString = () => `CancelAtStarting(queued=${this.queued})`;
}
class Stop implements fc.AsyncCommand<Model, Real> {
  constructor(readonly terminal: Terminal, readonly repeats: number) {}
  check = (m: Readonly<Model>) => m.mode === "recording";
  async run(m: Model, r: Real): Promise<void> {
    world.terminal = this.terminal;
    const outputs = Array.from({ length: this.repeats }, () => observe(r.service.stop()));
    await drain(r);
    await vi.advanceTimersByTimeAsync(20_000);
    await drain(r);
    expect(outputs.every(out => out.settled), "every Stop must settle, including missing terminal acknowledgements").toBe(true);
    if (this.terminal === "ack") {
      for (const out of outputs) expect(out.value).toEqual({ captureId: `capture-${m.owner}` });
      m.saved.add(m.owner!); m.mode = "idle"; m.owner = null; m.terminal = "ready";
    } else {
      expect(outputs.every(out => out.error instanceof Error)).toBe(true);
      for (const [path, file] of world.originals) if (file.request === m.owner) {
        expect(world.directories.get(dirname(path))?.removed, "failed Stop preserves the original for recovery").toBe(false);
      }
      m.mode = "failed"; m.retryable = false; m.owner = null;
    }
    checkOracle(m);
  }
  toString = () => `Stop(${this.terminal}, ${this.repeats} callers)`;
}
class Fault implements fc.AsyncCommand<Model, Real> {
  constructor(readonly cleanupRejects: boolean) {}
  check = (m: Readonly<Model>) => m.mode === "recording";
  async run(m: Model): Promise<void> {
    world.cleanupRejects = this.cleanupRejects;
    world.children.find(child => child.alive && child.request === m.owner)!.exit(7);
    m.mode = "failed"; m.owner = null; m.retryable = true;
    checkOracle(m);
  }
  toString = () => `RecorderExit(cleanup rejects=${this.cleanupRejects})`;
}
class Recover implements fc.AsyncCommand<Model, Real> {
  constructor(readonly action: "dismiss" | "retry") {}
  check = (m: Readonly<Model>) => m.mode === "failed" && (this.action === "dismiss" || m.retryable);
  async run(m: Model, r: Real): Promise<void> {
    const id = world.state.sessionId as string; // Opaque API identifier, not an expected-state oracle.
    if (this.action === "dismiss") {
      const dismissed = observe(r.service.dismissFailure(id));
      await drain(r);
      expect(dismissed).toEqual({ settled: true, value: undefined });
      m.mode = "idle"; m.owner = null; m.terminal = "idle";
    } else {
      m.owner = ++world.nextRequest; world.issuing = m.owner;
      r.starts = [observe(r.service.retry(id))];
      await makeRecording(m, r);
    }
    checkOracle(m);
  }
  toString = () => this.action === "dismiss" ? "DismissFailure" : "RetryFailure";
}
class BufferedEvents implements fc.AsyncCommand<Model, Real> {
  check = (m: Readonly<Model>) => m.mode !== "starting";
  async run(m: Model, r: Real): Promise<void> {
    for (const child of world.children.filter(c => !c.alive)) {
      deliver(() => child.line({ event: "started" }), "retired buffered start");
      deliver(() => child.line({ event: "error", code: "late", message: "retired" }), "retired buffered error");
      deliver(() => child.exit(7), "retired delayed exit");
    }
    await drain(r);
    await vi.advanceTimersByTimeAsync(20_000);
    await drain(r);
    checkOracle(m);
  }
  toString = () => "DeliverRetiredEventsAndDeadlines";
}
const commandArbitraries = [
  fc.tuple(fc.constantFrom<Stage>("allocation", "camera", "starting", "recording"), fc.integer({ min: 1, max: 3 })).map(([s, n]) => new Begin(s, n)),
  fc.constant(new Acknowledge()),
  fc.tuple(fc.integer({ min: 1, max: 3 }), fc.boolean()).map(([n, fails]) => new Cancel(n, fails)),
  fc.boolean().map(queued => new CancelAtStarting(queued)),
  fc.tuple(fc.constantFrom<Terminal>("ack", "exit", "error", "silence"), fc.integer({ min: 1, max: 3 })).map(([t, n]) => new Stop(t, n)),
  fc.boolean().map(fails => new Fault(fails)),
  fc.constantFrom<"dismiss" | "retry">("dismiss", "retry").map(action => new Recover(action)),
  fc.constant(new BufferedEvents())
];
const originalPlatform = process.platform;
const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  if (resourcesPath === undefined) delete (process as { resourcesPath?: string }).resourcesPath;
  else (process as { resourcesPath?: string }).resourcesPath = resourcesPath;
});
function resetWorld(platform: string, scheduler: fc.Scheduler): void {
  vi.useFakeTimers(); vi.clearAllTimers(); vi.setSystemTime(0);
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  (process as { resourcesPath?: string }).resourcesPath = "/fake";
  world.platform = platform; world.scheduler = scheduler;
  world.issuing = 0; world.nextRequest = 0; world.nextId = 0; world.state = { phase: "idle" };
  world.children = []; world.callbackErrors = []; world.directories.clear(); world.originals.clear(); world.adopted.clear(); world.rows.clear(); world.published.clear();
  world.terminal = "ack"; world.cleanupRejects = false; world.onStarting = null;
}
async function runHistory(platform: string, scheduler: fc.Scheduler, commands: Iterable<fc.AsyncCommand<Model, Real>>): Promise<void> {
  resetWorld(platform, scheduler);
  const { getRecordingService, __setRecordingServiceForTests } = await import("../recording-service");
  __setRecordingServiceForTests(null);
  const real: Real = { service: getRecordingService(), scheduler, starts: [] };
  const model: Model = { mode: "idle", owner: null, terminal: "idle", saved: new Set(), retryable: false };
  try {
    await fc.asyncModelRun(() => ({ model, real }), commands);
    if (model.mode === "starting" || model.mode === "recording") await new Cancel(1, false).run(model, real);
    if (model.mode === "failed") await new Recover("dismiss").run(model, real);
    checkOracle(model);
  } finally {
    // Failed/shrinking histories cannot leave fake timers or processes in the
    // next run. No real process, file, Electron window or user data is used.
    for (const child of world.children) child.alive = false;
    vi.clearAllTimers();
  }
}
describe.each(["darwin", "win32"])("RecordingService command model on %s", platform => {
  test("issued commands own all live recorders, settle controls and adopt each saved original once", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.commands(commandArbitraries, { maxCommands: 20 }),
      (scheduler, commands) => runHistory(platform, scheduler, commands)), { numRuns: 100 });
  });
  test("shrunk history: cancel before allocation completion leaves no orphan recorder", async () => {
    await runHistory(platform, fc.schedulerFor(platform === "darwin" ? [1, 2] : [2, 1]),
      [new Begin("allocation", 1), new Cancel(1, false)]);
  });
  test("two Starts before allocation completion admit only one original directory", async () => {
    await runHistory(platform, fc.schedulerFor([1, 2]), [new Begin("allocation", 2)]);
  });
  test("Stop without a stopped acknowledgement settles and retains the original", async () => {
    await runHistory(platform, fc.schedulerFor(Array.from({ length: 20 }, (_, i) => i + 1)),
      [new Begin("recording", 1), new Stop("exit", 1)]);
  });
});


// Mutation checks for the oracle itself: metadata outlives the producer-owned
// pathname for buffered events, but reads and moves must require live bytes.
describe("recording model source availability contract", () => {
  test.each([
    { style: "POSIX", paths: posix, prefix: "/tmp/recording-model-" },
    { style: "Windows", paths: win32, prefix: "C:\\Temp\\recording-model-" }
  ])("allocated $style directories retain ownership when an output filename is joined", async ({ paths, prefix }) => {
    const scheduler = fc.schedulerFor([1]);
    resetWorld("darwin", scheduler);
    world.issuing = ++world.nextRequest;
    const fs = await import("node:fs/promises");
    const dir = await scheduler.waitFor(fs.mkdtemp(prefix));
    expect(dir.startsWith(prefix), "mkdtemp must append to the caller's host-native prefix").toBe(true);
    const output = paths.join(dir, "original.mp4");
    expect(world.directories.get(paths.dirname(output)), "the output's parent is the allocated directory")
      .toEqual({ request: world.issuing, removed: false });
  });
  async function fixture() {
    const scheduler = fc.schedulerFor(Array.from({ length: 20 }, (_, i) => i + 1));
    resetWorld("darwin", scheduler);
    world.issuing = ++world.nextRequest;
    const fs = await import("node:fs/promises");
    const dir = await scheduler.waitFor(fs.mkdtemp(join(tmpdir(), "recording-model-contract-")));
    const child = new RecorderProcess();
    world.children.push(child);
    const path = join(dir, "original.mp4");
    child.open(path);
    child.stdin.write(JSON.stringify({ type: "stop" }));
    await scheduler.waitIdle();
    const source = await import("../../persistence/source-store");
    return { scheduler, fs, dir, child, path, source };
  }
  async function settle<T>(scheduler: fc.Scheduler, invoke: () => Promise<T>): Promise<Outcome<T>> {
    const result = observe(Promise.resolve().then(invoke));
    await flush();
    await scheduler.waitIdle();
    await flush();
    return result;
  }
  test("a removed finalized original cannot be prepared", async () => {
    const f = await fixture();
    await f.fs.rm(f.dir, { recursive: true, force: true });
    const prepared = await settle(f.scheduler, () => f.source.prepareExistingFileAsSource(f.path));
    expect(prepared.error).toBeInstanceOf(Error);
    expect(prepared.error?.message).toContain("unavailable");
    expect(original(f.path)).toMatchObject({ finalized: true, adopted: false });
    expect(world.adopted.size).toBe(0);
  });
  test("removal between preparation and scheduled adoption prevents the move", async () => {
    const f = await fixture();
    const prepared = await f.scheduler.waitFor(f.source.prepareExistingFileAsSource(f.path));
    const adoption = observe(f.source.adoptExistingFileAsSource(prepared));
    await f.fs.rm(f.dir, { recursive: true, force: true });
    await f.scheduler.waitIdle();
    await flush();
    expect(adoption.error).toBeInstanceOf(Error);
    expect(adoption.error?.message).toContain("unavailable");
    expect(original(f.path).adopted).toBe(false);
    expect(world.adopted.size).toBe(0);
  });
  test("an adopted original is unavailable even before its parent is removed", async () => {
    const f = await fixture();
    const prepared = await f.scheduler.waitFor(f.source.prepareExistingFileAsSource(f.path));
    await f.scheduler.waitFor(f.source.adoptExistingFileAsSource(prepared));
    expect(world.directories.get(f.dir)?.removed).toBe(false);
    const readAgain = await settle(f.scheduler, () => f.source.prepareExistingFileAsSource(f.path));
    expect(readAgain.error).toBeInstanceOf(Error);
    expect(readAgain.error?.message).toContain("unavailable");
    const moveAgain = await settle(f.scheduler, () => f.source.adoptExistingFileAsSource(prepared));
    expect(moveAgain.error?.message).toContain("unavailable");
    expect(world.adopted.size).toBe(1);
  });
  test("adoption permits idempotent parent cleanup and late buffered metadata", async () => {
    const f = await fixture();
    const prepared = await f.scheduler.waitFor(f.source.prepareExistingFileAsSource(f.path));
    await f.scheduler.waitFor(f.source.adoptExistingFileAsSource(prepared));
    await f.fs.rm(f.dir, { recursive: true, force: true });
    await f.fs.rm(f.dir, { recursive: true, force: true });
    deliver(() => { original(f.path).finalized = true; f.child.line({ event: "stopped" }); }, "buffered metadata after move");
    await f.scheduler.waitIdle();
    expect(original(f.path)).toMatchObject({ finalized: true, adopted: true });
    expect(world.directories.get(f.dir)?.removed).toBe(true);
    expect(world.callbackErrors).toEqual([]);
    expect(world.adopted.size).toBe(1);
  });
});
