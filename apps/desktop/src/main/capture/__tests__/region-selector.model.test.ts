import { afterEach, expect, test, vi } from "vitest";
import fc from "fast-check";
import type { ScreenSnapshot } from "../screen-snapshot";
import type { SelectorResult } from "../region-selector";
import type { WindowInfo } from "../window-list";

// Promise: latest admission exclusively owns the screen; every terminal
// invocation settles once; acquired pixels are either retained by that owner,
// transferred to its consumer, or released exactly once. This oracle has no
// access to the selector's resolver, phases, generation counters or caches.
type Outcome = "cancelled" | "destroyed" | "committed";
type Session = {
  ordinal: number;
  outcome?: Outcome;
  visible: boolean;
  frameQueued: boolean;
  frameDelivered: boolean;
  frameFailed: boolean;
  layoutDelivered: boolean;
  committedLayout?: readonly WindowInfo[];
  resolveFrame?: (frame: ScreenSnapshot) => void;
  rejectFrame?: (error: Error) => void;
  results: SelectorResult[];
};
type Mode = { window: FakeWindow; owner: Session; screenUrl: string };
type Action = {
  kind: "start" | "frame" | "fail" | "next" | "paint" | "result" | "hide" | "dispose" | "cleanup" | "clock";
  target: number;
  authentic: boolean;
  commit: boolean;
};

const h = vi.hoisted(() => ({
  windows: [] as FakeWindow[],
  modes: [] as Mode[],
  sessions: [] as Session[],
  current: null as Session | null,
  issuing: null as Session | null,
  protected: false,
  // A strict native registry: duplicate or unknown releases are bugs, as is
  // reading/transferring a snapshot whose backing storage was already freed.
  registry: new Set<string>(),
  released: new Set<string>(),
  shortcuts: new Set<string>(),
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  scheduler: null as fc.Scheduler | null
}));

const bounds = { x: 0, y: 0, width: 1440, height: 900 };
const display = { id: 1, bounds, workArea: bounds, scaleFactor: 1 };
class FakeWindow {
  readonly id = 100 + h.windows.length;
  destroyed = false;
  visible = false;
  mode: Mode | undefined;
  readonly events = new Map<string, (...args: unknown[]) => void>();
  readonly webEvents = new Map<string, (...args: unknown[]) => void>();
  readonly webContents = {
    id: this.id,
    focus: () => undefined,
    on: (name: string, callback: (...args: unknown[]) => void) => this.webEvents.set(name, callback),
    send: (channel: string, payload: { screenUrl?: string }) => {
      expect(this.destroyed, "a destroyed renderer cannot receive IPC").toBe(false);
      if (channel !== "region-selector:mode") return;
      const owner = h.sessions.find((session) => url(session) === payload.screenUrl);
      expect(owner, "mode must name an acquired snapshot").toBeDefined();
      expect(h.registry.has(snapshotId(owner!))).toBe(true);
      expect(owner, "only the latest admission may prepare its renderer").toBe(h.current);
      expect(owner!.outcome).toBeUndefined();
      this.mode = { window: this, owner: owner!, screenUrl: payload.screenUrl! };
      h.modes.push(this.mode);
    }
  };
  constructor() { h.windows.push(this); }
  isDestroyed() { return this.destroyed; }
  on(name: string, callback: (...args: unknown[]) => void) { this.events.set(name, callback); }
  setTitle() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setSimpleFullScreen() {}
  setFullScreen() {}
  isSimpleFullScreen() { return false; }
  setBounds() {}
  setContentBounds() {}
  getBounds() { return bounds; }
  getContentBounds() { return bounds; }
  focus() {}
  blur() {}
  moveTop() {}
  show() { expect(this.destroyed).toBe(false); this.visible = true; }
  hide() { this.visible = false; }
  destroy() { this.visible = false; this.destroyed = true; this.events.get("closed")?.(); }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
}

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/selector-model" },
  BrowserWindow: Object.assign(function () { return new FakeWindow(); }, {
    fromId: (id: number) => id === 7 ? {
      isDestroyed: () => false, getBounds: () => bounds,
      setContentProtection: (on: boolean) => { h.protected = on; }
    } : null
  }),
  screen: {
    getAllDisplays: () => [display], getDisplayNearestPoint: () => display, getDisplayMatching: () => display,
    getCursorScreenPoint: () => ({ x: 20, y: 20 }), screenToDipRect: (_win: unknown, rect: unknown) => rect,
    on: () => undefined, removeListener: () => undefined
  },
  globalShortcut: {
    register: (key: string) => {
      if (h.shortcuts.has(key)) return false;
      h.shortcuts.add(key); return true;
    },
    unregister: (key: string) => h.shortcuts.delete(key)
  },
  ipcMain: {
    on: (channel: string, callback: (event: unknown, payload: unknown) => void) => h.listeners.set(channel, callback),
    handle: () => undefined, removeHandler: () => undefined,
    removeAllListeners: (channel: string) => h.listeners.delete(channel)
  }
}));
vi.mock("../../window", () => ({ getPreloadPath: () => "/selector-model/preload.cjs" }));
vi.mock("../../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../../tray", () => ({ hideTrayPopoverIfVisible() {} }));
vi.mock("../../float-over", () => ({ setFloatOverState() {}, ensureFloatOverTopmost() {} }));
vi.mock("../../hotkeys/hotkey-recorder-suspension-instance", () => ({
  hotkeyRecorderSuspension: { registerParticipant() {} }
}));
vi.mock("../window-list", () => ({
  selfPidSet: () => new Set<number>(), boundsApproxEqual: () => false,
  listWindowsSnapshot: () => {
    const owner = h.issuing!;
    return h.scheduler!.schedule(Promise.resolve({
      windows: layout(owner), frontmostPid: 1000 + owner.ordinal, frontmostBundleId: "example.fixture"
    }), `enumeration:${owner.ordinal}`).then((value) => { owner.layoutDelivered = true; return value; });
  }
}));
vi.mock("../screen-snapshot", () => ({
  captureAndRegister: () => {
    const owner = h.issuing!;
    return new Promise<ScreenSnapshot>((resolve, reject) => {
      owner.resolveFrame = resolve;
      owner.rejectFrame = reject;
    });
  },
  releaseSnapshot: (id: string) => {
    expect(h.registry.delete(id), `release must own live storage: ${id}`).toBe(true);
    expect(h.released.has(id), `duplicate release: ${id}`).toBe(false);
    h.released.add(id);
    return Promise.resolve();
  },
  releaseAllSnapshots: () => {
    for (const id of h.registry) h.released.add(id);
    h.registry.clear();
    return Promise.resolve();
  },
  readSnapshotForRenderer() {}, recordSnapshotCanvasUpload() {}
}));

