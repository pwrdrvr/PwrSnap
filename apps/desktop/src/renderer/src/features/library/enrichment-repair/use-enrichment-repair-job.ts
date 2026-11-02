// The enrichment repair job as main reports it: read once on mount, then
// kept current by the `enrichmentRepairJob` broadcast. Main owns the job,
// so every Library window (and a reload) sees the same one.

import { useEffect, useState } from "react";
import { EVENT_CHANNELS, type EnrichmentRepairJob } from "@pwrsnap/shared";

import { dispatch, subscribe } from "../../../lib/pwrsnap";

function asJob(value: unknown): EnrichmentRepairJob | null {
  if (typeof value !== "object" || value === null) return null;
  const job = value as Partial<EnrichmentRepairJob>;
  return typeof job.jobId === "string" && typeof job.state === "string" && typeof job.total === "number"
    ? (job as EnrichmentRepairJob)
    : null;
}

export function useEnrichmentRepairJob(): {
  job: EnrichmentRepairJob | null;
  setJob: (job: EnrichmentRepairJob | null) => void;
} {
  const [job, setJob] = useState<EnrichmentRepairJob | null>(null);
  useEffect(() => {
    let cancelled = false;
    let heard = false;
    const unsubscribe = subscribe(EVENT_CHANNELS.enrichmentRepairJob, (payload) => {
      heard = true;
      setJob(asJob((payload as { job?: unknown } | null)?.job));
    });
    void dispatch("codex:repair:status", {}).then((result) => {
      // A broadcast that arrived while this read was in flight is newer.
      if (!cancelled && !heard && result.ok) setJob(asJob(result.value));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return { job, setJob };
}
