// The Settings pane's scroll on a route change. The rule that matters: a
// jump to a section never resets the pane to the top first — it travels
// from wherever the pane is. Resetting first made every sidebar section
// link leap to the top and then scroll all the way back down.

import { describe, expect, test } from "vitest";
import { paneScrollForRoute, type PaneRoute } from "../settings-nav";

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
