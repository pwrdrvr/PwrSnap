import { describe, expect, test } from "vitest";
import { resolveLibraryAiToggleAction } from "../library-ai-toggle";

describe("resolveLibraryAiToggleAction", () => {
  test("disables enabled AI even when Codex is unavailable", () => {
    expect(
      resolveLibraryAiToggleAction({
        aiEnabled: true,
        aiConsentAcceptedAt: "2026-05-19T12:00:00.000Z",
        codexAvailable: false
      })
    ).toBe("disable");
  });

  test("routes disabled AI to configuration when Codex is unavailable", () => {
    expect(
      resolveLibraryAiToggleAction({
        aiEnabled: false,
        aiConsentAcceptedAt: "2026-05-19T12:00:00.000Z",
        codexAvailable: false
      })
    ).toBe("configure");
  });

  test("requires consent before first enable", () => {
    expect(
      resolveLibraryAiToggleAction({
        aiEnabled: false,
        aiConsentAcceptedAt: null,
        codexAvailable: true
      })
    ).toBe("consent");
  });
});
