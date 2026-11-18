import { useEffect, useState } from "react";
import { isAppleFmProvider, type AppleFmStatus } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

/**
 * What macOS reports about Apple's on-device model — read ONLY while the
 * given enrichment provider selects it.
 *
 * Keyed on the selector for the same reason the ACP read beside it is: a
 * user who never chose the on-device model must never have `/usr/bin/fm`
 * run on their behalf, and window focus must never become a machine probe.
 * Main answers from its cached status; nothing here forces a re-check.
 *
 * `undefined` = not asked, or the answer has not landed yet.
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
    void dispatch("appleFm:status", {}).then((result) => {
      if (!cancelled && result.ok) setStatus(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);
  return status;
}
