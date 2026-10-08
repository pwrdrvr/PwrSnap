// In-process listeners for AI run updates.
//
// `broadcastAiRunUpdated` in codex-handlers.ts tells renderer windows (and
// the peer process) about every run transition. Main-side code that needs
// to wait for a run to finish — the enrichment repair job — subscribes
// here instead of polling the database. A listener that throws is logged
// and skipped, so one bad observer cannot stop the broadcast.

import type { AiRunSnapshot } from "@pwrsnap/shared";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:ai-run-observers");

type AiRunObserver = (run: AiRunSnapshot) => void;

const observers = new Set<AiRunObserver>();

export function observeAiRuns(observer: AiRunObserver): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

export function notifyAiRunObservers(run: AiRunSnapshot | null): void {
  if (run === null) return;
  for (const observer of [...observers]) {
    try {
      observer(run);
    } catch (error) {
      log.warn("AI run observer threw", {
        runId: run.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
