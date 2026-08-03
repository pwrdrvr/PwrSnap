// Electron-launch fixture for the PwrSnap E2E suite.
//
// Each spec calls `launchPwrSnap()` to spin up a fresh Electron process
// against an isolated tmpdir HOME (so SQLite, captures dir, cache dir,
// and trash all live in a throwaway location — no contamination from
// the user's real PwrSnap install or between specs).
//
// `PWRSNAP_E2E=1` tells main/index.ts to skip the global ⌘⇧P shortcut
// and the tray icon — both would interfere with deterministic testing
// (the global shortcut would race the host machine's keymap; the tray
// has no portable Linux story).
//
// The launcher returns the Electron app handle, the first BrowserWindow
// as a Playwright Page (the main library window), and a `dispatch`
// helper that fires command-bus calls through `ipcMain` from the test
// side. That last part is the key — it lets specs drive
// `capture:interactive`, `library:list`, etc. without simulating a
// global shortcut keystroke.
//
// IMPORTANT: specs must import `test` and `expect` from THIS file, not
// from `@playwright/test`. The exported `test` carries the leaked-app
// guard fixture (see `liveApps` below) that reaps Electron processes a
// timed-out test left behind — without it, one hung test wedges
// Playwright's worker teardown for 30s and fails the whole job even
// when the retry passes.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page
} from "@playwright/test";
import type { CommandName, Req, Res, Result, PwrSnapError } from "@pwrsnap/shared";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(fixtureDir, "..", "..");
const mainEntry = path.resolve(desktopRoot, "out", "main", "index.js");
const ELECTRON_CLOSE_TIMEOUT_MS = 5_000;
// Bound on the graceful `app.evaluate(exit)` round-trip during teardown.
// On the VS2026 Windows runner the main-process event loop can wedge
// mid window-creation; an UNBOUNDED `evaluate` then hangs the entire
// teardown, which is what trips Playwright's 30s worker-teardown timeout
// (reported as "an error not part of any test" — that fails the whole
// job even when the test itself passes on retry). Keep this short: it's
// a best-effort nicety before the forceful close/SIGKILL fallback.
const ELECTRON_EVAL_TIMEOUT_MS = 3_000;
// Bound on a single command-bus `dispatch` round-trip. A healthy command
// resolves in milliseconds (the heaviest spec dispatch — region capture,
// clipboard image encode, codex discovery — is a couple seconds at worst
// on slow CI); a wedged main never resolves. Before this existed, a wedge
// fell through to the full 60s test timeout, which poisons the Playwright
// worker. We want the opposite: fail FAST and let the retry recover the
// flake. 10s is ~5× headroom over any real dispatch yet declares a wedge
// in a sixth of the old ceiling, leaving the `finally { app.close() }`
// ample room to clean up before the 60s test deadline. A spurious trip is
// self-correcting (retry), so erring tight is the right trade.
const DISPATCH_TIMEOUT_MS = 10_000;

/**
 * Every Electron app launched by this fixture, until its `close()` runs.
 * Exists for the leaked-app guard below: when a test times out mid-await,
 * Playwright abandons the test body — the `finally { app.close() }`
 * inside the test NEVER runs (the abandoned promise is still parked on
 * the hung await), so the Electron process leaks. PwrSnap deliberately
 * stays resident after its windows close (tray/menubar-app lifecycle),
 * so Playwright's own end-of-worker graceful close then waits forever
 * for an exit that will never come — that's the "Worker teardown
 * timeout of 30000ms exceeded" that fails the whole job even when the
 * test passed on retry (seen live on the macOS VM lane, PR #353).
 */
type TrackedApp = {
  app: ElectronApplication;
  child: ElectronChildProcess;
  homeRoot: string;
};
const liveApps = new Set<TrackedApp>();

/**
 * The suite's `test` object. Identical to `@playwright/test`'s except
 * for one auto fixture: after every test, force-close any Electron app
 * the test leaked. Unlike a try/finally inside the test body, fixture
 * teardown ALWAYS runs — including after a test timeout — so a hung
 * app is reaped here (bounded: graceful-exit evaluate, then close,
 * then SIGKILL — ~11s worst case) instead of wedging Playwright's
 * worker teardown for 30s and turning a retryable flake into a
 * run-level "1 error was not a part of any test" failure.
 *
 * Specs must import `test` (and `expect`, for symmetry) from this file,
 * not from `@playwright/test`, or the guard silently doesn't apply.
 */
