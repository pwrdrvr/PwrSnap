// Regression coverage for the per-surface `ai.defaults.<surface>.model`
// validator. The bug: ACP agents advertise opaque model ids that the
// Codex-narrow alphabet rejects — Qwen's `coder-model(qwen-oauth)` and
// `qwen3.6-plus(openai)` contain parentheses — so `settings:write` rejected
// the patch and the Model picker snapped back to "Default" on every pick.
// (Gemini/Grok ids happen to use only [A-Za-z0-9.-] and slipped through,
// which is why only Qwen looked broken.)

import { describe, expect, test } from "vitest";
import { validateSettingsWrite } from "../settings-validators";

function writeModel(surface: "libraryChat" | "sizzleChat" | "enrichment", model: string) {
  return validateSettingsWrite({ ai: { defaults: { [surface]: { model } } } });
}

describe("validateSettingsWrite — ai.defaults.<surface>.model", () => {
  test("accepts Qwen model ids with parentheses (the reported bug)", () => {
    for (const id of [
      "coder-model(qwen-oauth)",
      "qwen3.6-plus(openai)",
      "glm-5.1(openai)",
      "deepseek-v4-pro(openai)"
    ]) {
      const result = writeModel("libraryChat", id);
      expect(result.ok, `expected ${id} to validate`).toBe(true);
    }
  });

  test("still accepts plain Codex / Gemini / Grok model ids", () => {
    for (const id of ["gpt-5.5", "gemini-3-pro-preview", "grok-build", "gemini-2.5-flash"]) {
      expect(writeModel("libraryChat", id).ok).toBe(true);
    }
  });

  test("empty string (clear → default) is allowed", () => {
    expect(writeModel("sizzleChat", "").ok).toBe(true);
  });

  test("rejects control characters and absurd lengths", () => {
    expect(writeModel("libraryChat", "bad\nid").ok).toBe(false);
    expect(writeModel("libraryChat", "x".repeat(201)).ok).toBe(false);
  });

  test("a non-string model is rejected", () => {
    const result = validateSettingsWrite({
      ai: { defaults: { libraryChat: { model: 42 } } }
    });
    expect(result.ok).toBe(false);
  });
});
