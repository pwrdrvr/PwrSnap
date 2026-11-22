// Properties of the caption fallback's two decisions: whether a fallback is
// armed for a run, and whether a Codex failure means this Mac is offline.
//
// Both oracles are written from the rule, not from the implementation:
// - Armed: a fallback is set, and it runs on another backend than the primary
//   ("" / "codex" / a disabled ACP agent are all Codex). Pre-fix code returned
//   null for every Codex primary, so `codex → apple:system` shrank here.
// - Offline: one of the three transport failures that carry no HTTP status.

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { Settings } from "@pwrsnap/shared";
import { CodexTurnFailedError, isCodexNetworkUnavailable, rawTurnErrorFor } from "../codex-turn-error";
import { enrichmentFallbackFor, isEnrichmentBackendUnavailable } from "../enrichment-fallback";

const SELECTORS = [
  undefined, "", "codex", "acp:kimi", "acp:gemini", "acp:qwen", "apple:system",
  "custom:12345678-1234-4234-8234-123456789001", "custom:12345678-1234-4234-8234-123456789002"
] as const;

function backendOf(provider: string | undefined, enabled: readonly string[]): string {
  if (provider === undefined || provider === "" || provider === "codex") return "codex";
  if (provider.startsWith("acp:") && !enabled.includes(provider.slice(4))) return "codex";
  return provider;
}

describe("enrichmentFallbackFor (property)", () => {
  test("armed exactly when a fallback is set on a backend other than the primary's", () => {
    fc.assert(fc.property(
      fc.constantFrom(...SELECTORS),
      fc.option(fc.constantFrom(...SELECTORS), { nil: null }),
      fc.subarray(["kimi", "gemini", "qwen"]),
      (primary, fallbackProvider, enabled) => {
        const fallback = fallbackProvider === null
          ? null
          : fallbackProvider === undefined ? {} : { provider: fallbackProvider };
        const settings = {
          ai: {
            defaults: { libraryChat: {}, sizzleChat: {}, enrichment: primary === undefined ? {} : { provider: primary } },
            enrichmentFallback: fallback,
            acp: { enabledAgentIds: enabled }
          }
        } as unknown as Settings;
        const expectedArmed = fallback !== null &&
          backendOf(fallback.provider, enabled) !== backendOf(primary, enabled);
        const armed = enrichmentFallbackFor(settings);
        expect(armed).toEqual(expectedArmed ? fallback : null);
      }
    ), { numRuns: 500 });
  });
});

const NO_ANSWER = ["httpConnectionFailed", "responseStreamConnectionFailed", "responseTooManyFailedAttempts"];
const WITH_STATUS = [...NO_ANSWER, "responseStreamDisconnected"];
const BARE = [
  "contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded", "rateLimitExceeded",
  "flexUnavailable", "serverOverloaded", "cyberPolicy", "misalignmentPolicyViolation", "tooManyDenials",
  "internalServerError", "unauthorized", "badRequest", "threadRollbackFailed", "sandboxError", "other"
];

const codexErrorInfo = fc.oneof(
  fc.constantFrom(...BARE),
  fc.record({
    key: fc.constantFrom(...WITH_STATUS),
    status: fc.option(fc.integer({ min: 100, max: 599 }), { nil: null })
  }).map(({ key, status }) => ({ [key]: { httpStatusCode: status } })),
  fc.constant({ activeTurnNotSteerable: { turnKind: "review" } }),
  fc.constant(null)
);

describe("isCodexNetworkUnavailable (property)", () => {
  test("offline only for a no-answer transport failure with no HTTP status", () => {
    fc.assert(fc.property(codexErrorInfo, (info) => {
      const expected = info !== null && typeof info === "object" &&
        NO_ANSWER.some((key) => key in info &&
          (info as Record<string, { httpStatusCode: number | null }>)[key]!.httpStatusCode === null);
      expect(isCodexNetworkUnavailable(info as never)).toBe(expected);
      // The run-level classifier agrees, through the error the pool throws.
      expect(isEnrichmentBackendUnavailable(new CodexTurnFailedError("x", info as never))).toBe(expected);
    }), { numRuns: 500 });
  });

  test("never throws, and never says offline, for shapes it does not know", () => {
    fc.assert(fc.property(fc.anything(), (value) => {
      const knownOffline = typeof value === "object" && value !== null && !Array.isArray(value) &&
        NO_ANSWER.some((key) => Object.prototype.hasOwnProperty.call(value, key));
      if (!knownOffline) expect(isCodexNetworkUnavailable(value as never)).toBe(false);
    }), { numRuns: 500 });
  });
});

describe("rawTurnErrorFor", () => {
  const info = { httpConnectionFailed: { httpStatusCode: null } };
  test("reads the final error notification and turn/completed for this turn only", () => {
    expect(rawTurnErrorFor("error",
      { threadId: "t", turnId: "u", willRetry: false, error: { message: "m", codexErrorInfo: info } }, "t", "u"))
      .toEqual({ message: "m", codexErrorInfo: info });
    expect(rawTurnErrorFor("turn/completed",
      { threadId: "t", turn: { id: "u", status: "failed", error: { message: "m", codexErrorInfo: info } } }, "t", "u"))
      .toEqual({ message: "m", codexErrorInfo: info });
  });

  test("ignores an error Codex will retry, another turn, and other methods", () => {
    expect(rawTurnErrorFor("error",
      { threadId: "t", turnId: "u", willRetry: true, error: { message: "m", codexErrorInfo: info } }, "t", "u")).toBeNull();
    expect(rawTurnErrorFor("error",
      { threadId: "t", turnId: "other", willRetry: false, error: { message: "m", codexErrorInfo: info } }, "t", "u")).toBeNull();
    expect(rawTurnErrorFor("turn/completed", { threadId: "t", turn: { id: "u", error: null } }, "t", "u")).toBeNull();
    expect(rawTurnErrorFor("item/completed", { threadId: "t", turnId: "u" }, "t", "u")).toBeNull();
  });
});
