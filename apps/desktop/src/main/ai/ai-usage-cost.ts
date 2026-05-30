import type { AiUsageCostEstimate, AiUsageTokenBreakdown } from "@pwrsnap/shared";
import {
  AI_PRICING_CATALOG_VERSION,
  AI_PRICING_EFFECTIVE_DATE,
  entryToRateSnapshot,
  findPricingEntry
} from "./pricing-catalog";

export function estimateAiUsageCost(input: {
  model: string | null;
  provider: string | null;
  serviceTier: string | null;
  tokens: AiUsageTokenBreakdown | null;
}): AiUsageCostEstimate {
  if (input.tokens === null) {
    return { status: "unavailable", reason: "usage unavailable" };
  }
  if (input.model === null) {
    return { status: "unavailable", reason: "model unavailable" };
  }

  const entry = findPricingEntry(input);
  if (entry === null) {
    return {
      status: "unavailable",
      reason: `no pricing catalog entry for ${input.model}`
    };
  }

  const cachedInputTokens = Math.max(0, input.tokens.cachedInputTokens);
  const uncachedInputTokens = Math.max(
    0,
    input.tokens.inputTokens - cachedInputTokens
  );
  const outputTokens = Math.max(0, input.tokens.outputTokens);
  const uncachedInputCostMicros = estimateMicros(
    uncachedInputTokens,
    entry.inputUsdPerMillion
  );
  const cachedInputCostMicros = estimateMicros(
    cachedInputTokens,
    entry.cachedInputUsdPerMillion
  );
  const outputCostMicros = estimateMicros(outputTokens, entry.outputUsdPerMillion);

  return {
    status: "available",
    currency: "USD",
    catalogVersion: AI_PRICING_CATALOG_VERSION,
    pricingSourceUrl: entry.pricingSourceUrl,
    pricedAt: new Date(`${AI_PRICING_EFFECTIVE_DATE}T00:00:00.000Z`).toISOString(),
    rateSnapshot: entryToRateSnapshot(entry),
    uncachedInputTokens,
    cachedInputTokens,
    outputTokens,
    uncachedInputCostMicros,
    cachedInputCostMicros,
    outputCostMicros,
    totalCostMicros:
      uncachedInputCostMicros + cachedInputCostMicros + outputCostMicros
  };
}

function estimateMicros(tokens: number, usdPerMillionTokens: number): number {
  return Math.round(tokens * usdPerMillionTokens);
}
