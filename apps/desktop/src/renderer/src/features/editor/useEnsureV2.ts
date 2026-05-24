// `useEnsureV2` — Phase 3 renderer-side glue for the v1 → v2 lazy
// doctor (apps/desktop/src/main/persistence/v1-to-v2-doctor.ts).
//
// When a user opens a v1 capture in the standalone Editor (or Library
// Focus), this hook orchestrates the per-capture doctor:
//
//   1. The capture loads through `useCaptureModel` as v1.
//   2. This hook sees `bundle_format_version === 1` and dispatches
//      `v1ToV2:upgrade` immediately.
//   3. While the doctor runs, the hook is in `{ status: "upgrading" }`;
//      the editor renders the V1ToV2DoctorBanner + disables the toolbar.
//   4. On success the doctor broadcasts `events:captures:changed`;
//      `useCaptureModel` re-fetches, the format flips to 2, this hook
//      flips to `{ status: "ready" }`, and the banner disappears.
//   5. On parking after MAX_ATTEMPTS=5 (or any uncaught error), the
//      hook flips to `{ status: "view_only" }`. The banner shows a
//      Retry button bound to `retry()`, which dispatches `v1ToV2:retry`
//      to clear parked state and then re-fires `v1ToV2:upgrade`.
//
// Race + cancel-safety: identical pattern to `useCaptureModel` — a
// per-effect `cancelled` flag drops late responses when the captureId
// changes mid-flight or the component unmounts.
//
// Late-mount race recovery: mirrors `LegacyMigrationBanner` — subscribe
// to `events:v1-to-v2-doctor:progress` FIRST, then query `v1ToV2:status`
// for the cached snapshot. If the cached snapshot says a per-capture
// doctor run for THIS capture has already parked, we jump straight to
// view_only.
//
// Plan reference:
// docs/plans/2026-05-23-001-feat-v2-editor-plan.md Phase 3.

import { useCallback, useEffect, useRef, useState } from "react";
import { EVENT_CHANNELS, type V1ToV2DoctorProgress } from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../lib/pwrsnap";

export type EnsureV2State =
  | { status: "irrelevant" }
  | { status: "upgrading"; progress?: V1ToV2DoctorProgress }
  | { status: "ready" }
  | { status: "view_only"; errorCode: string; attempts: number };

export interface UseEnsureV2Options {
  readonly captureId: string;
  /** From `useCaptureModel` — used to decide whether work is needed.
   *  `null` means the capture hasn't loaded yet; `1` triggers an
   *  upgrade attempt; `>= 2` short-circuits to `irrelevant`. */
  readonly currentBundleFormatVersion: number | null;
}

export interface UseEnsureV2Return {
  readonly state: EnsureV2State;
  /** Clear the parked retry budget on the main side, then re-fire the
   *  doctor. Bound to the Retry button on the read-only banner. */
  retry(): void;
}

