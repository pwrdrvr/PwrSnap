import { describe, expect, test } from "vitest";
import {
  acceleratorToAccessibleText,
  acceleratorToDisplay,
  acceleratorToDisplayKeys,
  acceleratorToDisplayText,
  acceleratorsAreEquivalent,
  canonicalAcceleratorForPlatform,
  normalizeAccelerator,
  shortcutPlatformFromString
} from "../shortcut-semantics";
import { defaultHotkeysForPlatform } from "../protocol";

describe("shortcut platform semantics", () => {
  test("leaves secondary defaults unbound outside macOS", () => {
    expect(defaultHotkeysForPlatform("darwin")).toMatchObject({
      videoCapture: "CommandOrControl+Alt+C",
      reshowFloatOver: "CommandOrControl+Alt+Shift+F"
    });
    for (const platform of ["win32", "linux"] as const) {
      const defaults = defaultHotkeysForPlatform(platform);
      expect(defaults).toMatchObject({
        videoCapture: "",
        reshowFloatOver: ""
      });
      expect(defaults.videoCapture).not.toContain("Control+Alt");
      expect(defaults.reshowFloatOver).not.toContain("Control+Alt");
      expect(defaults.videoCapture).not.toContain("Super");
      expect(defaults.reshowFloatOver).not.toContain("Super");
    }
  });

  test("coerces supported values and defaults unknown values to non-Mac semantics", () => {
    expect(shortcutPlatformFromString("darwin")).toBe("darwin");
    expect(shortcutPlatformFromString("win32")).toBe("win32");
    expect(shortcutPlatformFromString("linux")).toBe("linux");
    expect(shortcutPlatformFromString(undefined)).toBe("linux");
    expect(shortcutPlatformFromString("freebsd")).toBe("linux");
  });

  test("renders the same portable chord with native platform labels", () => {
    const accelerator = "CommandOrControl+Shift+C";
    expect(acceleratorToDisplay(accelerator, "darwin")).toEqual({
      keys: ["⌘", "⇧", "C"],
      text: "⌘⇧C",
      accessibleText: "Command plus Shift plus C"
    });
    expect(acceleratorToDisplay(accelerator, "win32")).toEqual({
      keys: ["Ctrl", "Shift", "C"],
      text: "Ctrl+Shift+C",
      accessibleText: "Control plus Shift plus C"
    });
  });

  test("distinguishes Windows, Ctrl, Alt, and Shift modifiers", () => {
    expect(acceleratorToDisplayKeys("Control+Super+Alt+Shift+C", "win32")).toEqual([
      "Ctrl",
      "Win",
      "Alt",
      "Shift",
      "C"
    ]);
    expect(acceleratorToDisplayText("Meta+Shift+P", "win32")).toBe("Win+Shift+P");
    expect(acceleratorToAccessibleText("Super+Shift+P", "win32")).toBe(
      "Windows plus Shift plus P"
    );
  });

  test("uses Windows names for editing keys", () => {
    expect(acceleratorToDisplayText("Control+Return", "win32")).toBe("Ctrl+Enter");
    expect(acceleratorToDisplayText("Control+Backspace", "win32")).toBe("Ctrl+Backspace");
    expect(acceleratorToDisplayText("Control+Delete", "win32")).toBe("Ctrl+Delete");
  });

  test("never emits Cmd or the Command glyph for win32", () => {
    const corpus = [
      "CommandOrControl+Shift+C",
      "CmdOrCtrl+Alt+R",
      "Command+Shift+P",
      "Cmd+Left",
      "Super+1",
      "Meta+Delete",
      "⌘+C",
      "CmdLike+C"
    ];
    for (const accelerator of corpus) {
      const display = acceleratorToDisplay(accelerator, "win32");
      const output = [display.text, display.accessibleText, ...display.keys].join(" ");
      expect(output).not.toContain("Cmd");
      expect(output).not.toContain("⌘");
    }
  });

  test("compares portable aliases and AltGr by physical platform semantics", () => {
    expect(
      acceleratorsAreEquivalent(
        "CommandOrControl+Shift+C",
        "Control+Shift+C",
        "win32"
      )
    ).toBe(true);
    expect(
      acceleratorsAreEquivalent("AltGr+Q", "Control+Alt+Q", "win32")
    ).toBe(true);
    expect(
      acceleratorsAreEquivalent("Super+Shift+C", "Control+Shift+C", "win32")
    ).toBe(false);
    expect(
      acceleratorsAreEquivalent(
        "CommandOrControl+Shift+C",
        "Command+Shift+C",
        "darwin"
      )
    ).toBe(true);
  });

  test("canonicalizes portable ownership aliases but preserves explicit AltGr", () => {
    expect(
      canonicalAcceleratorForPlatform("CommandOrControl+Shift+C", "win32")
    ).toMatchObject({
      ok: true,
      normalized: "Control+Shift+C"
    });
    expect(
      canonicalAcceleratorForPlatform("CommandOrControl+Shift+C", "darwin")
    ).toMatchObject({
      ok: true,
      normalized: "Command+Shift+C"
    });
    expect(canonicalAcceleratorForPlatform("AltGr+Q", "win32")).toMatchObject({
      ok: true,
      normalized: "AltGr+Q"
    });
  });
});

