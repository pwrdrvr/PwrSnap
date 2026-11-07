// Model test: random user sessions against the real auto-updater on Windows.
// Ported from PwrGit's auto-updater.held-update.property.test.ts
// (pwrdrvr/PwrGit#554). The held-download logic is shared across the Pwr
// family, and fixes have moved between the apps in both directions (#745 →
// PwrGit#467).
//
// fast-check generates sessions of the commands below and runs each on the
// real `auto-updater.ts` (fresh module per run, fake timers, stubbed fetch).
// Only electron-updater is faked, with the behaviour of electron-updater
// 6.8.x's source (AppUpdater, BaseUpdater, DownloadedUpdateHelper):
//
//   - There is ONE pending cache dir for every track.
//   - Starting a download of a different version empties it, deleting the
//     installer already downloaded (`getValidCachedUpdateFile` sees a sha512
//     mismatch and calls `cleanCacheDirForPendingUpdate`).
//   - `downloadedUpdateHelper.file` still names that deleted installer until
//     a download failure calls `clear()`.
//   - The quit handler is added when a download lands with install-on-quit
//     on; on quit it runs `file` if install-on-quit is on then.
//   - A check while a download runs emits `update-available` for whatever the
//     feed now says, and hands back the download ALREADY running
//     ("Downloading update (already in progress)"), with a cancellation token
//     wired to nothing.
//
// The reference model is `newestEligible(feed, train)`: the release a check
// should offer. Invariants, after every command:
//
//   I1  A shown "Restart to vX" means vX's installer is on disk.
//   I2  Install-on-quit armed means the installer it would run is on disk.
//   I3  Restart runs only an installer that is on disk, and only the one the
//       button named.
//   I4  A completed manual check offers newestEligible: as an update when it
//       is newer than the running build, and as a switch back when it is older
//       (#435). A held switch-back is kept rather than replaced.
//   I5  Automatic release-list requests keep the persisted budget across
//       restarts (#671): ten minutes after first launch, then hourly.
//   I6  electron-updater is never asked to check while it is downloading.
//   I7  Cancel, offered on a running download, stops that download.
//
// I1–I5 are PwrGit's. I6 is PwrGit's fake raising misuse, and I7 is added
// here because PwrSnap's check returns before its download ends, so Check can
// be clicked mid-download. Against the code before each fix, 10 seeds each,
// with the other invariants off so each counts only its own:
//   - before #745 (a download ended every check) I4 failed within 26–343 runs;
//   - before #671 (no persisted budget) I5 failed within 1–3 runs, shrunk to
//     a single `restart`;
//   - on main before the PR that added this file, I1 failed within 3–36 runs
//     (another track's download deleted the held installer) and I7 within 1–9
//     (Check mid-download left Cancel holding a dead token).
// The examples at the bottom are those shrunk sequences.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppUpdateCheckResult, AppUpdateStatus } from "@pwrsnap/shared";
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  APP_UPDATE_FIRST_CHECK_DELAY_MS
} from "../update-release-state";

type Handler = (...args: unknown[]) => void;
type Pending = {
  version: string;
  promise: Promise<string[]>;
  resolve: (files: string[]) => void;
  reject: (err: Error) => void;
};

