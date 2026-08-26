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
