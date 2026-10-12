// How many snaps, across all time, AI failed on and never read: the numbers
// the ways into the re-run dialog show (the Library status bar, the detail
// rail, Settings → AI Features). Read once, then re-read shortly after any
// AI run, capture, or repair job change, at most once per interval, so a
// burst of broadcasts costs one preview.

import { useEffect, useState } from "react";
import { EVENT_CHANNELS, type EnrichmentRepairCriteria, type EnrichmentRepairPreview } from "@pwrsnap/shared";

import { dispatch, subscribe } from "../../../lib/pwrsnap";

export type EnrichmentRepairCounts = { failed: number; never: number };

export const REPAIR_COUNTS_REFRESH_MS = 1500;

const ALL_TIME: EnrichmentRepairCriteria = {
  statuses: ["failed", "never"],
  since: null,
  until: null,
  apps: { mode: "include", appIds: [] }
};

export function useEnrichmentRepairCounts(active = true): EnrichmentRepairCounts | null {
  const [counts, setCounts] = useState<EnrichmentRepairCounts | null>(null);
  useEffect(() => {
    if (!active) {
      setCounts(null);
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = (): void => {
      void dispatch("codex:repair:preview", { criteria: ALL_TIME }).then((result) => {
        // A peer that does not know the verb yet answers with nothing.
        const byStatus = result.ok ? (result.value as Partial<EnrichmentRepairPreview> | undefined)?.byStatus : undefined;
        if (cancelled || byStatus === undefined) return;
        setCounts({ failed: byStatus.failed, never: byStatus.never });
      });
    };
    // At most one read per interval. Not a debounce: a repair broadcasts
    // steadily, and a timer that restarts on every event would hold the
    // counts still for the whole run.
    const schedule = (): void => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        read();
      }, REPAIR_COUNTS_REFRESH_MS);
    };
    const unsubscribers = [
      subscribe(EVENT_CHANNELS.aiRunUpdated, schedule),
      subscribe(EVENT_CHANNELS.capturesChanged, schedule),
      subscribe(EVENT_CHANNELS.enrichmentRepairJob, schedule)
    ];
    read();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [active]);
  return counts;
}
