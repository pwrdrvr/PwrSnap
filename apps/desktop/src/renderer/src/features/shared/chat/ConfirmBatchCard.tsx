// ConfirmBatchCard — inline "apply N agent changes?" confirmation card.
//
// When the Library chat agent produces a batch of layer writes, the
// controller surfaces this card inline in the transcript. The user
// either accepts the batch (commit) or rejects it (discard). Pure
// presentational — props in, callbacks out; no bus / IPC.
//
// Sticky-on-pending (plan §F10 T12): while a decision is outstanding
// the card is `position: sticky; bottom: 0` inside its scroll
// container so a long transcript can't scroll it out of reach. The
// `is-pending` class drives the sticky rule; it drops the moment the
// resolution settles so a resolved card scrolls away with the rest of
// the transcript.
//
// Resolve guard: identical machinery to ChatApprovalModal — both
// buttons disable on first click and a spinner shows until the chosen
// callback settles, with a ref guard so a double-click can't fire
// twice.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

export interface ConfirmBatchCardProps {
  /** Number of layer writes the agent wants to apply. */
  readonly writeCount: number;
  /** Human-readable summary of the batch. */
  readonly summary: string;
  /** Commit the batch. May be async — card stays busy until it settles. */
  readonly onAccept: () => void | Promise<void>;
  /** Discard the batch. May be async — card stays busy until it settles. */
  readonly onReject: () => void | Promise<void>;
}

type Phase = "idle" | "resolving";

export function ConfirmBatchCard(props: ConfirmBatchCardProps): ReactElement {
  const { writeCount, summary, onAccept, onReject } = props;

  const [phase, setPhase] = useState<Phase>("idle");
  const resolvingRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback((action: () => void | Promise<void>): void => {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setPhase("resolving");
    void Promise.resolve(action()).finally(() => {
      if (mountedRef.current) setPhase("idle");
    });
  }, []);

  const handleAccept = useCallback((): void => run(onAccept), [run, onAccept]);
  const handleReject = useCallback((): void => run(onReject), [run, onReject]);

  const busy = phase === "resolving";
  // Sticky only while a decision is pending — `busy` covers the
  // in-flight window; the idle (pre-click) state is also pending from
  // the user's perspective, so both keep the card pinned.
  const rootClass = "ps-confirm-batch is-pending";

  const changesLabel = writeCount === 1 ? "change" : "changes";

  return (
    <div className={rootClass} data-testid="ps-confirm-batch" aria-busy={busy}>
      <div className="ps-confirm-batch__body">
        <p className="ps-confirm-batch__title">
          {`Apply ${writeCount} ${changesLabel} from the agent?`}
        </p>
        <p className="ps-confirm-batch__summary">{summary}</p>
      </div>
      <div className="ps-confirm-batch__actions">
        <button
          type="button"
          className="ps-confirm-batch__btn ps-confirm-batch__btn--reject"
          onClick={handleReject}
          disabled={busy}
          data-testid="ps-confirm-batch-reject"
        >
          Reject
        </button>
        <button
          type="button"
          className="ps-confirm-batch__btn ps-confirm-batch__btn--accept"
          onClick={handleAccept}
          disabled={busy}
          data-testid="ps-confirm-batch-accept"
        >
          {busy ? (
            <span
              className="ps-confirm-batch__spinner"
              role="status"
              aria-label="Applying"
              data-testid="ps-confirm-batch-spinner"
            />
          ) : (
            "Accept"
          )}
        </button>
      </div>
    </div>
  );
}