const fake = vi.hoisted(() => {
  // Captured before the fake timers are installed.
  const macrotask = globalThis.setImmediate;
  /** Semver precedence for this file's tag pool: `X.Y.Z[-kind.N]`. */
  function compare(a: string, b: string): number {
    const parse = (v: string) => {
      const [core, pre] = v.replace(/^v/, "").split("-");
      return { core: core!.split(".").map(Number), pre };
    };
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < 3; i++) {
      if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
    }
    if (x.pre === y.pre) return 0;
    if (x.pre === undefined) return 1;
    if (y.pre === undefined) return -1;
    const [xk, xn] = x.pre.split(".");
    const [yk, yn] = y.pre.split(".");
    return xk !== yk ? (xk! < yk! ? -1 : 1) : Number(xn) - Number(yn);
  }

  const handlers = new Map<string, Set<Handler>>();
  const emit = (event: string, ...args: unknown[]): void => {
    for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
  };

  /** One process's electron-updater, plus the disk that outlives it. */
  const state = {
    userData: "",
    /** The running app's version. */
    current: "1.0.0",
    /** Installers in the one pending cache dir. Survives restarts. */
    disk: new Set<string>(),
    /** `downloadedUpdateHelper.file`: may name a deleted installer. */
    file: undefined as string | undefined,
    quitHandlerAdded: false,
    feedTag: undefined as string | undefined,
    pending: undefined as Pending | undefined,
    /** Every installer `quitAndInstall` ran: its file, and whether it existed. */
    ran: [] as Array<{ file: string | undefined; onDisk: boolean }>,
    /** The status the renderer last received, i.e. what Settings shows. */
    shown: undefined as AppUpdateStatus | undefined,
    /** The trigger of the check that logged last, consumed by the release
     *  read it makes. A read nobody logged for counts as automatic. */
    lastCheckTrigger: undefined as string | undefined,
    /** Misuse of electron-updater the fake caught. A throw alone would be
     *  swallowed by a background check's catch. */
    violations: [] as string[]
  };

  function landed(version: string): void {
    state.disk.add(version);
    state.file = version;
    emit("update-downloaded", { version });
    if (autoUpdater.autoInstallOnAppQuit) state.quitHandlerAdded = true;
  }

  const autoUpdater = {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: undefined as unknown,
    get currentVersion() {
      return { version: state.current };
    },
    setFeedURL: ({ url }: { url: string }) => {
      state.feedTag = decodeURIComponent(/\/download\/([^/]+)\/$/.exec(url)![1]!);
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, (handlers.get(event) ?? new Set()).add(handler));
    },
    removeListener: (event: string, handler: Handler) => {
      handlers.get(event)?.delete(handler);
    },
    checkForUpdates: async () => {
      if (state.pending) {
        state.violations.push(
          `electron-updater checked ${state.feedTag} while ${state.pending.version} downloads`
        );
      }
      emit("checking-for-update");
      const version = state.feedTag!.replace(/^v/, "");
      const order = compare(version, state.current);
      if (order === 0 || (order < 0 && !autoUpdater.allowDowngrade)) {
        emit("update-not-available", { version });
        return { isUpdateAvailable: false, updateInfo: { version } };
      }
      emit("update-available", { version });
      let downloadPromise: Promise<string[]>;
      // A token only the download started with it ever reads.
      let cancel = (): void => undefined;
      if (state.pending) {
        // `downloadUpdate` while `downloadPromise` is set: the running
        // download continues, whatever version this check found, and never
        // sees this check's token.
        downloadPromise = state.pending.promise;
      } else if (state.disk.has(version)) {
        // A valid cached installer: no download. It still lands after file
        // I/O (`validateDownloadedPath` hashes it), not within this call.
        downloadPromise = new Promise((resolve) => macrotask(resolve)).then(() => {
          landed(version);
          return [];
        });
      } else {
        // The sha512 mismatch empties the one cache dir. `file` goes stale.
        state.disk.clear();
        let resolve!: (files: string[]) => void;
        let reject!: (err: Error) => void;
        const promise = new Promise<string[]>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        const pending = { version, promise, resolve, reject };
        state.pending = pending;
        downloadPromise = promise;
        cancel = () => {
          // The abort lands after the request notices it, not inside cancel().
          macrotask(() => {
            if (state.pending !== pending) return;
            state.pending = undefined;
            // `executeDownload`'s catch: `removeFileIfAny` → `clear()`.
            state.file = undefined;
            state.disk.clear();
            emit("update-cancelled", { version });
            reject(Object.assign(new Error("cancelled"), { name: "CancellationError" }));
          });
        };
      }
      return {
        isUpdateAvailable: true,
        updateInfo: { version },
        cancellationToken: { cancel },
        downloadPromise
      };
    },
    quitAndInstall: () => {
      state.ran.push({
        file: state.file,
        onDisk: state.file !== undefined && state.disk.has(state.file)
      });
    }
  };

  return {
    compare,
    macrotask,
    state,
    /** The userData files, by path: see the `node:fs` mocks. */
    files: new Map<string, string>(),
    autoUpdater,
    downloadSucceeds(): void {
      const pending = state.pending!;
      state.pending = undefined;
      landed(pending.version);
      pending.resolve([]);
    },
    downloadFails(): void {
      const pending = state.pending!;
      state.pending = undefined;
      // `executeDownload`'s catch: `downloadedUpdateHelper.clear()`.
      state.file = undefined;
      state.disk.clear();
      const err = new Error("network failed");
      emit("error", err);
      pending.reject(err);
    },
    /** A new process: electron-updater's memory is gone, the disk is not. */
    newProcess(current: string): void {
      handlers.clear();
      state.current = current;
      state.file = undefined;
      state.quitHandlerAdded = false;
      state.feedTag = undefined;
      state.pending = undefined;
      state.shown = undefined;
      state.lastCheckTrigger = undefined;
      autoUpdater.allowDowngrade = false;
      autoUpdater.autoInstallOnAppQuit = false;
    }
  };
});

