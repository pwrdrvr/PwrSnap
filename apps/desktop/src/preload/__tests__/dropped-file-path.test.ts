import { describe, expect, test, vi } from "vitest";

import { resolveDroppedFilePath } from "../dropped-file-path";

describe("resolveDroppedFilePath", () => {
  test("returns the OS-backed path from Electron webUtils", () => {
    const file = new File(["png"], "drop.png", { type: "image/png" });
    const resolver = vi.fn(() => "/tmp/drop.png");

    expect(resolveDroppedFilePath(file, resolver)).toBe("/tmp/drop.png");
    expect(resolver).toHaveBeenCalledWith(file);
  });

  test("preserves Electron's empty-string result for a JS-created File", () => {
    const file = new File(["png"], "drop.png", { type: "image/png" });
    expect(resolveDroppedFilePath(file, () => "")).toBe("");
  });

  test("contains invalid-File exceptions at the preload boundary", () => {
    const file = new File(["png"], "drop.png", { type: "image/png" });
    expect(
      resolveDroppedFilePath(file, () => {
        throw new TypeError("not an OS-backed File");
      })
    ).toBe("");
  });
});
