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

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { ChatApprovalDecision, ChatApprovalRequest } from "@pwrsnap/shared";

export interface ChatApprovalModalProps {
  /** The approval the agent is waiting on. */
  readonly request: ChatApprovalRequest;
  /** Resolve the approval with the user's decision. May be async — the
   *  modal stays in its busy state until the returned promise settles. */
  readonly onResolve: (decision: ChatApprovalDecision) => void | Promise<void>;
}

type Phase = "idle" | "resolving";

export function ChatApprovalModal(props: ChatApprovalModalProps): ReactElement {
  const { request, onResolve } = props;

  const [phase, setPhase] = useState<Phase>("idle");
  // Ref guard so the first click wins even if a second click lands in
  // the same tick (React state updates are async; the ref is not).
  const resolvingRef = useRef<boolean>(false);
  // Avoid a state update after unmount when `onResolve` settles late.
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const resolve = useCallback(
    (decision: ChatApprovalDecision): void => {
      if (resolvingRef.current) return;
      resolvingRef.current = true;
      setPhase("resolving");
      void Promise.resolve(onResolve(decision)).finally(() => {
        // Leave the ref latched — once an approval is resolved it does
        // not re-arm; the parent unmounts the modal on the next render.
        if (mountedRef.current) setPhase("idle");
      });
    },
    [onResolve]
  );

  const onApprove = useCallback((): void => resolve("approve"), [resolve]);
  const onDeny = useCallback((): void => resolve("deny"), [resolve]);

  // Escape = Deny. Window-level so the modal catches it regardless of
  // which child holds focus.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      resolve("deny");
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [resolve]);

  const busy = phase === "resolving";
  const titleId = `ps-approval-title-${request.approvalId}`;

  return (
    <div className="ps-approval-scrim" data-testid="ps-approval-scrim">
      <div
        className="ps-approval"
        role="dialog"
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
        <div className="ps-approval__actions">
          <button
            type="button"
            className="ps-approval__btn ps-approval__btn--deny"
            onClick={onDeny}
            disabled={busy}
            data-testid="ps-approval-deny"
          >
            Deny
          </button>
          <button
            type="button"
            className="ps-approval__btn ps-approval__btn--approve"
            onClick={onApprove}
            disabled={busy}
            data-testid="ps-approval-approve"
          >
            {busy ? (
              <span
                className="ps-approval__spinner"
                role="status"
                aria-label="Resolving"
                data-testid="ps-approval-spinner"
              />
            ) : (
              "Approve"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