// Speed, not behaviour: a run relaunches the module several times.
//
// - `@pwrsnap/shared` is the real module, loaded once. A mocked module
//   survives `vi.resetModules()`, so relaunches skip re-evaluating it.
// - The userData files live in memory: the release-state file
//   (`node:fs/promises`) and the install-attempt file (`node:fs`). Both stores
//   still parse, validate and save them, and they still outlive a relaunch,
//   which is what I5 and the boot-time install check need. Their real-disk
//   behaviour is covered by auto-updater-restarts.test.ts and
//   update-install-attempt-store.test.ts. Every other path goes to disk.
vi.mock("@pwrsnap/shared", async (importOriginal) => await importOriginal());
const enoent = (path: unknown) =>
  Object.assign(new Error(`ENOENT: ${String(path)}`), { code: "ENOENT" });
const mine = (path: unknown) =>
  fake.state.userData !== "" && String(path).startsWith(fake.state.userData);
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const files = fake.files;
  type Name = "mkdir" | "readFile" | "writeFile" | "rename" | "rm";
  const route = <K extends Name>(name: K, inMemory: (...args: unknown[]) => unknown) =>
    (async (...args: unknown[]) =>
      mine(args[0]) ? inMemory(...args) : Reflect.apply(real[name], real, args)
    ) as unknown as (typeof real)[K];
  const fs = {
    ...real,
    mkdir: route("mkdir", () => undefined),
    readFile: route("readFile", (path) => {
      const data = files.get(String(path));
      if (data === undefined) throw enoent(path);
      return data;
    }),
    writeFile: route("writeFile", (path, data) => void files.set(String(path), String(data))),
    rename: route("rename", (from, to) => {
      const data = files.get(String(from));
      if (data === undefined) throw enoent(from);
      files.set(String(to), data);
      files.delete(String(from));
    }),
    rm: route("rm", (path) => void files.delete(String(path)))
  };
  return { ...fs, default: fs };
});
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const files = fake.files;
  type Name = "existsSync" | "readFileSync" | "writeFileSync" | "renameSync" | "rmSync";
  const route = <K extends Name>(name: K, inMemory: (...args: unknown[]) => unknown) =>
    ((...args: unknown[]) =>
      mine(args[0]) ? inMemory(...args) : Reflect.apply(real[name], real, args)
    ) as unknown as (typeof real)[K];
  const fs = {
    ...real,
    existsSync: route("existsSync", (path) => files.has(String(path))),
    readFileSync: route("readFileSync", (path) => {
      const data = files.get(String(path));
      if (data === undefined) throw enoent(path);
      return data;
    }),
    writeFileSync: route("writeFileSync", (path, data) => void files.set(String(path), String(data))),
    renameSync: route("renameSync", (from, to) => {
      files.set(String(to), files.get(String(from))!);
      files.delete(String(from));
    }),
    rmSync: route("rmSync", (path) => void files.delete(String(path)))
  };
  return { ...fs, default: fs };
});
vi.mock("electron", () => ({
  app: {
    getVersion: () => fake.state.current,
    getPath: () => fake.state.userData
  },
  autoUpdater: undefined
}));
vi.mock("electron-updater", () => ({ default: { autoUpdater: fake.autoUpdater } }));
vi.mock("../events", () => ({
  broadcastRendererEventToLocalWindows: (channel: string, payload: unknown) => {
    if (channel === "events:app-update:status") fake.state.shown = payload as AppUpdateStatus;
  }
}));
vi.mock("../process-split/event-relay", () => ({ relayRendererEventToPeer: () => undefined }));
vi.mock("../log", () => ({
  getMainLogger: () => ({
    info: (message: unknown, meta?: { trigger?: string }) => {
      if (message === "checking for app updates") fake.state.lastCheckTrigger = meta?.trigger;
    },
    warn() {},
    error() {},
    debug() {}
  })
}));

