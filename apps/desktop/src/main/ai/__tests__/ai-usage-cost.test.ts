import { describe, expect, test } from "vitest";
import { estimateAiUsageCost } from "../ai-usage-cost";

describe("estimateAiUsageCost", () => {
  test("prices gpt-5.4-mini usage with cached, uncached, and output buckets", () => {
    const estimate = estimateAiUsageCost({
      model: "gpt-5.4-mini",
      provider: "openai",
      serviceTier: null,
      tokens: {
        totalTokens: 1_500,
        inputTokens: 1_000,
        cachedInputTokens: 200,
        outputTokens: 500,
        reasoningOutputTokens: 50,
        modelContextWindow: null
      }
    });

    expect(estimate.status).toBe("available");
    if (estimate.status === "available") {
      expect(estimate.uncachedInputTokens).toBe(800);
      expect(estimate.cachedInputTokens).toBe(200);
      expect(estimate.outputTokens).toBe(500);
      expect(estimate.uncachedInputCostMicros).toBe(600);
      expect(estimate.cachedInputCostMicros).toBe(15);
      expect(estimate.outputCostMicros).toBe(2_250);
      expect(estimate.totalCostMicros).toBe(2_865);
    }
  });

  test("does not throw when cached input exceeds total input", () => {
    const estimate = estimateAiUsageCost({
      model: "gpt-5.4-mini",
      provider: "openai",
      serviceTier: "standard",
      tokens: {
        totalTokens: 120,
        inputTokens: 50,
        cachedInputTokens: 80,
        outputTokens: 70,
        reasoningOutputTokens: 0,
        modelContextWindow: null
      }
    });

    expect(estimate.status).toBe("available");
    if (estimate.status === "available") {
      expect(estimate.uncachedInputTokens).toBe(0);
      expect(estimate.cachedInputTokens).toBe(80);
    }
  });

  test("reports unavailable when usage or model pricing is missing", () => {
    expect(
      estimateAiUsageCost({
        model: "gpt-5.4-mini",
        provider: "openai",
        serviceTier: null,
        tokens: null
      })
    ).toEqual({ status: "unavailable", reason: "usage unavailable" });

    expect(
      estimateAiUsageCost({
        model: "unknown-model",
        provider: "openai",
        serviceTier: null,
        tokens: {
          totalTokens: 1,
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          modelContextWindow: null
        }
      })
    ).toEqual({
      status: "unavailable",
      reason: "no pricing catalog entry for unknown-model"
    });
  });
});
