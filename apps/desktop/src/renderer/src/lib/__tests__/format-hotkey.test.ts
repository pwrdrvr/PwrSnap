// Pure-function tests for the accelerator → glyph translator. Lives
// in `lib/` alongside the helper itself; multiple surfaces (the
// library top-bar, the settings hotkey rows, the reset confirmation
// modal) all render through this same function.

import { describe, expect, test } from "vitest";
import { acceleratorToDisplayKeys } from "../format-hotkey";

describe("acceleratorToDisplayKeys", () => {
  test("translates the Electron-canonical accelerator forms", () => {
    expect(acceleratorToDisplayKeys("CommandOrControl+Shift+P")).toEqual([
      "⌘",
      "⇧",
      "P"
    ]);
    expect(acceleratorToDisplayKeys("Cmd+Shift+R")).toEqual(["⌘", "⇧", "R"]);
    expect(acceleratorToDisplayKeys("Command+Shift+W")).toEqual([
      "⌘",
      "⇧",
      "W"
    ]);
  });

  test("translates the Option / Alt and Control glyphs", () => {
    expect(acceleratorToDisplayKeys("Alt+Backspace")).toEqual(["⌥", "⌫"]);
    expect(acceleratorToDisplayKeys("Option+Return")).toEqual(["⌥", "⏎"]);
    expect(acceleratorToDisplayKeys("Control+Tab")).toEqual(["⌃", "Tab"]);
    expect(acceleratorToDisplayKeys("Ctrl+Space")).toEqual(["⌃", "Space"]);
  });

  test("returns an empty array for the empty string", () => {
    expect(acceleratorToDisplayKeys("")).toEqual([]);
  });

  test("uppercases bare letter keys for visual parity with macOS menus", () => {
    expect(acceleratorToDisplayKeys("Cmd+a")).toEqual(["⌘", "A"]);
    expect(acceleratorToDisplayKeys("Cmd+,")).toEqual(["⌘", ","]);
  });

  test("preserves arrow keys + escape", () => {
    expect(acceleratorToDisplayKeys("Cmd+Left")).toEqual(["⌘", "←"]);
    expect(acceleratorToDisplayKeys("Escape")).toEqual(["Esc"]);
  });

  test("falls through to raw text for unknown multi-char tokens", () => {
    expect(acceleratorToDisplayKeys("Cmd+F12")).toEqual(["⌘", "F12"]);
  });
});