export const test = base.extend<{ leakedElectronAppGuard: void }>({
  leakedElectronAppGuard: [
    async ({}, use, testInfo) => {
      await use();
      for (const tracked of Array.from(liveApps)) {
        liveApps.delete(tracked);
        // eslint-disable-next-line no-console
        console.warn(
          `[e2e] "${testInfo.title}" leaked an Electron app (pid ${String(
            tracked.child.pid ?? "?"
          )}) — force-closing it so worker teardown can't hang`
        );
        try {
          await closeElectronApp(tracked.app);
        } finally {
          await removeHomeRoot(tracked.homeRoot);
        }
      }
    },
    { auto: true, box: true }
  ]
});

export { expect };

async function removeHomeRoot(homeRoot: string): Promise<void> {
  try {
    await rm(homeRoot, {
      recursive: true,
      force: true,
      // On Windows the OS reaps a dead process's file handles
      // asynchronously, so better-sqlite3's WAL/db files (pwrsnap.db,
      // DIPS-wal, …) can still be locked for a beat after Electron
      // exits — the unlink then hits EBUSY. fs.rm retries EBUSY with
      // linear backoff; give the handle a generous window to drop. The
      // VS2026 runner image surfaced this (its teardown timing loses a
      // race the VS2022 image always won); ~11s worst case, but it
      // returns the instant the unlink succeeds, so the healthy path
      // pays nothing.
      maxRetries: 10,
      retryDelay: 200
    });
  } catch (error) {
    // A leaked temp dir under os.tmpdir() on an ephemeral CI runner is
    // harmless. Throwing here is NOT: it escapes test teardown, crashes
    // the Playwright worker mid-run ("Failed worker ran N tests"), and
    // fails the whole job — turning an otherwise-green suite red and
    // flipping a pass-on-retry flake into a hard failure. Cleanup must
    // never take down the worker.
    // eslint-disable-next-line no-console
    console.warn(`[e2e] could not remove temp HOME ${homeRoot}: ${String(error)}`);
  }
}

type CloseResult = "closed" | "rejected" | "timeout";
type ElectronChildProcess = ReturnType<ElectronApplication["process"]>;

/**
 * Race a promise against a timeout. If the timeout wins, the returned
 * promise rejects with `new Error(message)` and the racing promise's
 * eventual settlement is swallowed so it can NEVER surface later as an
 * unhandled rejection — Playwright reports those as "errors not part of
 * any test", which fail the whole job even when the owning test passed
 * on retry. Used to bound every `electronApp.evaluate` round-trip so a
 * wedged main-process event loop (seen on the VS2026 runner during
 * window creation) produces a prompt, catchable error instead of an
 * open-ended hang.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  // Once the timeout wins we stop awaiting `promise`; without this catch
  // its later rejection (e.g. when the process is force-killed and the
  // Playwright connection drops) would have no handler.
  promise.catch(() => undefined);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Forcefully terminate the Electron process AND its whole child-process
 * tree, on every platform. Killing only the top PID orphans Electron's
 * renderer / GPU / utility / crashpad children: on Windows
 * `child.kill("SIGKILL")` maps to `TerminateProcess` on the top PID, and
 * on macOS/Linux SIGKILL is likewise delivered to one process, so the
 * helpers reparent to launchd/init and linger in the GUI session. Across
 * hundreds of sequential launch→close cycles (a persistent VM runner
 * serves many full-suite jobs) those orphans pile up and degrade the
 * session until every subsequent teardown times out — see the +6s/spec
 * pathology in docs/solutions/. `taskkill /T` (Windows) and an explicit
 * descendant walk + SIGKILL (POSIX) tear down the entire tree.
 * Best-effort and idempotent: already-gone processes are ignored.
 */
async function killProcessTree(child: ElectronChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    if (!child.killed) child.kill("SIGKILL");
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: 5_000 }, (error) => {
        // Non-zero exit usually just means "already exited" — nothing to do.
        if (error && !child.killed) child.kill("SIGKILL");
        resolve();
      });
    });
    return;
  }
  // POSIX: snapshot the descendant tree BEFORE killing the root — once the
  // root dies its children reparent and the ancestry link is gone.
  const descendants = await listDescendantPids(pid);
  if (!child.killed) child.kill("SIGKILL");
  for (const descendant of descendants) {
    try {
      process.kill(descendant, "SIGKILL");
    } catch {
      // ESRCH — already exited between the snapshot and now. Note the
      // snapshot also carries a tiny inherent race we accept (as every
      // pkill-style sweep does): a snapshotted PID could exit and be
      // recycled by an unrelated process before this kill lands. PIDs
      // don't recycle within milliseconds on macOS/Linux, and this only
      // runs on already-forced teardowns inside throwaway E2E guests.
    }
  }
}

