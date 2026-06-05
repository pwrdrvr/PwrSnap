import { describe, expect, it } from "vitest";
import { BUILT_IN_ACP_AGENT_IDS, builtInAcpAgentDisplayName } from "../protocol";

describe("builtInAcpAgentDisplayName", () => {
  it("maps every built-in agent id to a friendly name (never the raw id)", () => {
    for (const id of BUILT_IN_ACP_AGENT_IDS) {
      const label = builtInAcpAgentDisplayName(id);
      expect(label).not.toBe(id); // the whole point: don't show "gemini"
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("uses the kit-aligned names", () => {
    // These must match the kit strategies' displayName so the UI label is
    // stable before AND after async discovery resolves.
    expect(builtInAcpAgentDisplayName("gemini")).toBe("Gemini CLI");
    expect(builtInAcpAgentDisplayName("qwen")).toBe("Qwen Code");
    expect(builtInAcpAgentDisplayName("grok")).toBe("Grok");
    expect(builtInAcpAgentDisplayName("kimi")).toBe("Kimi Code CLI");
  });

  it("falls back to the id for an unknown agent (future/custom)", () => {
    expect(builtInAcpAgentDisplayName("acme-cli")).toBe("acme-cli");
  });
});
