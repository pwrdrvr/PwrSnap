// open-file — handles "open this `.pwrsnap` file in PwrSnap" requests
// from the OS. Three entry points all land here:
//
//   1. macOS double-click in Finder / "Open With" menu / drag-onto-
//      Dock-icon: `app.on('open-file', ...)`. This event MUST be
//      registered before `app.whenReady()` because macOS can dispatch
//      it during cold-start, before any windows exist. We queue
//      incoming paths and drain after the DB is open.
//
//   2. Cold-start via terminal (`open foo.pwrsnap` or
//      `PwrSnap.app/Contents/MacOS/PwrSnap /path/to/foo.pwrsnap`):
//      the file path lands in `process.argv`. We sweep argv once at
//      boot.
//
//   3. Already-running second-instance attempt: `app.on('second-
//      instance', ...)` receives the new process's `argv` and we
//      pass any `.pwrsnap` paths through this module.
//
// Resolving a path to an open-editor action:
//   - Normalize the OS-native path (macOS POSIX, Windows drive/UNC).
//   - Snapshot and validate the complete v2 image bundle.
//   - Open an identical local capture, or transactionally import a safe
//     app-owned copy (with deterministic collision handling).
//   - Broadcast the new row and route through `library:openInLibrary`.
//
// Never throws during cold-start. Bad input, missing DB row, malformed
// bundle → log + Notification, don't take the app down.

import { app, Notification } from "electron";
import { extname } from "node:path";

import { bus } from "./command-bus";
import { broadcastCapturesChanged } from "./events";
import { normalizePwrsnapOpenPath } from "./import/pwrsnap-open-path";
import { InvalidPwrsnapOpenPathError } from "./import/pwrsnap-open-path";
import { safeImportFailureLog } from "./import/pwrsnap-import-error-report";
import { importPwrsnapBundle } from "./import/pwrsnap-import-service";
import { PwrsnapImportError } from "./import/pwrsnap-import-reader";
import { getMainLogger } from "./log";

const log = getMainLogger("open-file");
const SECOND_INSTANCE_OPEN_FILE_PATHS_KEY = "pwrsnapOpenFilePaths";

// Files received before `app.whenReady()` resolves go here and get
// drained later. After ready, paths are dispatched immediately.
const pendingPaths: string[] = [];
let isReady = false;
let isWired = false;
let forwardToPrimaryOnly = false;
const forwardedPaths = new Set<string>();
let openQueue: Promise<void> = Promise.resolve();

/**
 * Pull any `.pwrsnap` paths out of an argv slice. Skips electron's
 * own argv flags (Chromium switches, the executable path, etc.) by
 * filtering on the file extension. Returns paths in argv order.
 */
function extractPwrsnapPaths(argv: readonly string[]): string[] {
  return argv.filter((arg) => {
    if (typeof arg !== "string") return false;
    if (arg.startsWith("-")) return false;
    // Chromium passes flags like `--remote-debugging-port=` —
    // extname returns "" for those, so the suffix check filters them.
    return extname(arg).toLowerCase() === ".pwrsnap";
  });
}

function extractHandoffOpenFilePaths(additionalData: unknown): string[] {
  if (typeof additionalData !== "object" || additionalData === null) return [];
  const candidate = (additionalData as Record<string, unknown>)[
    SECOND_INSTANCE_OPEN_FILE_PATHS_KEY
  ];
  if (!Array.isArray(candidate)) return [];
  return extractPwrsnapPaths(candidate.filter((item): item is string => typeof item === "string"));
}

/**
 * Register the macOS `open-file` listener and the cold-start argv
 * sweep. Idempotent — safe to call multiple times. MUST be called
 * before `app.whenReady().then(...)` so that an open-file event
 * fired during cold start gets caught.
 */
export function wireOpenFileHandler(): void {
  if (isWired) return;
  isWired = true;
  app.on("open-file", (event, path) => {
    // preventDefault tells macOS we've handled the file. Without it,
    // macOS may show a "Cannot open" dialog if no window appears
    // immediately, especially during cold start.
    event.preventDefault();
    enqueueOrOpen(path);
    if (forwardToPrimaryOnly) {
      forwardQueuedOpenFilesToPrimary();
    }
  });

  // Cold-start argv sweep. On macOS double-click doesn't pass the
  // path through argv (it uses open-file instead), but `open
  // foo.pwrsnap` from a terminal does. Run it once before the
  // app-ready handler so the path is queued no matter how it arrived.
  for (const path of extractPwrsnapPaths(process.argv.slice(1))) {
    enqueueOrOpen(path);
  }
}

/**
 * Build the payload passed to `requestSingleInstanceLock(additionalData)`.
 *
 * This is load-bearing for dev/manual testing: Finder may launch the
 * installed `/Applications/PwrSnap.app` for a `.pwrsnap` while a
 * source-tree dev build already owns the single-instance lock. The
 * installed app will lose the lock and exit, but Electron forwards
 * this payload to the running instance before it does. Without it,
 * macOS open-file paths captured in the losing process die with that
 * process.
 */
export function singleInstanceOpenFileHandoffData(): Record<string, unknown> {
  return openFileHandoffData(pendingPaths);
}

function openFileHandoffData(paths: readonly string[]): Record<string, unknown> {
  return {
    [SECOND_INSTANCE_OPEN_FILE_PATHS_KEY]: [...paths]
  };
}

export function enableOpenFileForwardingToPrimary(): void {
  forwardToPrimaryOnly = true;
}

