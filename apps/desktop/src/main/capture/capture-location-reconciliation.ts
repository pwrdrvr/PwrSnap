import type { DesktopSettingsStoreApi } from "../settings/desktop-settings-store";
import { countCapturePathReferencesUnder } from "../persistence/captures-repo";
import {
  getCapturesLocation,
  getHomeCapturesRoot,
  isOverriddenDataRoot,
  setCapturesLocation
} from "../persistence/paths";

export type CapturesLocationReconciliation =
  | { changed: false; homeCaptureReferences: number }
  | {
      changed: true;
      homeCaptureReferences: number;
      persisted: boolean;
      error?: unknown;
    };

/**
 * Repair a missing/corrupt/unreadable setting from the durable paths already
 * stored in SQLite. This runs immediately after the agent opens the DB and
 * before migrations or capture handlers can create anything at Documents.
 */
export async function reconcileCapturesLocationOnBoot(
  settingsService: Pick<DesktopSettingsStoreApi, "write">
): Promise<CapturesLocationReconciliation> {
  if (isOverriddenDataRoot() || getCapturesLocation() === "home") {
    return { changed: false, homeCaptureReferences: 0 };
  }

  const homeCaptureReferences = countCapturePathReferencesUnder(getHomeCapturesRoot());
  if (homeCaptureReferences === 0) {
    return { changed: false, homeCaptureReferences };
  }

  // Protect this process immediately even if the settings file is still
  // unreadable. A later boot can retry persistence, but this boot must not
  // split the library by creating new captures under Documents.
  setCapturesLocation("home");
  try {
    await settingsService.write({ storage: { capturesLocation: "home" } });
    return { changed: true, homeCaptureReferences, persisted: true };
  } catch (error) {
    return { changed: true, homeCaptureReferences, persisted: false, error };
  }
}
