import { describe, expect, test } from "vitest";
import {
  admitHotkeyRecorderDocument,
  allowNextHotkeyRecorderDocument,
  fenceHotkeyRecorderDocument,
  isHotkeyRecorderDocumentId,
  isLiveHotkeyRecorderDocument
} from "../hotkey-recorder-document";

describe("hotkey recorder document epochs", () => {
  test("cleanup fences delayed old-document admission until a new load completes", () => {
    const webContentsId = 4101;
    const oldDocument = "documentepoch0001";
    const newDocument = "documentepoch0002";

    expect(admitHotkeyRecorderDocument(webContentsId, oldDocument)).toBe(
      oldDocument
    );
    expect(isLiveHotkeyRecorderDocument(webContentsId, oldDocument)).toBe(true);
    expect(fenceHotkeyRecorderDocument(webContentsId)).toBe(oldDocument);
    expect(isLiveHotkeyRecorderDocument(webContentsId, oldDocument)).toBe(false);
    expect(admitHotkeyRecorderDocument(webContentsId, oldDocument)).toBeNull();

    allowNextHotkeyRecorderDocument(webContentsId);
    expect(admitHotkeyRecorderDocument(webContentsId, newDocument)).toBe(
      newDocument
    );
    expect(isLiveHotkeyRecorderDocument(webContentsId, newDocument)).toBe(true);
  });

  test("rejects malformed or caller-shaped epochs", () => {
    expect(isHotkeyRecorderDocumentId("17:29")).toBe(false);
    expect(isHotkeyRecorderDocumentId("too-short")).toBe(false);
    expect(isHotkeyRecorderDocumentId("document epoch with spaces")).toBe(
      false
    );
    expect(isHotkeyRecorderDocumentId("documentepoch0001")).toBe(true);
  });
});
