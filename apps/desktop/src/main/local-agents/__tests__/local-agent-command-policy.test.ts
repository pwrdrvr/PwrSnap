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

describe("local-agent duplicate and family command policy", () => {
  test.each(["capture:duplicate", "capture:duplicateJobs"])(
    "%s needs capture.edit, so a read-only grant cannot fork a snap",
    (command) => {
      expect(localAgentCommandRequirement(command, {})).toEqual({ all: ["capture.edit"] });
    }
  );

  test("cancelling a copy stays denied — that is the user's call in the Library", () => {
    expect(localAgentCommandRequirement("capture:cancelDuplicate", {})).toBeNull();
  });

  test("capture:editSummary is readable by a reader or an editor", () => {
    // An editor deciding withEdits has to see what the copy would carry.
    expect(localAgentCommandRequirement("capture:editSummary", {})).toEqual({
      any: ["library.read", "capture.edit"]
    });
  });

  test.each(["library:families", "library:family"])("%s is a library read", (command) => {
    expect(localAgentCommandRequirement(command, {})).toEqual({ all: ["library.read"] });
  });
});
