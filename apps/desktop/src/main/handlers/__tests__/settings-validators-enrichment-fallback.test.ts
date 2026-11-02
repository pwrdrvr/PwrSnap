import { describe, expect, test } from "vitest";
import { validateSettingsWrite } from "../settings-validators";

function write(enrichmentFallback: unknown) {
  return validateSettingsWrite({ ai: { enrichmentFallback } } as never);
}

describe("validateSettingsWrite — ai.enrichmentFallback", () => {
  test("null turns it off and {} turns it on", () => {
    expect(write(null).ok).toBe(true);
    expect(write({}).ok).toBe(true);
  });

  test("accepts the same selectors as a surface default", () => {
    expect(write({ provider: "codex", model: "gpt-6-luna", reasoning: "low" }).ok).toBe(true);
    expect(write({ provider: "acp:kimi" }).ok).toBe(true);
    expect(write({ provider: "custom:12345678-1234-4234-8234-123456789001" }).ok).toBe(true);
    expect(write({ provider: "", model: "", reasoning: "" }).ok).toBe(true);
  });

  test("rejects what a surface default rejects, naming the right path", () => {
    const unknownAgent = write({ provider: "acp:not-an-agent" });
    expect(unknownAgent.ok).toBe(false);
    if (!unknownAgent.ok) expect(unknownAgent.error.message).toContain("ai.enrichmentFallback.provider");
    expect(write({ reasoning: "Very High" }).ok).toBe(false);
    expect(write({ model: "bad\nid" }).ok).toBe(false);
    expect(write("codex").ok).toBe(false);
  });
});
