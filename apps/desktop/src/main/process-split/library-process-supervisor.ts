// Agent-side supervisor for the on-demand library process (plan
// 2026-06-12-001 §D2). The library spawns lazily — the first
// library-owned command (tray "Open Library", float-over "open",
// settings:open) pulls it up — and quits itself when its last window
// closes; the next demand respawns it. No auto-restart policy beyond
// that: ensure-on-demand IS the restart policy.

import { spawn, type ChildProcess } from "node:child_process";
import { app } from "electron";
import type { PwrSnapError, Result } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { broadcastRendererEventToLocalWindows } from "../events";
import { getMainLogger } from "../log";
import { channelForChildProcess } from "../process-bridge/channel";
import { BridgeEndpoint } from "../process-bridge/endpoint";
import { processRoleFlag } from "../process-role";
import { deliverRelayedRendererEventToMain, LIBRARY_WINDOW_READY_CHANNEL } from "./event-relay";

const log = getMainLogger("pwrsnap:library-supervisor");

/** Budget for a freshly-spawned library to boot, register handlers,
 *  and say hello before forwarded dispatches fail. Cold Electron boot
 *  is ~1–3s; first-launch-after-update and slow disks earn headroom. */
const LIBRARY_READY_TIMEOUT_MS = 30_000;

/**
 * Cold-launch watchdog window. After the agent forwards a verb that
 * should bring a library window up, the library must emit
 * `LIBRARY_WINDOW_READY_CHANNEL` (on its window's `did-finish-load`, or
 * immediately when re-showing an already-loaded window) within this
 * budget. If it doesn't, the library's main thread is wedged — the
 * black-window-that-never-paints bug — and a setTimeout INSIDE the
 * library can't fire to self-heal (the loop is blocked), so the agent
 * (which is NOT blocked) recovers from out here. Generous on purpose:
 * a healthy cold load is <5s even on the slow paths we measured, so
 * 20s only trips on a genuine hang, never on a slow-but-alive load.
 */
const LIBRARY_WINDOW_WATCHDOG_MS = 20_000;

/** Verbs the agent forwards that MUST produce a visible library main
 *  window. Used to arm the cold-launch watchdog. Other forwarded verbs
 *  (settings/data/etc.) don't create the main window and aren't armed. */
const LIBRARY_WINDOW_SPAWN_VERBS: ReadonlySet<string> = new Set([
  "library:focus",
  "library:openInLibrary",
  "editor:open"
]);

export function isLibraryWindowSpawnVerb(name: string): boolean {
  return LIBRARY_WINDOW_SPAWN_VERBS.has(name);
}

/**
 * How to launch a second instance of ourselves in the library role.
 * Packaged: process.execPath IS the app binary. Dev: execPath is the
 * bare Electron binary and needs the app dir (whose package.json main
 * points at out/main/index.js) as its first argument.
 */
export function libraryProcessSpawnPlan(input: {
  execPath: string;
  appPath: string;
  isPackaged: boolean;
}): { command: string; args: string[] } {
  return input.isPackaged
    ? { command: input.execPath, args: [processRoleFlag("library")] }
    : { command: input.execPath, args: [input.appPath, processRoleFlag("library")] };
}

let child: ChildProcess | null = null;
let endpoint: BridgeEndpoint | null = null;
let windowWatchdog: ReturnType<typeof setTimeout> | null = null;

function clearWindowWatchdog(): void {
  if (windowWatchdog !== null) {
    clearTimeout(windowWatchdog);
    windowWatchdog = null;
  }
}

/** Arm (or re-arm) the cold-launch watchdog for `verb`. Fires only if
 *  the library doesn't signal window-ready in time — then it logs a
 *  loud, unmistakable line and KILLS the wedged library so the user can
 *  simply re-open (the next intent respawns a fresh process) instead of
 *  being stuck with a black window that needs a force-quit. */
function armWindowWatchdog(verb: string): void {
  clearWindowWatchdog();
  windowWatchdog = setTimeout(() => {
    windowWatchdog = null;
    log.error(
      "library window watchdog: no window-ready signal within budget — " +
        "library main thread appears wedged; killing it for a clean respawn",
      { verb, timeoutMs: LIBRARY_WINDOW_WATCHDOG_MS, pid: child?.pid }
    );
    killWedgedLibrary();
  }, LIBRARY_WINDOW_WATCHDOG_MS);
  windowWatchdog.unref?.();
}

/** Kill the (presumed-wedged) library + forget it, so the next
 *  window-verb forward respawns a fresh process. The agent stays up. */
function killWedgedLibrary(): void {
  const spawned = child;
  const ep = endpoint;
  child = null;
  endpoint = null;
  ep?.close();
  if (spawned !== null && spawned.exitCode === null) {
    spawned.kill();
  }
}

