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

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { appUpdateNotice } from "./app-update-notice";
import { useAppUpdateInstall } from "./use-app-update";
import { useUserUpdateCheck } from "./use-user-update-check";

/** How long a settled outcome stands before it dismisses itself. Matches the
 *  Library's undo toast so the two transient notices read as one language. */
export const UPDATE_OUTCOME_DISMISS_MS = 8000;

type UpdateCardProps = {
  /** Headline. The card's live region announces this, so it is the phase or
   *  the answer — never the detail. */
  eyebrow: string;
  message: string;
  /** Danger tint. Only a failed check is one: a cancel is what the user
   *  asked for, and a download in flight has not failed yet. */
  isError?: boolean;
  /** Draw the auto-dismiss countdown, timed to whatever will actually
   *  dismiss the card. Omitted for a card reporting work still running —
   *  that has no fixed duration to drain toward. */
  timerMs?: number;
  /**
   * Whether a change anywhere in the card re-announces the WHOLE card.
   *
   * `role="status"` implies `aria-atomic="true"`, which is right for a card
   * that says one thing once and wrong for one whose percent and byte meter
   * tick every second — atomic wins over a descendant's `aria-live="off"`,
   * so without turning it off here the opt-outs below do nothing and the
   * phase changes are buried under "42%... 44%... 47%".
   */
  atomic?: boolean;
  /** Keep the message out of the announcements (it carries the percent). */
  quietMessage?: boolean;
  /** Track, meter, restart error — whatever sits under the message. */
  children?: ReactNode;
  actions?: ReactNode;
};

/** The one card shell all three notices share, so their a11y wiring and
 *  markup cannot drift apart. */
function UpdateCard({
  eyebrow,
  message,
  isError = false,
  timerMs,
  atomic = true,
  quietMessage = false,
  children,
  actions
}: UpdateCardProps): ReactElement {
  return (
    <aside
      className={isError ? "app-update-banner app-update-banner--error" : "app-update-banner"}
      role="status"
      aria-live="polite"
      aria-atomic={atomic}
    >
      {timerMs === undefined ? null : (
        <span
          className="app-update-banner__timer"
          style={{ animationDuration: `${String(timerMs)}ms` }}
          aria-hidden="true"
        />
      )}
      <div className="app-update-banner__content">
        <p className="app-update-banner__eyebrow">{eyebrow}</p>
        <p
          className="app-update-banner__message"
          {...(quietMessage ? ({ "aria-live": "off" } as const) : {})}
        >
          {message}
        </p>
        {children}
      </div>
      {actions === undefined ? null : (
        <div className="app-update-banner__actions">{actions}</div>
      )}
    </aside>
  );
}

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
        // The one card that reports work in flight: no countdown, and not
        // atomic, because its percent and byte meter move every second.
        <UpdateCard
          eyebrow={progress.title}
          message={progress.message}
          atomic={false}
          quietMessage
          actions={
            progress.cancelable ? (
              // aria-disabled, never `disabled`: Chromium blurs an element
              // the moment it becomes disabled, which would throw focus to
              // <body> at the instant the user asked to stop. The handler
              // guards instead.
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
            ) : undefined
          }
        >
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
        </UpdateCard>
      ) : null}
      {outcome !== undefined ? (
        // Finished talking, so it goes on the countdown the strip draws. Keyed
        // on the outcome so a later answer restarts that animation.
        <UpdateCard
          key={outcome.key}
          eyebrow={outcome.title}
          message={outcome.message}
          isError={outcome.isError}
          timerMs={UPDATE_OUTCOME_DISMISS_MS}
          actions={
            <button
              className="app-update-banner__dismiss"
              type="button"
              aria-label="Dismiss update check result"
              onClick={dismissOutcome}
            >
              Dismiss
            </button>
          }
        />
      ) : null}
      {offered && notice !== undefined ? (
        <UpdateCard
          eyebrow={notice.title}
          message={notice.message}
          actions={
            <>
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
            </>
          }
        >
          {restartError !== undefined ? (
            <p className="app-update-banner__error">{restartError}</p>
          ) : null}
        </UpdateCard>
      ) : null}
    </>
  );
}
