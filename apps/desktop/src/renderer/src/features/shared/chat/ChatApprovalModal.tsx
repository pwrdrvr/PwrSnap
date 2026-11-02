// ChatApprovalModal — pure presentational modal that surfaces a
// single Codex approval ServerRequest and routes the user's decision
// back out through `onResolve`.
//
// Codex emits approval requests mid-turn (sandbox write outside the
// chat dir, shell exec, etc.). The Library chat controller turns one
// of those into a `ChatApprovalRequest` and hands it to this modal.
// The user picks Approve / Deny; the decision rides back to the
// controller, which posts it on `codex:libraryChat:approval`. This
// component does NO bus / IPC work — props in, callback out.
//
// Resolve guard (plan §F4 H2 / §F10 T3): the moment the user clicks a
// button BOTH buttons disable and a spinner shows until `onResolve`
// settles. A `resolvingRef` guard means a double-click — or a click
// on the second button before the first settles — can never resolve
// the same approval twice. The async resolution path is awaited so a
// slow controller (network, App Server round-trip) keeps the modal in
// its busy state rather than letting the user fire a second decision.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement
} from "react";
import type { ChatApprovalDecision, ChatApprovalRequest } from "@pwrsnap/shared";
import { useDismissable } from "../../../lib/useDismissable";
import { useFocusTrap } from "../../../lib/useFocusTrap";
import "./chat-primitives.css";

export interface ChatApprovalModalProps {
  /** The approval the agent is waiting on. */
  readonly request: ChatApprovalRequest;
  /** Resolve the approval with the user's decision. May be async — the
   *  modal stays in its busy state until the returned promise settles. */
  readonly onResolve: (decision: ChatApprovalDecision) => void | Promise<void>;
  /** Main's broker is processing this exact request. Kept controlled so a
   *  successful IPC acknowledgement stays disabled until the cross-window
   *  resolved/superseded event arrives. */
  readonly submitting?: boolean;
  /** Sanitized renderer-owned copy. Never pass a raw transport or tool error. */
  readonly errorMessage?: string | null;
  /** The failed choice retried by the explicit Retry action. */
  readonly retryDecision?: ChatApprovalDecision | null;
}

type Phase = "idle" | "resolving";

