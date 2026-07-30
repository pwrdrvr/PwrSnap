import type { AiUsageRateSnapshot } from "@pwrsnap/shared";

export const AI_PRICING_CATALOG_VERSION = "2026-07-30-gpt-5.6";
export const AI_PRICING_EFFECTIVE_DATE = "2026-07-30";
/** Default/source landing pages, keyed only loosely — each entry carries its
 *  own `pricingSourceUrl`, so this is just a fallback for display. */
export const AI_PRICING_SOURCE_URL = "https://developers.openai.com/api/docs/models";

const GEMINI_PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";

export type AiPricingCatalogEntry = {
  model: string;
  provider: string;
  serviceTier: string | null;
  contextClass: string | null;
  /** Effective date for this historical rate. */
  effectiveFrom: string;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  pricingSourceUrl: string;
};

export type CodexCreditsPricingCatalogEntry = {
  model: "gpt-5.6-luna" | "gpt-5.6-terra";
  serviceTier: "standard" | "fast";
  effectiveFrom: string;
  inputCreditsPerMillion: number;
  cachedInputCreditsPerMillion: number;
  outputCreditsPerMillion: number;
};

export const AI_PRICING_CATALOG: readonly AiPricingCatalogEntry[] = [
  {
    model: "gpt-5.5",
    provider: "openai",
    serviceTier: null,
    contextClass: "standard",
    effectiveFrom: "2026-06-04",
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 30,
    pricingSourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.5"
  },
  {
    model: "gpt-5.4",
    provider: "openai",
    serviceTier: null,
    contextClass: "standard",
    effectiveFrom: "2026-06-04",
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    outputUsdPerMillion: 15,
    pricingSourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.4"
  },
  {
    model: "gpt-5.4-mini",
    provider: "openai",
    serviceTier: null,
    contextClass: "standard",
    effectiveFrom: "2026-06-04",
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 4.5,
    pricingSourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.4-mini"
  },
  {
    model: "gpt-5.6-luna",
    provider: "openai",
    serviceTier: null,
    contextClass: "standard",
    effectiveFrom: "2026-07-30",
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    outputUsdPerMillion: 1.2,
    pricingSourceUrl: "https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/"
  },
  {
    model: "gpt-5.6-luna",
    provider: "openai",
    serviceTier: "fast",
    contextClass: "standard",
    effectiveFrom: "2026-07-30",
    inputUsdPerMillion: 0.4,
    cachedInputUsdPerMillion: 0.04,
    outputUsdPerMillion: 2.4,
    pricingSourceUrl: "https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/"
  },
  {
    model: "gpt-5.6-terra",
    provider: "openai",
    serviceTier: null,
    contextClass: "standard",
    effectiveFrom: "2026-07-30",
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 12,
    pricingSourceUrl: "https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/"
  },
  {
    model: "gpt-5.6-terra",
    provider: "openai",
    serviceTier: "fast",
    contextClass: "standard",
    effectiveFrom: "2026-07-30",
    inputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.4,
    outputUsdPerMillion: 24,
    pricingSourceUrl: "https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/"
  },
  // Gemini (ACP via Gemini CLI). The kit reports `modelProvider: "gemini"`.
  // Preview models are priced at their tier's published Gemini list rate
  // (pro / flash / flash-lite). These are list-price ESTIMATES, not invoices.
  {
    model: "gemini-3-pro-preview",
    provider: "gemini",
    serviceTier: null,
    contextClass: "standard",
    effectiveFrom: "2026-06-04",
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.31,
    outputUsdPerMillion: 10,
    pricingSourceUrl: GEMINI_PRICING_SOURCE
  },
  {
    model: "gemini-3-flash-preview",
    provider: "gemini",
    serviceTier: null,
    contextClass: "standard",
    effectiveFrom: "2026-06-04",
    inputUsdPerMillion: 0.3,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 2.5,
    pricingSourceUrl: GEMINI_PRICING_SOURCE
  },
  {
    model: "gemini-2.5-pro",
    provider: "gemini",
    serviceTier: null,
    contextClass: "standard",
    effectiveFrom: "2026-06-04",
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.31,
    outputUsdPerMillion: 10,
    pricingSourceUrl: GEMINI_PRICING_SOURCE
  },
  {
    model: "gemini-2.5-flash",
    provider: "gemini",
    serviceTier: null,
    contextClass: "standard",
    effectiveFrom: "2026-06-04",
    inputUsdPerMillion: 0.3,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 2.5,
    pricingSourceUrl: GEMINI_PRICING_SOURCE
  },
  {
    model: "gemini-3.1-flash-lite",
    provider: "gemini",
    serviceTier: null,
    contextClass: "standard",
    effectiveFrom: "2026-06-04",
    inputUsdPerMillion: 0.1,
    cachedInputUsdPerMillion: 0.025,
    outputUsdPerMillion: 0.4,
    pricingSourceUrl: GEMINI_PRICING_SOURCE
  }
] as const;

/** Codex / ChatGPT Work credit rates are tracked separately from API USD
 * rates because credits are quota accounting, not invoice currency. */
export const CODEX_CREDITS_PRICING_CATALOG: readonly CodexCreditsPricingCatalogEntry[] = [
  { model: "gpt-5.6-luna", serviceTier: "standard", effectiveFrom: "2026-07-30", inputCreditsPerMillion: 5, cachedInputCreditsPerMillion: 0.5, outputCreditsPerMillion: 30 },
  { model: "gpt-5.6-luna", serviceTier: "fast", effectiveFrom: "2026-07-30", inputCreditsPerMillion: 12.5, cachedInputCreditsPerMillion: 1.25, outputCreditsPerMillion: 75 },
  { model: "gpt-5.6-terra", serviceTier: "standard", effectiveFrom: "2026-07-30", inputCreditsPerMillion: 50, cachedInputCreditsPerMillion: 5, outputCreditsPerMillion: 300 },
  { model: "gpt-5.6-terra", serviceTier: "fast", effectiveFrom: "2026-07-30", inputCreditsPerMillion: 125, cachedInputCreditsPerMillion: 12.5, outputCreditsPerMillion: 750 }
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
