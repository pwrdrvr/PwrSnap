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
//   - Read manifest.json from the ZIP → `capture_id`.
//   - Look up `captures.id = capture_id` in SQLite.
//   - If found → `library:openInLibrary` (the same inline Library
//     Focus editor used by the rest of the app).
//   - If not found → notify the user; cross-machine import is a
//     future feature and shouldn't crash the open flow.
//
// Never throws during cold-start. Bad input, missing DB row, malformed
// bundle → log + Notification, don't take the app down.

import { app, BrowserWindow, Notification } from "electron";
import { extname } from "node:path";

import { bus } from "./command-bus";
import { getMainLogger } from "./log";
import { readBundleManifest } from "./persistence/bundle-store";
import { getCaptureById } from "./persistence/captures-repo";
import { createMainWindow, findMainLibraryWindow } from "./window";

const log = getMainLogger("open-file");

// Files received before `app.whenReady()` resolves go here and get
// drained later. After ready, paths are dispatched immediately.
const pendingPaths: string[] = [];
let isReady = false;

/**
 * Pull any `.pwrsnap` paths out of an argv slice. Skips electron's
 * own argv flags (Chromium switches, the executable path, etc.) by
 * filtering on the file extension. Returns paths in argv order.
 */
function extractPwrsnapPaths(argv: readonly string[]): string[] {
  return argv.filter((arg) => {
    if (typeof arg !== "string") return false;
    // Chromium passes flags like `--remote-debugging-port=` —
    // extname returns "" for those, so the suffix check filters them.
    return extname(arg).toLowerCase() === ".pwrsnap";
  });
}

/**
 * Register the macOS `open-file` listener and the cold-start argv
 * sweep. Idempotent — safe to call multiple times. MUST be called
 * before `app.whenReady().then(...)` so that an open-file event
 * fired during cold start gets caught.
 */
export function wireOpenFileHandler(): void {
  app.on("open-file", (event, path) => {
    // preventDefault tells macOS we've handled the file. Without it,
    // macOS may show a "Cannot open" dialog if no window appears
    // immediately, especially during cold start.
    event.preventDefault();
    enqueueOrOpen(path);
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
export function handleSecondInstanceArgv(argv: readonly string[]): void {
  for (const path of extractPwrsnapPaths(argv)) {
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
    void openPwrsnapInEditor(path);
  }
}

function enqueueOrOpen(path: string): void {
  if (isReady) {
    void openPwrsnapInEditor(path);
  } else {
    pendingPaths.push(path);
  }
}

/**
 * Resolve a `.pwrsnap` file path to a SQLite capture row and open
 * the editor for it. Surfaces "not in library" via Notification
 * (cross-machine bundle import is a future feature).
 */
async function openPwrsnapInEditor(bundlePath: string): Promise<void> {
  let captureId: string;
  try {
    const manifest = await readBundleManifest(bundlePath);
    captureId = manifest.capture_id;
  } catch (cause) {
    log.warn("open-file: bundle unreadable", {
      bundlePath,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    notifyUser(
      "Can't open PwrSnap file",
      "The file isn't a readable PwrSnap bundle. It may be corrupt or from a future version."
    );
    return;
  }

  const record = getCaptureById(captureId);
  if (record === null) {
    log.info("open-file: capture not in library", { bundlePath, captureId });
    // Surface the library window so the user has somewhere to land.
    const main = findMainLibraryWindow() ?? createMainWindow();
    raiseToFront(main);
    notifyUser(
      "Capture not in your library",
      "This .pwrsnap file was created on a different device. Cross-device import is coming soon."
    );
    return;
  }
  if (record.deleted_at !== null) {
    log.info("open-file: capture is in trash", { bundlePath, captureId });
    notifyUser(
      "Capture is in the trash",
      "Restore it from the library trash view before opening."
    );
    return;
  }

  log.info("open-file: opening capture in library", { bundlePath, captureId });
  const result = await bus.dispatch(
    "library:openInLibrary",
    { captureId },
    { principal: "ipc" }
  );
  if (!result.ok) {
    log.warn("open-file: library open failed", {
      bundlePath,
      captureId,
      code: result.error.code,
      message: result.error.message
    });
    notifyUser("Can't open PwrSnap file", result.error.message);
  }
}

function raiseToFront(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

function notifyUser(title: string, body: string): void {
  if (!Notification.isSupported()) {
    log.info("notification", { title, body });
    return;
  }
  new Notification({ title, body }).show();
}