function snapshotId(session: Session) { return `model-${session.ordinal}`; }
function url(session: Session) { return `pwrsnap-screen://r/${snapshotId(session)}`; }
function frame(session: Session): ScreenSnapshot {
  return {
    id: snapshotId(session), displayId: 1, transport: "png-file",
    acquisition: { sourceBitmapBytes: 0, retainedBitmapBytes: 0, bitmapNormalizeMs: 0,
      mappingWriteBytes: 0, fullScreenPngEncodeCount: 1, fullScreenPngBytes: 10, fullScreenTempFileWriteBytes: 10 }
  };
}
function layout(session: Session): WindowInfo[] {
  return [{ windowId: 42, pid: 1000 + session.ordinal, bundleId: "example.fixture", appName: "Fixture",
    title: "Fixture", bounds: { x: 20, y: 20, width: 400, height: 300 }, layer: 0, alpha: 1, isFrontmostInApp: true }];
}
function event(mode: Mode, authentic = true) {
  const mainFrame = { processId: 1, routingId: 2 };
  return { sender: { id: mode.window.id + (authentic ? 0 : 10000), mainFrame, isDestroyed: () => mode.window.destroyed }, senderFrame: mainFrame };
}
async function flush() { for (let i = 0; i < 20; ++i) await Promise.resolve(); }
function retire(outcome: "cancelled" | "destroyed") {
  if (h.current && !h.current.outcome) h.current.outcome = outcome;
  if (h.current) h.current.visible = false;
  h.current = null;
}
function checkOracle() {
  for (const session of h.sessions) {
    expect(session.results, `terminal settlement for request ${session.ordinal}`).toHaveLength(session.outcome ? 1 : 0);
    const result = session.results[0];
    if (result) {
      expect(result.ok).toBe(session.outcome === "committed");
      if (result.ok) {
        expect(result.screenSnapshotId).toBe(snapshotId(session));
        expect(result.windowListSnapshot).toEqual(session.committedLayout);
      } else expect(result.reason).toBe(session.outcome);
    }
    if (!session.frameDelivered || session.frameFailed) continue;
    const retained = session.outcome === "committed" || h.current === session;
    expect(h.registry.has(snapshotId(session)), `snapshot conservation for ${session.ordinal}`).toBe(retained);
    expect(h.released.has(snapshotId(session))).toBe(!retained);
  }
  const visible = h.windows.filter((win) => win.visible);
  expect(visible.map((win) => win.mode?.owner.ordinal)).toEqual(h.current?.visible ? [h.current.ordinal] : []);
  expect(h.protected).toBe(h.current !== null && !h.current.outcome && !h.current.frameDelivered);
  const selecting = h.current !== null && !h.current.outcome && h.current.frameDelivered && !h.current.frameFailed;
  expect([...h.shortcuts].sort()).toEqual(selecting ? ["Escape", "Return"] : []);
}

