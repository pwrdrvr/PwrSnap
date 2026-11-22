import type { HotkeySettingKey, Settings } from "./protocol";
import {
  canonicalAcceleratorForPlatform,
  physicalAcceleratorIdentity,
  type ShortcutPlatform
} from "./shortcut-semantics";

const ACTION_KEYS: Record<HotkeySettingKey, string> = {
  quickCapture: "C",
  region: "R",
  window: "W",
  fullScreen: "F",
  allScreens: "A",
  timed: "T",
  videoCapture: "V",
  reshowFloatOver: "F",
  openLibrary: "L"
};

const RESERVED: Record<ShortcutPlatform, string[]> = {
  darwin: [
    "Command+Shift+3", "Command+Shift+4", "Command+Shift+5",
    "Command+Control+Shift+3", "Command+Control+Shift+4", "Command+Control+Shift+5",
    "Command+Space"
  ],
  win32: ["Control+Shift+Escape"],
  linux: []
};

/** Candidates to try. Native availability is checked when the user applies one. */
export function suggestHotkeyAlternatives(
  platform: ShortcutPlatform,
  action: HotkeySettingKey,
  attempted: string,
  saved: Settings["hotkeys"],
  rejected: Iterable<string>
): string[] {
  const parsed = canonicalAcceleratorForPlatform(attempted, platform);
  const key = parsed.ok && parsed.key !== null && /^[A-Z0-9]$/.test(parsed.key)
    ? parsed.key
    : ACTION_KEYS[action];
  const candidates = platform === "darwin"
    ? [
        `Command+Alt+Shift+${key}`,
        `Command+Control+Alt+${key}`,
        `Command+Control+Shift+${key}`,
        `Control+Alt+Shift+${key}`
      ]
    : [`Control+Shift+${key}`, `Alt+Shift+${key}`, "Control+Shift+F9", "Control+Shift+F10", "Control+Shift+F11", "Control+Shift+F12"];
  const excluded = new Set(
    [attempted, ...Object.values(saved), ...rejected, ...RESERVED[platform]]
      .map((chord) => physicalAcceleratorIdentity(chord, platform))
  );
  return candidates.filter((candidate) => {
    const identity = physicalAcceleratorIdentity(candidate, platform);
    if (identity === null || excluded.has(identity)) return false;
    excluded.add(identity);
    return true;
  }).slice(0, 3);
}
