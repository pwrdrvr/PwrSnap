// How fast capture enrichment may start runs, as a token bucket: `burst`
// runs back to back, then `perMinute` after that. The default is cautious
// on purpose — a stuck hotkey or a folder import must not run up a bill.
// A user on a fast SaaS model, or re-running a backlog, can raise it in
// Settings → AI Features; the cost-safety breaker still applies.

export type AiEnrichmentRateLimit = { burst: number; perMinute: number };

export const AI_ENRICHMENT_RATE_LIMIT_DEFAULT: AiEnrichmentRateLimit = { burst: 20, perMinute: 10 };

export const AI_ENRICHMENT_RATE_LIMIT_BOUNDS = {
  burst: { min: 1, max: 200 },
  perMinute: { min: 1, max: 600 }
} as const;

function inBounds(value: unknown, bounds: { min: number; max: number }): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= bounds.min && value <= bounds.max;
}

export function isAiEnrichmentRateLimit(value: unknown): value is AiEnrichmentRateLimit {
  if (typeof value !== "object" || value === null) return false;
  const { burst, perMinute } = value as Record<string, unknown>;
  return (
    inBounds(burst, AI_ENRICHMENT_RATE_LIMIT_BOUNDS.burst) &&
    inBounds(perMinute, AI_ENRICHMENT_RATE_LIMIT_BOUNDS.perMinute)
  );
}

/** The limit in force: the user's override, or the default. */
export function effectiveAiEnrichmentRateLimit(
  override: AiEnrichmentRateLimit | null | undefined
): AiEnrichmentRateLimit {
  return override ?? AI_ENRICHMENT_RATE_LIMIT_DEFAULT;
}

/** One token every this many ms. */
export function aiEnrichmentRefillIntervalMs(limit: AiEnrichmentRateLimit): number {
  return Math.max(1, Math.round(60_000 / limit.perMinute));
}
