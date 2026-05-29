import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement
} from "react";
import {
  EVENT_CHANNELS,
  type ChatApprovalDecision,
  type ChatApprovalRequest,
  type ChatToolCall,
  type CodexApprovalRequestEvent,
  type CodexStreamDeltaEvent,
  type CodexToolCallEvent,
  type CodexTurnCompleteEvent
} from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../lib/pwrsnap";

// The Sizzle composer's per-project chat with the Codex agent. Opens
// (or resumes) the project's session on mount, streams the transcript
// from the events:codex:* channels, and renders inline approval cards
// when the agent escalates outside its sandbox. All session state lives
// in main; this component is the view + composer.

type TranscriptEntry =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; turnId: string; itemId: string; text: string; streaming: boolean }
  | { kind: "tool"; id: string; turnId: string; toolCall: ChatToolCall }
  | {
      kind: "approval";
      id: string;
      turnId: string;
      request: ChatApprovalRequest;
      status: "pending" | ChatApprovalDecision;
    }
  | { kind: "error"; id: string; text: string };

const DECISION_LABELS: Record<ChatApprovalDecision, string> = {
  approve: "Approve",
  approveForSession: "Approve for session",
  decline: "Decline",
  cancel: "Cancel turn"
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function ChatPanel({ projectId }: { projectId: string }): ReactElement {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const currentTurnRef = useRef<string | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);
  const idSeq = useRef(0);
  const nextId = useCallback((): string => `e${++idSeq.current}`, []);

  // Open (or resume) the session for this project on mount. The session
  // lives in main keyed by projectId, so remounting (e.g. switching
  // projects then back) hands back the same session — though the
  // rendered transcript is in-memory and starts fresh each mount.
  useEffect(() => {
    let active = true;
    setSessionId(null);
    setStartError(null);
    setEntries([]);
    void dispatch("codex:newSession", { projectId }).then((r) => {
      if (!active) return;
      if (r.ok) setSessionId(r.value.sessionId);
      else setStartError(r.error.message);
    });
    return () => {
      active = false;
    };
  }, [projectId]);

  // Subscribe to the four chat channels once we have a session. Each
  // handler ignores events for other sessions (multiple composer windows
  // are not supported today, but the guard is cheap and correct).
  useEffect(() => {
    if (sessionId === null) return;

    const offDelta = subscribe(EVENT_CHANNELS.codexStreamDelta, (payload) => {
      if (!isObject(payload) || payload.sessionId !== sessionId) return;
      const e = payload as unknown as CodexStreamDeltaEvent;
      setEntries((prev) => appendDelta(prev, e, nextId));
    });
    const offTool = subscribe(EVENT_CHANNELS.codexToolCall, (payload) => {
      if (!isObject(payload) || payload.sessionId !== sessionId) return;
      const e = payload as unknown as CodexToolCallEvent;
      setEntries((prev) => [
        ...prev,
        { kind: "tool", id: nextId(), turnId: e.turnId, toolCall: e.toolCall }
      ]);
    });
    const offApproval = subscribe(EVENT_CHANNELS.codexApprovalRequest, (payload) => {
      if (!isObject(payload) || payload.sessionId !== sessionId) return;
      const e = payload as unknown as CodexApprovalRequestEvent;
      setEntries((prev) => [
        ...prev,
        {
          kind: "approval",
          id: nextId(),
          turnId: e.turnId,
          request: e.request,
          status: "pending"
        }
      ]);
    });
    const offComplete = subscribe(EVENT_CHANNELS.codexTurnComplete, (payload) => {
      if (!isObject(payload) || payload.sessionId !== sessionId) return;
      const e = payload as unknown as CodexTurnCompleteEvent;
      setEntries((prev) => finalizeTurn(prev, e, nextId));
      if (currentTurnRef.current === e.turnId) {
        currentTurnRef.current = null;
        setBusy(false);
      }
    });

    return () => {
      offDelta();
      offTool();
      offApproval();
      offComplete();
    };
  }, [sessionId, nextId]);

  // Auto-scroll to the newest entry.
  useLayoutEffect(() => {
    scrollEndRef.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  const onSend = useCallback(async () => {
    const text = draft.trim();
    if (text.length === 0 || sessionId === null || busy) return;
    setDraft("");
    setBusy(true);
    setEntries((prev) => [...prev, { kind: "user", id: nextId(), text }]);
    const r = await dispatch("codex:sendTurn", {
      sessionId,
      input: [{ type: "text", text }]
    });
    if (r.ok) {
      currentTurnRef.current = r.value.turnId;
    } else {
      setBusy(false);
      setEntries((prev) => [...prev, { kind: "error", id: nextId(), text: r.error.message }]);
    }
  }, [draft, sessionId, busy, nextId]);

  const onStop = useCallback(() => {
    if (sessionId === null || currentTurnRef.current === null) return;
    void dispatch("codex:cancelTurn", { sessionId, turnId: currentTurnRef.current });
  }, [sessionId]);

  const onApprove = useCallback(
    (turnId: string, requestId: string, decision: ChatApprovalDecision, entryId: string) => {
      if (sessionId === null) return;
      setEntries((prev) =>
        prev.map((en) => (en.id === entryId && en.kind === "approval" ? { ...en, status: decision } : en))
      );
      void dispatch("codex:submitApproval", { sessionId, turnId, requestId, decision });
    },
    [sessionId]
  );

  const onNewChat = useCallback(async () => {
    if (sessionId === null) return;
    await dispatch("codex:closeSession", { sessionId });
    currentTurnRef.current = null;
    setBusy(false);
    setEntries([]);
    setSessionId(null);
    const r = await dispatch("codex:newSession", { projectId });
    if (r.ok) setSessionId(r.value.sessionId);
    else setStartError(r.error.message);
  }, [sessionId, projectId]);

  return (
    <div className="szl__chat">
      <header className="szl__chat-head">
        <span className="szl__chat-title">Agent</span>
        <span className="szl__spacer" />
        <button
          type="button"
          className="szl__btn szl__chat-newchat"
          onClick={() => void onNewChat()}
          disabled={sessionId === null}
          title="Start a fresh chat (keeps the project's scratch folder)"
        >
          New chat
        </button>
      </header>

      <div className="szl__chat-transcript">
        {startError !== null ? (
          <div className="szl__chat-error">Couldn't start chat: {startError}</div>
        ) : sessionId === null ? (
          <div className="szl__chat-empty">Connecting to your agent…</div>
        ) : entries.length === 0 ? (
          <div className="szl__chat-empty">
            Describe the video you want. The agent can search your library,
            propose scenes, write scripts, and set transitions for this reel.
          </div>
        ) : (
          entries.map((entry) => <TranscriptRow key={entry.id} entry={entry} onApprove={onApprove} />)
        )}
        <div ref={scrollEndRef} aria-hidden="true" />
      </div>

      <div className="szl__chat-composer">
        <textarea
          className="szl__chat-input"
          placeholder="Message your agent…  (⌘↵ to send)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void onSend();
            }
          }}
          disabled={sessionId === null}
        />
        {busy ? (
          <button type="button" className="szl__btn szl__chat-stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="szl__btn-primary szl__chat-send"
            onClick={() => void onSend()}
            disabled={sessionId === null || draft.trim().length === 0}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function TranscriptRow({
  entry,
  onApprove
}: {
  entry: TranscriptEntry;
  onApprove: (
    turnId: string,
    requestId: string,
    decision: ChatApprovalDecision,
    entryId: string
  ) => void;
}): ReactElement {
  if (entry.kind === "user") {
    return (
      <div className="szl__chat-bubble szl__chat-bubble--user">
        <div className="szl__chat-bubble-text">{entry.text}</div>
      </div>
    );
  }
  if (entry.kind === "agent") {
    return (
      <div className="szl__chat-bubble szl__chat-bubble--agent">
        <div className="szl__chat-bubble-text">
          {entry.text}
          {entry.streaming ? <span className="szl__chat-caret" aria-hidden="true">▍</span> : null}
        </div>
      </div>
    );
  }
  if (entry.kind === "tool") {
    return (
      <div className={"szl__chat-tool" + (entry.toolCall.ok ? "" : " is-error")}>
        <span className="szl__chat-tool-name">{entry.toolCall.tool}</span>
        <span className="szl__chat-tool-summary">{entry.toolCall.summary}</span>
      </div>
    );
  }
  if (entry.kind === "error") {
    return <div className="szl__chat-error">{entry.text}</div>;
  }
  // approval
  const { request, status, turnId, id } = entry;
  return (
    <div className="szl__chat-approval">
      <div className="szl__chat-approval-head">Approval needed</div>
      {request.reason !== null ? (
        <div className="szl__chat-approval-reason">{request.reason}</div>
      ) : null}
      {request.command !== null ? (
        <pre className="szl__chat-approval-cmd">{request.command}</pre>
      ) : null}
      {status === "pending" ? (
        <div className="szl__chat-approval-actions">
          {request.availableDecisions.map((d) => (
            <button
              key={d}
              type="button"
              className={
                "szl__btn szl__chat-approval-btn" +
                (d === "approve" ? " szl__chat-approval-btn--primary" : "")
              }
              onClick={() => onApprove(turnId, request.requestId, d, id)}
            >
              {DECISION_LABELS[d]}
            </button>
          ))}
        </div>
      ) : (
        <div className="szl__chat-approval-resolved">{DECISION_LABELS[status]}</div>
      )}
    </div>
  );
}

/** Append a streaming delta to the matching agent bubble, creating it on
 *  first delta for an itemId. */
function appendDelta(
  prev: TranscriptEntry[],
  e: CodexStreamDeltaEvent,
  nextId: () => string
): TranscriptEntry[] {
  const idx = prev.findIndex(
    (en) => en.kind === "agent" && en.turnId === e.turnId && en.itemId === e.itemId
  );
  if (idx < 0) {
    return [
      ...prev,
      {
        kind: "agent",
        id: nextId(),
        turnId: e.turnId,
        itemId: e.itemId,
        text: e.delta,
        streaming: true
      }
    ];
  }
  const next = [...prev];
  const existing = next[idx];
  if (existing.kind === "agent") {
    next[idx] = { ...existing, text: existing.text + e.delta };
  }
  return next;
}

/** Mark this turn's streaming bubbles done; surface a final message if no
 *  bubble streamed; render a failure note. */
function finalizeTurn(
  prev: TranscriptEntry[],
  e: CodexTurnCompleteEvent,
  nextId: () => string
): TranscriptEntry[] {
  let sawAgent = false;
  const next = prev.map((en) => {
    if (en.kind === "agent" && en.turnId === e.turnId) {
      sawAgent = true;
      return { ...en, streaming: false };
    }
    return en;
  });
  if (e.status === "failed") {
    next.push({
      kind: "error",
      id: nextId(),
      text: e.error?.message ?? "The agent turn failed."
    });
  } else if (!sawAgent && e.finalMessage !== undefined && e.finalMessage.length > 0) {
    next.push({
      kind: "agent",
      id: nextId(),
      turnId: e.turnId,
      itemId: "final",
      text: e.finalMessage,
      streaming: false
    });
  }
  return next;
}
