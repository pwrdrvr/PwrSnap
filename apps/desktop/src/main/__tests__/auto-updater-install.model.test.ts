import { EventEmitter } from "node:events";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import fc from "fast-check";
import type { AppUpdateInstallResult, UpdateChannel } from "@pwrsnap/shared";

const fixture = vi.hoisted(() => ({
  events: new Map<string, Set<(...args: unknown[]) => void>>(),
  native: new Map<string, Set<(...args: unknown[]) => void>>(),
  check: vi.fn(),
  install: vi.fn(),
  write: vi.fn(),
  feed: vi.fn()
}));
vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.0", getPath: () => "" },
  autoUpdater: {
    once(event: string, handler: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        fixture.native.get(event)?.delete(wrapped);
        handler(...args);
      };
      (wrapped as { original?: typeof handler }).original = handler;
      const listeners = fixture.native.get(event) ?? new Set();
      listeners.add(wrapped);
      fixture.native.set(event, listeners);
    },
    removeListener(event: string, handler: (...args: unknown[]) => void) {
      for (const listener of fixture.native.get(event) ?? []) {
        if (listener === handler || (listener as { original?: typeof handler }).original === handler) {
          fixture.native.get(event)?.delete(listener);
        }
      }
    }
  }
}));
vi.mock("electron-updater", () => ({ default: { autoUpdater: {
  currentVersion: { version: "1.0.0" },
  checkForUpdates: fixture.check,
  quitAndInstall: fixture.install,
  setFeedURL: fixture.feed,
  on(event: string, handler: (...args: unknown[]) => void) {
    const listeners = fixture.events.get(event) ?? new Set();
    listeners.add(handler);
    fixture.events.set(event, listeners);
  },
  removeListener(event: string, handler: (...args: unknown[]) => void) {
    fixture.events.get(event)?.delete(handler);
  }
} } }));
vi.mock("../update-release-state", async (original) => ({
  ...await original<typeof import("../update-release-state")>(),
  createUpdateReleaseStateStore: () => ({
    read: async () => ({ schemaVersion: 1, firstSeenAt: 0, lastAttemptAt: null,
      retryAt: null, rateLimitResetAt: null, failures: 0, cache: null }),
    write: async () => undefined
  })
}));
vi.mock("../update-install-attempt-store", () => ({
  createAppUpdateInstallAttemptStore: () => ({
    read: () => undefined, clear: () => {}, filePath: () => "", write: fixture.write
  })
}));
vi.mock("../mac-shipit-diagnostics", () => ({ readMacShipItDiagnostics: () => undefined }));
vi.mock("../events", () => ({ broadcastRendererEventToLocalWindows: () => {} }));
vi.mock("../process-split/event-relay", () => ({ relayRendererEventToPeer: () => {} }));
vi.mock("../log", () => ({ getMainLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function emit(event: string, ...args: unknown[]) {
  for (const handler of [...fixture.events.get(event) ?? []]) handler(...args);
}
type Target = { version: string; channel: UpdateChannel };
type Outcome = "ok" | "error" | "throw" | "cancel";
type Hook = {
  gate: ReturnType<typeof deferred<void>>;
  finished: ReturnType<typeof deferred<void>>;
  invoke: (onInstallFailed?: () => void) => void;
  existingObservers: Set<(...args: unknown[]) => void>;
  promise?: Promise<AppUpdateInstallResult>;
  observer: ((...args: unknown[]) => void) | undefined;
};
let updater: typeof import("../auto-updater");
let barrier: typeof import("../sizzle/sizzle-close-barrier");
const originalPlatform = process.platform;
const originalFetch = globalThis.fetch;
const originalEnv = process.env.NODE_ENV;
beforeAll(async () => {
  updater = await import("../auto-updater");
  barrier = await import("../sizzle/sizzle-close-barrier");
});
afterEach(() => {
  updater.disposeAutoUpdater();
  Object.defineProperty(process, "platform", { value: originalPlatform });
  globalThis.fetch = originalFetch;
  process.env.NODE_ENV = originalEnv;
});

/** The oracle is the native boundary, not updateStatus or private updater state.
 * Native install must name the payload actually staged, for the live selection.
 * The real Sizzle barrier supplies accepted/stale close-response semantics. */
class Real {
  channel: UpdateChannel = "latest";
  published = "1.0.1";
  staged = "";
  hooks: Hook[] = [];
  calls: number[] = [];
  notifications: number[] = [];
  outcome: Outcome = "ok";
  executing = -1;
  requestId = 0;
  windowEvents = new EventEmitter();
  contentsEvents = new EventEmitter();
  window = {
    id: 748,
    isDestroyed: () => false,
    on: (event: string, handler: (...args: unknown[]) => void) => this.windowEvents.on(event, handler),
    webContents: {
      isDestroyed: () => false,
      on: (event: string, handler: (...args: unknown[]) => void) => this.contentsEvents.on(event, handler),
      send: (_event: string, message: { requestId: number }) => { this.requestId = message.requestId; }
    },
    close: () => this.windowEvents.emit("close", { preventDefault() {} })
  };

  async boot(version: string) {
    this.published = version;
    updater.initAppUpdater(() => ({ train: "stable", channel: this.channel }));
    await updater.checkForAppUpdatesNow("startup");
    await this.completeDownload();
  }
  async completeDownload() {
    this.staged = this.published;
    emit("update-downloaded", { version: this.published });
    this.download.resolve([]);
    for (const handler of [...fixture.native.get("update-downloaded") ?? []]) handler();
    await this.download.promise;
  }
  download = deferred<string[]>();

  async start() {
    const promise = updater.installDownloadedAppUpdate();
    // Let the synchronously reserved request enter the injected shutdown hook.
    // These are microtask checkpoints, not elapsed-time/network assumptions.
    await Promise.resolve();
    await Promise.resolve();
    return { promise };
  }
  async finish(id: number, outcome: Outcome, reject = false) {
    const hook = this.hooks[id]!;
    this.outcome = outcome;
    if (reject) hook.gate.reject(new Error("shutdown preparation failed"));
    else hook.gate.resolve();
    await hook.finished.promise;
    await hook.promise;
  }
  cancel() {
    return barrier.completeSizzleCloseRequest(this.window.id, this.requestId, "cancel");
  }
  async close() {
    updater.disposeAutoUpdater();
    for (const hook of this.hooks) hook.gate.resolve();
    await Promise.all(this.hooks.map((hook) => hook.finished.promise));
    this.windowEvents.emit("closed");
  }
}

async function createReal(platform: "darwin" | "win32") {
  process.env.NODE_ENV = "production";
  Object.defineProperty(process, "platform", { value: platform });
  updater.disposeAutoUpdater();
  fixture.events.clear();
  fixture.native.clear();
  fixture.write.mockReset();
  fixture.install.mockReset();
  const real = new Real();
  const release = () => ({ tag_name: `v${real.published}`, draft: false, prerelease: false, assets: [
    { name: "latest-mac.yml", state: "uploaded" },
    { name: `PwrSnap-${real.published}-universal-mac.zip`, state: "uploaded" },
    { name: "latest.yml", state: "uploaded" },
    { name: `PwrSnap-${real.published}-windows-x64-setup.exe`, state: "uploaded" }
  ] });
  globalThis.fetch = vi.fn(async (input) => ({ ok: true, json: async () =>
    String(input).endsWith("/latest") ? release() : [release()]
  })) as unknown as typeof fetch;
  fixture.check.mockImplementation(async () => {
    real.download = deferred<string[]>();
    emit("update-available", { version: real.published });
    return { updateInfo: { version: real.published }, downloadPromise: real.download.promise };
  });
  fixture.install.mockImplementation(() => {
    const attempt = fixture.write.mock.lastCall?.[0] as { expectedVersion: string; channel: UpdateChannel } | undefined;
    expect(attempt).toMatchObject({ expectedVersion: real.staged, channel: real.channel });
    expect(real.executing).toBeGreaterThanOrEqual(0);
    real.calls.push(real.executing);
    const hook = real.hooks[real.executing]!;
    hook.observer = [...fixture.events.get("error")!].find((listener) => !hook.existingObservers.has(listener));
    if (real.outcome === "throw") throw new Error("native failure");
    if (real.outcome === "error") emit("error", new Error("native failure"));
    else {
      real.window.close();
      if (real.outcome === "cancel") real.cancel();
    }
  });
  await real.boot("1.0.1");
  barrier.wireSizzleCloseBarrier(real.window as unknown as import("electron").BrowserWindow);
  barrier.markSizzleCloseRendererReady(real.window.id);
  updater.setAppUpdateInstallHandler(async (invoke) => {
    const id = real.hooks.length;
    const hook: Hook = { gate: deferred(), finished: deferred(), invoke, observer: undefined,
      existingObservers: new Set(fixture.events.get("error")) };
    real.hooks.push(hook);
    try {
      await hook.gate.promise;
      real.executing = id;
      invoke(() => real.notifications.push(id));
    } finally {
      real.executing = -1;
      hook.finished.resolve();
    }
  });
  return real;
}

// Independent promise: a Restart intent leases one staged payload. That lease
// survives deferral, ends on explicit abandonment, and never permits a second
// native call for the same intent. No UI projection participates in this model.
type Model = {
  payload: Target;
  channel: UpdateChannel;
  intents: Target[];
  owner: number | undefined;
  waiting: number[];
  native: number[];
  abandoned: number[];
  serial: number;
};
type Action = "restart" | "finish" | "reject" | "error" | "cancel" | "select" | "publish" | "reboot" | "stale" | "repeat";
class Step implements fc.AsyncCommand<Model, Real> {
  constructor(readonly action: Action, readonly index = 0, readonly outcome: Outcome = "ok") {}
  check(m: Readonly<Model>) {
    if (this.action === "finish" || this.action === "reject") return m.waiting.length > 0;
    if (this.action === "cancel") return m.owner !== undefined && m.native.includes(m.owner);
    if (this.action === "stale") return m.native.some((id) => id !== m.owner);
    if (this.action === "repeat") return m.native.length > 0;
    return true;
  }
  async run(m: Model, r: Real) {
    if (this.action === "restart") {
      const owner = m.owner;
      const { promise } = await r.start();
      if (owner !== undefined) expect(promise).toBe(r.hooks[owner]!.promise);
      else if (m.channel === m.payload.channel) {
        const id = m.intents.length;
        m.owner = id;
        m.intents.push({ ...m.payload });
        m.waiting.push(id);
        r.hooks[id]!.promise = promise;
      } else await expect(promise).resolves.toMatchObject({ status: "error" });
    } else if (this.action === "finish" || this.action === "reject") {
      const id = m.waiting.splice(this.index % m.waiting.length, 1)[0]!;
      const target = m.intents[id]!;
      const valid = m.owner === id && target.channel === m.channel &&
        target.channel === m.payload.channel && target.version === m.payload.version;
      if (valid && this.action === "finish") {
        m.native.push(id);
        if (this.outcome !== "ok") { m.abandoned.push(id); m.owner = undefined; }
      } else if (m.owner === id) m.owner = undefined;
      await r.finish(id, this.outcome, this.action === "reject");
    } else if (this.action === "error" || this.action === "cancel") {
      if (m.owner !== undefined && m.native.includes(m.owner)) {
        m.abandoned.push(m.owner);
        m.owner = undefined;
      }
      if (this.action === "error") emit("error", new Error("late native failure"));
      else expect(r.cancel()).toBe(true);
    } else if (this.action === "select") {
      m.channel = m.channel === "latest" ? "prerelease" : "latest";
      r.channel = m.channel;
      updater.reconcileAppUpdateSelection();
    } else if (this.action === "publish" || this.action === "reboot") {
      const version = `1.0.${++m.serial}`;
      if (this.action === "reboot") {
        updater.disposeAutoUpdater();
        m.owner = undefined;
        r.channel = m.channel = "latest";
        await r.boot(version);
      } else {
        r.published = version;
        await updater.checkForAppUpdatesNow("manual");
        await r.completeDownload();
      }
      m.payload = { version, channel: m.channel };
    } else {
      const choices = this.action === "stale" ? m.native.filter((id) => id !== m.owner) : m.native;
      const id = choices[this.index % choices.length]!;
      if (this.action === "stale") r.hooks[id]!.observer?.(new Error("obsolete native failure"));
      else r.hooks[id]!.invoke(() => { throw new Error("duplicate handoff notified diagnostics"); });
    }
    expect(r.hooks).toHaveLength(m.intents.length);
    expect(r.calls).toEqual(m.native);
    expect(r.notifications).toEqual(m.abandoned);
    for (const id of m.native.filter((id) => id !== m.owner)) {
      const observer = r.hooks[id]!.observer;
      if (observer) expect(fixture.events.get("error")?.has(observer)).toBe(false);
    }
  }
  toString() { return `${this.action}(${this.index},${this.outcome})`; }
}

const steps = fc.commands([
  fc.constant(new Step("restart")),
  fc.tuple(fc.nat(), fc.constantFrom<Outcome>("ok", "error", "throw", "cancel")).map(([i, outcome]) => new Step("finish", i, outcome)),
  fc.nat().map((i) => new Step("reject", i)),
  ...(["error", "cancel", "select", "publish", "reboot"] as const).map((action) => fc.constant(new Step(action))),
  fc.nat().map((i) => new Step("stale", i)),
  fc.nat().map((i) => new Step("repeat", i))
], { maxCommands: 40 });

test.each(["darwin", "win32"] as const)("Restart leases obey the native boundary oracle across generated sessions on %s", async (platform) => {
  await fc.assert(fc.asyncProperty(steps, async (commands) => {
    const real = await createReal(platform);
    try {
      await fc.asyncModelRun((): { model: Model; real: Real } => ({ model: {
        payload: { version: "1.0.1", channel: "latest" }, channel: "latest",
        intents: [], owner: undefined, waiting: [], native: [], abandoned: [], serial: 1
      }, real }), commands);
    } finally { await real.close(); }
  }), { numRuns: 100 });
});

test("scheduled duplicate requests and shutdown completion share one native handoff until failure", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.integer({ min: 2, max: 6 }), async (scheduler, clicks) => {
    const real = await createReal("darwin");
    updater.setAppUpdateInstallHandler(async (install) => {
      const id = real.hooks.length;
      real.hooks.push({ gate: deferred(), finished: deferred(), invoke: install, observer: undefined,
        existingObservers: new Set(fixture.events.get("error")) });
      await scheduler.schedule(Promise.resolve(), `shutdown ready ${id}`);
      real.executing = id;
      try { install(() => real.notifications.push(id)); }
      finally { real.hooks[id]!.finished.resolve(); real.executing = -1; }
    });
    try {
      // Schedule independent click/readiness completions, not the returned
      // install promises (which themselves depend on scheduled readiness).
      const restart = () => scheduler.schedule(Promise.resolve(), "Restart click")
        .then(() => updater.installDownloadedAppUpdate());
      const first = Array.from({ length: clicks }, () => restart());
      await scheduler.waitFor(Promise.all(first));
      expect(real.calls).toEqual([0]);
      emit("error", new Error("late native failure"));
      expect(real.notifications).toEqual([0]);
      const second = Array.from({ length: clicks }, () => restart());
      await scheduler.waitFor(Promise.all(second));
      expect(real.calls).toEqual([0, 1]);
      expect(real.notifications).toEqual([0]);
    } finally { await real.close(); }
  }), { numRuns: 100 });
});
