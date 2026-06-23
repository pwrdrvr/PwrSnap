import { describe, expect, test } from "vitest";
import { agentErrorMessage } from "../agent-error-message";

describe("agentErrorMessage", () => {
  test("extracts JSON-RPC object messages instead of [object Object]", () => {
    expect(
      agentErrorMessage({
        code: -32000,
        message: "This client is no longer supported for Gemini Code Assist for individuals."
      })
    ).toBe("This client is no longer supported for Gemini Code Assist for individuals.");
  });

  test("extracts Gemini ineligible-tier reason messages", () => {
    expect(
      agentErrorMessage({
        ineligibleTiers: [
          {
            reasonCode: "UNSUPPORTED_CLIENT",
            reasonMessage: "This client is no longer supported for Gemini Code Assist for individuals."
          }
        ]
      })
    ).toBe("This client is no longer supported for Gemini Code Assist for individuals.");
  });

  test("extracts nested JSON-RPC error envelope messages", () => {
    expect(
      agentErrorMessage({
        error: {
          code: -32000,
          message: "Authentication failed"
        }
      })
    ).toBe("Authentication failed");
  });
});
