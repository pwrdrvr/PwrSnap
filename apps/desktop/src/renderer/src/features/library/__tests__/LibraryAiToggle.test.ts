import { describe, expect, test } from "vitest";
import { resolveLibraryAiToggleAction } from "../library-ai-toggle";

describe("resolveLibraryAiToggleAction", () => {
  test("disables enabled AI even when the provider is unavailable", () => {
    expect(
      resolveLibraryAiToggleAction({
        aiEnabled: true,
        aiConsentAcceptedAt: "2026-05-19T12:00:00.000Z",
        providerAvailable: false
      })
    ).toBe("disable");
  });

  test("routes disabled AI to configuration when the provider is unavailable", () => {
    expect(
      resolveLibraryAiToggleAction({
        aiEnabled: false,
        aiConsentAcceptedAt: "2026-05-19T12:00:00.000Z",
        providerAvailable: false
      })
    ).toBe("configure");
  });

  test("requires consent before first enable", () => {
    expect(
      resolveLibraryAiToggleAction({
        aiEnabled: false,
        aiConsentAcceptedAt: null,
        providerAvailable: true
      })
    ).toBe("consent");
  });

  test("enables an installed ACP agent even when Codex is absent (providerAvailable=true)", () => {
    expect(
      resolveLibraryAiToggleAction({
        aiEnabled: false,
        aiConsentAcceptedAt: "2026-05-19T12:00:00.000Z",
        providerAvailable: true
      })
    ).toBe("enable");
  });

  test("does not block enable while provider discovery is pending (undefined)", () => {
    expect(
      resolveLibraryAiToggleAction({
        aiEnabled: false,
        aiConsentAcceptedAt: "2026-05-19T12:00:00.000Z",
        providerAvailable: undefined
      })
    ).toBe("enable");
  });
});
