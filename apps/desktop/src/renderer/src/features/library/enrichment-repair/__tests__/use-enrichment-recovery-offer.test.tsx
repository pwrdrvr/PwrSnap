// The back-online offer: a recovery nudge from main becomes an offer only
// when something failed in that span, and the span looks back a little
// before the first failed attempt.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, type EnrichmentRepairCriteria } from "@pwrsnap/shared";

import {
  RECOVERY_LOOKBACK_MS,
  useEnrichmentRecoveryOffer,
  type EnrichmentRecoveryOffer
} from "../use-enrichment-recovery-offer";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement;
let root: Root;
let listeners: Map<string, (payload: unknown) => void>;
let failed: number;
let criteria: EnrichmentRepairCriteria[];
let seen: EnrichmentRecoveryOffer | null;

function Probe(): null {
  seen = useEnrichmentRecoveryOffer().offer;
  return null;
}

beforeEach(async () => {
  listeners = new Map();
  criteria = [];
  failed = 6;
  seen = null;
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      on: (channel: string, listener: (payload: unknown) => void) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
      dispatch: vi.fn(async (_name: string, req: { criteria: EnrichmentRepairCriteria }) => {
        criteria.push(req.criteria);
        return { ok: true, value: { total: failed, byStatus: { failed, never: 0 }, apps: [] } };
      })
    }
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Probe)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function recover(): Promise<void> {
  await act(async () => {
    listeners.get(EVENT_CHANNELS.enrichmentPrimaryRecovered)?.({
      provider: "codex",
      downSince: "2026-10-07T10:42:00.000Z",
      upAt: "2026-10-07T11:20:00.000Z"
    });
  });
}

describe("useEnrichmentRecoveryOffer", () => {
  test("offers the failed snaps from a little before the outage to its end", async () => {
    await recover();
    const since = new Date(Date.parse("2026-10-07T10:42:00.000Z") - RECOVERY_LOOKBACK_MS).toISOString();
    expect(criteria).toEqual([
      { statuses: ["failed"], since, until: "2026-10-07T11:20:00.000Z", apps: { mode: "include", appIds: [] } }
    ]);
    expect(seen).toEqual({
      downSince: "2026-10-07T10:42:00.000Z",
      upAt: "2026-10-07T11:20:00.000Z",
      since,
      until: "2026-10-07T11:20:00.000Z",
      failed: 6
    });
  });

  test("nothing failed, nothing offered", async () => {
    failed = 0;
    await recover();
    expect(seen).toBeNull();
  });
});
