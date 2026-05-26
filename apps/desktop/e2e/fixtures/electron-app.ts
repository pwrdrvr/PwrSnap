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

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page
} from "@playwright/test";
import type { CommandName, Req, Res, Result, PwrSnapError } from "@pwrsnap/shared";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(fixtureDir, "..", "..");
const mainEntry = path.resolve(desktopRoot, "out", "main", "index.js");
const ELECTRON_CLOSE_TIMEOUT_MS = 5_000;

async function removeHomeRoot(homeRoot: string): Promise<void> {
  await rm(homeRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100
  });
}

type CloseResult = "closed" | "rejected" | "timeout";
type ElectronChildProcess = ReturnType<ElectronApplication["process"]>;

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
    await app.evaluate(({ app: electronApp }) => {
      electronApp.dock?.hide();
      electronApp.exit(0);
    });
  } catch {
    // The process may exit before the evaluate call can round-trip.
  }

  const closePromise = app.close();
  const result = await waitForClose(closePromise, ELECTRON_CLOSE_TIMEOUT_MS);
  if (result === "closed" && (await waitForProcessExit(child, 1_000))) return;

  if (!hasExited(child) && !child.killed) {
    child.kill("SIGKILL");
  }
  await waitForProcessExit(child, 1_000);
  await waitForClose(closePromise, 1_000);
}

/**
 * Poll Electron's BrowserWindow list until the library window appears
 * AND has finished loading the renderer bundle. Both the library and
 * the pre-warmed region selectors render through the same
 * `out/renderer/index.html`, so the document `<title>` is "PwrSnap"
 * on both. The selectors are distinguishable by their URL hash —
 * `#stage=region&displayId=N`. The library window has no hash.
 */
async function waitForLibraryWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      const url = candidate.url();
      // Library = same renderer index.html, no `stage=` in the hash.
      // The pre-warmed region selectors carry `#stage=region&...`.
      if (url.includes("/renderer/index.html") && !url.includes("stage=region")) {
        await candidate.waitForLoadState("domcontentloaded").catch(() => undefined);
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

export async function launchPwrSnap(
  options: LaunchOptions = {}
): Promise<LaunchedApp> {
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
    // every SQLite write under our tmpdir.
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

    // The main process pre-warms a region-selector BrowserWindow before
    // it opens the library window. firstWindow() races them and may
    // hand back the selector. Find the library window by title instead
    // so specs always see the user-facing surface.
    const window = await waitForLibraryWindow(launchedApp);

    if (options.windowSize !== undefined) {
      const size = options.windowSize;
      await launchedApp.evaluate(({ BrowserWindow }, target) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (!win) throw new Error("no live BrowserWindow to resize");
        win.setMinimumSize(0, 0);
        win.setContentSize(target.width, target.height);
      }, size);
      await expect
        .poll(async () =>
          window.evaluate(() => ({
            innerWidth: globalThis.innerWidth,
            innerHeight: globalThis.innerHeight
          }))
        )
        .toMatchObject({ innerWidth: size.width, innerHeight: size.height });
    }

    return {
      electronApp: launchedApp,
      window,
      homeRoot,
      dispatch: async <C extends CommandName>(name: C, req: Req<C>) => {
        // Drive the command bus through the E2E bridge that main installs
        // when `PWRSNAP_E2E=1`. The bridge re-uses the same `bus.dispatch`
        // that ipcMain calls, so the Result envelope a spec sees is the
        // exact same shape a renderer would.
        const result = await launchedApp.evaluate(
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
        );
        return result as Result<Res<C>, PwrSnapError>;
      },
      close: async () => {
        try {
          await closeElectronApp(launchedApp);
        } finally {
          await removeHomeRoot(homeRoot);
        }
      }
    };
  } catch (cause) {
    if (electronApp !== null) {
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
