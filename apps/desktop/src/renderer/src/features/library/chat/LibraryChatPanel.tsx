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

  const activeThreadRef = useRef<string | null>(null);
  activeThreadRef.current = activeThreadId;
  const streamState = useRef<Map<string, StreamEntry>>(new Map());

  // Initial thread list.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await dispatch("codex:libraryChat:list", {});
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
  }, []);

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
    const result = await dispatch("codex:libraryChat:create", {});
    if (!result.ok) {
      setCodexError(result.error.message);
      return;
    }
    setThreads((prev) => [result.value, ...prev.filter((t) => t.threadId !== result.value.threadId)]);
    setActiveThreadId(result.value.threadId);
    setMessages([]);
  }, []);

  const onSubmit = useCallback(
    async (text: string, _attachments: readonly ComposerAttachment[]): Promise<void> => {
      let threadId = activeThreadRef.current;
      if (threadId === null) {
        const created = await dispatch("codex:libraryChat:create", {});
        if (!created.ok) {
          setCodexError(created.error.message);
          return;
        }
        threadId = created.value.threadId;
        setThreads((prev) => [created.value, ...prev]);
        setActiveThreadId(threadId);
      }
      const result = await dispatch("codex:libraryChat:send", {
        threadId,
        text,
        anchorCaptureId
      });
      if (!result.ok) {
        setCodexError(result.error.message);
      }
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
            void dispatch("codex:libraryChat:list", {}).then((r) => {
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
        <button type="button" className="ps-libchat-newchat" onClick={() => void onNewChat()}>
          + New chat
        </button>
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

      <div className="ps-libchat-main">
        {showGreeting ? (
          <div className="ps-libchat-greeting">
            <div className="ps-libchat-empty-title">PwrSnap chat</div>
            <p className="ps-libchat-empty-body">
              I can browse your library, edit the capture you’re viewing, redact
              sensitive data, and answer “how do I…”. Type below to start — I’ll
              spin up a new chat.
            </p>
          </div>
        ) : (
          <MessageList
            messages={messages}
            streamingMessageId={streamingMessageId}
            subscribeToStream={subscribeToStream}
          />
        )}
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