export function ChatApprovalModal(props: ChatApprovalModalProps): ReactElement {
  const {
    request,
    onResolve,
    submitting = false,
    errorMessage = null,
    retryDecision = null
  } = props;

  const [phase, setPhase] = useState<Phase>("idle");
  const [localDecision, setLocalDecision] = useState<ChatApprovalDecision | null>(null);
  const busy = submitting || phase === "resolving";
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const denyButtonRef = useRef<HTMLButtonElement | null>(null);
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);
  const busyRef = useRef<boolean>(busy);
  busyRef.current = busy;
  // Ref guard so the first click wins even if a second click lands in
  // the same tick (React state updates are async; the ref is not).
  const resolvingRef = useRef<boolean>(false);
  const requestKey = `${request.threadId}\u0000${request.turnId}\u0000${request.approvalId}`;
  const requestKeyRef = useRef<string>(requestKey);
  // Avoid a state update after unmount when `onResolve` settles late.
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // `aria-modal` describes the accessibility tree but does not manage focus.
  // The shared trap keeps Tab inside and, when the exact approval leaves the
  // UI, returns focus to the element that owned it before the prompt. Request
  // supersession reuses this mounted modal, so the original app control
  // remains the restore target.
  //
  // It is the shared trap rather than a listener of its own so that a second
  // modal open at the same time — a DeleteConfirm the user had up when the
  // agent asked — resolves Tab by one owner rule instead of fighting it.
  useFocusTrap({ open: true, containerRef: dialogRef, initialFocusRef: denyButtonRef });

  // What the trap does not do: a PROGRAMMATIC focus move behind the scrim
  // (the composer re-focusing after a turn event) is recaptured at once, so
  // Enter or Space can never land on an app control the user cannot see.
  // The trap would only pull focus back on the next Tab.
  useLayoutEffect(() => {
    const containFocus = (event: FocusEvent): void => {
      const dialog = dialogRef.current;
      if (dialog === null || dialog.contains(event.target as Node | null)) return;
      if (busyRef.current) dialog.focus();
      else (denyButtonRef.current ?? primaryButtonRef.current ?? dialog).focus();
    };
    document.addEventListener("focusin", containFocus, true);
    return () => document.removeEventListener("focusin", containFocus, true);
  }, []);

  // Deny is the safe initial/default action. While submission disables every
  // action, keep focus on the dialog itself so Tab cannot escape to the hidden
  // composer, New, thread-close, or other app controls behind the scrim.
  useLayoutEffect(() => {
    if (busy) dialogRef.current?.focus();
    else denyButtonRef.current?.focus();
  }, [busy, requestKey]);

  // A newer exact request may replace the modal without unmounting it. Its
  // controls must not inherit the prior request's local click latch.
  useEffect(() => {
    requestKeyRef.current = requestKey;
    resolvingRef.current = false;
    setPhase("idle");
    setLocalDecision(null);
  }, [requestKey]);

  const resolve = useCallback(
    (decision: ChatApprovalDecision): void => {
      if (resolvingRef.current || submitting) return;
      const resolvingRequestKey = requestKey;
      resolvingRef.current = true;
      setLocalDecision(decision);
      setPhase("resolving");
      void Promise.resolve()
        .then(() => onResolve(decision))
        // The approval session presents its own sanitized error. Swallowing a
        // rejection here prevents an unhandled promise while still re-arming
        // the buttons for retry.
        .catch(() => undefined)
        .finally(() => {
          if (requestKeyRef.current !== resolvingRequestKey) return;
          resolvingRef.current = false;
          if (mountedRef.current) {
            setPhase("idle");
            setLocalDecision(null);
          }
        });
    },
    [onResolve, requestKey, submitting]
  );

  const onApprove = useCallback((): void => resolve("approve"), [resolve]);
  const onDeny = useCallback((): void => resolve("deny"), [resolve]);
  const onRetry = useCallback(
    (): void => resolve(retryDecision ?? "deny"),
    [resolve, retryDecision]
  );

  // Escape is Deny. `resolve` already refuses a second decision while one
  // is in flight.
  useDismissable({ open: true, onDismiss: () => resolve("deny"), surfaceRef: dialogRef });

  const activeDecision = submitting ? retryDecision : localDecision;
  const titleId = `ps-approval-title-${request.approvalId}`;

  return (
    <div className="ps-approval-scrim" data-testid="ps-approval-scrim">
      <div
        ref={dialogRef}
        className="ps-approval"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label="Agent approval"
        aria-labelledby={titleId}
        aria-busy={busy}
        data-testid="ps-approval"
      >
        <p id={titleId} className="ps-approval__summary">
          {request.summary}
        </p>
        {request.detail !== undefined && request.detail !== "" ? (
          <pre className="ps-approval__detail" data-testid="ps-approval-detail">
            {request.detail}
          </pre>
        ) : null}
        {errorMessage !== null ? (
          <p
            className="ps-approval__error"
            role="alert"
            data-testid="ps-approval-error"
          >
            {errorMessage}
          </p>
        ) : null}
        <div className="ps-approval__actions">
          <button
            ref={denyButtonRef}
            type="button"
            className="ps-approval__btn ps-approval__btn--deny"
            onClick={onDeny}
            disabled={busy}
            data-testid="ps-approval-deny"
          >
            {busy && activeDecision === "deny" ? (
              <>
                <span
                  className="ps-approval__spinner"
                  role="status"
                  aria-label="Denying"
                  data-testid="ps-approval-spinner"
                />
                Denying…
              </>
            ) : (
              "Deny"
            )}
          </button>
          <button
            ref={primaryButtonRef}
            type="button"
            className="ps-approval__btn ps-approval__btn--approve"
            onClick={errorMessage === null ? onApprove : onRetry}
            disabled={busy}
            data-testid={errorMessage === null ? "ps-approval-approve" : "ps-approval-retry"}
          >
            {busy && activeDecision !== "deny" ? (
              <>
                <span
                  className="ps-approval__spinner"
                  role="status"
                  aria-label="Approving"
                  data-testid="ps-approval-spinner"
                />
                Approving…
              </>
            ) : (
              errorMessage === null ? "Approve" : "Retry"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