/** All transitive child PIDs of `rootPid`, via one `ps` snapshot. */
async function listDescendantPids(rootPid: number): Promise<number[]> {
  const stdout = await new Promise<string>((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid="], { timeout: 5_000 }, (_error, out) => {
      resolve(out ?? "");
    });
  });
  const childrenOf = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match === null) continue;
    const childPid = Number(match[1]);
    const parentPid = Number(match[2]);
    const bucket = childrenOf.get(parentPid);
    if (bucket === undefined) childrenOf.set(parentPid, [childPid]);
    else bucket.push(childPid);
  }
  const result: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    for (const childPid of childrenOf.get(next) ?? []) {
      result.push(childPid);
      queue.push(childPid);
    }
  }
  return result;
}

async function waitForClose(promise: Promise<void>, timeoutMs: number): Promise<CloseResult> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<CloseResult>([
      promise.then(
        () => "closed",
        () => "rejected"
      ),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function hasExited(child: ElectronChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForProcessExit(
  child: ElectronChildProcess,
  timeoutMs: number
): Promise<boolean> {
  if (hasExited(child)) return true;
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<boolean>([
      new Promise<true>((resolve) => {
        child.once("exit", () => resolve(true));
      }),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function closeElectronApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  try {
    // Bounded: a wedged main never round-trips this `evaluate`, and an
    // unbounded await here is exactly what hangs teardown long enough to
    // trip Playwright's worker-teardown timeout. If it doesn't land
    // quickly, fall through to the forceful close + SIGKILL below.
    await withTimeout(
      app.evaluate(({ app: electronApp }) => {
        electronApp.dock?.hide();
        electronApp.exit(0);
      }),
      ELECTRON_EVAL_TIMEOUT_MS,
      "graceful electron exit evaluate timed out"
    );
  } catch {
    // The process may exit before the evaluate call can round-trip, or
    // the main event loop may be wedged — either way the forceful path
    // below takes over.
  }

  const closePromise = app.close();
  const result = await waitForClose(closePromise, ELECTRON_CLOSE_TIMEOUT_MS);
  if (result === "closed" && (await waitForProcessExit(child, 1_000))) return;

  // Every trip through here costs this spec ~6s and, before the tree-kill
  // below existed, leaked the app's helper processes into the session. If
  // these lines show up on most specs of a run, the guest is degraded —
  // reboot it (see the VM-lab troubleshooting doc).
  // eslint-disable-next-line no-console
  console.warn(
    `[e2e-teardown] graceful close failed (close=${result}, exited=${hasExited(child)}) — force-killing pid=${child.pid ?? "?"}`
  );
  if (!hasExited(child)) {
    await killProcessTree(child);
  }
  await waitForProcessExit(child, 1_000);
  await waitForClose(closePromise, 1_000);
}

/**
 * Poll Electron's BrowserWindow list until the library window appears
 * AND has finished loading the renderer bundle. Every auxiliary
 * renderer window (region selectors, tray popover, float-over toast,
 * settings, …) renders through the same `out/renderer/index.html` and
 * is distinguished by a `#stage=<name>` URL fragment (see
 * `rendererTarget` in src/main/window.ts). The library is the ONLY
 * renderer window with no `stage=` in its hash — exclude them ALL,
 * not just `stage=region`, or a pre-warmed tray/float-over window can
 * be mistaken for the library depending on creation order.
 */
async function waitForLibraryWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      const url = candidate.url();
      // Library = same renderer index.html, no `stage=` in the hash.
      if (url.includes("/renderer/index.html") && !url.includes("stage=")) {
        // Bounded: an unbounded load-state wait inside this loop would
        // defeat the deadline above — a renderer that never finishes
        // loading would park the test on this await until the test
        // timeout, leaking the app (see the leaked-app guard).
        const remaining = Math.max(1, deadline - Date.now());
        await candidate
          .waitForLoadState("domcontentloaded", { timeout: Math.min(remaining, 10_000) })
          .catch(() => undefined);
        return candidate;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("library window never appeared (only region selectors found)");
}

export type LaunchedApp = {
  electronApp: ElectronApplication;
  /** The library/main window — first window opened on boot. */
  window: Page;
  /** Where this run's HOME lives. Cleaned up by `close()`. */
  homeRoot: string;
  /**
   * Dispatch a typed command-bus command from the test side. This lifts
   * the call through Electron's main process via `electronApp.evaluate`
   * — the test gets the same Result envelope a renderer would.
   */
  dispatch<C extends CommandName>(
    name: C,
    req: Req<C>
  ): Promise<Result<Res<C>, PwrSnapError>>;
  close(): Promise<void>;
};

export type LaunchOptions = {
  /** Extra env vars to inject (overrides defaults). */
  env?: Record<string, string | undefined>;
  /** Override the main BrowserWindow size before assertions run. */
  windowSize?: { width: number; height: number };
  /**
   * Extra command-line arguments appended after the main entry point.
   * Used by the open-file spec to simulate `open foo.pwrsnap` cold-
   * start launches: a `.pwrsnap` path in argv triggers the argv-
   * sweep branch of `wireOpenFileHandler()` and exercises the
   * full `open-file → readBundleManifest → editor:open` flow.
   */
  extraArgs?: readonly string[];
  /**
   * Called with the fresh tmpdir HOME after creation but before Electron
   * launches. Use to seed `pwrsnap-settings.json`, the captures dir,
   * or other userData state that needs to exist on first paint — anything
   * that has to be on disk BEFORE main reads it, not after.
   */
  seedUserData?: (homeRoot: string) => Promise<void>;
};

/** A launched app with no library window expected — the tray-only
 *  login-item boot path (`--launched-at-login`). Everything except the
 *  `window` Page; specs reach main via `dispatch` / `electronApp`. */
export type WindowlessLaunchedApp = Omit<LaunchedApp, "window">;

async function launchPwrSnapCore(
  options: LaunchOptions = {}
): Promise<WindowlessLaunchedApp> {
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-e2e-home-"));

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    HOME: homeRoot,
    NODE_ENV: "production",
    PWRSNAP_E2E: "1",
    // Belt-and-braces isolation: HOME alone doesn't reliably rebase
    // app.getPath('userData') under Playwright (the bundle name is
    // "Electron" not "PwrSnap" so the cached path lands at the host
    // user's real ~/Library/.../Electron). Forcing userData puts
    // every SQLite write under our tmpdir. With PWRSNAP_E2E=1, main
    // also rebases app.getPath('documents') to <homeRoot>/Documents,
    // so the captures dir (`getCapturesRoot()`) stays off the host's
    // real ~/Documents/PwrSnap too.
    PWRSNAP_USER_DATA: homeRoot
  });
  // electron-vite injects ELECTRON_RENDERER_URL during dev; the
  // packaged main entry must NOT see it or it will try to load from a
  // dead localhost dev server.
  delete env.ELECTRON_RENDERER_URL;

  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  if (options.seedUserData !== undefined) {
    // Seeding has to land BEFORE `electron.launch` so the seeded state
    // is what main reads on first paint — that's what makes the spec
    // prove a live read instead of a fallback.
    await options.seedUserData(homeRoot);
  }

  let electronApp: ElectronApplication | null = null;
  try {
    const launchedApp = await electron.launch({
      args: [mainEntry, ...(options.extraArgs ?? [])],
      cwd: desktopRoot,
      env
    });
    electronApp = launchedApp;
    // Registered until close() runs; the leaked-app guard reaps
    // whatever is still here when the test ends (e.g. after a test
    // timeout abandoned the body before its finally could close us).
    const tracked: TrackedApp = {
      app: launchedApp,
      child: launchedApp.process(),
      homeRoot
    };
    liveApps.add(tracked);

    return {
      electronApp: launchedApp,
      homeRoot,
      dispatch: async <C extends CommandName>(name: C, req: Req<C>) => {
        // Drive the command bus through the E2E bridge that main installs
        // when `PWRSNAP_E2E=1`. The bridge re-uses the same `bus.dispatch`
        // that ipcMain calls, so the Result envelope a spec sees is the
        // exact same shape a renderer would.
        //
        // Bounded so a wedged main process can't make `dispatch` hang the
        // full test timeout: a prompt rejection lets the test fail fast
        // (and its `finally { app.close() }` clean up) rather than burning
        // 60s and poisoning the Playwright worker.
        const result = await withTimeout(
          launchedApp.evaluate(
            async (_electron, payload: { name: string; req: unknown }) => {
              const bridge = (
                globalThis as unknown as {
                  __PWRSNAP_TEST__?: { dispatch: (n: string, r: unknown) => Promise<unknown> };
                }
              ).__PWRSNAP_TEST__;
              if (bridge === undefined) {
                throw new Error("PWRSNAP_E2E bridge not installed — did you set PWRSNAP_E2E=1?");
              }
              return await bridge.dispatch(payload.name, payload.req);
            },
            { name, req }
          ),
          DISPATCH_TIMEOUT_MS,
          `command-bus dispatch "${name}" timed out after ${DISPATCH_TIMEOUT_MS}ms (main process unresponsive?)`
        );
        return result as Result<Res<C>, PwrSnapError>;
      },
      close: async () => {
        liveApps.delete(tracked);
        try {
          await closeElectronApp(launchedApp);
        } finally {
          await removeHomeRoot(homeRoot);
        }
      }
    };
  } catch (cause) {
    if (electronApp !== null) {
      for (const tracked of Array.from(liveApps)) {
        if (tracked.app === electronApp) liveApps.delete(tracked);
      }
      try {
        await closeElectronApp(electronApp);
      } catch {
        // Ignore cleanup failures; preserve the original launch error.
      }
    }
    await removeHomeRoot(homeRoot);
    throw cause;
  }
}

export async function launchPwrSnap(
  options: LaunchOptions = {}
): Promise<LaunchedApp> {
  const core = await launchPwrSnapCore(options);
  try {
    // The main process pre-warms a region-selector BrowserWindow before
    // it opens the library window. firstWindow() races them and may
    // hand back the selector. Find the library window by title instead
    // so specs always see the user-facing surface.
    const window = await waitForLibraryWindow(core.electronApp);

    if (options.windowSize !== undefined) {
      const size = options.windowSize;
      // RE-ASSERT the size on every poll tick until the RENDERER
      // confirms it, and never trust main-side readbacks. A one-shot
      // setContentSize right after boot intermittently leaves the web
      // contents laid out at the boot height while the native frame
      // resizes (~5-10% of launches on macOS; visible as the title bar
      // clipped off the top plus a black band at the bottom). In that
      // stuck state `getContentSize()` REPORTS THE REQUESTED SIZE, so
      // main cannot even detect it (same "readback lies" trap as the
      // implicit-minimum clamp documented in AGENTS.md → "BrowserWindow
      // sizing"). The renderer's innerWidth/innerHeight is the only
      // truthful signal. To unstick, each retry must be a REAL frame
      // change — alternate the height by 1px so macOS performs a fresh
      // contentView layout, and only the exact-target application can
      // satisfy the poll.
      let attempt = 0;
      await expect
        .poll(async () => {
          const current = await window.evaluate(() => ({
            innerWidth: globalThis.innerWidth,
            innerHeight: globalThis.innerHeight
          }));
          if (current.innerWidth === size.width && current.innerHeight === size.height) {
            return current;
          }
          const bump = attempt % 2;
          attempt += 1;
          await core.electronApp.evaluate(({ BrowserWindow }, target) => {
            // Pick the LIBRARY window, not just the first live window:
            // the pre-warmed auxiliary windows (region selectors, tray
            // popover, float-over toast) render through the same
            // renderer index.html and can precede the library in
            // getAllWindows(). Same URL discrimination as
            // `waitForLibraryWindow` — every auxiliary renderer window
            // carries a `stage=<name>` hash, the library carries none.
            // The renderer-URL check must be POSITIVE (not merely "no
            // stage="): a still-loading auxiliary window reports an
            // empty URL, which would pass a negative filter and steal
            // the resize. The library URL is guaranteed loaded here —
            // `waitForLibraryWindow` awaited it above.
            const win = BrowserWindow.getAllWindows().find((w) => {
              if (w.isDestroyed()) return false;
              const url = w.webContents.getURL();
              return url.includes("/renderer/index.html") && !url.includes("stage=");
            });
            if (!win) throw new Error("no live library BrowserWindow to resize");
            win.setMinimumSize(0, 0);
            win.setContentSize(target.width, target.height + target.bump);
          }, { width: size.width, height: size.height, bump });
          return window.evaluate(() => ({
            innerWidth: globalThis.innerWidth,
            innerHeight: globalThis.innerHeight
          }));
        }, { timeout: 15_000 })
        .toMatchObject({ innerWidth: size.width, innerHeight: size.height });
    }

    return { ...core, window };
  } catch (cause) {
    try {
      await core.close();
    } catch {
      // Ignore cleanup failures; preserve the original error.
    }
    throw cause;
  }
}

/**
 * Launch without waiting for a library window — for specs that exercise
 * the tray-only login-item boot (`--launched-at-login`), where the
 * whole point is that no library window appears. `windowSize` is not
 * supported here (there is no window to size).
 */
export async function launchPwrSnapWindowless(
  options: Omit<LaunchOptions, "windowSize"> = {}
): Promise<WindowlessLaunchedApp> {
  return launchPwrSnapCore(options);
}
