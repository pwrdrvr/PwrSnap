import { BrowserWindow, shell } from "electron";
import { readdir } from "node:fs/promises";
import {
  EVENT_CHANNELS,
  err,
  ok,
  type CapturesLocationStatus
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import {
  ensureCapturesDirReady,
  getCapturesRootAccessState,
  runExclusiveCapturesRootOperation
} from "../capture/capture-storage-gate";
import { getMainLogger } from "../log";
import { countCapturePathReferencesUnder } from "../persistence/captures-repo";
import {
  getCapturesLocation,
  getCapturesRootForLocation,
  getHomeCapturesRoot,
  isOverriddenDataRoot,
  setCapturesLocation
} from "../persistence/paths";
import { relayRendererEventToPeer } from "../process-split/event-relay";
import {
  getCapturesAccessHealth,
  onCapturesAccessHealthChanged,
  reportCapturesAccessFailure,
  reportCapturesAccessSuccess
} from "../storage/captures-access-health";

const log = getMainLogger("pwrsnap:capture-storage-handlers");
const ACCESS_PROBE_NAME = ".pwrsnap-access-probe";
let captureStorageEventsRegistered = false;

/** Agent-owned capture-root commands. Keeping the guarded switch in the same
 * process as capture persistence makes the shared exclusive queue real in
 * both combined and split-process modes. */
export function registerCaptureStorageHandlers(): void {
  registerCaptureStorageEventBroadcast();

  bus.register("storage:capturesAccessHealth", async () => {
    return ok(getCapturesAccessHealth());
  });

  bus.register("storage:capturesLocationStatus", async () => {
    try {
      return ok(await getCapturesLocationStatus());
    } catch (cause) {
      return err({
        kind: "persistence",
        code: "captures_location_status_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });

  bus.register("storage:openCapturesAccessSettings", async () => {
    if (process.platform !== "darwin") return ok(undefined);
    try {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
      );
      return ok(undefined);
    } catch (cause) {
      log.warn("storage:openCapturesAccessSettings failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "persistence",
        code: "open_privacy_settings_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });

  bus.register("storage:checkCapturesAccess", async () => {
    const blocked = await ensureCapturesDirReady({
      force: true,
      location: "documents",
      fallbackOnDenial: false
    });
    const root = getCapturesRootForLocation("documents");
    if (blocked === null) {
      reportCapturesAccessSuccess(root);
      return ok({ granted: true });
    }
    reportCapturesAccessFailure(root, blocked.ok ? undefined : blocked.error.cause);
    return ok({ granted: false });
  });

  bus.register("storage:moveCapturesToDocuments", async () => {
    try {
      return await runExclusiveCapturesRootOperation(async () => {
        // Revalidate while holding the same queue capture persistence uses.
        // A home capture can no longer land between this snapshot and the
        // settings commit.
        const status = await getCapturesLocationStatus();
        if (!status.canMoveToDocuments) {
          return err({
            kind: "persistence",
            code: "captures_move_not_allowed",
            message: moveBackBlockedMessage(status)
          });
        }

        const written = await bus.dispatch(
          "settings:write",
          { storage: { capturesLocation: "documents" } },
          { principal: "bridge" }
        );
        if (!written.ok) return err(written.error);

        setCapturesLocation("documents");
        return ok(await getCapturesLocationStatus());
      });
    } catch (cause) {
      return err({
        kind: "persistence",
        code: "captures_move_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });
}

async function getCapturesLocationStatus(): Promise<CapturesLocationStatus> {
  const overridden = isOverriddenDataRoot();
  const homeRoot = getHomeCapturesRoot();
  const [homeCaptureReferences, homeDirectoryEntryCount] = await Promise.all([
    Promise.resolve(countCapturePathReferencesUnder(homeRoot)),
    countHomeDirectoryEntries(homeRoot)
  ]);
  const location = getCapturesLocation();
  const documentsAccess = getCapturesRootAccessState("documents");
  return {
    location,
    documentsAccess,
    homeCaptureReferences,
    homeDirectoryEntryCount,
    canMoveToDocuments:
      !overridden &&
      location === "home" &&
      documentsAccess === "confirmed" &&
      homeCaptureReferences === 0 &&
      homeDirectoryEntryCount === 0,
    overridden
  };
}

async function countHomeDirectoryEntries(root: string): Promise<number> {
  try {
    const entries = await readdir(root);
    return entries.filter((name) => name !== ACCESS_PROBE_NAME).length;
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      (cause as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return 0;
    }
    throw cause;
  }
}

function moveBackBlockedMessage(status: CapturesLocationStatus): string {
  if (status.overridden) {
    return "The captures root is controlled by PWRSNAP_DATA_ROOT and can't be changed here.";
  }
  if (status.location !== "home") {
    return "PwrSnap is already saving new captures to Documents.";
  }
  if (status.documentsAccess !== "confirmed") {
    return "Check Documents access successfully before moving new captures back.";
  }
  return "~/PwrSnap still contains captures or database references. Remove or relocate them before switching roots.";
}

function registerCaptureStorageEventBroadcast(): void {
  if (captureStorageEventsRegistered) return;
  captureStorageEventsRegistered = true;
  onCapturesAccessHealthChanged((health) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(EVENT_CHANNELS.capturesAccessChanged, health);
    }
    relayRendererEventToPeer(EVENT_CHANNELS.capturesAccessChanged, health);
  });
}
