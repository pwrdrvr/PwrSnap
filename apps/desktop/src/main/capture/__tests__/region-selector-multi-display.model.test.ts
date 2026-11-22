import { afterEach, expect, test, vi } from "vitest";
import fc from "fast-check";
import type { ScreenSnapshot } from "../screen-snapshot";
import type { SelectorResult } from "../region-selector";

// Model test for a selector session spanning two displays.
//
// Promise: every frozen snapshot a session acquires — the primary
// display's and each secondary's, including one whose capture lands
// after the session ended — is either handed to exactly one consumer
// (`screenSnapshotId` + `extraSnapshots` of a committed result) or
// released by the selector, exactly once; a handed-over snapshot is
// still alive when the consumer gets it; and every request settles once.
// The oracle is a strict native registry; it knows nothing of the
// selector's surfaces, phases or pick merging.

type Action = {
  kind: "start" | "capture" | "paint" | "clock" | "report" | "commit" | "cancel" | "hide";
  target: number;
  merge: boolean;
  ids: number[];
};

const DISPLAYS = [
  { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 },
  { id: 2, bounds: { x: 1440, y: -100, width: 1920, height: 1080 }, scaleFactor: 1 }
];

const h = vi.hoisted(() => ({
  windows: [] as FakeWindow[],
  registry: new Set<string>(),
  released: new Set<string>(),
  pendingCaptures: [] as Array<() => void>,
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  nextSnapshot: 0,
  scheduler: null as fc.Scheduler | null
}));

type ModeSeen = { screenUrl: string; displayId: number };

class FakeWindow {
  readonly id = 500 + h.windows.length;
  destroyed = false;
  visible = false;
  displayId: number;
  mode: ModeSeen | null = null;
  readonly events = new Map<string, (...args: unknown[]) => void>();
  readonly webContents = {
    id: this.id,
    focus: () => undefined,
    on: () => undefined,
    send: (channel: string, payload: { screenUrl?: string }) => {
      expect(this.destroyed, "a destroyed renderer cannot receive IPC").toBe(false);
      if (channel === "region-selector:mode" && payload.screenUrl !== undefined) {
        const id = payload.screenUrl.replace("pwrsnap-screen://r/", "");
        expect(h.registry.has(id), "a mode signal must name a live snapshot").toBe(true);
        this.mode = { screenUrl: payload.screenUrl, displayId: this.displayId };
      }
    }
  };
  constructor(options: { x: number }) {
    this.displayId = options.x >= 1440 ? 2 : 1;
    h.windows.push(this);
  }
  isDestroyed() { return this.destroyed; }
  isFocused() { return false; }
  on(name: string, callback: (...args: unknown[]) => void) { this.events.set(name, callback); }
  setTitle() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setSimpleFullScreen() {}
  setFullScreen() {}
  isSimpleFullScreen() { return false; }
  setBounds() {}
  setContentBounds() {}
  getBounds() { return DISPLAYS.find((d) => d.id === this.displayId)!.bounds; }
  getContentBounds() { return this.getBounds(); }
  focus() {}
  blur() {}
  moveTop() {}
  show() { this.visible = true; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  destroy() { this.visible = false; this.destroyed = true; this.events.get("closed")?.(); }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
}

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/selector-multi" },
  BrowserWindow: Object.assign(function (options: { x: number }) { return new FakeWindow(options); }, {
    fromId: () => null
  }),
  screen: {
    getAllDisplays: () => DISPLAYS,
    getDisplayNearestPoint: (p: { x: number }) => (p.x >= 1440 ? DISPLAYS[1] : DISPLAYS[0]),
    getDisplayMatching: (b: { x: number }) => (b.x >= 1440 ? DISPLAYS[1] : DISPLAYS[0]),
    getCursorScreenPoint: () => ({ x: 20, y: 20 }),
    screenToDipRect: (_win: unknown, rect: unknown) => rect,
    on: () => undefined,
    removeListener: () => undefined
  },
  globalShortcut: { register: () => true, unregister: () => undefined },
  ipcMain: {
    on: (channel: string, callback: (event: unknown, payload: unknown) => void) => h.listeners.set(channel, callback),
    handle: () => undefined,
    removeHandler: () => undefined,
    removeAllListeners: (channel: string) => h.listeners.delete(channel)
  }
}));
vi.mock("../../window", () => ({ getPreloadPath: () => "/selector-multi/preload.cjs" }));
vi.mock("../../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../../tray", () => ({ hideTrayPopoverIfVisible() {} }));
vi.mock("../../float-over", () => ({ setFloatOverState() {}, ensureFloatOverTopmost() {} }));
vi.mock("../../hotkeys/hotkey-recorder-suspension-instance", () => ({
  hotkeyRecorderSuspension: { registerParticipant() {} }
}));
vi.mock("../window-list", () => ({
  selfPidSet: () => new Set<number>(),
  boundsApproxEqual: () => false,
  listWindowsSnapshot: () =>
    Promise.resolve({
      windows: [
        { windowId: 3, pid: 30, bundleId: "x", appName: "Straddler", title: "S",
          bounds: { x: 1300, y: 100, width: 400, height: 300 }, layer: 0, alpha: 1, isFrontmostInApp: true }
      ],
      frontmostPid: 30,
      frontmostBundleId: "x"
    })
}));
vi.mock("../screen-snapshot", () => ({
  // Every capture completes on the scheduler, so captures interleave with
  // commits, cancels and supersessions in generated orders.
  captureAndRegister: (displayId: number) =>
    h.scheduler!.schedule(Promise.resolve(), `capture:${displayId}`).then(() => {
      const id = `snap-${++h.nextSnapshot}`;
      h.registry.add(id);
      return {
        id, displayId, transport: "png-file",
        acquisition: { sourceBitmapBytes: 0, retainedBitmapBytes: 0, bitmapNormalizeMs: 0,
          mappingWriteBytes: 0, fullScreenPngEncodeCount: 1, fullScreenPngBytes: 1, fullScreenTempFileWriteBytes: 1 }
      } satisfies ScreenSnapshot;
    }),
  releaseSnapshot: (id: string) => {
    expect(h.registry.has(id), `release must own live storage: ${id}`).toBe(true);
    expect(h.released.has(id), `duplicate release: ${id}`).toBe(false);
    h.registry.delete(id);
    h.released.add(id);
    return Promise.resolve();
  },
  readSnapshotForRenderer() {},
  recordSnapshotCanvasUpload() {}
}));