function spawnLibraryProcess(): BridgeEndpoint {
  const plan = libraryProcessSpawnPlan({
    execPath: process.execPath,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged
  });
  // The child inherits the dev server URL, PWRSNAP_USER_DATA, the
  // login-shell PATH hydration, etc. ELECTRON_RUN_AS_NODE must not
  // leak in — it would boot the child as plain Node, no Electron.
  const env = { ...process.env };
  delete env["ELECTRON_RUN_AS_NODE"];
  log.info("spawning library process", { command: plan.command, args: plan.args });
  const spawned = spawn(plan.command, plan.args, {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env
  });
  const ep = new BridgeEndpoint({
    role: "agent",
    channel: channelForChildProcess(spawned),
    dispatchLocal: (name, req) =>
      bus.dispatch(name as never, req as never, { principal: "bridge" }),
    onRemoteEvent: (channel, payload) => {
      // Internal control signal — the library's window is up; disarm the
      // cold-launch watchdog. Not a renderer event: don't fan it out to
      // the agent's windows.
      if (channel === LIBRARY_WINDOW_READY_CHANNEL) {
        log.info("library window-ready signal received — disarming watchdog");
        clearWindowWatchdog();
        return;
      }
      broadcastRendererEventToLocalWindows(channel, payload);
      deliverRelayedRendererEventToMain(channel, payload);
    },
    onRemoteCancel: (key) => {
      bus.cancel(key);
    },
    warn: (message, meta) => log.warn(message, meta)
  });
  const forget = (): void => {
    if (child === spawned) {
      child = null;
      endpoint = null;
      // The process this watchdog was guarding is gone — don't let a
      // stale timer fire against a dead/replaced child.
      clearWindowWatchdog();
    }
    ep.close();
  };
  spawned.on("exit", (code, signal) => {
    log.info("library process exited", { code, signal });
    forget();
  });
  spawned.on("error", (cause) => {
    log.error("library process spawn error", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
    forget();
  });
  child = spawned;
  endpoint = ep;
  return ep;
}

/** Spawn the library if it isn't running; idempotent. */
export function ensureLibraryProcess(): BridgeEndpoint {
  if (child !== null && endpoint !== null) return endpoint;
  return spawnLibraryProcess();
}

export function isLibraryProcessRunning(): boolean {
  return child !== null;
}

/**
 * The agent's RemoteCommandForwarder body: ensure the library process
 * exists, wait for its readiness hello, dispatch. Never rejects.
 */
export async function dispatchToLibraryProcess(
  name: string,
  req: unknown
): Promise<Result<unknown, PwrSnapError>> {
  // Name the trigger whenever a dispatch is what pulls the process up
  // — a spawn the user didn't ask for traces back to one log line.
  if (child === null) {
    log.info("library process spawn triggered by command", { name });
  }
  const ep = ensureLibraryProcess();
  const ready = await ep.waitForPeer(LIBRARY_READY_TIMEOUT_MS);
  // DIAG (cold-launch race): brackets the agent→library round trip so a
  // hang shows up as "sent, never returned" vs "peer never ready".
  log.info("dispatchToLibraryProcess: peer ready", { name, ok: ready.ok });
  if (!ready.ok) return ready;
  // Cold-launch watchdog for window-spawning verbs: armed AFTER the boot
  // gate (waitForPeer already covers boot) and BEFORE the dispatch await,
  // so an existing-window's synchronous window-ready signal — which can
  // arrive during the await — disarms it instead of racing a re-arm.
  // A new window disarms later, on its did-finish-load.
  if (isLibraryWindowSpawnVerb(name)) {
    armWindowWatchdog(name);
  }
  const result = await ep.dispatchRemote(name, req);
  log.info("dispatchToLibraryProcess: remote returned", {
    name,
    ok: result.ok,
    code: result.ok ? undefined : result.error.code
  });
  return result;
}

/** Renderer-event relay toward the library. Deliberately does NOT
 *  spawn: broadcasting a capture change to a closed library is
 *  meaningless — its renderers re-read fresh state on next launch. */
export function forwardRendererEventToLibrary(channel: string, payload: unknown): void {
  endpoint?.emitEvent(channel, payload);
}

/** Cancellation relay toward the library (no spawn — a process that
 *  isn't running has nothing to cancel). */
export function forwardCancellationToLibrary(key: string): void {
  endpoint?.cancelRemote(key);
}

/** Agent quit path: take the library down with us. */
export function stopLibraryProcess(): void {
  clearWindowWatchdog();
  const spawned = child;
  const ep = endpoint;
  child = null;
  endpoint = null;
  ep?.close();
  if (spawned !== null && spawned.exitCode === null) {
    spawned.kill();
  }
}
