// LibraryChatPanel — the live Library chat surface. Wires the shared
// renderer primitives (MessageList, Composer, ChatApprovalModal) to the
// codex:libraryChat:* bus verbs + the events:libraryChat:* stream.
//
// Scope: thread list + active-thread message view + composer. The
// current capture (anchorCaptureId) is passed on send so the agent's
// per-turn context tracks whatever the user is viewing. Three empty
// states: no Codex, zero threads, normal (plan §F11 G1/G2/G15).

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type {
  ChatApprovalRequest,
  ChatMessage,
  LibraryChatStreamDeltaEvent,
  LibraryChatMessageCommittedEvent,
  LibraryChatToolCallEvent,
  LibraryChatThreadView
} from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../../lib/pwrsnap";
import { MessageList } from "../../shared/chat/MessageList";
import { Composer, type ComposerAttachment } from "../../shared/chat/Composer";
import { ChatApprovalModal } from "../../shared/chat/ChatApprovalModal";
import "./LibraryChatPanel.css";

export interface LibraryChatPanelProps {
  /** The capture the user is currently viewing, passed as the thread
   *  anchor on send. Null when viewing the Library grid. */
  anchorCaptureId?: string | null;
}

type StreamEntry = { full: string; listeners: Set<(t: string) => void> };

