import fc from "fast-check";
import { expect, test } from "vitest";
import { defaultHotkeysForPlatform } from "../protocol";
import { suggestHotkeyAlternatives } from "../hotkey-alternatives";
import { acceleratorsAreEquivalent, canonicalAcceleratorForPlatform } from "../shortcut-semantics";

test("alternatives are deterministic, valid and distinct from every excluded chord", () => {
  const keys = fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "F9", "Space");
  const mods = fc.constantFrom("CmdOrCtrl+Shift", "Alt+Shift", "Cmd+Ctrl+Alt", "Super", "Ctrl+Alt", "AltGr");
  const chord = fc.tuple(mods, keys).map(([modifier, key]) => `${modifier}+${key}`);
  fc.assert(fc.property(
    fc.constantFrom("darwin", "win32", "linux"), chord, chord, fc.array(chord, { maxLength: 12 }),
    (platform, attempted, region, rejected) => {
      const saved = { ...defaultHotkeysForPlatform(platform), region };
      const excluded = [attempted, ...Object.values(saved), ...rejected];
      const candidates = suggestHotkeyAlternatives(platform, "quickCapture", attempted, saved, rejected);
      expect(candidates).toEqual(suggestHotkeyAlternatives(platform, "quickCapture", attempted, saved, rejected));
      expect(candidates.length).toBeLessThanOrEqual(3);
      for (const candidate of candidates) {
        const parsed = canonicalAcceleratorForPlatform(candidate, platform);
        if (!parsed.ok) throw new Error(parsed.message);
        expect(excluded.some((key) => acceleratorsAreEquivalent(candidate, key, platform))).toBe(false);
        excluded.push(candidate);
        if (platform !== "darwin") {
          expect(parsed.modifiers).not.toContain("Super");
          expect(parsed.modifiers).not.toContain("AltGr");
          expect(parsed.modifiers.includes("Control") && parsed.modifiers.includes("Alt")).toBe(false);
        }
      }
    }
  ));
});

test("the macOS ladder leaves screenshot-to-clipboard shortcuts out", () => {
  expect(suggestHotkeyAlternatives(
    "darwin", "quickCapture", "Command+Shift+4", defaultHotkeysForPlatform("darwin"), []
  )).toEqual(["Command+Alt+Shift+4", "Command+Control+Alt+4", "Control+Alt+Shift+4"]);
});

test("alternatives preserve built-in PwrSnap commands", () => {
  fc.assert(fc.property(
    fc.constantFrom("win32", "linux"),
    fc.constantFrom("L", "D", "Z", "I", "R"),
    (platform, key) => {
      const candidates = suggestHotkeyAlternatives(
        platform, "openLibrary", `Ctrl+Alt+${key}`, defaultHotkeysForPlatform(platform), []
      );
      expect(candidates).toHaveLength(3);
      expect(candidates.some((chord) => acceleratorsAreEquivalent(chord, `Ctrl+Shift+${key}`, platform))).toBe(false);
    }
  ));
});

test("recovering Open Library leaves Ctrl+Shift+L available for Sizzle Reels", () => {
  expect(suggestHotkeyAlternatives(
    "win32", "openLibrary", "Control+Alt+L", defaultHotkeysForPlatform("win32"), []
  )).toEqual(["Alt+Shift+L", "Control+Shift+F9", "Control+Shift+F10"]);
});