describe("normalizeAccelerator", () => {
  test("normalizes aliases and platform ordering", () => {
    expect(normalizeAccelerator("shift+ctrl+c", "win32")).toEqual({
      ok: true,
      input: "shift+ctrl+c",
      normalized: "Control+Shift+C",
      modifiers: ["Control", "Shift"],
      key: "C",
      unbound: false
    });
    expect(normalizeAccelerator("Meta+Control+c", "win32")).toMatchObject({
      ok: true,
      normalized: "Control+Super+C",
      modifiers: ["Control", "Super"]
    });
    expect(normalizeAccelerator("CmdOrCtrl+Option+Return", "darwin")).toMatchObject({
      ok: true,
      normalized: "CommandOrControl+Alt+Return"
    });
  });

  test("accepts empty input only as the explicit unbound value", () => {
    expect(normalizeAccelerator("", "win32")).toMatchObject({
      ok: true,
      normalized: "",
      unbound: true
    });
    expect(normalizeAccelerator("C", "win32")).toMatchObject({
      ok: false,
      code: "missing_modifier"
    });
  });

  test("rejects unsupported and physically conflicting modifiers", () => {
    const unsupportedWindowsCommand = normalizeAccelerator(
      "Command+Shift+C",
      "win32"
    );
    expect(unsupportedWindowsCommand).toMatchObject({
      ok: false,
      code: "unsupported_modifier"
    });
    if (unsupportedWindowsCommand.ok) throw new Error("unreachable");
    expect(unsupportedWindowsCommand.message).toContain("Windows shortcut modifier");
    expect(unsupportedWindowsCommand.message).not.toContain("win32");
    expect(normalizeAccelerator("Control+CommandOrControl+C", "win32")).toMatchObject({
      ok: false,
      code: "conflicting_modifier"
    });
    expect(normalizeAccelerator("CommandOrControl+Super+C", "darwin")).toMatchObject({
      ok: false,
      code: "conflicting_modifier"
    });
    expect(normalizeAccelerator("AltGr+Control+C", "win32")).toMatchObject({
      ok: false,
      code: "conflicting_modifier"
    });
  });

  test("requires the named Plus key and rejects unsupported keys", () => {
    expect(normalizeAccelerator("Control+Plus", "win32")).toMatchObject({
      ok: true,
      normalized: "Control+Plus"
    });
    expect(normalizeAccelerator("Control++", "win32")).toMatchObject({
      ok: false,
      code: "empty_token"
    });
    expect(normalizeAccelerator("Control+ç", "win32")).toMatchObject({
      ok: false,
      code: "unsupported_key"
    });
  });

  test("accepts Electron number-pad key tokens", () => {
    for (const key of [
      "num0",
      "num1",
      "num2",
      "num3",
      "num4",
      "num5",
      "num6",
      "num7",
      "num8",
      "num9",
      "numadd",
      "numdec",
      "numdiv",
      "nummult",
      "numsub"
    ]) {
      expect(normalizeAccelerator(`Control+${key}`, "win32")).toMatchObject({
        ok: true,
        normalized: `Control+${key}`
      });
    }
    expect(acceleratorToDisplayText("Control+numadd", "win32")).toBe("Ctrl+Num +");
  });
});
