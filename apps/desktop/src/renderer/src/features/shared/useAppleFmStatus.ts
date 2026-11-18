import { useEffect, useState } from "react";
import {
  EVENT_CHANNELS,
  isAppleFmProvider,
  newerAppleFmStatus,
  parseAppleFmStatusChangedEvent,
  type AppleFmStatus
} from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../lib/pwrsnap";

/**
 * What macOS reports about Apple's on-device model, followed ONLY while the
 * given enrichment provider selects it.
 *
 * Keyed on the selector for the same reason the ACP read beside it is: a
 * user who never chose the on-device model must never have `/usr/bin/fm`
 * run on their behalf, and window focus must never become a machine probe.
 *
 * While selected, the window reads main's cached answer once and then
 * follows `appleFmStatusChanged`. A broadcast status is taken as it arrives,
 * with no read of its own: that is how "Check again" in Settings reaches the
 * Library and the Float-Over. An invalidation (`status: null`, sent when a
 * caption run failed for a setup reason) means the held answer is stale, so
 * it is dropped and main is asked once; that read is single-flight in main
 * across every window. Nothing here polls, and nothing forces a re-check.
 *
 * `undefined` = not selected, or the answer has not landed yet.
 */
export function useAppleFmStatusWhenSelected(provider: string | undefined): AppleFmStatus | undefined {
  const selected = isAppleFmProvider(provider);
  const [status, setStatus] = useState<AppleFmStatus | undefined>(undefined);
  useEffect(() => {
    if (!selected) {
      setStatus(undefined);
      return;
    }
    let cancelled = false;
    const take = (incoming: AppleFmStatus): void => {
      // A read and a broadcast can land in either order; the later CHECK wins.
      setStatus((current) => newerAppleFmStatus(current, incoming));
    };
    const read = (): void => {
      void dispatch("appleFm:status", {}).then((result) => {
        if (!cancelled && result.ok) take(result.value);
      });
    };
    // Subscribe before asking, so a change that lands while the first read
    // is in flight is not missed.
    const unsubscribe = subscribe(EVENT_CHANNELS.appleFmStatusChanged, (payload) => {
      if (cancelled) return;
      const event = parseAppleFmStatusChangedEvent(payload);
      if (event === null) return;
      if (event.status === null) {
        setStatus(undefined);
        read();
        return;
      }
      take(event.status);
    });
    read();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [selected]);
  return status;
}
