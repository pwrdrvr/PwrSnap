import { describe, expect, test } from "vitest";
import { APPLE_FM_PROVIDER } from "@pwrsnap/shared";
import { validateSettingsWrite } from "../settings-validators";

function defaults(surface: string, provider: string) {
  return validateSettingsWrite({ ai: { defaults: { [surface]: { provider } } } } as never);
}

describe("validateSettingsWrite — the on-device Apple model", () => {
  test("captions and the caption fallback may be set to it", () => {
    expect(defaults("enrichment", APPLE_FM_PROVIDER).ok).toBe(true);
    expect(validateSettingsWrite({ ai: { enrichmentFallback: { provider: APPLE_FM_PROVIDER } } } as never).ok).toBe(true);
    expect(
      validateSettingsWrite({
        ai: { defaults: { enrichment: { provider: APPLE_FM_PROVIDER, model: "", reasoning: "" } } }
      } as never).ok
    ).toBe(true);
  });

  test("a chat surface may not: the model has no chat transport", () => {
    for (const surface of ["libraryChat", "sizzleChat"]) {
      const result = defaults(surface, APPLE_FM_PROVIDER);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(`invalid_ai_defaults_${surface}_provider`);
        expect(result.error.message).toContain("captions only");
      }
    }
  });

  test("only the exact selector is accepted", () => {
    // In particular never Apple's cloud model, which leaves the Mac.
    for (const provider of ["apple:pcc", "apple", "apple:system:x", "Apple:System"]) {
      expect(defaults("enrichment", provider).ok).toBe(false);
    }
  });
});
