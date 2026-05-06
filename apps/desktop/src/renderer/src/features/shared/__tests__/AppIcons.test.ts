// Tests for the procedural-icon initials helpers. `initialsFor` is
// the function the procedural <AppIcon> falls back to when there's
// no hand-drawn glyph for a given app. The renderer ships them at
// 8 / 10 / 11 px, so getting the right 1-2 letters matters more than
// any other procedural-icon decision.

import { describe, expect, test } from "vitest";
import { initialsFor, tokenInitials } from "../AppIcons";

describe("tokenInitials — captured user-facing app names", () => {
  // The common case: the renderer has a `source_app_name` from the
  // OS and just wants up-to-2-letter initials.
  test.each<[string, string]>([
    ["Microsoft Edge", "ME"],
    ["Activity Monitor", "AM"],
    ["Splashtop Business", "SB"],
    ["System Settings", "SS"],
    ["GitHub Desktop", "GD"],
    ["Spotify", "SP"],
    ["Discord", "DI"],
    ["Claude", "CL"]
  ])("%s → %s", (input, expected) => {
    expect(tokenInitials(input)).toBe(expected);
  });

  test("camelCase splits when there's no explicit separator", () => {
    // Single mashed token falls back to a camelCase split — for
    // explicit-separator inputs this stays disabled (see GitHub
    // Desktop above) so we don't over-split inside CamelCase words.
    expect(tokenInitials("iCloudDrive")).toBe("IC");
  });

  test("explicit separator wins over camelCase inside a token", () => {
    // Regression for "GitHub Desktop" → "GD" (not "GH"). The
    // explicit-separator split takes ["GitHub","Desktop"] before
    // the camelCase pass ever sees "GitHub".
    expect(tokenInitials("GitHub Desktop")).toBe("GD");
  });

  test("dashes and underscores are word boundaries", () => {
    expect(tokenInitials("foo-bar")).toBe("FB");
    expect(tokenInitials("foo_bar")).toBe("FB");
  });

  test("single-word input takes first two chars", () => {
    expect(tokenInitials("Slack")).toBe("SL");
  });

  test("empty input returns empty", () => {
    expect(tokenInitials("")).toBe("");
  });
});

describe("initialsFor — name path (preferred)", () => {
  test("non-empty name short-circuits before bundle-id fallback", () => {
    expect(initialsFor("Microsoft Edge", "com.microsoft.edgemac")).toBe("ME");
  });

  test("name with leading/trailing whitespace is trimmed", () => {
    expect(initialsFor("  Activity Monitor  ", "x")).toBe("AM");
  });

  test("name that's only whitespace falls through to bundle id", () => {
    expect(initialsFor("   ", "com.spotify.client")).toBe("SP");
  });
});

describe("initialsFor — bundle-id fallback (rare path)", () => {
  // When name is undefined (Swift helper failed name lookup but
  // succeeded on bundle id), the heuristic picks the LONGEST non-
  // generic dotted segment. It's pragmatic, not perfect: when the
  // publisher segment happens to be longer than the app segment
  // (e.g. `keepcoder` > `telegram`), the publisher wins. The chip
  // never normally hits this path because the call site passes the
  // captured `appName` whenever it has one.
  test.each<[string, string]>([
    ["com.spotify.client", "SP"], // generic `com` + `client` filtered → "spotify"
    ["com.hnc.discord", "DI"], // generic `com` filtered → longest of [hnc, discord]
    ["us.zoom.xos", "ZO"], // generic `us` filtered → longest of [zoom, xos]
    ["com.openai.codex", "OP"], // generic `com` filtered → "openai" wins on length
    ["ru.keepcoder.telegram", "KE"] // generic `ru` filtered → "keepcoder" wins on length
  ])("%s → %s", (bundleId, expected) => {
    expect(initialsFor(undefined, bundleId)).toBe(expected);
  });

  test("bundle id with only generic segments returns first two chars", () => {
    expect(initialsFor(undefined, "com.app")).toBe("CO");
  });

  test("malformed bundle id (no dots) takes first two chars", () => {
    expect(initialsFor(undefined, "weirdname")).toBe("WE");
  });

  test("empty fallback returns single '?' so chip is never blank", () => {
    expect(initialsFor(undefined, "")).toBe("?");
  });
});
