import type { AiEnrichmentBudgetStatus, Settings } from "@pwrsnap/shared";

export const AI_ENRICHMENT_BUDGET_DEFAULTS = {
  capacity: 20,
  refillIntervalMs: 6_000,
  limitedAttemptWindowMs: 60 * 60 * 1000,
  disableThreshold: 8
} as const;

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
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private readonly limitedAttemptWindowMs: number;
  private readonly disableThreshold: number;
  private readonly nowMs: () => number;
  private tokens: number;
  private lastRefillAtMs: number;
  private readonly limitedAttemptsMs: number[] = [];
  private sawSafetyDisabled = false;

  constructor(config: AiEnrichmentBudgetConfig = {}) {
    this.capacity = config.capacity ?? AI_ENRICHMENT_BUDGET_DEFAULTS.capacity;
    this.refillIntervalMs =
      config.refillIntervalMs ?? AI_ENRICHMENT_BUDGET_DEFAULTS.refillIntervalMs;
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
    if (settings.ai.budgetSafetyDisabledAt !== null) {
      this.sawSafetyDisabled = true;
      return;
    }
    if (!this.sawSafetyDisabled) return;
    this.reset();
    this.sawSafetyDisabled = false;
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
