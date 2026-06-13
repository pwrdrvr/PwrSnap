// Launch-at-login: OS login-item registration + login-launch detection.
//
// `Settings.general.launchAtLogin` is the saved preference (settings
// substrate, Settings → General toggle); this module syncs the OS-side
// registration to it — once at boot and again on every settings write
// (`installLaunchAtLoginSync`). A login-item launch boots TRAY-ONLY:
// index.ts consults `wasLaunchedAtLogin()` and skips the Library window
// so signing in brings up the hotkeys + menu-bar icon without flashing
// a window. The two-process split plan (docs/plans/2026-06-12-001, §D2
// + §D10) later makes that structural — login items boot the agent
// role under LSUIElement — but the detection seam is the same: this
// module stays the single place that answers "was this a login
// launch?".
//
// Per-platform mechanics:
//
//   - macOS: `app.setLoginItemSettings({ openAtLogin })` → SMAppService
//     on macOS 13+. There is no programmatic permission prompt; the OS
//     posts its own "PwrSnap was added as a Login Item" notification,
//     and the user can flip the item off in System Settings → General
//     → Login Items. That OS-side disable shows up as
//     `status: "requires-approval"` — surfaced to the renderer as
//     `blockedByOs` via `app:launchAtLoginStatus`. Login items launch
//     with no custom argv, so detection uses
//     `getLoginItemSettings().wasOpenedAtLogin`.
//
//   - Windows: same Electron API → HKCU Run key, with
//     `--launched-at-login` in the registered args (registry entries
//     DO carry argv, so detection is a plain flag check). Task Manager
//     → Startup apps can disable the entry (StartupApproved); that maps
//     to `blockedByOs` too.
//
//   - Linux: Electron has no login-item support (the API is
//     darwin/win32-only as of Electron 41), so we write an XDG
//     autostart entry at `~/.config/autostart/pwrsnap.desktop` with the
//     same `--launched-at-login` flag in Exec. AppImage runs register
//     the AppImage path (process.env.APPIMAGE), not the extracted
//     binary.
//
// Registration is skipped (never attempted) in dev builds — an
// unpackaged run would register the bare Electron binary — and under
// the E2E harness, which must never touch the host's real startup
// items. The pure planner/mapper functions exist so unit tests can pin
// the per-platform behavior without an Electron app instance.

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { join as joinPosix } from "node:path/posix";
import type { LaunchAtLoginStatus } from "@pwrsnap/shared";
import { DesktopSettingsService } from "./settings/desktop-settings-service";
import { onSettingsChanged } from "./handlers/settings-handlers";
import { getMainLogger } from "./log";

const log = getMainLogger("pwrsnap:launch-at-login");

/** Argv flag carried by Windows registry / Linux autostart launches
 *  (and usable from any platform's command line — E2E specs and the
 *  future split-mode supervisor included) that marks the process as a
 *  login-item boot. macOS SMAppService launches carry no argv; they
 *  are detected via `getLoginItemSettings().wasOpenedAtLogin`. */
export const LAUNCHED_AT_LOGIN_ARG = "--launched-at-login";

export function parseLaunchedAtLoginArgv(argv: readonly string[]): boolean {
  return argv.includes(LAUNCHED_AT_LOGIN_ARG);
}

let wasLaunchedAtLoginCache: boolean | null = null;

/** True when this process was started by the OS at sign-in rather than
 *  by the user. Cached on first call — index.ts reads it during boot
 *  to decide tray-only vs Library boot, and later callers (status
 *  rows, diagnostics) must see the same answer. */
