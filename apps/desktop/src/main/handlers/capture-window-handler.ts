import {
  err,
  type CaptureRecord,
  type PwrSnapError,
  type Result
} from "@pwrsnap/shared";
import type { CommandHandler } from "../command-bus";
import type { CaptureRegionResult } from "../capture/screencapture";
import type {
  WindowBounds,
  WindowInfo,
  WindowListSnapshot
} from "../capture/window-list";

type BlockingGate = () => Promise<Result<never, PwrSnapError> | null>;

export type CaptureWindowHandlerDependencies = {
  platform: NodeJS.Platform;
  guardScreenCapture: (
    options: { routeToSettings?: boolean }
  ) => Promise<Result<never, PwrSnapError> | null>;
  ensureCapturesDirReady: BlockingGate;
  listWindowsSnapshot: () => Promise<WindowListSnapshot>;
  normalizeWindowSnapshot: (
    windows: readonly WindowInfo[],
    platform: NodeJS.Platform
  ) => readonly WindowInfo[];
  selfPidSet: () => ReadonlySet<number>;
  selfWindowBoundsList: () => readonly WindowBounds[];
  peerPwrSnapPid: () => number | null;
  boundsApproxEqual: (a: WindowBounds, b: WindowBounds) => boolean;
  captureWindow: (windowId: number) => Promise<CaptureRegionResult>;
  persistCapture: (
    tempPath: string,
    sourceWindow: WindowInfo
  ) => Promise<Result<CaptureRecord, PwrSnapError>>;
  releaseCaptureTemp: (tempPath: string) => Promise<void>;
  reportCleanupFailure: (tempPath: string, cause: unknown) => void;
};

function captureError(
  code: string,
  message: string
): Result<never, PwrSnapError> {
  return err({ kind: "capture", code, message });
}

function hasSameNativeWindowIdentity(
  before: WindowInfo,
  after: WindowInfo
): boolean {
  return (
    before.windowId === after.windowId &&
    before.pid === after.pid &&
    before.bundleId === after.bundleId &&
    before.appName === after.appName
  );
}

/**
 * Headless capture of one currently-enumerable native window.
 *
 * The numeric id is deliberately treated as an ephemeral lookup key: every
 * dispatch enumerates the platform's live window list, matches the id once,
 * and passes it only to the existing window-capture primitive. It is never
 * persisted or used to derive a path/process read.
 */
export function createCaptureWindowHandler(
  deps: CaptureWindowHandlerDependencies
): CommandHandler<"capture:window"> {
  return async (req) => {
    // IPC/RPC callers are untyped at runtime even though the shared command
    // map is typed. Read the field defensively so null/malformed payloads
    // become Result errors rather than handler throws.
    const rawRequest = req as unknown;
    const windowId =
      typeof rawRequest === "object" &&
      rawRequest !== null &&
      "windowId" in rawRequest
        ? (rawRequest as { windowId?: unknown }).windowId
        : undefined;
    if (
      typeof windowId !== "number" ||
      !Number.isSafeInteger(windowId) ||
      windowId <= 0
    ) {
      return err({
        kind: "validation",
        code: "invalid_window_id",
        message: "windowId must be a positive safe integer"
      });
    }

    if (deps.platform !== "darwin" && deps.platform !== "win32") {
      return captureError(
        "unsupported_platform",
        `capture:window is not supported on ${deps.platform}`
      );
    }

    let permissionBlocked: Result<never, PwrSnapError> | null;
    try {
      permissionBlocked = await deps.guardScreenCapture({
        routeToSettings: false
      });
    } catch {
      return err({
        kind: "permission",
        code: "screen_permission_check_failed",
        message: "PwrSnap could not verify screen-capture permission"
      });
    }
    if (permissionBlocked !== null) return permissionBlocked;

    let storageBlocked: Result<never, PwrSnapError> | null;
    try {
      storageBlocked = await deps.ensureCapturesDirReady();
    } catch {
      return captureError(
        "captures_dir_check_failed",
        "PwrSnap could not verify capture storage"
      );
    }
    if (storageBlocked !== null) return storageBlocked;

    let windows: readonly WindowInfo[];
    try {
      const snapshot = await deps.listWindowsSnapshot();
      windows = deps.normalizeWindowSnapshot(snapshot.windows, deps.platform);
    } catch {
      return captureError(
        "window_list_failed",
        "PwrSnap could not enumerate the current window list"
      );
    }

    const sourceWindow = windows.find(
      (windowInfo) => windowInfo.windowId === windowId
    );
    if (sourceWindow === undefined) {
      return captureError(
        "window_unavailable",
        `Window ${windowId} is no longer available for capture`
      );
    }

    let isOwnWindow: boolean;
    try {
      const ownPids = deps.selfPidSet();
      const ownBounds = deps.selfWindowBoundsList();
      const peerPid = deps.peerPwrSnapPid();
      isOwnWindow =
        peerPid === sourceWindow.pid ||
        (ownPids.has(sourceWindow.pid) &&
          ownBounds.some((bounds) =>
            deps.boundsApproxEqual(sourceWindow.bounds, bounds)
          ));
    } catch {
      return captureError(
        "window_ownership_check_failed",
        "PwrSnap could not safely classify the requested window"
      );
    }
    if (isOwnWindow) {
      return err({
        kind: "validation",
        code: "own_window_not_allowed",
        message: "PwrSnap cannot headlessly capture one of its own windows"
      });
    }

    let captureResult: CaptureRegionResult;
    try {
      captureResult = await deps.captureWindow(windowId);
    } catch {
      return captureError(
        "window_capture_failed",
        "The requested window could not be captured"
      );
    }
    if (!captureResult.ok) {
      return captureError(
        captureResult.reason === "revoked"
          ? "revoked"
          : "window_capture_failed",
        captureResult.reason === "revoked"
          ? "Screen-capture permission was revoked"
          : "The requested window could not be captured"
      );
    }

    try {
      let revalidatedWindows: readonly WindowInfo[];
      try {
        const snapshot = await deps.listWindowsSnapshot();
        revalidatedWindows = deps.normalizeWindowSnapshot(
          snapshot.windows,
          deps.platform
        );
      } catch {
        return captureError(
          "window_list_failed",
          "PwrSnap could not revalidate the captured window"
        );
      }

      const revalidatedWindow = revalidatedWindows.find(
        (windowInfo) => windowInfo.windowId === windowId
      );
      if (
        revalidatedWindow === undefined ||
        !hasSameNativeWindowIdentity(sourceWindow, revalidatedWindow)
      ) {
        return captureError(
          "window_unavailable",
          `Window ${windowId} changed or disappeared during capture`
        );
      }

      return await deps.persistCapture(
        captureResult.tempPath,
        revalidatedWindow
      );
    } catch {
      return captureError(
        "persist_failed",
        "The captured window could not be persisted"
      );
    } finally {
      // The v2 writer consumes the PNG on success, but its empty mkdtemp
      // parent remains. The release seam removes the exact capture-owned
      // directory and is best-effort so cleanup cannot turn an already-
      // persisted record into a false failure.
      await deps
        .releaseCaptureTemp(captureResult.tempPath)
        .catch((cause) => deps.reportCleanupFailure(captureResult.tempPath, cause));
    }
  };
}