export function useEnsureV2(opts: UseEnsureV2Options): UseEnsureV2Return {
  const { captureId, currentBundleFormatVersion } = opts;
  const [state, setState] = useState<EnsureV2State>(() =>
    initialStateFor(currentBundleFormatVersion)
  );

  // Monotonic sequence number per (captureId × attempt). Late
  // resolutions whose seq is stale are dropped — covers both
  // captureId changes mid-flight AND a Retry() that fires while
  // the previous upgrade is still in flight.
  const seqRef = useRef<number>(0);

  // Fire the doctor for THIS capture. Returns a cleanup that marks
  // the dispatch as cancelled.
  const runUpgrade = useCallback(
    (mySeq: number) => {
      let cancelled = false;
      void (async (): Promise<void> => {
        const result = await dispatch("v1ToV2:upgrade", { captureId });
        if (cancelled) return;
        if (seqRef.current !== mySeq) return;
        if (!result.ok) {
          // SIMPLIFICATION (per task spec): any error → view_only.
          // The Retry button is the recovery path. Attempts is
          // unknown from this side; the parked flag arrives via the
          // progress event channel for the canonical count.
          setState({
            status: "view_only",
            errorCode: result.error.code,
            attempts: 0
          });
          return;
        }
        const value = result.value;
        if (value.migrated) {
          // Doctor flipped the row to v2. useCaptureModel's
          // captures:changed subscription will re-fetch and the
          // parent will see currentBundleFormatVersion === 2 next
          // render, at which point initialStateFor() flips us to
          // "irrelevant". Sit at "ready" in the meantime so the
          // banner stops showing the spinner.
          setState({ status: "ready" });
          return;
        }
        if (value.reason === "already_v2") {
          // Doctor short-circuited (the bundle was already v2 on
          // disk — boot reconcile path). Same terminal state.
          setState({ status: "ready" });
          return;
        }
        if (value.reason === "parked") {
          setState({
            status: "view_only",
            errorCode: "parked",
            attempts: 5
          });
          return;
        }
      })();
      return () => {
        cancelled = true;
      };
    },
    [captureId]
  );

  // Initial state + auto-fire on format-version change.
  //
  // `currentBundleFormatVersion` drives the state machine:
  //   • null → wait (state stays at whatever initialStateFor returned)
  //   • 1    → upgrading + dispatch
  //   • >= 2 → irrelevant (capture is already v2; no work)
  //
  // The seq bump ensures any in-flight upgrade from a prior render
  // gets dropped before the new one fires.
  useEffect(() => {
    if (currentBundleFormatVersion === null) {
      // Wait for the capture model to load before deciding. Don't
      // reset state here — a Retry() that fires while the parent is
      // re-rendering with a transient null shouldn't drop us back
      // into the wait state.
      return;
    }
    if (currentBundleFormatVersion >= 2) {
      setState({ status: "irrelevant" });
      return;
    }
    // v1 capture — kick off the doctor.
    seqRef.current += 1;
    const mySeq = seqRef.current;
    setState({ status: "upgrading" });
    const cancel = runUpgrade(mySeq);
    return cancel;
  }, [captureId, currentBundleFormatVersion, runUpgrade]);

  // Subscribe to per-capture progress events for "failed" notifications
  // that arrive faster than the upgrade Promise resolves (or in case
  // the resolution path was missed). Also seed via `v1ToV2:status` on
  // mount for late-mount race recovery.
  //
  // CRITICAL — the snapshot + progress channels are CONSULTED ONLY
  // WHEN the capture is actually a v1 (or unknown) and the doctor
  // could plausibly be running. If `currentBundleFormatVersion >= 2`,
  // the capture is healthy v2 on disk RIGHT NOW — any "failed"
  // event we see for this captureId is a stale snapshot from a
  // previous attempt that has since been rescued (by the boot-time
  // reconcile sweep, a successful retry, etc.). Flipping to
  // view_only in that case is the bug described in
  // docs/plans Phase 3.2 verification — six healthy v2 screenshots
  // all sporting a spurious "Couldn't upgrade — read-only view"
  // banner because the module-level cachedProgress in the doctor
  // still remembered an old failure for the same captureId.
  useEffect(() => {
    // Skip the entire subscribe + snapshot dance for already-healthy
    // captures. The doctor has no work to do; any stale snapshot
    // chatter is just noise.
    if (currentBundleFormatVersion !== null && currentBundleFormatVersion >= 2) {
      return;
    }

    let cancelled = false;

    // 1. Subscribe FIRST so a "failed" event arriving while the
    //    snapshot query is in flight isn't dropped.
    const unsubscribe = subscribe(
      EVENT_CHANNELS.v1ToV2DoctorProgress,
      (payload) => {
        if (cancelled) return;
        const event = payload as V1ToV2DoctorProgress;
        // Filter out boot-time global events (captureId === null) and
        // events for OTHER captures. The doctor uses captureId !== null
        // for per-capture events; we only care about ours.
        if (event.captureId === null) return;
        if (event.captureId !== captureId) return;
        if (event.status === "failed") {
          setState({
            status: "view_only",
            errorCode: event.errorCode,
            attempts: event.attempts
          });
        }
        // We deliberately do NOT flip to "ready" on a "complete"
        // event — the captures:changed broadcast + useCaptureModel
        // re-fetch is the canonical signal. Flipping here would race
        // with the model's reload and could momentarily disable then
        // re-enable the toolbar.
      }
    );

    // 2. Query the cached snapshot for late-mount recovery. If the
    //    snapshot shows THIS capture is parked, jump to view_only.
    void dispatch("v1ToV2:status", {}).then((result) => {
      if (cancelled) return;
      if (!result.ok) return;
      const snapshot = result.value;
      if (snapshot === null) return;
      if (snapshot.captureId !== captureId) return;
      if (snapshot.status === "failed") {
        setState({
          status: "view_only",
          errorCode: snapshot.errorCode,
          attempts: snapshot.attempts
        });
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [captureId, currentBundleFormatVersion]);

  const retry = useCallback((): void => {
    void (async (): Promise<void> => {
      // Bump seq BEFORE the retry dispatch so the previous upgrade's
      // resolution (if it's still pending) is dropped.
      seqRef.current += 1;
      const mySeq = seqRef.current;
      setState({ status: "upgrading" });
      const retryResult = await dispatch("v1ToV2:retry", { captureId });
      if (seqRef.current !== mySeq) return;
      if (!retryResult.ok) {
        setState({
          status: "view_only",
          errorCode: retryResult.error.code,
          attempts: 0
        });
        return;
      }
      // Parked state cleared. Fire the upgrade. runUpgrade closes
      // over its own seq — bump again so its cleanup is owned by
      // this attempt.
      seqRef.current += 1;
      const upgradeSeq = seqRef.current;
      runUpgrade(upgradeSeq);
    })();
  }, [captureId, runUpgrade]);

  return { state, retry };
}

function initialStateFor(formatVersion: number | null): EnsureV2State {
  if (formatVersion === null) {
    // Hasn't loaded yet — pretend "irrelevant" so the banner doesn't
    // flash a spinner during the initial useCaptureModel load. The
    // effect above will flip us to "upgrading" once the format
    // resolves to 1.
    return { status: "irrelevant" };
  }
  if (formatVersion >= 2) return { status: "irrelevant" };
  return { status: "upgrading" };
}
