// Floating toast (lower-left .app-toast-stack) for everything the Library
// window has to say about updates. Three jobs, all driven from main and all
// deliberately non-modal:
//
//  - A user-initiated Help -> Check for Updates gets a LIVE card for as long
//    as it is working: an indeterminate sweep while the release read is out,
//    a real meter with a Cancel button once bytes are moving. It carries no
//    dismiss countdown, because the work it reports has no fixed duration.
//  - When that check lands on something with nothing to act on — up to date,
//    unavailable, canceled, failed — the live card comes down and the outcome
//    goes on an ordinary auto-dismissing notice, which is where a card that
//    has finished talking belongs.
//  - A downloaded update (or a failed install worth retrying) is actionable,
//    so it gets the sticky notice that stays until it is acted on or
//    dismissed. This is the one the user meets WITHOUT asking — a background
//    check found it.
//
// Background (startup/periodic) checks raise no live card at all: they never
// emit `events:app-update:check-result`, and the card is gated on having seen
// one. That gate is the whole reason this component listens to two channels
// instead of one — the status channel alone cannot tell a check the user
// asked for from one the hour hand asked for. See AGENTS.md in this folder.
//
// The Library's roomy variant of the offer the tray popover and the
// post-capture toast make through AppUpdateRow. Copy for the actionable half
// comes from the shared `appUpdateNotice` so the three surfaces cannot drift;
// the live/settled copy is this surface's alone (`update-progress.ts`) —
// the two compact rows deliberately stay out of transient states.
//
// Mirrors PwrAgnt's apps/desktop/src/renderer/src/features/update/
// AppUpdateBanner.tsx, adapted to PwrSnap's `dispatch` + `on` helpers
// instead of PwrAgnt's per-method DesktopApi shape.

import { useEffect, useState, type ReactElement } from "react";
import { appUpdateNotice } from "./app-update-notice";
import { useAppUpdateInstall } from "./use-app-update";
import { useUserUpdateCheck } from "./use-user-update-check";

/** How long a settled outcome stands before it dismisses itself. Matches the
 *  Library's undo toast so the two transient notices read as one language. */
export const UPDATE_OUTCOME_DISMISS_MS = 8000;

export function AppUpdateBanner(): ReactElement | null {
  const { status, progress, outcome, canceling, cancel, dismissOutcome, checkSeq } =
    useUserUpdateCheck();
  const {
    busy: restarting,
    error: restartError,
    install: handleRestart,
    reset: resetRestart
  } = useAppUpdateInstall();
  const [dismissedKey, setDismissedKey] = useState<string | undefined>();

  const notice = appUpdateNotice(status);
  const noticeKey = notice?.key;

  useEffect(() => {
    if (noticeKey === undefined || dismissedKey === noticeKey) return;
    // A new actionable update state arrived after the user dismissed
    // an older notice — clear stale restart-error / restarting state.
    resetRestart();
  }, [dismissedKey, noticeKey, resetRestart]);

  useEffect(() => {
    if (checkSeq === 0) return;
    // Asking again is asking to see the answer again: an update dismissed
    // earlier comes back rather than the check looking dead, and it comes
    // back without the failed restart that preceded it.
    setDismissedKey(undefined);
    resetRestart();
  }, [checkSeq, resetRestart]);

  const outcomeKey = outcome?.key;
  useEffect(() => {
    if (outcomeKey === undefined) return;
    const timer = setTimeout(dismissOutcome, UPDATE_OUTCOME_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [outcomeKey, dismissOutcome]);

  const offered = notice !== undefined && dismissedKey !== notice.key;
  if (progress === undefined && outcome === undefined && !offered) return null;

  return (
    <>
      {progress !== undefined ? (
        <aside className="app-update-banner" role="status" aria-live="polite">
          <div className="app-update-banner__content">
            <p className="app-update-banner__eyebrow">{progress.title}</p>
            {/* `role="status"` above makes this card a polite live region, so
                the eyebrow announces each phase — which is what a screen
                reader user wants to hear. The percent, the bar and the byte
                meter change about once a second, and announcing every tick
                would bury the phase changes in "42%... 44%... 47%". They opt
                out; the progressbar keeps its value for anyone who asks. */}
            <p className="app-update-banner__message" aria-live="off">
              {progress.message}
            </p>
            <div
              className={
                progress.percent === undefined
                  ? "app-update-banner__track app-update-banner__track--indeterminate"
                  : "app-update-banner__track"
              }
              role="progressbar"
              aria-live="off"
              aria-label={progress.title}
              aria-valuemin={progress.percent === undefined ? undefined : 0}
              aria-valuemax={progress.percent === undefined ? undefined : 100}
              aria-valuenow={progress.percent}
            >
              <span
                style={
                  progress.percent === undefined
                    ? undefined
                    : { width: `${String(progress.percent)}%` }
                }
              />
            </div>
            {progress.meter !== undefined ? (
              <p className="app-update-banner__meter" aria-live="off">
                {progress.meter}
              </p>
            ) : null}
          </div>
          {progress.cancelable ? (
            <div className="app-update-banner__actions">
              {/* aria-disabled, never `disabled`: Chromium blurs an element
                  the moment it becomes disabled, which would throw focus to
                  <body> at the instant the user asked to stop. The handler
                  guards instead. */}
              <button
                className="app-update-banner__dismiss"
                type="button"
                aria-disabled={canceling}
                onClick={() => {
                  if (canceling) return;
                  cancel();
                }}
              >
                {canceling ? "Canceling..." : "Cancel"}
              </button>
            </div>
          ) : null}
        </aside>
      ) : null}
      {outcome !== undefined ? (
        <aside
          key={outcome.key}
          className={
            outcome.isError
              ? "app-update-banner app-update-banner--error"
              : "app-update-banner"
          }
          role="status"
          aria-live="polite"
        >
          {/* The countdown this card IS on, drawn so the dismissal is not a
              surprise. The live card above deliberately has none. */}
          <span
            className="app-update-banner__timer"
            style={{ animationDuration: `${String(UPDATE_OUTCOME_DISMISS_MS)}ms` }}
            aria-hidden="true"
          />
          <div className="app-update-banner__content">
            <p className="app-update-banner__eyebrow">{outcome.title}</p>
            <p className="app-update-banner__message">{outcome.message}</p>
          </div>
          <div className="app-update-banner__actions">
            <button
              className="app-update-banner__dismiss"
              type="button"
              aria-label="Dismiss update check result"
              onClick={dismissOutcome}
            >
              Dismiss
            </button>
          </div>
        </aside>
      ) : null}
      {offered && notice !== undefined ? (
        <aside className="app-update-banner" role="status" aria-live="polite">
          <div className="app-update-banner__content">
            <p className="app-update-banner__eyebrow">{notice.title}</p>
            <p className="app-update-banner__message">{notice.message}</p>
            {restartError !== undefined ? (
              <p className="app-update-banner__error">{restartError}</p>
            ) : null}
          </div>
          <div className="app-update-banner__actions">
            <button
              className="app-update-banner__restart"
              type="button"
              disabled={restarting}
              onClick={handleRestart}
            >
              {restarting ? notice.busyAction : notice.action}
            </button>
            <button
              className="app-update-banner__dismiss"
              type="button"
              disabled={restarting}
              aria-label="Dismiss update notification"
              onClick={() => setDismissedKey(notice.key)}
            >
              Dismiss
            </button>
          </div>
        </aside>
      ) : null}
    </>
  );
}
