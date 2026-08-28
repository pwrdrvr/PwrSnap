import { describe, expect, test } from "vitest";
import type { CapturesLocationStatus } from "@pwrsnap/shared";
import { moveBackBlockedMessage } from "../capture-storage-copy";

const blockedStatus: CapturesLocationStatus = {
  location: "home",
  documentsAccess: "confirmed",
  homeCaptureReferences: 1,
  homeDirectoryEntryCount: 1,
  canMoveToDocuments: false,
  overridden: false
};

describe("moveBackBlockedMessage", () => {
  test("describes the guarded root switch without claiming to migrate a Windows library", () => {
    const message = moveBackBlockedMessage(blockedStatus, "win32");

    expect(message).toContain("%USERPROFILE%\\PwrSnap");
    expect(message).toContain("Documents\\PwrSnap");
    expect(message).toContain("future captures");
    expect(message).toContain("does not migrate a populated library");
    expect(message).toContain("home folder is empty");
    expect(message).toContain("including items in Trash");
    expect(message).not.toContain("active captures folder");
  });

  test("preserves the Darwin home and Documents destinations", () => {
    const message = moveBackBlockedMessage(blockedStatus, "darwin");

    expect(message).toContain("~/PwrSnap");
    expect(message).toContain("~/Documents/PwrSnap");
    expect(message).not.toContain("active captures folder");
  });
});
