import { describe, expect, test } from "vitest";

import { TOOLS } from "../editor-tools";

describe("editor tool metadata", () => {
  test("uses S as the Shape tool shortcut", () => {
    expect(TOOLS.find((tool) => tool.id === "shape")?.key).toBe("S");
  });

  test("keeps tool shortcuts unique", () => {
    const keys = TOOLS.map((tool) => tool.key);

    expect(new Set(keys).size).toBe(keys.length);
  });
});
