import type { AiUsageRateSnapshot } from "@pwrsnap/shared";

export const AI_PRICING_CATALOG_VERSION = "2026-05-30-openai-public";
export const AI_PRICING_EFFECTIVE_DATE = "2026-05-30";
export const AI_PRICING_SOURCE_URL = "https://developers.openai.com/api/docs/pricing";

export type AiPricingCatalogEntry = {
  model: string;
  provider: string;
  serviceTier: string | null;
  contextClass: string | null;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

export const AI_PRICING_CATALOG: readonly AiPricingCatalogEntry[] = [
  {
    model: "gpt-5.4-mini",
    provider: "openai",
    serviceTier: null,
    contextClass: "standard",
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 4.5
  }
] as const;

export function findPricingEntry(input: {
  model: string | null;
  provider: string | null;
  serviceTier: string | null;
}): AiPricingCatalogEntry | null {
  if (input.model === null) return null;
  const provider = input.provider ?? "openai";
  return (
    AI_PRICING_CATALOG.find(
      (entry) =>
        entry.model === input.model &&
        entry.provider === provider &&
        serviceTierMatches(entry.serviceTier, input.serviceTier)
    ) ?? null
  );
}

export function entryToRateSnapshot(entry: AiPricingCatalogEntry): AiUsageRateSnapshot {
  return {
    model: entry.model,
    serviceTier: entry.serviceTier,
    contextClass: entry.contextClass,
    inputUsdPerMillion: entry.inputUsdPerMillion,
    cachedInputUsdPerMillion: entry.cachedInputUsdPerMillion,
    outputUsdPerMillion: entry.outputUsdPerMillion
  };
}

function serviceTierMatches(entryTier: string | null, actualTier: string | null): boolean {
  if (entryTier === actualTier) return true;
  return entryTier === null && (actualTier === null || actualTier === "standard");
}
