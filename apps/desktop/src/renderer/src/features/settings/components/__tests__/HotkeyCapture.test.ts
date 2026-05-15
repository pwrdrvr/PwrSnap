// Unit tests for the chord parser used by HotkeyCapture. The
// component renders trivially around this helper; the helper is the
// load-bearing part (translating Chromium KeyboardEvent semantics
// into Electron-accelerator strings), and is tested directly here.

import { describe, expect, test, vi } from "vitest";
import { accelFromKeyboardEvent } from "../HotkeyCapture";

function keyEvent(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("accelFromKeyboardEvent", () => {
  test("⌘+Shift+C on macOS → CommandOrControl+Shift+C", () => {
    // macOS reports the platform-cmd modifier via metaKey. Our parser
    // canonicalizes that to `CommandOrControl` so the same accelerator
    // works cross-platform.
    const platformSpy = vi
      .spyOn(navigator, "platform", "get")
      .mockReturnValue("MacIntel");
    try {
      const e = keyEvent({ key: "c", metaKey: true, shiftKey: true });
      expect(accelFromKeyboardEvent(e)).toBe("CommandOrControl+Shift+C");
    } finally {
      platformSpy.mockRestore();
    }
  });

  test("Ctrl+Shift+C on Windows → CommandOrControl+Shift+C", () => {
    // On non-mac platforms, Ctrl maps to `CommandOrControl` — the same
    // chord on either OS produces the same Electron accelerator.
    const platformSpy = vi
      .spyOn(navigator, "platform", "get")
      .mockReturnValue("Win32");
    try {
      const e = keyEvent({ key: "c", ctrlKey: true, shiftKey: true });
      expect(accelFromKeyboardEvent(e)).toBe("CommandOrControl+Shift+C");
    } finally {
      platformSpy.mockRestore();
    }
  });

  test("Ctrl on macOS → literal Control (distinct from ⌘)", () => {
    // Hitting Control+Shift+C on macOS records the literal ⌃ —
    // that's a different chord from ⌘⇧C and the parser must NOT
    // collapse them together.
    const platformSpy = vi
      .spyOn(navigator, "platform", "get")
      .mockReturnValue("MacIntel");
    try {
      const e = keyEvent({ key: "c", ctrlKey: true, shiftKey: true });
      expect(accelFromKeyboardEvent(e)).toBe("Control+Shift+C");
    } finally {
      platformSpy.mockRestore();
    }
  });

  test("modifier-only keydown returns null (caller keeps listening)", () => {
    // When the user starts holding Shift but hasn't pressed the final
    // key yet, we get a `key: "Shift"` event. The chord isn't
    // complete; return null and let the caller keep listening.
    expect(accelFromKeyboardEvent(keyEvent({ key: "Shift", shiftKey: true }))).toBeNull();
    expect(accelFromKeyboardEvent(keyEvent({ key: "Meta", metaKey: true }))).toBeNull();
    expect(accelFromKeyboardEvent(keyEvent({ key: "Control", ctrlKey: true }))).toBeNull();
  });

  test("rejects pure-key chords (no modifier)", () => {
    // A bare `c` keypress would record as an accelerator that swallows
    // the letter c globally — almost certainly a user mistake. We
    // require at least one modifier.
    expect(accelFromKeyboardEvent(keyEvent({ key: "c" }))).toBeNull();
    expect(accelFromKeyboardEvent(keyEvent({ key: "A" }))).toBeNull();
  });

  test("translates named keys (Enter, arrows, F-keys) into Electron tokens", () => {
    const platformSpy = vi
      .spyOn(navigator, "platform", "get")
      .mockReturnValue("MacIntel");
    try {
      expect(
        accelFromKeyboardEvent(keyEvent({ key: "Enter", metaKey: true }))
      ).toBe("CommandOrControl+Return");
      expect(
        accelFromKeyboardEvent(keyEvent({ key: "ArrowUp", metaKey: true, shiftKey: true }))
      ).toBe("CommandOrControl+Shift+Up");
      expect(
        accelFromKeyboardEvent(keyEvent({ key: "F5", metaKey: true }))
      ).toBe("CommandOrControl+F5");
      expect(
        accelFromKeyboardEvent(keyEvent({ key: " ", metaKey: true }))
      ).toBe("CommandOrControl+Space");
    } finally {
      platformSpy.mockRestore();
    }
  });

  test("dead-key / unidentified events return null", () => {
    // Chromium emits `key: "Dead"` for combining-mark sequences and
    // `key: "Unidentified"` for keys the browser couldn't classify
    // (some game-pad chords, some IME states). Either way, we don't
    // accept them as accelerator material.
    const platformSpy = vi
      .spyOn(navigator, "platform", "get")
      .mockReturnValue("MacIntel");
    try {
      expect(
        accelFromKeyboardEvent(keyEvent({ key: "Dead", metaKey: true }))
      ).toBeNull();
      expect(
        accelFromKeyboardEvent(keyEvent({ key: "Unidentified", metaKey: true }))
      ).toBeNull();
    } finally {
      platformSpy.mockRestore();
    }
  });

  test("Alt + Option are the same modifier across operating systems", () => {
    // Electron's accelerator grammar emits `Alt`; the renderer's
    // KeyboardEvent.altKey is set whether the user hit Option (mac) or
    // Alt (win/linux). Either way the output is `Alt+<key>`.
    const platformSpy = vi
      .spyOn(navigator, "platform", "get")
      .mockReturnValue("MacIntel");
    try {
      expect(
        accelFromKeyboardEvent(keyEvent({ key: "a", altKey: true, metaKey: true }))
      ).toBe("CommandOrControl+Alt+A");
    } finally {
      platformSpy.mockRestore();
    }
  });
});