function event(win: FakeWindow) {
  const mainFrame = { processId: 1, routingId: 2 };
  return { sender: { id: win.id, mainFrame, isDestroyed: () => win.destroyed }, senderFrame: mainFrame };
}
async function flush() { for (let i = 0; i < 30; ++i) await Promise.resolve(); }

async function exercise(scheduler: fc.Scheduler, actions: readonly Action[]): Promise<SelectorResult[]> {
  vi.useFakeTimers();
  vi.resetModules();
  Object.assign(h, { windows: [], nextSnapshot: 0, scheduler });
  h.registry.clear(); h.released.clear(); h.listeners.clear();
  const selector = await import("../region-selector");
  const results: SelectorResult[] = [];
  let started = 0;
  const consumed = new Set<string>();
  const consume = (result: SelectorResult) => {
    if (!result.ok) return;
    const ids = [result.screenSnapshotId, ...(result.extraSnapshots ?? []).map((e) => e.screenSnapshotId)];
    for (const id of ids) {
      // Handed over alive, to exactly one consumer.
      expect(h.registry.has(id), `transferred snapshot must be live: ${id}`).toBe(true);
      expect(consumed.has(id), `transferred twice: ${id}`).toBe(false);
      consumed.add(id);
    }
    // Every extra is a different display from the home one.
    const displays = [result.displayId, ...(result.extraSnapshots ?? []).map((e) => e.displayId)];
    expect(new Set(displays).size).toBe(displays.length);
  };
  try {
    selector.preWarmRegionSelector();
    await flush();
    for (const action of actions) {
      const withMode = h.windows.filter((w) => w.mode !== null && !w.destroyed);
      const win = withMode.length > 0 ? withMode[action.target % withMode.length] : undefined;
      if (action.kind === "start") {
        started += 1;
        void selector.pickRegion({ keepPwrSnapChrome: true }).then((result) => {
          results.push(result);
          consume(result);
        });
        await flush();
      } else if (action.kind === "capture") {
        if (scheduler.count()) await scheduler.waitNext(1);
      } else if (action.kind === "paint" && win !== undefined) {
        h.listeners.get("region-selector:painted")?.(event(win), { screenUrl: win.mode!.screenUrl });
      } else if (action.kind === "clock") {
        await vi.advanceTimersByTimeAsync(300);
      } else if (action.kind === "report" && win !== undefined) {
        h.listeners.get("region-selector:picks")?.(event(win), {
          screenUrl: win.mode!.screenUrl,
          picks: action.ids.map((id) => ({ id, rect: { x: 10 + id, y: 10, w: 100, h: 80 } })),
          outputMode: action.merge ? "rectangle" : "windows",
          ...(action.ids.length === 0 && action.merge ? { clearAll: true } : {}),
          ...(action.ids.length === 1 ? { unpick: [3] } : {})
        });
      } else if (action.kind === "commit" && win !== undefined) {
        const extents = action.ids.map((id) => ({ x: 10 + id, y: 10, w: 100, h: 80 }));
        h.listeners.get("region-selector:result")?.(event(win), {
          ok: true,
          screenUrl: win.mode!.screenUrl,
          displayId: win.mode!.displayId,
          // A window straddling the seam, from either side.
          rect: win.mode!.displayId === 1 ? { x: 1300, y: 100, w: 400, h: 300 } : { x: -140, y: 200, w: 400, h: 300 },
          ...(action.merge || extents.length > 1
            ? { extents, extentIds: action.ids, mergePeers: action.merge, outputMode: "windows" }
            : {})
        });
      } else if (action.kind === "cancel" && win !== undefined) {
        h.listeners.get("region-selector:result")?.(event(win), { ok: false, screenUrl: win.mode!.screenUrl });
      } else if (action.kind === "hide") {
        selector.hideSelector();
      }
      await flush();
    }
    // Drain: end whatever is live, let every in-flight capture land, then
    // the consumer releases what it was handed.
    selector.hideSelector();
    await scheduler.waitIdle();
    await vi.advanceTimersByTimeAsync(1000);
    await scheduler.waitIdle();
    await flush();
    expect(results, "every request settles exactly once").toHaveLength(started);
    for (const id of consumed) {
      expect(h.registry.has(id)).toBe(true);
      h.registry.delete(id);
    }
    expect([...h.registry], "every snapshot is released or handed over").toEqual([]);
    return results;
  } finally {
    selector.disposeRegionSelector();
    vi.useRealTimers();
  }
}

