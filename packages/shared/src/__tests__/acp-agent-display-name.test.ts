import { describe, expect, it } from "vitest";
import {
  acpAgentIdFromThreadId,
  BUILT_IN_ACP_AGENT_IDS,
  builtInAcpAgentDisplayName,
  chatThreadProviderLabel
} from "../protocol";

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

describe("chat thread provider derivation", () => {
  it("parses the ACP agent id from a thread id", () => {
    expect(acpAgentIdFromThreadId("acp:gemini:836a1942-8a8e")).toBe("gemini");
    expect(acpAgentIdFromThreadId("acp:qwen:abc")).toBe("qwen");
  });

  it("returns null for a Codex (non-acp) thread id", () => {
    expect(acpAgentIdFromThreadId("0199-uuid-codex-thread")).toBeNull();
  });

  it("labels a thread by the provider baked into its id (stable across config changes)", () => {
    expect(chatThreadProviderLabel("acp:gemini:836a1942")).toBe("Gemini CLI");
    expect(chatThreadProviderLabel("acp:qwen:abc")).toBe("Qwen Code");
    expect(chatThreadProviderLabel("codex-thread-uuid")).toBe("Codex");
  });
});