type Train = "stable" | "beta";
type Updater = typeof import("../auto-updater");

/** Already published when the app first launches; the installed version. */
const BASELINE = "v1.0.0";
/** Every tag a session can publish. The alpha and `-prerelease` are never
 *  eligible on a Latest track; they are there to be ignored. */
const TAG_POOL = [
  "v1.0.1",
  "v1.0.2",
  "v1.1.0",
  "v1.1.0-beta.1",
  "v1.1.0-beta.2",
  "v1.2.0-beta.1",
  "v1.1.0-alpha.1",
  "v1.0.3-prerelease.1"
] as const;

const coreOf = (tag: string) => tag.replace(/^v/, "").split("-")[0]!;
const maxTag = (tags: string[]) => [...tags].sort(fake.compare).at(-1)!;

/** The release a check on `train`'s Latest track should offer: Stable Latest
 *  is the newest final; Beta Latest is the newest `-beta.N` of a core newer
 *  than Stable Latest, else Stable Latest. */
function newestEligible(feed: ReadonlySet<string>, train: Train): string {
  const tags = [...feed];
  const stable = maxTag(tags.filter((tag) => !tag.includes("-")));
  if (train === "stable") return stable.slice(1);
  const betas = tags.filter(
    (tag) => /-beta\.\d+$/.test(tag) && fake.compare(coreOf(tag), coreOf(stable)) > 0
  );
  return maxTag([stable, ...betas]).slice(1);
}

type Model = { feed: Set<string>; train: Train; downloading: boolean };

type ManualCheck = {
  target: string;
  current: string;
  /** Started with no download running, so it read the feed itself. */
  ownCheck: boolean;
  /** A switch-back already shown when the click landed: the check keeps it. */
  heldDowngrade: string | undefined;
  result?: AppUpdateCheckResult;
  error?: unknown;
  judged?: boolean;
};

/** Let the updater run until it waits on the user or the clock. Real
 *  macrotasks drain every queued microtask; the fake's cached landing takes
 *  one turn, and the updater may react to it with another. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn++) {
    await new Promise<void>((resolve) => fake.macrotask(resolve));
  }
}

const RELEASES_URL = "https://api.github.com/repos/pwrdrvr/PwrSnap/releases";

class World {
  updater!: Updater;
  train: Train;
  readonly feed: Set<string>;
  readonly firstSeenAt: number;
  manualChecks: ManualCheck[] = [];
  lastFetchAt: number | undefined;
  readonly budgetViolations: string[] = [];

  constructor(feed: Set<string>, train: Train) {
    this.feed = feed;
    this.train = train;
    // A fresh installation, already due for its first automatic check.
    fake.files.clear();
    this.firstSeenAt = Date.now() - APP_UPDATE_FIRST_CHECK_DELAY_MS;
    fake.files.set(
      join(fake.state.userData, "pwrsnap-update-release-state.json"),
      JSON.stringify({
        schemaVersion: 1, firstSeenAt: this.firstSeenAt, lastAttemptAt: null,
        retryAt: null, rateLimitResetAt: null, failures: 0, cache: null
      })
    );
    fake.state.disk.clear();
    fake.state.ran = [];
    fake.state.violations = [];
  }

  private release(tag: string) {
    const version = tag.slice(1);
    return {
      tag_name: tag,
      draft: false,
      prerelease: version.includes("-"),
      assets: [
        { name: "latest.yml", state: "uploaded" },
        { name: `PwrSnap-${version}-setup.exe`, state: "uploaded" }
      ]
    };
  }

  /** Stands in for GitHub: `/releases/latest`, then one page of the list. */
  fetch = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    let body: unknown;
    if (url === `${RELEASES_URL}/latest`) {
      // Every release read opens with this request, so it is the one the
      // budget counts. The trigger is consumed by it.
      const now = Date.now();
      const trigger = fake.state.lastCheckTrigger;
      fake.state.lastCheckTrigger = undefined;
      if (trigger !== "manual" && trigger !== "menu" && trigger !== "selection") {
        const due = Math.max(
          this.firstSeenAt + APP_UPDATE_FIRST_CHECK_DELAY_MS,
          this.lastFetchAt === undefined ? 0 : this.lastFetchAt + APP_UPDATE_CHECK_INTERVAL_MS
        );
        if (now < due) {
          this.budgetViolations.push(`${trigger ?? "unlogged"} release read ${due - now} ms early`);
        }
      }
      this.lastFetchAt = now;
      body = this.release(maxTag([...this.feed].filter((tag) => !tag.includes("-"))));
    } else if (url.startsWith(`${RELEASES_URL}?`)) {
      body = new URL(url).searchParams.get("page") === "1"
        ? [...this.feed].sort(fake.compare).reverse().map((tag) => this.release(tag))
        : [];
    } else {
      throw new Error(`unexpected fetch ${url}`);
    }
    return {
      headers: new Headers(),
      ok: true,
      status: 200,
      json: async () => body
    } as Response;
  };

  /** Quit, then launch `current`: a new process on the same userData. */
  async launch(current: string): Promise<void> {
    // The old process's timers die with it. Clearing them also rewinds the
    // fake clock to where it started, and the budget is about the clock.
    const now = Date.now();
    vi.clearAllTimers();
    vi.setSystemTime(now);
    fake.newProcess(current);
    this.manualChecks = [];
    vi.resetModules();
    this.updater = await import("../auto-updater");
    this.updater.initAppUpdater(() => ({ train: this.train, channel: "latest" }));
    await settle();
  }
}

