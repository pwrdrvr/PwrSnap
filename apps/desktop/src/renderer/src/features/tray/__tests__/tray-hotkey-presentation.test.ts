import { describe, expect, test } from "vitest";
import {
  defaultHotkeysForPlatform,
  type HotkeyRegistrationStatusSnapshot,
  type HotkeySettingKey,
  type Settings
} from "@pwrsnap/shared";
import {
  activeTrayHotkeyKeys,
  TRAY_MODE_HOTKEY
} from "../tray-hotkey-presentation";

function statusFor(
  hotkeys: Settings["hotkeys"],
  state: "active" | "inactive" | "suspended"
): HotkeyRegistrationStatusSnapshot {
  return Object.fromEntries(
    (Object.keys(hotkeys) as HotkeySettingKey[]).map((key) => [
      key,
      {
        key,
        accelerator: hotkeys[key],
        state: hotkeys[key] === "" ? "unbound" : state,
        failure:
          state === "inactive"
            ? { code: "unavailable", message: "Another app owns this shortcut." }
            : null
      }
    ])
  ) as HotkeyRegistrationStatusSnapshot;
}

describe("activeTrayHotkeyKeys", () => {
  test("shows every configured explicit-mode chord only while runtime registration is active", () => {
    const hotkeys = {
      ...defaultHotkeysForPlatform("win32"),
      region: "Control+Shift+R",
      window: "Control+Shift+W",
      fullScreen: "Control+Shift+F",
      allScreens: "Control+Shift+A",
      timed: "Control+Shift+T"
    };
    const status = statusFor(hotkeys, "active");

    expect(
      Object.values(TRAY_MODE_HOTKEY).map((key) =>
        activeTrayHotkeyKeys(hotkeys, status, key, "win32").join("+")
      )
    ).toEqual([
      "Ctrl+Shift+R",
      "Ctrl+Shift+W",
      "Ctrl+Shift+F",
      "Ctrl+Shift+A",
      "Ctrl+Shift+T"
    ]);
  });

  test.each([null, "inactive", "suspended"] as const)(
    "omits a persisted chord when runtime status is %s",
    (state) => {
      const hotkeys = defaultHotkeysForPlatform("win32");
      const status = state === null ? null : statusFor(hotkeys, state);
      expect(activeTrayHotkeyKeys(hotkeys, status, "quickCapture", "win32")).toEqual([]);
    }
  );

  test("omits stale status and never emits Cmd or its glyph on Windows", () => {
    const hotkeys = defaultHotkeysForPlatform("win32");
    const status = statusFor(hotkeys, "active");
    status.quickCapture = {
      ...status.quickCapture,
      accelerator: "CommandOrControl+Shift+X"
    };

    const rendered = activeTrayHotkeyKeys(
      hotkeys,
      status,
      "quickCapture",
      "win32"
    ).join("+");
    expect(rendered).toBe("");
    expect(rendered).not.toMatch(/Cmd|⌘/u);
  });
});
