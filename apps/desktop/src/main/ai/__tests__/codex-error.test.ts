import { describe, expect, it } from "vitest";
import type { TurnError } from "@pwrsnap/codex-app-server-protocol/v2";
import { formatCodexTurnError } from "../codex-error";

function turnError(partial: Partial<TurnError>): TurnError {
  return {
    message: "",
    codexErrorInfo: null,
    additionalDetails: null,
    ...partial
  };
}

describe("formatCodexTurnError", () => {
  it("unwraps a nested provider-error JSON blob (the gpt-image-2 case)", () => {
    const error = turnError({
      message: JSON.stringify({
        type: "error",
        error: {
          type: "image_generation_user_error",
          code: "invalid_value",
          message: "The model 'gpt-image-2' does not exist.",
          param: "tools"
        },
        status: 400
      })
    });
    expect(formatCodexTurnError(error)).toBe("The model 'gpt-image-2' does not exist.");
  });

  it("passes a plain message through verbatim", () => {
    expect(formatCodexTurnError(turnError({ message: "Rate limit exceeded" }))).toBe(
      "Rate limit exceeded"
    );
  });

  it("appends additionalDetails when present and not already included", () => {
    expect(
      formatCodexTurnError(
        turnError({ message: "Something broke", additionalDetails: "retry in 5s" })
      )
    ).toBe("Something broke (retry in 5s)");
  });

  it("does not duplicate details already contained in the message", () => {
    expect(
      formatCodexTurnError(
        turnError({ message: "Something broke: retry in 5s", additionalDetails: "retry in 5s" })
      )
    ).toBe("Something broke: retry in 5s");
  });

  it("falls back to a sentinel for null / empty errors", () => {
    expect(formatCodexTurnError(null)).toBe("Codex returned an error");
    expect(formatCodexTurnError(turnError({ message: "   " }))).toBe("Codex returned an error");
  });

  it("uses the raw text when the message is JSON-shaped but has no nested error", () => {
    expect(formatCodexTurnError(turnError({ message: "{not really json" }))).toBe(
      "{not really json"
    );
  });
});
