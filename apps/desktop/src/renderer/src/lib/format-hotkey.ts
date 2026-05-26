// Pure-function translator for Electron accelerator strings → display
// glyphs. Lives in `lib/` (not under `features/settings/`) so any
// surface — the library top-bar, the tray, the float-over, the
// in-canvas editor — can render hotkey chords without reaching across
// feature boundaries.

/**
 * Translate an Electron accelerator string (e.g. `CommandOrControl+Shift+P`,
 * `Cmd+Alt+R`, `Option+Backspace`) into the array of glyphs the
 * `Hk` component renders. Returns an empty array for an empty input
 * so callers can branch on the unbound case cleanly.
 */
export function acceleratorToDisplayKeys(accel: string): string[] {
  if (accel.length === 0) return [];
  const parts = accel.split("+").map((p) => p.trim());
  const out: string[] = [];
  for (const raw of parts) {
    out.push(modifierToGlyph(raw));
  }
  return out;
}

function modifierToGlyph(part: string): string {
  const lower = part.toLowerCase();
  switch (lower) {
    case "command":
    case "cmd":
    case "commandorcontrol":
    case "cmdorctrl":
    case "super":
      return "⌘";
    case "control":
    case "ctrl":
      return "⌃";
    case "alt":
    case "option":
      return "⌥";
    case "shift":
      return "⇧";
    case "meta":
      return "⌘";
    case "return":
    case "enter":
      return "⏎";
    case "esc":
    case "escape":
      return "Esc";
    case "tab":
      return "Tab";
    case "space":
      return "Space";
    case "backspace":
      return "⌫";
    case "delete":
      return "⌦";
    case "left":
      return "←";
    case "right":
      return "→";
    case "up":
      return "↑";
    case "down":
      return "↓";
    default:
      // Single-character keys (letters / digits / punctuation):
      // uppercase letters for visual parity with how macOS draws
      // them in menus.
      return part.length === 1 ? part.toUpperCase() : part;
  }
}
