// The caption model answered again after captures failed to reach it: offer
// to re-run what failed in that span, if anything did. Main sends the
// `enrichmentPrimaryRecovered` nudge; this asks how many failed and holds
// the offer until it is taken or dismissed.

import { useCallback, useEffect, useState } from "react";
import {
  EVENT_CHANNELS,
  type EnrichmentPrimaryRecovery,
  type EnrichmentRepairPreview
} from "@pwrsnap/shared";

import { dispatch, subscribe } from "../../../lib/pwrsnap";

/** How far before a caption model's first failed attempt the offer looks
 *  for failed snaps: a capture is taken a little before its enrichment
 *  starts, and a queue can hold it longer. */
export const RECOVERY_LOOKBACK_MS = 2 * 60_000;

export type EnrichmentRecoveryOffer = {
  /** When the first run could not reach the model: what the toast says. */
  downSince: string;
  upAt: string;
  /** The span to re-run: `downSince` less the lookback, to `upAt`. */
  since: string;
  until: string;
  failed: number;
};

export function useEnrichmentRecoveryOffer(): {
  offer: EnrichmentRecoveryOffer | null;
  dismiss: () => void;
} {
  const [offer, setOffer] = useState<EnrichmentRecoveryOffer | null>(null);
  useEffect(
    () =>
      subscribe(EVENT_CHANNELS.enrichmentPrimaryRecovered, (payload) => {
        const recovery = payload as Partial<EnrichmentPrimaryRecovery> | null;
        if (typeof recovery?.downSince !== "string" || typeof recovery.upAt !== "string") return;
        const { downSince, upAt } = recovery;
        const since = new Date(Date.parse(downSince) - RECOVERY_LOOKBACK_MS).toISOString();
        void dispatch("codex:repair:preview", {
          criteria: { statuses: ["failed"], since, until: upAt, apps: { mode: "include", appIds: [] } }
        }).then((result) => {
          // A peer that does not know the verb yet answers with nothing.
          const failed = result.ok ? (result.value as Partial<EnrichmentRepairPreview> | undefined)?.total : undefined;
          if (failed !== undefined && failed > 0) setOffer({ downSince, upAt, since, until: upAt, failed });
        });
      }),
    []
  );
  const dismiss = useCallback(() => setOffer(null), []);
  return { offer, dismiss };
}
