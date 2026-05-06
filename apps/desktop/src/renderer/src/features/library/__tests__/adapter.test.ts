// Tests for the bundle-id → AppId mapping. The mapper is pure logic
// keyed off a small table of anchored regex patterns; each branch
// gets one realistic bundle id so a future edit that breaks a row
// (regression on case sensitivity, anchor drift, accidental false
// positive) fails loudly.

import { describe, expect, test } from "vitest";
import { mapBundleIdToAppId } from "../adapter";

describe("mapBundleIdToAppId — null / empty input", () => {
  test("null bundle id falls back to 'any'", () => {
    expect(mapBundleIdToAppId(null)).toBe("any");
  });

  test("empty string falls back to 'any'", () => {
    expect(mapBundleIdToAppId("")).toBe("any");
  });
});

describe("mapBundleIdToAppId — curated apps (case-insensitive)", () => {
  // Real macOS bundle ids use CamelCase tail components; the matcher
  // must lowercase before testing. Each row is the EXACT id macOS
  // returns from CFBundleIdentifier.
  test.each<[string, string]>([
    ["com.tinyspeck.slackmacgap", "slack"],
    ["com.apple.Terminal", "terminal"],
    ["com.microsoft.VSCode", "vscode"],
    ["com.microsoft.VSCodeInsiders", "vscode"],
    ["com.apple.finder", "finder"],
    ["com.google.Chrome", "chrome"],
    ["com.apple.Safari", "safari"],
    ["com.figma.Desktop", "figma"],
    ["notion.id", "notion"],
    ["com.github.GitHubClient", "github"],
    ["com.linear.LinearMac", "linear"],
    ["us.zoom.xos", "zoom"],
    ["com.apple.Preview", "preview"],
    ["com.microsoft.Excel", "excel"],
    ["ru.keepcoder.Telegram", "telegram"],
    ["com.mitchellh.ghostty", "terminal"]
  ])("%s → %s", (bundleId, expected) => {
    expect(mapBundleIdToAppId(bundleId)).toBe(expected);
  });
});

describe("mapBundleIdToAppId — open fallback for unknown apps", () => {
  // Unknown apps return their LOWERCASED bundle id as a stable
  // group key. The Library sidebar groups by this key, so two
  // captures of the same app must produce the same key regardless
  // of whether macOS returned the bundle id as `com.hnc.Discord`
  // or `com.hnc.discord`.
  test.each<[string, string]>([
    ["com.spotify.client", "com.spotify.client"],
    ["com.hnc.Discord", "com.hnc.discord"],
    ["com.microsoft.edgemac", "com.microsoft.edgemac"],
    ["com.apple.ActivityMonitor", "com.apple.activitymonitor"],
    ["com.anthropic.claudefordesktop", "com.anthropic.claudefordesktop"],
    ["com.openai.codex", "com.openai.codex"],
    ["com.apple.systempreferences", "com.apple.systempreferences"],
    ["com.zeitalabs.jottleai", "com.zeitalabs.jottleai"]
  ])("%s → %s (lowercased)", (bundleId, expected) => {
    expect(mapBundleIdToAppId(bundleId)).toBe(expected);
  });
});

describe("mapBundleIdToAppId — anchored matching prevents false positives", () => {
  // The matcher used to do unanchored substring tests
  // (`bundleId.includes("notion")`), so a third-party clone like
  // `com.acme.notion-importer` would steal Notion's hand-drawn
  // glyph. After the regex tightening, generic-name third parties
  // fall through to the open set and get a procedural icon.
  test.each<string>([
    "com.acme.notion-importer",
    "com.someone.fakelinear",
    "com.example.previewer",
    "com.anothercompany.figmaclone"
  ])("%s falls through (no false positive)", (bundleId) => {
    expect(mapBundleIdToAppId(bundleId)).toBe(bundleId.toLowerCase());
  });

  // But legitimate vendor-glued tail words MUST still match — the
  // matcher allows known suffixes (slackmacgap, vscodeinsiders,
  // githubclient, …) for this reason.
  test("Slack still matches despite glued 'macgap' suffix", () => {
    expect(mapBundleIdToAppId("com.tinyspeck.slackmacgap")).toBe("slack");
  });

  test("VS Code Insiders still matches", () => {
    expect(mapBundleIdToAppId("com.microsoft.VSCodeInsiders")).toBe("vscode");
  });

  test("GitHub Client still matches", () => {
    expect(mapBundleIdToAppId("com.github.GitHubClient")).toBe("github");
  });
});

describe("mapBundleIdToAppId — Xcode does not get VS Code's glyph", () => {
  // Regression: when the matcher had a `lower.includes("code")`
  // branch, Xcode (`com.apple.dt.Xcode`) and any other app with
  // "code" in its bundle id would inherit VS Code's glyph. The
  // `vscode`-only needle, anchored, prevents that.
  test("Xcode falls through to its lowercased bundle id", () => {
    expect(mapBundleIdToAppId("com.apple.dt.Xcode")).toBe("com.apple.dt.xcode");
  });
});