export function LibraryChatPanel({ anchorCaptureId = null }: LibraryChatPanelProps): ReactElement {
  const [threads, setThreads] = useState<LibraryChatThreadView[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [approval, setApproval] = useState<ChatApprovalRequest | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  // The in-flight turn + the activity chips it has produced so far
  // (point 3: show "Thinking…" + which tools ran while the agent works).
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [toolChips, setToolChips] = useState<Array<{ callId: string; summary: string; ok: boolean }>>(
    []
  );

  const activeThreadRef = useRef<string | null>(null);
  activeThreadRef.current = activeThreadId;
  const activeTurnRef = useRef<string | null>(null);
  activeTurnRef.current = activeTurnId;
  const streamState = useRef<Map<string, StreamEntry>>(new Map());

  // Thread list — SCOPED to the focused capture (chats are glued to
  // assets). Re-runs when the user navigates to a different capture:
  // resets the selection + working state, then lists that capture's
  // threads. `anchorCaptureId === null` lists library-wide threads.
  useEffect(() => {
    let cancelled = false;
    setActiveThreadId(null);
    setMessages([]);
    setActiveTurnId(null);
    setToolChips([]);
    setLoading(true);
    void (async () => {
      const result = await dispatch("codex:libraryChat:list", { anchorCaptureId });
      if (cancelled) return;
      if (!result.ok) {
        setCodexError(result.error.message);
        setLoading(false);
        return;
      }
      setThreads(result.value?.threads ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [anchorCaptureId]);

  // Load history when the active thread changes.
  useEffect(() => {
    if (activeThreadId === null) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await dispatch("codex:libraryChat:history", { threadId: activeThreadId });
      if (cancelled || !result.ok) return;
      setMessages(result.value.messages);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeThreadId]);

  // Subscribe to the chat event stream.
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      subscribe(EVENT_CHANNELS.libraryChatThreadUpdated, (payload) => {
        const { thread } = payload as { thread: LibraryChatThreadView };
        setThreads((prev) => {
          const idx = prev.findIndex((t) => t.threadId === thread.threadId);
          if (idx === -1) return [thread, ...prev];
          const next = [...prev];
          next[idx] = thread;
          return next;
        });
      })
    );

    unsubs.push(
      subscribe(EVENT_CHANNELS.libraryChatStreamDelta, (payload) => {
        const e = payload as LibraryChatStreamDeltaEvent;
        if (e.threadId !== activeThreadRef.current) return;
        let entry = streamState.current.get(e.messageId);
        if (entry === undefined) {
          entry = { full: "", listeners: new Set() };
          streamState.current.set(e.messageId, entry);
        }
        entry.full += e.delta;
        for (const listener of entry.listeners) listener(entry.full);
        setStreamingMessageId(e.messageId);
        setMessages((prev) =>
          prev.some((m) => m.id === e.messageId)
            ? prev
            : [
                ...prev,
                {
                  id: e.messageId,
                  role: "assistant",
                  content: [{ kind: "text", text: "" }],
                  status: "streaming",
                  createdAt: new Date().toISOString()
                }
              ]
        );
      })
    );

    unsubs.push(
      subscribe(EVENT_CHANNELS.libraryChatToolCall, (payload) => {
        const e = payload as LibraryChatToolCallEvent;
        if (e.threadId !== activeThreadRef.current) return;
        // A tool fired → the agent is working. Adopt the turn id if we
        // didn't capture it from the send result, and append the chip.
        if (activeTurnRef.current === null) setActiveTurnId(e.turnId);
        setToolChips((prev) =>
          prev.some((c) => c.callId === e.callId)
            ? prev
            : [...prev, { callId: e.callId, summary: e.summary, ok: e.ok }]
        );
      })
    );

    unsubs.push(
      subscribe(EVENT_CHANNELS.libraryChatMessageCommitted, (payload) => {
        const e = payload as LibraryChatMessageCommittedEvent;
        if (e.threadId !== activeThreadRef.current) return;
        if (streamingMessageIdMatches(e.message.id, streamState)) {
          streamState.current.delete(e.message.id);
        }
        setStreamingMessageId((cur) => (cur === e.message.id ? null : cur));
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === e.message.id);
          if (idx === -1) return [...prev, e.message];
          const next = [...prev];
          next[idx] = e.message;
          return next;
        });
        // The assistant turn finished → clear the working indicator +
        // activity chips (they're transient, per-turn).
        if (e.message.role === "assistant" && e.message.status !== "streaming") {
          setActiveTurnId(null);
          setToolChips([]);
        }
      })
    );

    unsubs.push(
      subscribe(EVENT_CHANNELS.libraryChatApprovalRequested, (payload) => {
        const req = payload as ChatApprovalRequest;
        if (req.threadId !== activeThreadRef.current) return;
        setApproval(req);
      })
    );

    unsubs.push(
      subscribe(EVENT_CHANNELS.libraryChatTurnInterrupted, (payload) => {
        const e = payload as { threadId: string };
        if (e.threadId !== activeThreadRef.current) return;
        setStreamingMessageId(null);
        setActiveTurnId(null);
        setToolChips([]);
      })
    );

    return () => {
      for (const u of unsubs) u();
    };
  }, []);

  const subscribeToStream = useCallback(
    (messageId: string, onDelta: (fullText: string) => void): (() => void) => {
      let entry = streamState.current.get(messageId);
      if (entry === undefined) {
        entry = { full: "", listeners: new Set() };
        streamState.current.set(messageId, entry);
      }
      entry.listeners.add(onDelta);
      onDelta(entry.full);
      return () => {
        streamState.current.get(messageId)?.listeners.delete(onDelta);
      };
    },
    []
  );

  const onNewChat = useCallback(async () => {
    const result = await dispatch("codex:libraryChat:create", { anchorCaptureId });
    if (!result.ok) {
      setCodexError(result.error.message);
      return;
    }
    setThreads((prev) => [result.value, ...prev.filter((t) => t.threadId !== result.value.threadId)]);
    setActiveThreadId(result.value.threadId);
    setMessages([]);
    setToolChips([]);
  }, [anchorCaptureId]);

  const onSubmit = useCallback(
    async (text: string, _attachments: readonly ComposerAttachment[]): Promise<void> => {
      let threadId = activeThreadRef.current;
      if (threadId === null) {
        const created = await dispatch("codex:libraryChat:create", { anchorCaptureId });
        if (!created.ok) {
          setCodexError(created.error.message);
          return;
        }
        threadId = created.value.threadId;
        setThreads((prev) => [created.value, ...prev]);
        setActiveThreadId(threadId);
      }
      // Reset activity for the new turn; the working indicator shows
      // until the assistant message commits.
      setToolChips([]);
      const result = await dispatch("codex:libraryChat:send", {
        threadId,
        text,
        anchorCaptureId
      });
      if (!result.ok) {
        setCodexError(result.error.message);
        return;
      }
      setActiveTurnId(result.value.turnId);
    },
    [anchorCaptureId]
  );

  if (codexError !== null) {
    return (
      <div className="ps-libchat ps-libchat--empty" data-testid="library-chat-panel">
        <div className="ps-libchat-empty-title">Chat is unavailable</div>
        <p className="ps-libchat-empty-body">{codexError}</p>
        <p className="ps-libchat-empty-body">
          Open <b>Settings → AI Providers</b> to configure Codex, then try again.
        </p>
        <button
          type="button"
          className="ps-libchat-cta"
          onClick={() => {
            setCodexError(null);
            setLoading(true);
            void dispatch("codex:libraryChat:list", { anchorCaptureId }).then((r) => {
              if (r.ok) setThreads(r.value.threads);
              else setCodexError(r.error.message);
              setLoading(false);
            });
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="ps-libchat ps-libchat--empty" data-testid="library-chat-panel">
        Loading…
      </div>
    );
  }

  const showGreeting = activeThreadId === null;

  return (
    <div className="ps-libchat" data-testid="library-chat-panel">
      <div className="ps-libchat-threads">
        <button
          type="button"
          className="ps-libchat-newchat"
          onClick={() => void onNewChat()}
          title="Start a new chat for this capture"
        >
          + New
        </button>
        <div className="ps-libchat-thread-strip">
          {threads.map((t) => (
            <button
              type="button"
              key={t.threadId}
              className={
                "ps-libchat-thread" + (t.threadId === activeThreadId ? " is-active" : "")
              }
              onClick={() => setActiveThreadId(t.threadId)}
            >
              <span className="ps-libchat-thread-name">{t.name}</span>
              {t.status.kind === "streaming" ? <span className="ps-libchat-dot" /> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="ps-libchat-main">
        {showGreeting ? (
          <div className="ps-libchat-greeting">
            <div className="ps-libchat-empty-title">PwrSnap chat</div>
            <p className="ps-libchat-empty-body">
              I can edit the capture you’re viewing, redact sensitive data, browse
              your library, and answer “how do I…”. Type below to start.
            </p>
          </div>
        ) : (
          <MessageList
            messages={messages}
            streamingMessageId={streamingMessageId}
            subscribeToStream={subscribeToStream}
          />
        )}
        {activeTurnId !== null ? (
          <div className="ps-libchat-working" aria-live="polite">
            {toolChips.map((c) => (
              <div
                key={c.callId}
                className={"ps-libchat-chip" + (c.ok ? "" : " is-error")}
              >
                <span className="ps-libchat-chip-dot" />
                {c.summary}
              </div>
            ))}
            {streamingMessageId === null ? (
              <div className="ps-libchat-thinking">
                <span className="ps-libchat-thinking-dot" />
                Thinking…
              </div>
            ) : null}
          </div>
        ) : null}
        <Composer onSubmit={onSubmit} placeholder="Ask PwrSnap to edit, redact, or find…" />
      </div>

      {approval !== null ? (
        <ChatApprovalModal
          request={approval}
          onResolve={async (decision) => {
            await dispatch("codex:libraryChat:approval", {
              threadId: approval.threadId,
              turnId: approval.turnId,
              approvalId: approval.approvalId,
              decision
            });
            setApproval(null);
          }}
        />
      ) : null}
    </div>
  );
}

function streamingMessageIdMatches(
  messageId: string,
  streamState: React.MutableRefObject<Map<string, StreamEntry>>
): boolean {
  return streamState.current.has(messageId);
}
