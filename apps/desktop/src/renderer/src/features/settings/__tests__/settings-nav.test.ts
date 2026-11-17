// The Settings pane's scroll on a route change. The rule that matters: a
// jump to a section never resets the pane to the top first — it travels
// from wherever the pane is. Resetting first made every sidebar section
// link leap to the top and then scroll all the way back down.

import { describe, expect, test } from "vitest";
import type { AiProviderStatus } from "../ai-provider-status";
import { paneScrollForRoute, settingsNavChildren, type PaneRoute } from "../settings-nav";

function route(page: PaneRoute["page"], sub: string | null = null, request = 0): PaneRoute {
  return { page, sub, request };
}

describe("paneScrollForRoute", () => {
  test.each([
    ["another page", route("hotkeys"), route("general", null, 1), "top"],
    ["a provider screen from the hub", route("ai"), route("ai", "codex", 1), "top"],
    ["one provider screen to another", route("ai", "codex"), route("ai", "kimi", 1), "top"],
    ["a section from another page", route("hotkeys"), route("ai-features", "usage", 1), "none"],
    ["a section from the same page's top", route("ai-features"), route("ai-features", "usage", 1), "none"],
    [
      "one section to another",
      route("ai-features", "default-agents"),
      route("ai-features", "guidance", 1),
      "none"
    ],
    ["a re-click of the section shown", route("ai-features", "usage"), route("ai-features", "usage", 1), "none"],
    ["a section page's top, from a section", route("ai-features", "usage"), route("ai-features", null, 1), "travel-top"],
    ["a re-click of a section page's parent row", route("ai-features"), route("ai-features", null, 1), "travel-top"],
    ["a section page's top, from another page", route("hotkeys"), route("ai-features", null, 1), "top"],
    ["the first render", route("ai-features", "usage"), route("ai-features", "usage"), "none"],
    ["a re-click of a plain page", route("hotkeys"), route("hotkeys", null, 1), "none"]
  ])("%s", (_label, prev, next, expected) => {
    expect(paneScrollForRoute(prev, next)).toBe(expected);
  });
});

describe("settingsNavChildren — AI Providers", () => {
  const provider = (sub: AiProviderStatus["sub"], label: string): AiProviderStatus => ({
    sub, label, badge: "Ready", meta: "", tone: "ok"
  });

  test("the on-device model sits under its own heading, between the agents and Direct API", () => {
    const children = settingsNavChildren("ai", [
      provider("codex", "Codex"),
      provider("openai", "OpenAI voiceover"),
      provider("apple", "Apple Intelligence")
    ]);
    expect(children.map((child) => [child.label, child.heading])).toEqual([
      ["Codex", undefined],
      ["OpenAI voiceover", undefined],
      ["Apple Intelligence", "On this Mac"],
      ["Add connection", "Direct API"]
    ]);
  });

  test("without it (Windows, Linux) there is no such heading", () => {
    const children = settingsNavChildren("ai", [provider("codex", "Codex")]);
    expect(children.some((child) => child.heading === "On this Mac")).toBe(false);
  });
});