export function wasLaunchedAtLogin(): boolean {
  if (wasLaunchedAtLoginCache !== null) return wasLaunchedAtLoginCache;
  let result = parseLaunchedAtLoginArgv(process.argv);
  if (!result && process.platform === "darwin" && app.isPackaged) {
    try {
      result = app.getLoginItemSettings().wasOpenedAtLogin === true;
    } catch (cause) {
      log.warn("getLoginItemSettings threw during login-launch detection", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
  wasLaunchedAtLoginCache = result;
  return result;
}

/** Test seam: clear the boot-time cache between specs. */
export function __resetWasLaunchedAtLoginForTests(): void {
  wasLaunchedAtLoginCache = null;
}

/** Everything the planner needs to decide what registration looks like
 *  on this machine. Captured as a value (not read ambiently) so unit
 *  tests can exercise every platform from any host. */
export type LaunchAtLoginEnvironment = {
  platform: NodeJS.Platform;
  packaged: boolean;
  e2e: boolean;
  execPath: string;
  /** Self-path when running from an AppImage (process.env.APPIMAGE) —
   *  the registered Exec must point at the AppImage, not the
   *  temp-mounted inner binary. */
  appImagePath: string | null;
  /** XDG base-dir override (process.env.XDG_CONFIG_HOME). */
  xdgConfigHome: string | null;
  homeDir: string;
};

export function currentLaunchAtLoginEnvironment(): LaunchAtLoginEnvironment {
  return {
    platform: process.platform,
    packaged: app.isPackaged,
    e2e: process.env.PWRSNAP_E2E === "1",
    execPath: process.execPath,
    appImagePath: process.env.APPIMAGE ?? null,
    xdgConfigHome: process.env.XDG_CONFIG_HOME ?? null,
    homeDir: os.homedir()
  };
}

export type LaunchAtLoginPlan =
  | { kind: "skip"; reason: "dev-build" | "e2e" | "platform-unsupported" }
  | {
      kind: "electron-login-item";
      settings: { openAtLogin: boolean; args?: string[] };
    }
  | {
      kind: "xdg-autostart";
      enabled: boolean;
      desktopFilePath: string;
      content: string;
    };

/** Double-quote an Exec path per the desktop-entry spec's quoting
 *  rules (reserved characters are only safe inside quotes; backslash,
 *  double-quote, dollar, and backtick must be escaped within them).
 *  Field codes are a separate layer on top: a literal `%` anywhere in
 *  an Exec value must be doubled (`%%`) or the launcher treats it as a
 *  `%f`-style placeholder — quoting does not exempt it. */
function quoteExecPath(path: string): string {
  const quoted = `"${path.replace(/[\\"$`]/g, (ch) => `\\${ch}`)}"`;
  return quoted.replace(/%/g, "%%");
}

function xdgAutostartFilePath(env: LaunchAtLoginEnvironment): string {
  // POSIX join on purpose: this builds LINUX paths from env values. The
  // planner is documented as host-independent (unit tests exercise the
  // linux branch from any host); plain `join` would emit backslashes
  // when the suite runs on Windows.
  const configHome = env.xdgConfigHome ?? joinPosix(env.homeDir, ".config");
  return joinPosix(configHome, "autostart", "pwrsnap.desktop");
}

