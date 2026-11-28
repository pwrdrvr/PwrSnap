// File names for Copy all: a paste of several files into one folder must
// never ask to replace one with another, so every name is unique (compared
// case-insensitively, as macOS and Windows do), and a name that was already
// unique is left alone.

import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";

vi.mock("../../persistence/captures-repo", () => ({ getCaptureById: vi.fn() }));
vi.mock("../../render/image-presets", () => ({ resolveImagePresetFile: vi.fn() }));
vi.mock("../../log", () => ({
  getMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

const { uniqueFileNames } = await import("../cart-render");

const nameArb = fc.oneof(
  fc.constantFrom("PwrSnap-granola-med.png", "pwrsnap-granola-med.png", "PwrSnap-oat-milk-med.png", "a (2).png", "noext"),
  fc.stringMatching(/^[A-Za-z ()]{1,8}\.png$/)
);

describe("uniqueFileNames", () => {
  test("every output is unique, case-insensitively, and keeps its extension", () => {
    fc.assert(
      fc.property(fc.array(nameArb, { maxLength: 30 }), (names) => {
        const out = uniqueFileNames(names);
        expect(out).toHaveLength(names.length);
        expect(new Set(out.map((n) => n.toLowerCase())).size).toBe(out.length);
        for (const [index, name] of names.entries()) {
          const dot = name.lastIndexOf(".");
          if (dot > 0) expect(out[index]!.endsWith(name.slice(dot))).toBe(true);
        }
      })
    );
  });

  test("the first of each name is untouched; already-unique lists come back as they were", () => {
    fc.assert(
      fc.property(fc.uniqueArray(nameArb, { selector: (n) => n.toLowerCase(), maxLength: 20 }), (names) => {
        expect(uniqueFileNames(names)).toEqual(names);
      })
    );
  });

  test("repeats count up before the extension", () => {
    expect(uniqueFileNames(["Snap.png", "snap.png", "Snap.png"])).toEqual([
      "Snap.png",
      "snap (2).png",
      "Snap (3).png"
    ]);
  });
});
