import { describe, expect, test } from "vitest";
import { localAgentCommandRequirement } from "../local-agent-command-policy";

describe("local-agent chat command policy", () => {
  test.each([
    ["codex:libraryChat:approval", "capture.edit"],
    ["codex:sizzleChat:approval", "sizzle.compose"]
  ] as const)("pins the actual %s command name", (command, capability) => {
    expect(localAgentCommandRequirement(command, {})).toEqual({ all: [capability] });
  });
});

describe("local-agent video command policy", () => {
  test.each(["video:edit", "video:setDefaultRange"])("%s needs capture.edit", (command) => {
    expect(localAgentCommandRequirement(command, {})).toEqual({ all: ["capture.edit"] });
  });

  test.each(["video:inspect", "video:activity"])(
    "%s is readable by a reader or an editor",
    (command) => {
      expect(localAgentCommandRequirement(command, {})).toEqual({
        any: ["library.read", "capture.edit"]
      });
    }
  );

  test.each(["video:export", "video:frames", "video:playback", "video:prepareDrag"])(
    "%s stays denied",
    (command) => {
      // Exports write files an agent could exfiltrate by path; the MCP
      // surface reaches them through its own export tool, not the bus.
      expect(localAgentCommandRequirement(command, {})).toBeNull();
    }
  );
});
