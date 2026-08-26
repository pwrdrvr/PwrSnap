import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatApprovalDecision,
  ChatApprovalRequest,
  PwrSnapError,
  Result
} from "@pwrsnap/shared";
import { subscribe } from "../../../lib/pwrsnap";

type ApprovalPhase = "idle" | "pending" | "submitting";

interface ApprovalIdentity {
  readonly threadId: string;
  readonly turnId: string;
  readonly approvalId: string;
}

interface ApprovalSessionState {
  readonly request: ChatApprovalRequest | null;
  readonly phase: ApprovalPhase;
  readonly errorMessage: string | null;
  readonly retryDecision: ChatApprovalDecision | null;
}

export interface UseChatApprovalSessionOptions {
  /** The thread visible in this panel. Requests for other threads stay in
   *  main's broker and are replayed when their thread becomes active. */
  readonly activeThreadId: string | null;
  /** Authoritative replay detail from the controller/store thread view. */
  readonly pendingApproval: ChatApprovalRequest | null;
  readonly requestedChannel: string;
  readonly resolvedChannel: string;
  readonly supersededChannel: string;
  /** Submit the exact request identity. A successful Result is only an IPC
   *  acknowledgement; the terminal event remains the clearing authority. */
  readonly submit: (
    request: ChatApprovalRequest,
    decision: ChatApprovalDecision
  ) => Promise<Result<void, PwrSnapError>>;
}

export interface ChatApprovalSession {
  readonly request: ChatApprovalRequest | null;
  readonly phase: ApprovalPhase;
  readonly errorMessage: string | null;
  readonly retryDecision: ChatApprovalDecision | null;
  readonly resolve: (decision: ChatApprovalDecision) => Promise<void>;
}

const INITIAL_STATE: ApprovalSessionState = {
  request: null,
  phase: "idle",
  errorMessage: null,
  retryDecision: null
};

/**
 * Renderer half of the app-owned approval lifecycle.
 *
 * Main owns the pending request and broadcasts terminal events to every
 * window. This hook deliberately does not resolve on unmount: remounting the
 * panel rehydrates the exact request from `pendingApproval`. It also keeps all
 * state transitions identity-checked, so a late response for request A cannot
 * dismiss a newer request B on the same thread.
 */
export function useChatApprovalSession(
  options: UseChatApprovalSessionOptions
): ChatApprovalSession {
  const {
    activeThreadId,
    pendingApproval,
    requestedChannel,
    resolvedChannel,
    supersededChannel,
    submit
  } = options;
  const [state, setState] = useState<ApprovalSessionState>(INITIAL_STATE);
  const activeThreadRef = useRef<string | null>(activeThreadId);
  activeThreadRef.current = activeThreadId;
  const stateRef = useRef<ApprovalSessionState>(state);
  stateRef.current = state;
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const mountedRef = useRef(true);
  const submittingIdentityRef = useRef<string | null>(null);
  // A terminal event can arrive before the accompanying threadUpdated view.
  // Remember it so switching away and back cannot replay that stale detail.
  const terminalIdentityKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A list/threadUpdated view is the replay path after panel unmount/remount
  // or thread switching. Preserve an in-flight/error phase when React hands us
  // a fresh object for the same exact request.
  useEffect(() => {
    setState((current) => {
      if (pendingApproval === null) {
        return current.request === null ? current : INITIAL_STATE;
      }
      if (terminalIdentityKeysRef.current.has(identityKey(pendingApproval))) {
        return INITIAL_STATE;
      }
      if (
        pendingApproval.threadId !== activeThreadId ||
        !sameApproval(current.request, pendingApproval)
      ) {
        return pendingApproval.threadId === activeThreadId
          ? {
              request: pendingApproval,
              phase: "pending",
              errorMessage: null,
              retryDecision: null
            }
          : INITIAL_STATE;
      }
      return current;
    });
  }, [
    activeThreadId,
    pendingApproval?.threadId,
    pendingApproval?.turnId,
    pendingApproval?.approvalId
  ]);

  useEffect(() => {
    const onRequested = (payload: unknown): void => {
      const request = payload as ChatApprovalRequest;
      // Registration publishes the replayable pending thread view before the
      // one-shot requested event. Another window can resolve that replay in
      // between, so the requested event may arrive after the exact identity is
      // already terminal. Broker identities are never reused: retain the
      // tombstone and ignore the late event instead of resurrecting its modal.
      if (terminalIdentityKeysRef.current.has(identityKey(request))) return;
      if (request.threadId !== activeThreadRef.current) return;
      setState((current) =>
        sameApproval(current.request, request)
          ? current
          : {
              request,
              phase: "pending",
              errorMessage: null,
              retryDecision: null
            }
      );
    };

    const onTerminal = (payload: unknown): void => {
      const identity = payload as ApprovalIdentity;
      terminalIdentityKeysRef.current.add(identityKey(identity));
      setState((current) =>
        sameApproval(current.request, identity) ? INITIAL_STATE : current
      );
      const key = identityKey(identity);
      if (submittingIdentityRef.current === key) submittingIdentityRef.current = null;
    };

    const unsubs = [
      subscribe(requestedChannel, onRequested),
      subscribe(resolvedChannel, onTerminal),
      subscribe(supersededChannel, onTerminal)
    ];
    return () => {
      // Main's broker owns the pending request. Unmount only removes this
      // window's listeners; it must never imply approve, deny, or cancel.
      for (const unsubscribe of unsubs) unsubscribe();
    };
  }, [requestedChannel, resolvedChannel, supersededChannel]);

  const resolve = useCallback(async (decision: ChatApprovalDecision): Promise<void> => {
    const request = stateRef.current.request;
    if (request === null) return;
    const key = identityKey(request);
    if (submittingIdentityRef.current === key) return;

    submittingIdentityRef.current = key;
    setState((current) =>
      sameApproval(current.request, request)
        ? {
            request: current.request,
            phase: "submitting",
            errorMessage: null,
            retryDecision: decision
          }
        : current
    );

    try {
      const result = await submitRef.current(request, decision);
      if (!result.ok && mountedRef.current) {
        markFailure(request, decision, setState);
      }
      // A successful Result only acknowledges command handling. The broker's
      // resolved/superseded event clears the request in this and other windows.
    } catch {
      // Never surface thrown transport details (which may carry tool payloads,
      // paths, or stack data). The exact request remains visible and retryable.
      if (mountedRef.current) markFailure(request, decision, setState);
    } finally {
      if (submittingIdentityRef.current === key) submittingIdentityRef.current = null;
    }
  }, []);

  return {
    request: state.request,
    phase: state.phase,
    errorMessage: state.errorMessage,
    retryDecision: state.retryDecision,
    resolve
  };
}

function markFailure(
  request: ChatApprovalRequest,
  decision: ChatApprovalDecision,
  setState: React.Dispatch<React.SetStateAction<ApprovalSessionState>>
): void {
  setState((current) =>
    sameApproval(current.request, request)
      ? {
          request: current.request,
          phase: "pending",
          errorMessage:
            "PwrSnap couldn’t send your response. The request is still pending. Try again, or send Deny instead.",
          retryDecision: decision
        }
      : current
  );
}

function sameApproval(
  left: ApprovalIdentity | null,
  right: ApprovalIdentity
): boolean {
  return left !== null && identityKey(left) === identityKey(right);
}

function identityKey(identity: ApprovalIdentity): string {
  return JSON.stringify([identity.threadId, identity.turnId, identity.approvalId]);
}
