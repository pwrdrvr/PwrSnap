// The re-run job stays off the live enrichment budget only because its
// production deps enqueue through the dispatcher `registerCodexHandlers`
// returns. A refactor back to `bus.dispatch("codex:enrich", …)` would pass
// every runner and handler test while spending live tokens again, so the
// production wiring is pinned here, not the runner's fakes.

import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { PwrSnapError, Result } from "@pwrsnap/shared";

import { bus } from "../../command-bus";
import type { EnrichmentRepairDispatcher } from "../codex-handlers";
import { productionRepairDeps } from "../enrichment-repair-handlers";

describe("enrichment repair production wiring", () => {
  test("enqueues and paces through the dispatcher, never through the bus", async () => {
    const enqueued: Result<{ runId: string }, PwrSnapError> = { ok: true, value: { runId: "run-1" } };
    const dispatcher: EnrichmentRepairDispatcher = {
      enrich: vi.fn(async () => enqueued),
      dispatchIntervalMs: vi.fn(async () => 6_000)
    };
    const dispatch = vi.spyOn(bus, "dispatch");
    try {
      const deps = productionRepairDeps(dispatcher);
      await expect(deps.enrich("cap_1")).resolves.toBe(enqueued);
      await expect(deps.dispatchIntervalMs()).resolves.toBe(6_000);
      expect(dispatcher.enrich).toHaveBeenCalledWith("cap_1");
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      dispatch.mockRestore();
    }
  });

  test("index.ts hands the codex handlers' dispatcher to the repair handlers", () => {
    const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(source).toContain("registerEnrichmentRepairHandlers(productionRepairDeps(registerCodexHandlers()));");
  });
});
