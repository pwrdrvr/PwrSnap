import type { AppUpdateCheckResult } from "@pwrsnap/shared";

export interface InFlightUpdateCheck {
  selection: string | undefined;
  promise: Promise<AppUpdateCheckResult>;
}

// Bound microtask retries, not network time. A pending network request yields
// to the event loop; repeatedly awaiting an already settled promise does not.
const MAX_SELECTION_WAITS = 8;

export async function waitForUpdateCheckSlot(
  selection: string,
  readInFlight: () => InFlightUpdateCheck | undefined,
  onWait: (check: InFlightUpdateCheck) => void,
  startCheck: () => Promise<AppUpdateCheckResult>
): Promise<AppUpdateCheckResult> {
  let settled: Promise<AppUpdateCheckResult> | undefined;
  for (let waits = 0; ; waits++) {
    const check = readInFlight();
    // Reserve synchronously: awaiting an empty-slot result in the caller
    // would allow multiple callers to start overlapping checks.
    if (!check) return startCheck();
    // Check identity BEFORE joining: even a matching selection must not reuse
    // a completed check whose owner failed to release it.
    if (check.promise === settled) {
      throw new Error("Update check did not release its completed request. Please restart PwrSnap.");
    }
    if (check.selection === selection) return check.promise;
    if (waits >= MAX_SELECTION_WAITS) {
      throw new Error("Update selection kept changing while checking. Please try again.");
    }
    onWait(check);
    await check.promise.catch(() => undefined);
    settled = check.promise;
  }
}
