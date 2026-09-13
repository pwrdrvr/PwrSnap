// The half of the update surface that only exists because SOMEBODY ASKED.
//
// Two channels, and they are not redundant (see features/update/AGENTS.md):
//   - `events:app-update:status`  — what the updater is DOING. Every check
//     moves it, including the hourly background ones.
//   - `events:app-update:check-result` — emitted from exactly one place,
//     `runMenuUpdateCheck` in main, i.e. Help -> Check for Updates.
//
// So the live card is gated on having seen a `checking` tick on the RESULT
// channel and is then driven by the STATUS channel. A background download
// must raise nothing: the user did not ask, and the only thing worth
// interrupting them for is the finished, actionable offer — which
// `appUpdateNotice` already carries.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppUpdateCheckResult, AppUpdateStatus } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import { useAppUpdateStatus } from "./use-app-update";
import {
  isUpdateCheckInProgress,
  updateCheckOutcomeNotice,
  updateProgressCopy,
  type AppUpdateProgressStatus,
  type UpdateCheckOutcomeNotice,
  type UpdateProgressCopy
} from "./update-progress";

/** Statuses on the result channel that carry a `version` the card prints.
 *  Same reasoning as `use-app-update.ts`: a payload claiming one of these
 *  without a version renders literal "vundefined". */
const VERSIONED_RESULTS = new Set(["no-update", "available", "downloaded", "canceled"]);

function asAppUpdateCheckResult(payload: unknown): AppUpdateCheckResult | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { status, version, reason, message } = payload as {
    status?: unknown;
    version?: unknown;
    reason?: unknown;
    message?: unknown;
  };
  if (typeof status !== "string") return undefined;
  if (VERSIONED_RESULTS.has(status) && typeof version !== "string") return undefined;
  if (status === "skipped" && typeof reason !== "string") return undefined;
  if (status === "error" && typeof message !== "string") return undefined;
  return payload as AppUpdateCheckResult;
}

export type UserUpdateCheck = {
  /** The live updater status this hook already subscribes to. Handed back so
   *  the host does not open a second subscription for the same broadcast. */
  status: AppUpdateStatus;
  /** The check is still working: live card, no countdown. */
  progress: UpdateProgressCopy | undefined;
  /** The check finished and left nothing to press: countdown notice. */
  outcome: UpdateCheckOutcomeNotice | undefined;
  /** Cancel was pressed and main has not answered with an outcome yet. */
  canceling: boolean;
  cancel: () => void;
  dismissOutcome: () => void;
  /** Bumped on every `checking` tick. Asking again is asking to see the
   *  answer again, so the host clears whatever a previous answer left
   *  behind — a dismissal, a failed restart — when this moves. */
  checkSeq: number;
};

export function useUserUpdateCheck(): UserUpdateCheck {
  const status = useAppUpdateStatus();
  // A check the user asked for is running. Only then does the live card show.
  const [watching, setWatching] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [result, setResult] = useState<AppUpdateCheckResult | undefined>(undefined);
  const [checkSeq, setCheckSeq] = useState(0);
  // Stand-in `checking` for the stretch between "the user asked" and the first
  // status event — see the subscription below. Held HERE rather than written
  // into the shared status: a check started while an update is already
  // downloaded must not walk that status backwards, or the Restart offer the
  // user already has vanishes for the length of the check.
  const [seedChecking, setSeedChecking] = useState(false);
  // Read inside the subscription without making the status a dependency of it
  // — resubscribing on every progress tick would drop events between the
  // unsubscribe and the re-subscribe. Written during render rather than in an
  // effect so it is never a commit behind: the value is only ever read from an
  // event callback, never during render, so there is nothing to tear.
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const unsubscribe = window.pwrsnapApi?.on(
      EVENT_CHANNELS.appUpdateCheckResult,
      (payload) => {
        const next = asAppUpdateCheckResult(payload);
        if (next === undefined) return;
        receivedEvent = true;
        if (next.status === "checking") {
          // The only mid-flight tick on this channel; everything else on it is
          // an outcome. The live card takes it from here, driven by the status
          // channel.
          setWatching(true);
          setCanceling(false);
          setResult(undefined);
          setCheckSeq((seq) => seq + 1);
          // This tick outruns the status event it mirrors — main emits it
          // before the release read even starts, and that read can take
          // seconds — so seed `checking` rather than showing nothing at all.
          // But a check that JOINED a download already running is further
          // along than `checking` and must not be walked backwards.
          setSeedChecking(!isUpdateCheckInProgress(statusRef.current));
          return;
        }
        // Everything below is an outcome, so the live card has nothing left to
        // report and must come down before the outcome is shown.
        setWatching(false);
        setCanceling(false);
        setSeedChecking(false);
        setResult(next);
      }
    );
    // Race the snapshot against the live event, exactly as `useAppUpdateStatus`
    // does — and for a sharper reason. The `checking` tick is edge-triggered
    // and never replayed, and React flushes passive effects AFTER paint, so a
    // window that was already on screen when the user picked the menu item can
    // still subscribe a beat too late and then show nothing for the whole
    // download. A real event always wins.
    void (async () => {
      const snapshot = await dispatch("app:update:userCheckRunning", {});
      // Same posture as `asAppUpdateCheckResult`: the reply crosses IPC as
      // `unknown`, and this hook rides on surfaces that must keep working
      // without it.
      if (cancelled || receivedEvent || !snapshot.ok) return;
      if (snapshot.value?.running !== true) return;
      setWatching(true);
      setSeedChecking(!isUpdateCheckInProgress(statusRef.current));
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    // The real thing arrived; the stand-in has done its job. Retiring it here
    // rather than on the outcome is what keeps a finished download from
    // falling back through it and flashing "Checking for updates" again.
    if (isUpdateCheckInProgress(status)) setSeedChecking(false);
  }, [status]);

  const cancel = useCallback((): void => {
    setCanceling(true);
    void (async () => {
      const result = await dispatch("app:update:cancel", {});
      // A successful reply needs no state change: main answers the click with
      // a check outcome either way, and a `canceled: false` race means the
      // download finished — which is about to raise the Restart notice, not
      // un-press this.
      if (result.ok) return;
      // The click never reached main (a dropped split-mode bridge, an agent
      // that died mid-download). No outcome is coming, so nothing else would
      // ever clear this — and the button's own handler is guarded off while
      // it is set, leaving a dead control reading "Canceling...".
      setCanceling(false);
    })();
  }, []);

  const dismissOutcome = useCallback((): void => {
    setResult(undefined);
  }, []);

  // Memoized on the payload, not recomputed per render: the host arms the
  // auto-dismiss countdown off this object, and a fresh identity every render
  // would re-arm the timer forever and the notice would never expire.
  const outcome = useMemo(
    () => (result === undefined ? undefined : updateCheckOutcomeNotice(result)),
    [result]
  );

  // The real status wins whenever it has something to say; the seed covers
  // only the gap before it does.
  const progressStatus: AppUpdateProgressStatus | undefined = isUpdateCheckInProgress(status)
    ? status
    : seedChecking
      ? { status: "checking" }
      : undefined;

  return {
    status,
    progress:
      watching && progressStatus !== undefined ? updateProgressCopy(progressStatus) : undefined,
    outcome,
    canceling,
    cancel,
    dismissOutcome,
    checkSeq
  };
}
