import {
  capturesFolderDisplayPath,
  type CapturesLocationStatus
} from "@pwrsnap/shared";

/** Truthful remediation for the guarded home-fallback → Documents switch.
 * The command selects the root for future captures; it does not migrate a
 * populated library or rewrite absolute paths already stored in SQLite. */
export function moveBackBlockedMessage(
  status: CapturesLocationStatus,
  platform: string = process.platform
): string {
  if (status.overridden) {
    return "The captures root is controlled by PWRSNAP_DATA_ROOT and can't be changed here.";
  }
  if (status.location !== "home") {
    return "PwrSnap is already saving new captures to Documents.";
  }
  if (status.documentsAccess !== "confirmed") {
    return "Check Documents access successfully before moving new captures back.";
  }

  const homeFolder = capturesFolderDisplayPath(platform, "home");
  const documentsFolder = capturesFolderDisplayPath(platform, "documents");
  return `${homeFolder} still contains captures or database references, so PwrSnap will keep saving there. This action only selects ${documentsFolder} for future captures; it does not migrate a populated library. Retry only after the home folder is empty and every database reference to it, including items in Trash, has been permanently removed.`;
}