type Cmd = fc.AsyncCommand<Model, World>;

function syncModel(model: Model): void {
  model.downloading = fake.state.pending !== undefined;
}

function checkInvariants(world: World): void {
  const { state } = fake;
  if (state.shown?.status === "downloaded") {
    expect(state.disk, `I1: "Restart to v${state.shown.version}" is shown`).toContain(
      state.shown.version
    );
  }
  if (fake.autoUpdater.autoInstallOnAppQuit && state.quitHandlerAdded && state.file) {
    expect(state.disk, `I2: install-on-quit would run v${state.file}`).toContain(state.file);
  }
  for (const check of world.manualChecks) {
    if (check.judged || (check.result === undefined && check.error === undefined)) continue;
    check.judged = true;
    expect(check.error, "I4: a manual check rejected").toBeUndefined();
    if (!check.ownCheck) continue;
    const result = check.result!;
    const offered = `I4: a manual check offered ${JSON.stringify(result)}, newest eligible v${check.target} from v${check.current}`;
    if (check.heldDowngrade !== undefined) {
      expect(result, offered).toEqual({
        status: "downloaded", version: check.heldDowngrade, downgrade: true
      });
      continue;
    }
    const order = fake.compare(check.target, check.current);
    if (order === 0) {
      expect(result, offered).toEqual({ status: "no-update", version: check.current });
    } else {
      expect(["available", "downloaded"], offered).toContain(result.status);
      expect(result, offered).toMatchObject({ version: check.target });
      expect((result as { downgrade?: true }).downgrade === true, offered).toBe(order < 0);
    }
  }
  expect(world.budgetViolations.join("; "), "I5: the persisted request budget").toBe("");
  expect(state.violations.join("; "), "I6: the fake electron-updater").toBe("");
}

async function after(model: Model, world: World): Promise<void> {
  await settle();
  syncModel(model);
  checkInvariants(world);
}

class Publish implements Cmd {
  constructor(readonly tag: string) {}
  check = (m: Readonly<Model>) => !m.feed.has(this.tag);
  async run(m: Model, w: World) {
    m.feed.add(this.tag);
    w.feed.add(this.tag);
    await after(m, w);
  }
  toString = () => `publish(${this.tag})`;
}

/** Settings → Updates: pick a train (Latest track). */
class SelectTrain implements Cmd {
  constructor(readonly train: Train) {}
  check = (m: Readonly<Model>) => m.train !== this.train;
  async run(m: Model, w: World) {
    m.train = this.train;
    w.train = this.train;
    w.updater.handleAppUpdateSelectionChanged();
    await after(m, w);
  }
  toString = () => `selectTrain(${this.train})`;
}

