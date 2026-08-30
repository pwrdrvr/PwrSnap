import { describe, expect, test } from "vitest";
import {
  admitHotkeyRecorderDocument,
  fenceHotkeyRecorderDocument
} from "../hotkey-recorder-document";
import {
  attestSettingsHotkeyRecorderOwnerForBridge,
  isLiveSettingsHotkeyRecorderOwner
} from "../hotkey-recorder-owner";

const DOCUMENT_A = "documentepoch0001";

function settingsWindow(options: {
  windowId?: number;
  webContentsId?: number;
  destroyed?: boolean;
  rendererDestroyed?: boolean;
} = {}) {
  return {
    id: options.windowId ?? 41,
    isDestroyed: () => options.destroyed ?? false,
    webContents: {
      id: options.webContentsId ?? 4101,
      isDestroyed: () => options.rendererDestroyed ?? false
    }
  };
}

describe("isLiveSettingsHotkeyRecorderOwner", () => {
  test("accepts only the live Settings singleton and its current document epoch", () => {
    const settings = settingsWindow();
    expect(admitHotkeyRecorderDocument(settings.webContents.id, DOCUMENT_A)).toBe(
      DOCUMENT_A
    );

    expect(isLiveSettingsHotkeyRecorderOwner(settings, 41, DOCUMENT_A)).toBe(true);
    expect(isLiveSettingsHotkeyRecorderOwner(settings, 88, DOCUMENT_A)).toBe(false);
    expect(isLiveSettingsHotkeyRecorderOwner(null, 41, DOCUMENT_A)).toBe(false);
    expect(
      isLiveSettingsHotkeyRecorderOwner(
        settingsWindow({ destroyed: true }),
        41,
        DOCUMENT_A
      )
    ).toBe(false);
    expect(
      isLiveSettingsHotkeyRecorderOwner(
        settingsWindow({ rendererDestroyed: true }),
        41,
        DOCUMENT_A
      )
    ).toBe(false);
  });

  test("keeps a fenced old document unauthorized after lifecycle cleanup", () => {
    const settings = settingsWindow({ webContentsId: 4102 });
    expect(admitHotkeyRecorderDocument(settings.webContents.id, DOCUMENT_A)).toBe(
      DOCUMENT_A
    );
    expect(fenceHotkeyRecorderDocument(settings.webContents.id)).toBe(DOCUMENT_A);

    expect(isLiveSettingsHotkeyRecorderOwner(settings, 41, DOCUMENT_A)).toBe(false);
  });

  test("attests a bridged recorder command only while Settings owns the document", () => {
    const settings = settingsWindow({ webContentsId: 4103 });
    expect(admitHotkeyRecorderDocument(settings.webContents.id, DOCUMENT_A)).toBe(
      DOCUMENT_A
    );
    const context = {
      principal: "ipc" as const,
      sourceWindowId: 41,
      sourceDocumentId: DOCUMENT_A
    };

    expect(
      attestSettingsHotkeyRecorderOwnerForBridge(
        "settings:beginHotkeyRecording",
        context,
        settings
      )
    ).toEqual({ ...context, sourceSettingsHotkeyRecorderOwner: true });
    expect(
      attestSettingsHotkeyRecorderOwnerForBridge("settings:read", context, settings)
    ).toBe(context);

    fenceHotkeyRecorderDocument(settings.webContents.id);
    expect(
      attestSettingsHotkeyRecorderOwnerForBridge(
        "settings:beginHotkeyRecording",
        context,
        settings
      )
    ).toBe(context);
  });
});
