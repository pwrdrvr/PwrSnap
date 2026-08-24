import { describe, expect, test } from "vitest";
import {
  acceleratorToAccessibleText,
  acceleratorToDisplayKeys,
  acceleratorToDisplayText
} from "../format-hotkey";

describe("renderer shortcut formatting", () => {
  test("renders portable accelerators for macOS", () => {
    expect(acceleratorToDisplayKeys("CommandOrControl+Shift+P", "darwin")).toEqual([
      "⌘",
      "⇧",
      "P"
    ]);
    expect(acceleratorToDisplayKeys("Cmd+Shift+R", "darwin")).toEqual(["⌘", "⇧", "R"]);
    expect(acceleratorToDisplayKeys("Alt+Backspace", "darwin")).toEqual(["⌥", "⌫"]);
    expect(acceleratorToDisplayKeys("Control+Tab", "darwin")).toEqual(["⌃", "Tab"]);
  });

  test("renders portable accelerators for Windows", () => {
    expect(acceleratorToDisplayKeys("CommandOrControl+Shift+P", "win32")).toEqual([
      "Ctrl",
      "Shift",
      "P"
    ]);
    expect(acceleratorToDisplayText("Control+Super+Alt+C", "win32")).toBe(
      "Ctrl+Win+Alt+C"
    );
    expect(acceleratorToAccessibleText("Control+Super+Alt+C", "win32")).toBe(
      "Control plus Windows plus Alt plus C"
    );
  });

  test("returns an empty presentation for an unbound shortcut", () => {
    expect(acceleratorToDisplayKeys("", "darwin")).toEqual([]);
    expect(acceleratorToDisplayText("", "win32")).toBe("");
  });

  test("normalizes letter case and named keys", () => {
    expect(acceleratorToDisplayKeys("Cmd+a", "darwin")).toEqual(["⌘", "A"]);
    expect(acceleratorToDisplayKeys("Cmd+Left", "darwin")).toEqual(["⌘", "←"]);
    expect(acceleratorToDisplayKeys("Control+F12", "win32")).toEqual(["Ctrl", "F12"]);
    expect(acceleratorToDisplayKeys("Control+Return", "win32")).toEqual(["Ctrl", "Enter"]);
  });

  test("win32 output never contains Cmd or the Command glyph", () => {
    const accelerators = [
      "CommandOrControl+Shift+C",
      "CmdOrCtrl+Alt+R",
      "Cmd+P",
      "Super+Shift+C",
      "Meta+Delete"
    ];
    const output = accelerators
      .flatMap((accelerator) => [
        ...acceleratorToDisplayKeys(accelerator, "win32"),
        acceleratorToDisplayText(accelerator, "win32"),
        acceleratorToAccessibleText(accelerator, "win32")
      ])
      .join(" ");
    expect(output).not.toContain("Cmd");
    expect(output).not.toContain("⌘");
  });
});