const action = fc.record({
  kind: fc.constantFrom<Action["kind"]>(
    "start", "capture", "capture", "capture", "paint", "clock", "report", "report", "commit", "cancel", "hide"
  ),
  target: fc.nat(10),
  merge: fc.boolean(),
  ids: fc.uniqueArray(fc.constantFrom(-1, 3, 4, 5), { maxLength: 3 })
});

const platform = process.platform;
afterEach(() => { Object.defineProperty(process, "platform", { value: platform, configurable: true }); });

test("a commit on the primary of a straddling window hands over both displays' snapshots", async () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  const step = (kind: Action["kind"], extra: Partial<Action> = {}): Action =>
    ({ kind, target: 0, merge: false, ids: [], ...extra });
  const results = await exercise(
    fc.schedulerFor([1, 2]),
    [step("start"), step("capture"), step("clock"), step("capture"), step("clock"), step("commit")]
  );
  expect(results).toHaveLength(1);
  const result = results[0]!;
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.displayId).toBe(1);
  expect(result.extraSnapshots?.map((e) => e.displayId)).toEqual([2]);
});

test("↵ on one display for picks made only on the other releases the unused snapshot", async () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  const step = (kind: Action["kind"], extra: Partial<Action> = {}): Action =>
    ({ kind, target: 0, merge: false, ids: [], ...extra });
  const results = await exercise(fc.schedulerFor([1, 2]), [
    step("start"), step("capture"), step("clock"), step("capture"), step("clock"),
    // The second display picks a window; ↵ lands on the first.
    step("report", { target: 1, ids: [4, 5] }),
    step("commit", { target: 0, merge: true })
  ]);
  const result = results[0]!;
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // Filed under the display the picks are on, with nothing extra; the
  // first display's snapshot was released (the drain's registry check).
  expect(result.displayId).toBe(2);
  expect(result.extraSnapshots).toBeUndefined();
  expect(result.extents).toHaveLength(2);
});

test.each(["darwin", "win32", "linux"])(
  "two-display sessions conserve every snapshot under generated orders (%s)",
  async (targetPlatform) => {
    Object.defineProperty(process, "platform", { value: targetPlatform, configurable: true });
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(action, { minLength: 1, maxLength: 30 }),
        async (scheduler, actions) => {
          await exercise(scheduler, actions);
        }
      ),
      { numRuns: 150 }
    );
  },
  60_000
);
