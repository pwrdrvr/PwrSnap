// Pure-function translator for Electron accelerator strings → display
// glyphs. Split out of HotkeysPage.tsx so that file exports only React
// components — a non-component export sitting next to a component
// causes vite-plugin-react to bail out of Fast Refresh, which (when
// the invalidation bubbles up to App.tsx) leaves the renderer with a
// half-applied module graph and stale state.

/**
 * Translate an Electron accelerator string (e.g. `CommandOrControl+Shift+P`,
 * `Cmd+Alt+R`, `Option+Backspace`) into the array of glyphs the
 * `Hk` component renders. Returns an empty array for an empty input
 * so the page can render `<HkUnset />` cleanly.
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