function xdgDesktopEntryContent(env: LaunchAtLoginEnvironment): string {
  const exec = env.appImagePath ?? env.execPath;
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=PwrSnap",
    "Comment=Screen capture, ready at sign-in",
    `Exec=${quoteExecPath(exec)} ${LAUNCHED_AT_LOGIN_ARG}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    ""
  ].join("\n");
}

export function planLaunchAtLoginSync(
  enabled: boolean,
  env: LaunchAtLoginEnvironment
): LaunchAtLoginPlan {
  if (env.e2e) return { kind: "skip", reason: "e2e" };
  if (!env.packaged) return { kind: "skip", reason: "dev-build" };
  switch (env.platform) {
    case "darwin":
      return { kind: "electron-login-item", settings: { openAtLogin: enabled } };
    case "win32":
      // Same args on enable AND disable — Windows matches Run-key
      // entries by path + args, so the remove call must mirror the
      // registration exactly.
      return {
        kind: "electron-login-item",
        settings: { openAtLogin: enabled, args: [LAUNCHED_AT_LOGIN_ARG] }
      };
    case "linux":
      return {
        kind: "xdg-autostart",
        enabled,
        desktopFilePath: xdgAutostartFilePath(env),
        content: enabled ? xdgDesktopEntryContent(env) : ""
      };
    default:
      return { kind: "skip", reason: "platform-unsupported" };
  }
}

export function applyLaunchAtLoginPlan(plan: LaunchAtLoginPlan): void {
  switch (plan.kind) {
    case "skip":
      return;
    case "electron-login-item":
      app.setLoginItemSettings(plan.settings);
      return;
    case "xdg-autostart":
      if (!plan.enabled) {
        rmSync(plan.desktopFilePath, { force: true });
        return;
      }
      mkdirSync(dirname(plan.desktopFilePath), { recursive: true });
      // Atomic write (tmp → rename), same rule as the settings
      // substrate — a crash mid-write must not leave a truncated
      // .desktop file for the session manager to choke on.
      {
        const tmpPath = `${plan.desktopFilePath}.tmp`;
        writeFileSync(tmpPath, plan.content, "utf8");
        renameSync(tmpPath, plan.desktopFilePath);
      }
      return;
  }
}

// ---- live OS status (app:launchAtLoginStatus) -----------------------

type OsRegistration = Pick<LaunchAtLoginStatus, "registered" | "blockedByOs">;

/** macOS: `status` is the SMAppService state on macOS 13+.
 *  `requires-approval` means registered-but-user-disabled (System
 *  Settings → Login Items) — PwrSnap will NOT launch until the user
 *  re-approves. Older macOS reports no useful `status`; fall back to
 *  `openAtLogin`. */
export function statusFromDarwinLoginItemSettings(settings: {
  status?: string;
  openAtLogin?: boolean;
}): OsRegistration {
  if (settings.status === "enabled") return { registered: true, blockedByOs: false };
  if (settings.status === "requires-approval") return { registered: true, blockedByOs: true };
  return { registered: settings.openAtLogin === true, blockedByOs: false };
}

/** Windows: `openAtLogin` matches the Run-key entry (path + args);
 *  `launchItems[].enabled` carries the Task Manager → Startup apps
 *  approval state for the entry. */
export function statusFromWindowsLoginItemSettings(
  settings: {
    openAtLogin?: boolean;
    launchItems?: Array<{ path?: string; enabled?: boolean }>;
  },
  execPath: string
): OsRegistration {
  const ours = settings.launchItems?.find(
    (item) => item.path !== undefined && item.path.toLowerCase() === execPath.toLowerCase()
  );
  return {
    registered: settings.openAtLogin === true || ours !== undefined,
    blockedByOs: ours !== undefined && ours.enabled === false
  };
}

/** Linux: registered = the autostart entry exists; blocked = the entry
 *  exists but a desktop-environment tool flipped it off in place
 *  (GNOME's Startup Applications writes these keys rather than
 *  deleting the file). */
export function statusFromXdgDesktopFile(content: string | null): OsRegistration {
  if (content === null) return { registered: false, blockedByOs: false };
  const blocked = /^(Hidden=true|X-GNOME-Autostart-enabled=false)\s*$/m.test(content);
  return { registered: true, blockedByOs: blocked };
}

export function readLaunchAtLoginStatus(): LaunchAtLoginStatus {
  const env = currentLaunchAtLoginEnvironment();
  const unsupported = (reason: "dev-build" | "e2e" | "platform-unsupported"): LaunchAtLoginStatus => ({
    supported: false,
    reason,
    registered: false,
    blockedByOs: false
  });
  if (env.e2e) return unsupported("e2e");
  if (!env.packaged) return unsupported("dev-build");
  switch (env.platform) {
    case "darwin":
      return { supported: true, ...statusFromDarwinLoginItemSettings(app.getLoginItemSettings()) };
    case "win32":
      return {
        supported: true,
        ...statusFromWindowsLoginItemSettings(
          app.getLoginItemSettings({ args: [LAUNCHED_AT_LOGIN_ARG] }),
          env.execPath
        )
      };
    case "linux": {
      const filePath = xdgAutostartFilePath(env);
      let content: string | null = null;
      try {
        if (existsSync(filePath)) content = readFileSync(filePath, "utf8");
      } catch (cause) {
        log.warn("failed to read autostart entry for status", {
          filePath,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      }
      return { supported: true, ...statusFromXdgDesktopFile(content) };
    }
    default:
      return unsupported("platform-unsupported");
  }
}

// ---- boot wiring -----------------------------------------------------

type LaunchAtLoginApplierDeps = {
  environment: () => LaunchAtLoginEnvironment;
  applyPlan: (plan: LaunchAtLoginPlan) => void;
};

/** The stateful core behind `installLaunchAtLoginSync`, extracted (with
 *  injectable planner inputs) so the dedupe / retry / enable-only-boot
 *  semantics are unit-testable without an Electron app or a real OS.
 *
 *  - `apply(enabled)` plans + applies registration, deduping repeat
 *    values (every settings write broadcasts; only changes should hit
 *    the OS). A failed apply drops the dedupe marker so the next
 *    settings write retries instead of being swallowed.
 *  - `seed(enabled)` records the current value WITHOUT touching the
 *    OS — the enable-only boot reconcile: a `false` preference at boot
 *    must not unregister a startup item the user created through the
 *    OS itself (Dock → Options → Open at Login, Task Manager). */
export function createLaunchAtLoginApplier(
  deps: LaunchAtLoginApplierDeps = {
    environment: currentLaunchAtLoginEnvironment,
    applyPlan: applyLaunchAtLoginPlan
  }
): { apply: (enabled: boolean) => void; seed: (enabled: boolean) => void } {
  let lastApplied: boolean | null = null;
  return {
    apply: (enabled: boolean): void => {
      if (enabled === lastApplied) return;
      lastApplied = enabled;
      const plan = planLaunchAtLoginSync(enabled, deps.environment());
      try {
        deps.applyPlan(plan);
        log.info("login-item registration synced", {
          enabled,
          plan: plan.kind,
          ...(plan.kind === "skip" ? { reason: plan.reason } : {})
        });
      } catch (cause) {
        lastApplied = null;
        log.warn("login-item registration sync failed", {
          enabled,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      }
    },
    seed: (enabled: boolean): void => {
      lastApplied = enabled;
    }
  };
}

/** Sync OS registration to `general.launchAtLogin` — apply the persisted
 *  value now, then follow every settings write. Boot reconcile is
 *  ENABLE-ONLY: when the setting is off we do NOT unregister at boot
 *  (see `createLaunchAtLoginApplier.seed`). Unregistration happens only
 *  when the user flips the toggle off.
 *
 *  Mirrors `wireHotkeyRegistrations`: a dedicated settings reader keeps
 *  the boot dependency graph one-way, and `onSettingsChanged` rides the
 *  substrate's main-side fan-out (which the settings:write handler
 *  awaits before resolving — so by the time the renderer's patch()
 *  returns, registration has already been attempted and
 *  `app:launchAtLoginStatus` reads fresh). */
export async function installLaunchAtLoginSync(): Promise<void> {
  const service = new DesktopSettingsService({
    filePath: join(app.getPath("userData"), "pwrsnap-settings.json")
  });
  const applier = createLaunchAtLoginApplier();
  try {
    const settings = await service.read();
    if (settings.general.launchAtLogin) {
      applier.apply(true);
    } else {
      applier.seed(false);
    }
  } catch (cause) {
    // Treat an unreadable settings file as "preference off" for dedupe
    // purposes: the enable-only boot courtesy must hold here too, so a
    // later unrelated settings write (broadcasting launchAtLogin=false)
    // doesn't unregister an OS-side registration the user made
    // manually.
    applier.seed(false);
    log.warn("initial settings read failed; login-item registration left as-is", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
  onSettingsChanged((settings) => {
    applier.apply(settings.general.launchAtLogin);
  });
}
