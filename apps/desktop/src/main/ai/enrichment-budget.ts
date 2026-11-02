import {
  AI_ENRICHMENT_RATE_LIMIT_DEFAULT,
  aiEnrichmentRefillIntervalMs,
  type AiEnrichmentBudgetStatus,
  type Settings
} from "@pwrsnap/shared";

export const AI_ENRICHMENT_BUDGET_DEFAULTS = {
  capacity: AI_ENRICHMENT_RATE_LIMIT_DEFAULT.burst,
  refillIntervalMs: aiEnrichmentRefillIntervalMs(AI_ENRICHMENT_RATE_LIMIT_DEFAULT),
  limitedAttemptWindowMs: 60 * 60 * 1000,
  disableThreshold: 8
} as const;

/** `capacity` / `refillIntervalMs` are the shape when the user has not set
 *  `ai.enrichmentRateLimit`; an override in settings wins over them. */
export type AiEnrichmentBudgetConfig = {
  capacity?: number;
  refillIntervalMs?: number;
  limitedAttemptWindowMs?: number;
  disableThreshold?: number;
  nowMs?: () => number;
};

export type AiEnrichmentBudgetDecision =
  | {
      allowed: true;
      before: AiEnrichmentBudgetStatus;
      after: AiEnrichmentBudgetStatus;
    }
  | {
      allowed: false;
      reason: "slow" | "safety_disabled";
      before: AiEnrichmentBudgetStatus;
      after: AiEnrichmentBudgetStatus;
      shouldDisableAi: boolean;
    };

export class AiEnrichmentBudget {
  private readonly baseCapacity: number;
  private readonly baseRefillIntervalMs: number;
  private capacity: number;
  private refillIntervalMs: number;
  private readonly limitedAttemptWindowMs: number;
  private readonly disableThreshold: number;
  private readonly nowMs: () => number;
  private tokens: number;
  private lastRefillAtMs: number;
  private readonly limitedAttemptsMs: number[] = [];
  private sawSafetyDisabled = false;

  constructor(config: AiEnrichmentBudgetConfig = {}) {
    this.baseCapacity = config.capacity ?? AI_ENRICHMENT_BUDGET_DEFAULTS.capacity;
    this.baseRefillIntervalMs =
      config.refillIntervalMs ?? AI_ENRICHMENT_BUDGET_DEFAULTS.refillIntervalMs;
    this.capacity = this.baseCapacity;
    this.refillIntervalMs = this.baseRefillIntervalMs;
    this.limitedAttemptWindowMs =
      config.limitedAttemptWindowMs ??
      AI_ENRICHMENT_BUDGET_DEFAULTS.limitedAttemptWindowMs;
    this.disableThreshold =
      config.disableThreshold ?? AI_ENRICHMENT_BUDGET_DEFAULTS.disableThreshold;
    this.nowMs = config.nowMs ?? (() => Date.now());
    this.tokens = this.capacity;
    this.lastRefillAtMs = this.nowMs();
  }

  consume(settings: Settings): AiEnrichmentBudgetDecision {
    this.reconcileSettings(settings);
    this.refill();
    const before = this.status(settings);
    if (settings.ai.budgetSafetyDisabledAt !== null) {
      return {
        allowed: false,
        reason: "safety_disabled",
        before,
        after: before,
        shouldDisableAi: false
      };
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return {
        allowed: true,
        before,
        after: this.status(settings)
      };
    }

    this.recordLimitedAttempt();
    const after = this.status(settings);
    return {
      allowed: false,
      reason: "slow",
      before,
      after,
      shouldDisableAi: after.limitedAttemptsLastHour >= this.disableThreshold
    };
  }

  status(settings: Settings): AiEnrichmentBudgetStatus {
    this.reconcileSettings(settings);
    this.refill();
    this.dropExpiredLimitedAttempts();
    const disabledAt = settings.ai.budgetSafetyDisabledAt;
    return {
      mode: disabledAt !== null ? "safety_disabled" : this.tokens >= 1 ? "available" : "slow",
      tokensAvailable: this.tokens,
      capacity: this.capacity,
      refillIntervalMs: this.refillIntervalMs,
      nextTokenAt:
        disabledAt !== null || this.tokens >= this.capacity
          ? null
          : new Date(this.lastRefillAtMs + this.refillIntervalMs).toISOString(),
      limitedAttemptsLastHour: this.limitedAttemptsMs.length,
      disableThreshold: this.disableThreshold,
      disabledAt
    };
  }

  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillAtMs = this.nowMs();
    this.limitedAttemptsMs.length = 0;
  }

  private refill(): void {
    const now = this.nowMs();
    if (now <= this.lastRefillAtMs) return;
    const elapsed = now - this.lastRefillAtMs;
    const tokensToAdd = Math.floor(elapsed / this.refillIntervalMs);
    if (tokensToAdd <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillAtMs += tokensToAdd * this.refillIntervalMs;
  }

  private reconcileSettings(settings: Settings): void {
    this.applyRateLimit(settings.ai.enrichmentRateLimit ?? null);
    if (settings.ai.budgetSafetyDisabledAt !== null) {
      this.sawSafetyDisabled = true;
      return;
    }
    if (!this.sawSafetyDisabled) return;
    this.reset();
    this.sawSafetyDisabled = false;
  }

  /** Reshape the bucket when the user's limit changes. Tokens already earned
   *  at the old rate are credited first; a bigger burst adds its extra room
   *  now (raising the limit is how a user unblocks a backlog), a smaller one
   *  clamps. */
  private applyRateLimit(override: Settings["ai"]["enrichmentRateLimit"]): void {
    const capacity = override?.burst ?? this.baseCapacity;
    const refillIntervalMs =
      override === null ? this.baseRefillIntervalMs : aiEnrichmentRefillIntervalMs(override);
    if (capacity === this.capacity && refillIntervalMs === this.refillIntervalMs) return;
    this.refill();
    this.tokens = Math.max(0, Math.min(capacity, this.tokens + Math.max(0, capacity - this.capacity)));
    this.capacity = capacity;
    this.refillIntervalMs = refillIntervalMs;
    this.lastRefillAtMs = Math.max(this.lastRefillAtMs, this.nowMs() - refillIntervalMs);
  }

  private recordLimitedAttempt(): void {
    this.dropExpiredLimitedAttempts();
    this.limitedAttemptsMs.push(this.nowMs());
  }

  private dropExpiredLimitedAttempts(): void {
    const cutoff = this.nowMs() - this.limitedAttemptWindowMs;
    while (this.limitedAttemptsMs.length > 0 && this.limitedAttemptsMs[0]! < cutoff) {
      this.limitedAttemptsMs.shift();
    }
  }
}

export const aiEnrichmentBudget = new AiEnrichmentBudget();
