import { describe, expect, test } from "vitest";
import { buildSizzleSystemPrompt } from "../sizzle-chat-system-prompt";

describe("buildSizzleSystemPrompt", () => {
  test("instructs the chat agent to use cached TTS transcript phrases for sequence anchors", () => {
    const prompt = buildSizzleSystemPrompt({
      settings: { ai: { chat: { userGuidance: "" } } } as never,
      anchorCaptureId: "sz_1"
    });

    expect(prompt).toContain("Phrase anchors come from the TTS transcript");
    expect(prompt).toContain("choose phrase anchors from");
    expect(prompt).toMatch(/one unique start phrase per intended start\s+word/);
    expect(prompt).toContain("change the sequence");
    expect(prompt).toContain("prefer `auto`");
  });
});
