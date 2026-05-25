// Unit tests for the `resolveToolColor` helper — the one stop on the
// edit pipeline where popover/swatch state (ColorToken | hex string)
// turns into the strict `"auto" | "#rrggbb"` shape the v1 Overlay
// schemas accept.

import { describe, expect, test } from "vitest";
import type { ColorToken } from "@pwrsnap/shared";
import { resolveToolColor } from "../resolveToolColor";

describe("resolveToolColor", () => {
  test("maps every named ColorToken to a strict #rrggbb hex", () => {
    const expected: Record<ColorToken, string> = {
      red: "#ff5f57",
      yellow: "#facc15",
      green: "#28c840",
      blue: "#1f7cff",
      gray: "#8b8a87",
      black: "#0a0a0a",
      white: "#f5efe3",
      accent: "#ff8a1f"
    };
    for (const [token, hex] of Object.entries(expected)) {
      const out = resolveToolColor(token as ColorToken);
      expect(out, `token=${token}`).toBe(hex);
      // Every mapped value must be valid for the overlay zod regex.
      expect(out).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test("'auto' sentinel passes through unchanged", () => {
    expect(resolveToolColor("auto")).toBe("auto");
  });

  test("free-form hex string passes through unchanged", () => {
    expect(resolveToolColor("#abcdef")).toBe("#abcdef");
    expect(resolveToolColor("#012345")).toBe("#012345");
    // Pre-fix this also passes through. Downstream zod will reject
    // malformed hex — that's the right place to validate, not here.
    expect(resolveToolColor("#nothex")).toBe("#nothex");
  });

  test("unknown free-form (non-hex, non-token) falls back to 'auto'", () => {
    expect(resolveToolColor("rgb(255,0,0)")).toBe("auto");
    expect(resolveToolColor("transparent")).toBe("auto");
    expect(resolveToolColor("")).toBe("auto");
  });
});
