import { describe, expect, test } from "vitest";
import { estimateAiUsageCost } from "../ai-usage-cost";
import {
  CODEX_CREDITS_PRICING_CATALOG,
  findCodexCreditsPricingEntry
} from "../pricing-catalog";

describe("estimateAiUsageCost", () => {
  test.each([
    ["gpt-5.6-luna", null, 0.2, 0.02, 1.2, null],
    ["gpt-5.6-luna", "fast", 0.4, 0.04, 2.4, "fast"],
    ["gpt-5.6-luna", "priority", 0.4, 0.04, 2.4, "fast"],
    ["gpt-5.6-terra", null, 2, 0.2, 12, null],
    ["gpt-5.6-terra", "fast", 4, 0.4, 24, "fast"],
    ["gpt-5.6-terra", "priority", 4, 0.4, 24, "fast"]
  ] as const)(
    "prices %s service tier %s at the July 30 API rate",
    (model, serviceTier, input, cached, output, catalogTier) => {
      const estimate = estimateAiUsageCost({
        model,
        provider: "openai",
        serviceTier,
        tokens: {
          totalTokens: 1_000_000,
          inputTokens: 600_000,
          cachedInputTokens: 100_000,
          outputTokens: 400_000,
          reasoningOutputTokens: 0,
          modelContextWindow: null
        }
      });

      expect(estimate.status).toBe("available");
      if (estimate.status === "available") {
        expect(estimate.catalogVersion).toBe("2026-07-30-gpt-5.6");
        expect(estimate.pricedAt).toBe("2026-07-30T00:00:00.000Z");
        expect(estimate.pricingSourceUrl).toBe(
          "https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/"
        );
        expect(estimate.rateSnapshot.serviceTier).toBe(catalogTier);
        expect(estimate.rateSnapshot.inputUsdPerMillion).toBe(input);
        expect(estimate.rateSnapshot.cachedInputUsdPerMillion).toBe(cached);
        expect(estimate.rateSnapshot.outputUsdPerMillion).toBe(output);
        expect(estimate.uncachedInputCostMicros).toBe(Math.round(500_000 * input));
        expect(estimate.cachedInputCostMicros).toBe(Math.round(100_000 * cached));
        expect(estimate.outputCostMicros).toBe(Math.round(400_000 * output));
      }
    }
  );

  test("records the July 30 GPT-5.6 Codex credit catalog and maps priority to Fast", () => {
    expect(CODEX_CREDITS_PRICING_CATALOG).toEqual([
      {
        model: "gpt-5.6-luna",
        serviceTier: "standard",
        effectiveFrom: "2026-07-30",
        inputCreditsPerMillion: 5,
        cachedInputCreditsPerMillion: 0.5,
        outputCreditsPerMillion: 30
      },
      {
        model: "gpt-5.6-luna",
        serviceTier: "fast",
        effectiveFrom: "2026-07-30",
        inputCreditsPerMillion: 12.5,
        cachedInputCreditsPerMillion: 1.25,
        outputCreditsPerMillion: 75
      },
      {
        model: "gpt-5.6-terra",
        serviceTier: "standard",
        effectiveFrom: "2026-07-30",
        inputCreditsPerMillion: 50,
        cachedInputCreditsPerMillion: 5,
        outputCreditsPerMillion: 300
      },
      {
        model: "gpt-5.6-terra",
        serviceTier: "fast",
        effectiveFrom: "2026-07-30",
        inputCreditsPerMillion: 125,
        cachedInputCreditsPerMillion: 12.5,
        outputCreditsPerMillion: 750
      }
    ]);
    expect(
      findCodexCreditsPricingEntry({
        model: "gpt-5.6-luna",
        serviceTier: "priority"
      })
    ).toEqual(
      expect.objectContaining({
        serviceTier: "fast",
        inputCreditsPerMillion: 12.5,
        cachedInputCreditsPerMillion: 1.25,
        outputCreditsPerMillion: 75
      })
    );
  });

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
      expect(estimate.pricedAt).toBe("2026-06-04T00:00:00.000Z");
      expect(estimate.pricingSourceUrl).toBe(
        "https://developers.openai.com/api/docs/models/gpt-5.4-mini"
      );
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

  test("prices gpt-5.5 usage when Codex reports the frontier default", () => {
    const estimate = estimateAiUsageCost({
      model: "gpt-5.5",
      provider: "openai",
      serviceTier: null,
      tokens: {
        totalTokens: 22_155,
        inputTokens: 21_981,
        cachedInputTokens: 2_432,
        outputTokens: 174,
        reasoningOutputTokens: 0,
        modelContextWindow: 1_050_000
      }
    });

    expect(estimate.status).toBe("available");
    if (estimate.status === "available") {
      expect(estimate.pricedAt).toBe("2026-06-04T00:00:00.000Z");
      expect(estimate.pricingSourceUrl).toBe(
        "https://developers.openai.com/api/docs/models/gpt-5.5"
      );
      expect(estimate.uncachedInputTokens).toBe(19_549);
      expect(estimate.cachedInputTokens).toBe(2_432);
      expect(estimate.outputTokens).toBe(174);
      expect(estimate.uncachedInputCostMicros).toBe(97_745);
      expect(estimate.cachedInputCostMicros).toBe(1_216);
      expect(estimate.outputCostMicros).toBe(5_220);
      expect(estimate.totalCostMicros).toBe(104_181);
    }
  });

  test("prices a Gemini ACP enrichment run (provider 'gemini')", () => {
    // Mirrors a live gemini-3-flash-preview enrichment turn.
    const estimate = estimateAiUsageCost({
      model: "gemini-3-flash-preview",
      provider: "gemini",
      serviceTier: null,
      tokens: {
        totalTokens: 10_645,
        inputTokens: 10_642,
        cachedInputTokens: 0,
        outputTokens: 3,
        reasoningOutputTokens: 0,
        modelContextWindow: null
      }
    });

    expect(estimate.status).toBe("available");
    if (estimate.status === "available") {
      expect(estimate.pricingSourceUrl).toBe(
        "https://ai.google.dev/gemini-api/docs/pricing"
      );
      // input 10,642 @ $0.30/M, output 3 @ $2.50/M.
      expect(estimate.uncachedInputCostMicros).toBe(3_193);
      expect(estimate.outputCostMicros).toBe(8);
      expect(estimate.totalCostMicros).toBe(3_201);
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