export function markQueuedOpenFilesForwarded(): void {
  for (const path of pendingPaths) {
    forwardedPaths.add(path);
  }
}

export function forwardQueuedOpenFilesToPrimary(): void {
  const unforwarded = pendingPaths.filter((path) => !forwardedPaths.has(path));
  if (unforwarded.length === 0) return;
  for (const path of unforwarded) {
    forwardedPaths.add(path);
  }
  app.requestSingleInstanceLock(openFileHandoffData(unforwarded));
}

/**
 * Called from the `second-instance` listener — receives the newer
 * process's argv and queues any `.pwrsnap` paths. The newer process
 * has already exited (single-instance lock); we're handling its
 * requested files.
 *
 * Rare path on macOS: GUI double-click on a `.pwrsnap` while
 * PwrSnap is already running dispatches the `open-file` event
 * directly to the running app, NOT a second-instance spawn — argv
 * is never re-evaluated. This handler covers (a) `open foo.pwrsnap`
 * from a terminal while the app is running, (b) drag-onto-Dock
 * shortcuts that occasionally land via argv depending on macOS
 * version. Mostly defense-in-depth so a future macOS behavior
 * change doesn't silently drop file opens.
 */
export function handleSecondInstanceArgv(
  argv: readonly string[],
  additionalData?: unknown
): void {
  const paths = [
    ...extractHandoffOpenFilePaths(additionalData),
    ...extractPwrsnapPaths(argv)
  ];
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    enqueueOrOpen(path);
  }
}

/**
 * Called after `app.whenReady()` resolves AND the DB is open AND
 * handlers are registered. Drains the pending queue and switches
 * subsequent calls to immediate dispatch.
 */
export function processQueuedOpenFiles(): void {
  isReady = true;
  const drained = pendingPaths.splice(0, pendingPaths.length);
  for (const path of drained) {
    scheduleOpen(path);
  }
}

function enqueueOrOpen(path: string): void {
  if (forwardToPrimaryOnly) {
    if (extractPwrsnapPaths([path]).length > 0) {
      pendingPaths.push(path);
    }
    return;
  }
  if (isReady) {
    scheduleOpen(path);
  } else {
    pendingPaths.push(path);
  }
}

/**
 * Serialize open/import requests so multiple Finder/Explorer selections retain
 * OS order and cannot race destination naming or final Focus selection.
 */
function scheduleOpen(path: string): void {
  openQueue = openQueue
    .catch(() => undefined)
    .then(() => openPwrsnapInEditor(path));
}

async function openPwrsnapInEditor(bundlePath: string): Promise<void> {
  let normalizedPath: string;
  try {
    normalizedPath = normalizePwrsnapOpenPath(bundlePath);
  } catch (cause) {
    log.warn("open-file: rejected non-native or malformed path", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
    notifyUser(
      "Can't open PwrSnap file",
      cause instanceof InvalidPwrsnapOpenPathError
        ? cause.message
        : "The selected file path is invalid."
    );
    return;
  }

  try {
    const outcome = await importPwrsnapBundle(normalizedPath);
    if (outcome.status === "imported") {
      broadcastCapturesChanged([outcome.record.id]);
      notifyUser(
        "Imported PwrSnap capture",
        outcome.captureIdChanged
          ? "A different capture already used this file's ID, so PwrSnap imported a separate safe copy."
          : "The capture was copied into your library and is ready to edit."
      );
    } else {
      notifyUser(
        "Already in your PwrSnap library",
        "This bundle matches an existing capture, which PwrSnap is opening now."
      );
    }
    await openCaptureInLibrary(outcome.record.id);
  } catch (cause) {
    log.warn("open-file: bundle import failed", safeImportFailureLog(cause));
    notifyImportFailure(cause);
  }
}

async function openCaptureInLibrary(captureId: string): Promise<void> {
  log.info("open-file: opening capture in library", { captureId });
  let result: Awaited<ReturnType<typeof bus.dispatch>>;
  try {
    result = await bus.dispatch(
      "library:openInLibrary",
      { captureId },
      { principal: "ipc" }
    );
  } catch (cause) {
    log.warn("open-file: library open threw", {
      captureId,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    notifyUser(
      "Capture saved, but couldn't open",
      "The capture is safely in your library. Open PwrSnap and select it there."
    );
    return;
  }
  if (!result.ok) {
    log.warn("open-file: library open failed", {
      captureId,
      code: result.error.code,
      message: result.error.message
    });
    notifyUser("Can't open PwrSnap file", result.error.message);
  }
}

function notifyImportFailure(cause: unknown): void {
  if (cause instanceof PwrsnapImportError) {
    if (cause.kind === "unsupported") {
      notifyUser("Unsupported PwrSnap file", cause.message);
      return;
    }
    if (cause.kind === "corrupt" || cause.kind === "unsafe") {
      notifyUser(
        "Can't import PwrSnap file",
        `${cause.message} The original file was left unchanged.`
      );
      return;
    }
    notifyUser(
      "PwrSnap import failed",
      `${cause.message} No existing capture or source file was changed.`
    );
    return;
  }
  notifyUser(
    "PwrSnap import failed",
    "The import could not be completed. No existing capture or source file was changed."
  );
}

function notifyUser(title: string, body: string): void {
  if (!Notification.isSupported()) {
    log.info("notification", { title, body });
    return;
  }
  new Notification({ title, body }).show();
}