/** Settings → Updates: Check for Updates (`app:update:check`). */
class ClickCheck implements Cmd {
  check = () => true;
  async run(m: Model, w: World) {
    const shown = fake.state.shown;
    const record: ManualCheck = {
      target: newestEligible(m.feed, m.train),
      current: fake.state.current,
      ownCheck: fake.state.pending === undefined,
      heldDowngrade:
        shown?.status === "downloaded" && shown.downgrade === true ? shown.version : undefined
    };
    w.manualChecks.push(record);
    void w.updater.checkForAppUpdatesNow("manual").then(
      (result) => { record.result = result; },
      (error: unknown) => { record.error = error; }
    );
    await after(m, w);
  }
  toString = () => "clickCheck";
}

/** Opening Settings: it reads the status and the release list on mount, and
 *  a release found that way is downloaded (`downloadDiscoveredRelease`). */
class OpenSettings implements Cmd {
  check = () => true;
  async run(m: Model, w: World) {
    w.updater.readAppUpdateStatus();
    void w.updater.readAppUpdateReleaseVersions();
    await after(m, w);
  }
  toString = () => "openSettings";
}

/** The update card's Cancel button (`app:update:cancel`). The card offers it
 *  while the status is `available` or `downloading`. */
class ClickCancel implements Cmd {
  check = (m: Readonly<Model>) => m.downloading;
  async run(m: Model, w: World) {
    const running = fake.state.pending;
    const shown = fake.state.shown?.status;
    const offered = shown === "available" || shown === "downloading";
    const { canceled } = w.updater.cancelAppUpdateDownload();
    await after(m, w);
    if (offered) expect(canceled, `I7: Cancel on a ${shown} card`).toBe(true);
    if (canceled) {
      expect(fake.state.pending, `I7: Cancel reported it stopped v${running!.version}`).not.toBe(
        running
      );
    }
  }
  toString = () => "clickCancel";
}

class DownloadSucceeds implements Cmd {
  check = (m: Readonly<Model>) => m.downloading;
  async run(m: Model, w: World) {
    fake.downloadSucceeds();
    await after(m, w);
  }
  toString = () => "downloadSucceeds";
}

class DownloadFails implements Cmd {
  check = (m: Readonly<Model>) => m.downloading;
  async run(m: Model, w: World) {
    fake.downloadFails();
    await after(m, w);
  }
  toString = () => "downloadFails";
}

/** Leave the app open for an hour: the periodic automatic check runs. */
class CheckAndWait implements Cmd {
  check = () => true;
  async run(m: Model, w: World) {
    await vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL_MS);
    await after(m, w);
  }
  toString = () => "checkAndWait";
}

/** Settings' Restart button (`app:update:install`). Whatever it runs, the
 *  app relaunches into. */
class ClickRestart implements Cmd {
  check = () => true;
  async run(m: Model, w: World) {
    const shown = fake.state.shown;
    const named = shown?.status === "downloaded" ? shown.version : undefined;
    const before = fake.state.ran.length;
    await w.updater.installDownloadedAppUpdate();
    const ran = fake.state.ran.slice(before);
    expect(ran.length, "I3: Restart ran more than one installer").toBeLessThanOrEqual(1);
    if (named === undefined) {
      expect(ran, "I3: Restart ran an installer no button named").toEqual([]);
    } else {
      expect(ran, `I3: "Restart to v${named}"`).toEqual([{ file: named, onDisk: true }]);
    }
    if (ran[0]?.onDisk) await w.launch(ran[0].file!);
    await after(m, w);
  }
  toString = () => "clickRestart";
}

/** Quit and relaunch. Install-on-quit, if armed, installs on the way out. */
class Restart implements Cmd {
  check = () => true;
  async run(m: Model, w: World) {
    const { state } = fake;
    const installs =
      fake.autoUpdater.autoInstallOnAppQuit && state.quitHandlerAdded && state.file !== undefined
        ? state.file
        : undefined;
    // I2 already holds: an armed installer is on disk.
    await w.launch(installs ?? state.current);
    await after(m, w);
  }
  toString = () => "restart";
}

