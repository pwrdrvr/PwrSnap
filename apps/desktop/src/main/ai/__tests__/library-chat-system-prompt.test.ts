import { describe, expect, test } from "vitest";
import { buildLibrarySystemPrompt } from "../library-chat-system-prompt";

const baseSettings = {
  ai: {
    chat: {
      userGuidance: "",
      sensitiveDataPatterns: [],
      defaultRedactionStyle: "redact"
    }
  }
} as never;

describe("buildLibrarySystemPrompt — verify-after-edit guidance", () => {
  const prompt = buildLibrarySystemPrompt({ settings: baseSettings, anchorCaptureId: null });

  test("forbids narrating an edit that wasn't actually performed via a tool call", () => {
    // The observed failure: the model said it deleted the bad box and added a
    // new one, but only the delete tool call happened. The prompt must tell it
    // that intentions are not edits.
    expect(prompt).toContain("Only report what a tool call actually returned");
    expect(prompt).toMatch(/intentions are not\s+edits/);
  });

  test("requires re-rendering and looking after any edit with extents", () => {
    expect(prompt).toContain("render_composite");
    expect(prompt).toMatch(/After any edit with extents/);
  });

  test("explains that an invisible new box landed off-canvas due to pixel-vs-normalized coords", () => {
    expect(prompt).toMatch(/NOT visible in the re-render, it\s+landed off-canvas/);
    expect(prompt).toContain("never pixels");
  });

  test("teaches that replacing a box is TWO edits (delete + add), both confirmed", () => {
    expect(prompt).toContain("Replacing a box = TWO edits");
  });
});
