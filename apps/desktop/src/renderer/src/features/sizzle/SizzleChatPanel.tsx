// SizzleChatPanel — the live Sizzle composer chat surface. Wires the
// shared renderer primitives (MessageList, Composer, ChatApprovalModal)
// to the codex:sizzleChat:* bus verbs + the events:sizzleChat:* stream.
//
// Mirrors LibraryChatPanel; the anchor is the active SIZZLE PROJECT
// (passed as `anchorCaptureId` on the wire — the substrate's anchor field
// is surface-neutral). Reuses LibraryChatPanel's chrome CSS (.ps-libchat*).

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
import { dispatch, subscribe } from "../../lib/pwrsnap";
import { MessageList, type ChatActivityChip } from "../shared/chat/MessageList";
import { Composer, type ComposerAttachment } from "../shared/chat/Composer";
import { ChatApprovalModal } from "../shared/chat/ChatApprovalModal";
import "../shared/chat/chat-panel.css";

export interface SizzleChatPanelProps {
  /** The Sizzle project this chat composes — passed as the thread anchor
   *  so the agent's tools are scoped to it. */
  projectId: string;
}

type StreamEntry = { full: string; listeners: Set<(t: string) => void> };

export function SizzleChatPanel({ projectId }: SizzleChatPanelProps): ReactElement {
  const [threads, setThreads] = useState<LibraryChatThreadView[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [approval, setApproval] = useState<ChatApprovalRequest | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [activityByMsg, setActivityByMsg] = useState<Record<string, ChatActivityChip[]>>({});
  const [pendingChips, setPendingChips] = useState<ChatActivityChip[]>([]);

  const activeThreadRef = useRef<string | null>(null);
  activeThreadRef.current = activeThreadId;
  const activeTurnRef = useRef<string | null>(null);
  activeTurnRef.current = activeTurnId;
  const pendingChipsRef = useRef<ChatActivityChip[]>(pendingChips);
  pendingChipsRef.current = pendingChips;
  const turnMsgRef = useRef<Map<string, string>>(new Map());
  const streamState = useRef<Map<string, StreamEntry>>(new Map());

  const appendActivity = useCallback((messageId: string, chip: ChatActivityChip): void => {
    setActivityByMsg((prev) => {
      const existing = prev[messageId] ?? [];
      if (existing.some((c) => c.callId === chip.callId)) return prev;
      return { ...prev, [messageId]: [...existing, chip] };
    });
  }, []);

  const flushPendingTo = useCallback((messageId: string): void => {
    const pending = pendingChipsRef.current;
    if (pending.length === 0) return;
    setActivityByMsg((prev) => {
      const merged = [...(prev[messageId] ?? [])];
      for (const c of pending) {
        if (!merged.some((m) => m.callId === c.callId)) merged.push(c);
      }
      return { ...prev, [messageId]: merged };
    });
    setPendingChips([]);
  }, []);

  // Thread list — scoped to the active project. Re-runs on project switch.
  useEffect(() => {
    let cancelled = false;
    setActiveThreadId(null);
    setMessages([]);
    setActiveTurnId(null);
    setActivityByMsg({});
    setPendingChips([]);
    turnMsgRef.current.clear();
    setLoading(true);
    void (async () => {
      const result = await dispatch("codex:sizzleChat:list", { anchorCaptureId: projectId });
      if (cancelled) return;
      if (!result.ok) {
        setCodexError(result.error.message);
        setLoading(false);
        return;
      }
      const found = result.value?.threads ?? [];
      setThreads(found);
      // Resume the reel's most-recent chat (threads are modified_at DESC)
      // instead of dropping to the greeting — so switching reels (and
      // relaunching the app) reopens the conversation for that reel.
      if (found.length > 0) setActiveThreadId(found[0]!.threadId);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Load history when the active thread changes.
  useEffect(() => {
    setActivityByMsg({});
    setPendingChips([]);
    setActiveTurnId(null);
    setStreamingMessageId(null);
    turnMsgRef.current.clear();
    if (activeThreadId === null) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await dispatch("codex:sizzleChat:history", { threadId: activeThreadId });
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
      subscribe(EVENT_CHANNELS.sizzleChatThreadUpdated, (payload) => {
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
      subscribe(EVENT_CHANNELS.sizzleChatStreamDelta, (payload) => {
        const e = payload as LibraryChatStreamDeltaEvent;
        if (e.threadId !== activeThreadRef.current) return;
        if (turnMsgRef.current.get(e.turnId) !== e.messageId) {
          turnMsgRef.current.set(e.turnId, e.messageId);
          flushPendingTo(e.messageId);
        }
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
      subscribe(EVENT_CHANNELS.sizzleChatToolCall, (payload) => {
        const e = payload as LibraryChatToolCallEvent;
        if (e.threadId !== activeThreadRef.current) return;
        if (activeTurnRef.current === null) setActiveTurnId(e.turnId);
        const chip: ChatActivityChip = { callId: e.callId, summary: e.summary, ok: e.ok };
        const msgId = turnMsgRef.current.get(e.turnId);
        if (msgId !== undefined) {
          appendActivity(msgId, chip);
        } else {
          setPendingChips((prev) =>
            prev.some((c) => c.callId === chip.callId) ? prev : [...prev, chip]
          );
        }
      })
    );

    unsubs.push(
      subscribe(EVENT_CHANNELS.sizzleChatMessageCommitted, (payload) => {
        const e = payload as LibraryChatMessageCommittedEvent;
        if (e.threadId !== activeThreadRef.current) return;
        if (streamState.current.has(e.message.id)) {
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
        if (e.message.role === "assistant" && e.message.status !== "streaming") {
          flushPendingTo(e.message.id);
          setActiveTurnId(null);
        }
      })
    );

    unsubs.push(
      subscribe(EVENT_CHANNELS.sizzleChatApprovalRequested, (payload) => {
        const req = payload as ChatApprovalRequest;
        if (req.threadId !== activeThreadRef.current) return;
        setApproval(req);
      })
    );

    unsubs.push(
      subscribe(EVENT_CHANNELS.sizzleChatTurnInterrupted, (payload) => {
        const e = payload as { threadId: string };
        if (e.threadId !== activeThreadRef.current) return;
        setStreamingMessageId(null);
        setActiveTurnId(null);
        setPendingChips([]);
      })
    );

    return () => {
      for (const u of unsubs) u();
    };
  }, [appendActivity, flushPendingTo]);

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
    const result = await dispatch("codex:sizzleChat:create", { anchorCaptureId: projectId });
    if (!result.ok) {
      setCodexError(result.error.message);
      return;
    }
    setThreads((prev) => [result.value, ...prev.filter((t) => t.threadId !== result.value.threadId)]);
    setActiveThreadId(result.value.threadId);
    setMessages([]);
    setActivityByMsg({});
    setPendingChips([]);
    turnMsgRef.current.clear();
  }, [projectId]);

  const onSubmit = useCallback(
    async (text: string, _attachments: readonly ComposerAttachment[]): Promise<void> => {
      let threadId = activeThreadRef.current;
      if (threadId === null) {
        const created = await dispatch("codex:sizzleChat:create", { anchorCaptureId: projectId });
        if (!created.ok) {
          setCodexError(created.error.message);
          return;
        }
        threadId = created.value.threadId;
        // Dedup: the controller also broadcasts threadUpdated for this new
        // thread, which can land before this optimistic add — without the
        // filter the same thread shows as two tiles.
        setThreads((prev) => [
          created.value,
          ...prev.filter((t) => t.threadId !== created.value.threadId)
        ]);
        setActiveThreadId(threadId);
      }
      setPendingChips([]);
      const result = await dispatch("codex:sizzleChat:send", {
        threadId,
        text,
        anchorCaptureId: projectId
      });
      if (!result.ok) {
        setCodexError(result.error.message);
        return;
      }
      setActiveTurnId(result.value.turnId);
    },
    [projectId]
  );

  if (codexError !== null) {
    return (
      <div className="ps-libchat ps-libchat--empty" data-testid="sizzle-chat-panel">
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
            void dispatch("codex:sizzleChat:list", { anchorCaptureId: projectId }).then((r) => {
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
      <div className="ps-libchat ps-libchat--empty" data-testid="sizzle-chat-panel">
        Loading…
      </div>
    );
  }

  const showGreeting = activeThreadId === null;

  return (
    <div className="ps-libchat" data-testid="sizzle-chat-panel">
      <div className="ps-libchat-threads">
        <button
          type="button"
          className="ps-libchat-newchat"
          onClick={() => void onNewChat()}
          title="Start a new chat for this reel"
        >
          + New
        </button>
        <div className="ps-libchat-thread-strip">
          {threads.map((t) => (
            <button
              type="button"
              key={t.threadId}
              className={"ps-libchat-thread" + (t.threadId === activeThreadId ? " is-active" : "")}
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
            <div className="ps-libchat-empty-title">Reel composer</div>
            <p className="ps-libchat-empty-body">
              Describe the video you want. I can search your library, propose
              scenes, write narrator scripts, set transitions, and render this
              reel. Type below to start.
            </p>
          </div>
        ) : (
          <MessageList
            messages={messages}
            streamingMessageId={streamingMessageId}
            subscribeToStream={subscribeToStream}
            activityByMessageId={activityByMsg}
            trailingActivity={
              activeTurnId !== null
                ? { chips: pendingChips, thinking: streamingMessageId === null }
                : null
            }
          />
        )}
        <Composer onSubmit={onSubmit} placeholder="Describe the reel, or ask for an edit…" />
      </div>

      {approval !== null ? (
        <ChatApprovalModal
          request={approval}
          onResolve={async (decision) => {
            await dispatch("codex:sizzleChat:approval", {
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