async function exercise(scheduler: fc.Scheduler, actions: readonly Action[]) {
  vi.useFakeTimers();
  vi.resetModules();
  Object.assign(h, { windows: [], modes: [], sessions: [], current: null, issuing: null, protected: false, scheduler });
  h.registry.clear(); h.released.clear(); h.shortcuts.clear(); h.listeners.clear();
  const selector = await import("../region-selector");
  try {
    for (const action of actions) {
      const pick = <T>(items: readonly T[]) => items.length ? items[action.target % items.length] : undefined;
      if (action.kind === "start") {
        retire("cancelled");
        const session: Session = { ordinal: h.sessions.length + 1, visible: false, frameQueued: false,
          frameDelivered: false, frameFailed: false, layoutDelivered: false, results: [] };
        h.sessions.push(session); h.current = session; h.issuing = session;
        void selector.pickRegion({ keepPwrSnapChrome: true, protectWindowIds: [7] }).then((result) => session.results.push(result));
        await vi.advanceTimersByTimeAsync(50);
      } else if (action.kind === "frame" || action.kind === "fail") {
        const session = pick(h.sessions.filter((entry) => entry.resolveFrame && !entry.frameQueued));
        if (session) {
          session.frameQueued = true;
          const fail = action.kind === "fail";
          void scheduler.schedule(Promise.resolve(), `${fail ? "fail" : "frame"}:${session.ordinal}`).then(() => {
            session.frameDelivered = true; session.frameFailed = fail;
            if (fail) {
              if (h.current === session && !session.outcome) session.outcome = "destroyed";
              session.rejectFrame!(new Error("native capture failed"));
            } else {
              expect(h.registry.has(snapshotId(session))).toBe(false);
              h.registry.add(snapshotId(session));
              session.resolveFrame!(frame(session));
            }
          });
        }
      } else if (action.kind === "next") {
        if (scheduler.count()) await scheduler.waitNext(1);
      } else if (action.kind === "paint") {
        const mode = pick(h.modes);
        if (mode) {
          if (action.authentic && h.current === mode.owner && !mode.owner.outcome && !mode.window.destroyed) mode.owner.visible = true;
          h.listeners.get("region-selector:painted")?.(event(mode, action.authentic), { screenUrl: mode.screenUrl });
        }
      } else if (action.kind === "result") {
        const mode = pick(h.modes);
        if (mode) {
          if (action.authentic && h.current === mode.owner && !mode.owner.outcome && !mode.window.destroyed) {
            mode.owner.outcome = action.commit ? "committed" : "cancelled";
            if (action.commit) mode.owner.committedLayout = mode.owner.layoutDelivered ? layout(mode.owner) : [];
          }
          h.listeners.get("region-selector:result")?.(event(mode, action.authentic), {
            ok: action.commit, screenUrl: mode.screenUrl, displayId: 1, rect: { x: 20, y: 20, w: 40, h: 40 }
          });
        }
      } else if (action.kind === "cleanup") {
        const session = pick(h.sessions.filter((entry) => entry.results.length));
        if (session) {
          if (h.current === session) retire("cancelled");
          selector.hideSelector(session.results[0]!.selectorInvocationId);
        }
      } else if (action.kind === "hide") {
        retire("cancelled"); selector.hideSelector();
      } else if (action.kind === "dispose") {
        retire("destroyed"); selector.disposeRegionSelector();
      } else if (action.kind === "clock") {
        if (h.current && !h.current.outcome && h.current.frameDelivered && !h.current.frameFailed) h.current.visible = true;
        await vi.advanceTimersByTimeAsync(250);
      }
      await flush(); checkOracle();
    }
    // Drain every native completion, including stale acquisitions that outlive
    // disposal. The registry is the independent oracle for their final owner.
    retire("destroyed"); selector.disposeRegionSelector();
    for (const session of h.sessions) {
      if (session.resolveFrame && !session.frameQueued) {
        session.frameQueued = true;
        void scheduler.schedule(Promise.resolve(), `drain:${session.ordinal}`).then(() => {
          session.frameDelivered = true; h.registry.add(snapshotId(session)); session.resolveFrame!(frame(session));
        });
      }
    }
    await scheduler.waitIdle(); await flush(); checkOracle();
  } finally {
    selector.disposeRegionSelector();
    vi.useRealTimers();
  }
}

const action = fc.record({
  kind: fc.constantFrom<Action["kind"]>("start", "start", "frame", "frame", "fail", "next", "next", "paint", "result", "hide", "dispose", "cleanup", "clock"),
  target: fc.nat(20), authentic: fc.boolean(), commit: fc.boolean()
});
const platform = process.platform;
afterEach(() => { Object.defineProperty(process, "platform", { value: platform, configurable: true }); });

test("a second admission settles the previous request before either native capture returns", async () => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  const start: Action = { kind: "start", target: 0, authentic: true, commit: false };
  await exercise(fc.schedulerFor([1, 2, 3, 4]), [start, start]);
});

test.each(["darwin", "win32", "linux"])("generated selector sessions conserve ownership under scheduled completions (%s)", async (targetPlatform) => {
  Object.defineProperty(process, "platform", { value: targetPlatform, configurable: true });
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.array(action, { minLength: 1, maxLength: 35 }), exercise), { numRuns: 100 });
});
