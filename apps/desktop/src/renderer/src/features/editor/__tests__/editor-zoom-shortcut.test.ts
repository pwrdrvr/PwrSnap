import { describe, expect, test } from "vitest";
import type { ShortcutPlatform } from "@pwrsnap/shared";
import { editorZoomShortcut } from "../editor-zoom-shortcut";

function chord(
  key: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}
): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...modifiers });
}

describe("editorZoomShortcut", () => {
  test.each([
    ["darwin", { metaKey: true }, { ctrlKey: true }],
    ["win32", { ctrlKey: true }, { metaKey: true }]
  ] as const)(
    "%s accepts only its exact primary modifier",
    (platform, primary, wrong) => {
      expect(editorZoomShortcut(chord("0", primary), platform)).toBe("fit");
      expect(editorZoomShortcut(chord("+", primary), platform)).toBe("in");
      expect(editorZoomShortcut(chord("-", primary), platform)).toBe("out");
      expect(editorZoomShortcut(chord("0", wrong), platform)).toBeNull();
      expect(
        editorZoomShortcut(
          chord("0", { ctrlKey: true, metaKey: true }),
          platform as ShortcutPlatform
        )
      ).toBeNull();
    }
  );

  test("leaves Primary+1 to the panel owner and rejects Alt-modified zoom", () => {
    expect(editorZoomShortcut(chord("1", { ctrlKey: true }), "win32")).toBeNull();
    expect(
      editorZoomShortcut(chord("0", { ctrlKey: true, altKey: true }), "win32")
    ).toBeNull();
  });
});
