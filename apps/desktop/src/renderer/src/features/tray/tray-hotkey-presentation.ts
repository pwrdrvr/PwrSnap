import {
  acceleratorToDisplayKeys,
  type HotkeyRegistrationStatusSnapshot,
  type HotkeySettingKey,
  type Settings,
  type ShortcutPlatform
} from "@pwrsnap/shared";

export const TRAY_MODE_HOTKEY: Readonly<
  Record<"region" | "window" | "full" | "all" | "timed", HotkeySettingKey>
> = {
  region: "region",
  window: "window",
  full: "fullScreen",
  all: "allScreens",
  timed: "timed"
};

/**
 * A tray hint describes runtime ownership, not just persisted intent. Fail
 * closed while status is loading, after a boot conflict, while recording has
 * suspended registration, or when an older status snapshot names a different
 * accelerator.
 */
export function activeTrayHotkeyKeys(
  hotkeys: Settings["hotkeys"],
  status: HotkeyRegistrationStatusSnapshot | null,
  key: HotkeySettingKey,
  platform: ShortcutPlatform
): string[] {
  const accelerator = hotkeys[key];
  const registration = status?.[key];
  if (
    accelerator.length === 0 ||
    registration?.state !== "active" ||
    registration.accelerator !== accelerator
  ) {
    return [];
  }
  return acceleratorToDisplayKeys(accelerator, platform);
}
