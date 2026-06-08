import { describe, expect, test } from "vitest";

import { acpReasoningEffort } from "../acp-effort";

describe("acpReasoningEffort", () => {
  test("'low' stays 'low' (Fast / thinking off)", () => {
    expect(acpReasoningEffort("low")).toBe("low");
  });

  test("'high' stays 'high' (Thinking / thinking on)", () => {
    expect(acpReasoningEffort("high")).toBe("high");
  });

  test("'medium' collapses to 'high' — the kit has no thought_level mapping for it", () => {
    // A surface can carry a stale Codex "medium" after its provider is switched
    // to an ACP agent; it must resolve to a value the kit honors, never be sent
    // verbatim (where it silently falls through to the agent's own default).
    expect(acpReasoningEffort("medium")).toBe("high");
  });

  test("any unrecognized effort collapses to 'high'", () => {
    expect(acpReasoningEffort("")).toBe("high");
    expect(acpReasoningEffort("minimal")).toBe("high");
  });
});
