import { describe, expect, test } from "vitest";
import type { Settings } from "@pwrsnap/shared";
import { AiEnrichmentBudget } from "../enrichment-budget";
import { defaultSettings } from "../../settings/desktop-settings-service";

function enabledSettings(patch?: Partial<Settings["ai"]>): Settings {
  return {
    ...defaultSettings(),
    ai: {
      ...defaultSettings().ai,
      enabled: true,
      consentAcceptedAt: "2026-05-12T12:00:00.000Z",
      budgetSafetyDisabledAt: null,
      autoAcceptSuggestions: false,
      ...patch
    }
  };
}

describe("AiEnrichmentBudget", () => {
  test("allows up to capacity and then enters slow mode", () => {
    let now = 1_000;
    const budget = new AiEnrichmentBudget({
      capacity: 2,
      refillIntervalMs: 6_000,
      nowMs: () => now
    });
    const settings = enabledSettings();

    expect(budget.consume(settings).allowed).toBe(true);
    expect(budget.consume(settings).allowed).toBe(true);
    const limited = budget.consume(settings);

    expect(limited.allowed).toBe(false);
    if (limited.allowed) return;
    expect(limited.reason).toBe("slow");
    expect(limited.after.mode).toBe("slow");
    expect(limited.after.tokensAvailable).toBe(0);

    now += 6_000;
    expect(budget.status(settings).mode).toBe("available");
    expect(budget.status(settings).tokensAvailable).toBe(1);
  });

  test("asks caller to disable AI after repeated limited attempts in the window", () => {
    const budget = new AiEnrichmentBudget({
      capacity: 0,
      disableThreshold: 2
    });
    const settings = enabledSettings();

    const first = budget.consume(settings);
    const second = budget.consume(settings);

    expect(first.allowed).toBe(false);
    expect(second.allowed).toBe(false);
    if (second.allowed) return;
    expect(second.shouldDisableAi).toBe(true);
    expect(second.after.limitedAttemptsLastHour).toBe(2);
  });

  test("blocks immediately when settings carry the persisted safety disable", () => {
    const budget = new AiEnrichmentBudget();
    const disabled = budget.consume(
      enabledSettings({ enabled: false, budgetSafetyDisabledAt: "2026-05-12T12:30:00.000Z" })
    );

    expect(disabled.allowed).toBe(false);
    if (disabled.allowed) return;
    expect(disabled.reason).toBe("safety_disabled");
    expect(disabled.shouldDisableAi).toBe(false);
    expect(disabled.after.disabledAt).toBe("2026-05-12T12:30:00.000Z");
  });

  test("resets local counters after the persisted safety disable is cleared", () => {
    const budget = new AiEnrichmentBudget({
      capacity: 0,
      disableThreshold: 1
    });
    const settings = enabledSettings();
    const limited = budget.consume(settings);
    expect(limited.allowed).toBe(false);

    budget.status(
      enabledSettings({ enabled: false, budgetSafetyDisabledAt: "2026-05-12T12:30:00.000Z" })
    );
    const resetStatus = budget.status(settings);

    expect(resetStatus.limitedAttemptsLastHour).toBe(0);
  });

  test("defaults to a burst of 20 and 10 a minute", () => {
    const budget = new AiEnrichmentBudget({ nowMs: () => 0 });
    const status = budget.status(enabledSettings());
    expect(status.capacity).toBe(20);
    expect(status.refillIntervalMs).toBe(6_000);
  });

  test("a user rate limit reshapes the bucket, and clearing it restores the default", () => {
    let now = 0;
    const budget = new AiEnrichmentBudget({ nowMs: () => now });
    const fast = enabledSettings({ enrichmentRateLimit: { burst: 60, perMinute: 120 } });
    for (let i = 0; i < 20; i += 1) expect(budget.consume(enabledSettings()).allowed).toBe(true);
    expect(budget.status(enabledSettings()).tokensAvailable).toBe(0);

    // Raising the burst adds its extra room at once.
    const raised = budget.status(fast);
    expect(raised).toMatchObject({ capacity: 60, refillIntervalMs: 500, tokensAvailable: 40 });
    now += 1_000;
    expect(budget.status(fast).tokensAvailable).toBe(42);

    // Back to the default: clamped to the smaller burst.
    expect(budget.status(enabledSettings())).toMatchObject({
      capacity: 20,
      refillIntervalMs: 6_000,
      tokensAvailable: 20
    });
  });

  test("switching to a faster rate credits at most one token for time already waited", () => {
    let now = 0;
    const budget = new AiEnrichmentBudget({ capacity: 5, refillIntervalMs: 60_000, nowMs: () => now });
    for (let i = 0; i < 5; i += 1) budget.consume(enabledSettings());
    now += 59_000;
    const fast = enabledSettings({ enrichmentRateLimit: { burst: 5, perMinute: 600 } });
    // 59s at the old rate is worth one token at the new one, not 590.
    expect(budget.status(fast).tokensAvailable).toBe(1);
    now += 100;
    expect(budget.status(fast).tokensAvailable).toBe(2);
  });
});