const trainArb = fc.constantFrom<Train>("stable", "beta");
const selectTrainArb = trainArb.map((train) => new SelectTrain(train));
const clickCheckArb = fc.constant(new ClickCheck());
const commandArbs = [
  fc.constantFrom(...TAG_POOL).map((tag) => new Publish(tag)),
  // Twice as likely as the rest: the bugs live where a train switch or a
  // click lands between a download starting and settling.
  selectTrainArb,
  selectTrainArb,
  clickCheckArb,
  clickCheckArb,
  fc.constant(new OpenSettings()),
  fc.constant(new ClickCancel()),
  fc.constant(new DownloadSucceeds()),
  fc.constant(new DownloadFails()),
  fc.constant(new CheckAndWait()),
  fc.constant(new ClickRestart()),
  fc.constant(new Restart())
];

/** What was published before the first launch, and the train it is on. */
const startArb = fc.record({
  published: fc.subarray([...TAG_POOL]),
  train: trainArb
});

const savedEnv = { NODE_ENV: process.env.NODE_ENV, PWRSNAP_E2E: process.env.PWRSNAP_E2E };
const originalPlatform = process.platform;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  vi.useFakeTimers();
  // Real auto-update runs in production builds only, and never under e2e.
  process.env.NODE_ENV = "production";
  delete process.env.PWRSNAP_E2E;
  // Never created: the fs mocks keep everything under it in memory.
  fake.state.userData = join(tmpdir(), `pwrsnap-updater-model-${process.pid}`);
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
});

afterAll(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedEnv.NODE_ENV;
  if (savedEnv.PWRSNAP_E2E !== undefined) process.env.PWRSNAP_E2E = savedEnv.PWRSNAP_E2E;
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

async function runSession(
  start: { published: string[]; train: Train },
  commands: Iterable<Cmd>
): Promise<void> {
  const feed = new Set([BASELINE, ...start.published]);
  const world = new World(new Set(feed), start.train);
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: world.fetch });
  await world.launch(BASELINE.slice(1));
  const model: Model = { feed, train: start.train, downloading: false };
  syncModel(model);
  checkInvariants(world);
  await fc.asyncModelRun(() => ({ model, real: world }), commands);
}

/** Sessions are "medium" (up to 30 commands): at the default size, PwrGit
 *  measured its #468 bug taking ~700 runs to find. */
const commandsArb = fc.commands(commandArbs, { size: "medium", maxCommands: 30 });

describe("auto-updater held-update model (Windows)", () => {
  it(
    "never offers, arms or runs an installer that is gone, and checks offer the newest eligible release",
    async () => {
      await fc.assert(fc.asyncProperty(startArb, commandsArb, runSession), {
        // Budget: about 1.5 s for 400 runs on an M-series Mac. Against the
        // code before #745, 10 seeds first failed I4 at runs 26–343, so 400
        // runs can miss it; the slower bugs below fail within 40 runs.
        numRuns: 400
      });
    },
    // The 5 s default is too close on the Windows runner.
    20_000
  );

  // The shrunk counterexamples, so each regression has a name. Each fails on
  // the code before its fix.
  it("Cancel stops a download after Check is clicked during it (I6, I7)", async () => {
    // The click asked electron-updater to check again, and Cancel then fired
    // the new check's token, which no download reads.
    await runSession({ published: ["v1.1.0"], train: "stable" }, [
      new ClickCheck(),
      new ClickCancel()
    ]);
  });

  it("switching back does not offer an installer another track's download deleted (I1)", async () => {
    await runSession({ published: ["v1.1.0", "v1.2.0-beta.1"], train: "stable" }, [
      new SelectTrain("beta"),
      new DownloadSucceeds(),
      new SelectTrain("stable")
    ]);
  });

  it("Check replaces a downloaded update when a newer release ships (#745, I4)", async () => {
    await runSession({ published: ["v1.0.1"], train: "stable" }, [
      new DownloadSucceeds(),
      new Publish("v1.0.2"),
      new ClickCheck()
    ]);
  });

  it("a relaunch keeps the persisted request budget (#671, I5)", async () => {
    await runSession({ published: [], train: "stable" }, [new Restart()]);
  });
});
