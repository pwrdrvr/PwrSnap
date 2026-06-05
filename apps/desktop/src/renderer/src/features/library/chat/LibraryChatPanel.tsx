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
import { MessageList, type ChatActivityChip } from "../../shared/chat/MessageList";
import { Composer, type ComposerAttachment } from "../../shared/chat/Composer";
import { ChatApprovalModal } from "../../shared/chat/ChatApprovalModal";
import "../../shared/chat/chat-panel.css";

export interface LibraryChatPanelProps {
  /** The capture the user is currently viewing, passed as the thread
   *  anchor on send. Null when viewing the Library grid. */
  anchorCaptureId?: string | null;
}

type StreamEntry = { full: string; listeners: Set<(t: string) => void> };
type ChatPanelError = { message: string; showSettingsHint: boolean };

export function LibraryChatPanel({ anchorCaptureId = null }: LibraryChatPanelProps): ReactElement {
  const [threads, setThreads] = useState<LibraryChatThreadView[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [approval, setApproval] = useState<ChatApprovalRequest | null>(null);
  const [codexError, setCodexError] = useState<ChatPanelError | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  // Tool-activity lives IN the transcript flow, not a fixed bar:
  //   • activityByMsg — chips for completed turns, keyed by the assistant
  //     message they produced (rendered above that bubble). Retained for
  //     the session; reset only on thread switch, never on turn end.
  //   • pendingChips — chips for the IN-FLIGHT turn whose assistant
  //     message id isn't known yet (the agent is running tools before any
  //     text streams). Rendered as the trailing group + "Thinking…", then
  //     flushed into activityByMsg once the message id is known.
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [activityByMsg, setActivityByMsg] = useState<Record<string, ChatActivityChip[]>>({});
  const [pendingChips, setPendingChips] = useState<ChatActivityChip[]>([]);

  const threadsRef = useRef<LibraryChatThreadView[]>([]);
  threadsRef.current = threads;
  const activeThreadRef = useRef<string | null>(null);
  activeThreadRef.current = activeThreadId;
  const activeTurnRef = useRef<string | null>(null);
  activeTurnRef.current = activeTurnId;
  const pendingChipsRef = useRef<ChatActivityChip[]>(pendingChips);
  pendingChipsRef.current = pendingChips;
  // turnId → the assistant message id that turn produced, learned from the
  // first stream delta (or the commit for tool-only turns). Lets a tool
  // chip attach to the right bubble in the transcript.
  const turnMsgRef = useRef<Map<string, string>>(new Map());
  const streamState = useRef<Map<string, StreamEntry>>(new Map());

  /** Append a chip to a message's activity (dedup by callId). */
  const appendActivity = useCallback(
    (messageId: string, chip: ChatActivityChip): void => {
      setActivityByMsg((prev) => {
        const existing = prev[messageId] ?? [];
        if (existing.some((c) => c.callId === chip.callId)) return prev;
        return { ...prev, [messageId]: [...existing, chip] };
      });
    },
    []
  );

  /** Move the in-flight pending chips onto a now-known assistant message
   *  (dedup), then clear pending. No-op when there's nothing pending. */
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

  // Thread list — SCOPED to the focused capture (chats are glued to
  // assets). Re-runs when the user navigates to a different capture:
  // resets the selection + working state, then lists that capture's
  // threads. `anchorCaptureId === null` lists library-wide threads.
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
      const result = await dispatch("codex:libraryChat:list", { anchorCaptureId });
      if (cancelled) return;
      if (!result.ok) {
        setCodexError(errorFor(result.error));
        setLoading(false);
        return;
      }
      const found = result.value?.threads ?? [];
      const sorted = sortChatThreads(found);
      setThreads(sorted);
      // Resume this capture's most-recent chat (threads are modified_at
      // DESC) instead of dropping to the greeting — so navigating away
      // and back (and relaunching) reopens the conversation.
      if (sorted.length > 0) setActiveThreadId(sorted[0]!.threadId);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [anchorCaptureId]);

  // Load history when the active thread changes. Switching threads is a
  // fresh view: drop the prior thread's in-memory activity + turn state
  // (it isn't journaled, so it doesn't reload — that's fine).
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
          if (thread.archived) return prev.filter((t) => t.threadId !== thread.threadId);
          const idx = prev.findIndex((t) => t.threadId === thread.threadId);
          if (idx === -1) return sortChatThreads([thread, ...prev]);
          const next = [...prev];
          next[idx] = thread;
          return sortChatThreads(next);
        });
      })
    );

    unsubs.push(
      subscribe(EVENT_CHANNELS.libraryChatStreamDelta, (payload) => {
        const e = payload as LibraryChatStreamDeltaEvent;
        if (e.threadId !== activeThreadRef.current) return;
        // First delta tells us which assistant message this turn produced
        // → attach any chips that arrived before the text started.
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
      subscribe(EVENT_CHANNELS.libraryChatToolCall, (payload) => {
        const e = payload as LibraryChatToolCallEvent;
        if (e.threadId !== activeThreadRef.current) return;
        // A tool fired → the agent is working. Adopt the turn id if we
        // didn't capture it from the send result.
        if (activeTurnRef.current === null) setActiveTurnId(e.turnId);
        const chip: ChatActivityChip = { callId: e.callId, summary: e.summary, ok: e.ok };
        const msgId = turnMsgRef.current.get(e.turnId);
        if (msgId !== undefined) {
          // The turn's assistant message already exists → attach inline
          // above it.
          appendActivity(msgId, chip);
        } else {
          // Message not known yet → hold in the trailing (pending) group.
          setPendingChips((prev) =>
            prev.some((c) => c.callId === chip.callId) ? prev : [...prev, chip]
          );
        }
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
        // Assistant turn finished. Attach any still-pending chips to this
        // committed message (a tool-only turn that produced no streamed
        // text never learned its message id until now), then stop the
        // "Thinking…" indicator. The chips STAY in the transcript — they
        // are not cleared on turn end.
        if (e.message.role === "assistant" && e.message.status !== "streaming") {
          flushPendingTo(e.message.id);
          setActiveTurnId(null);
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
        // Drop the in-flight pending chips, but keep whatever already
        // attached to committed messages.
        setPendingChips([]);
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
      setCodexError(errorFor(result.error));
      return;
    }
    setThreads((prev) =>
      sortChatThreads([result.value, ...prev.filter((t) => t.threadId !== result.value.threadId)])
    );
    setActiveThreadId(result.value.threadId);
    setMessages([]);
    setActivityByMsg({});
    setPendingChips([]);
    turnMsgRef.current.clear();
  }, [anchorCaptureId]);

  const onSubmit = useCallback(
    async (text: string, _attachments: readonly ComposerAttachment[]): Promise<void> => {
      let threadId = activeThreadRef.current;
      if (threadId === null) {
        const created = await dispatch("codex:libraryChat:create", { anchorCaptureId });
        if (!created.ok) {
          setCodexError(errorFor(created.error));
          return;
        }
        threadId = created.value.threadId;
        // Dedup: the controller also broadcasts threadUpdated for this new
        // thread, which can land before this optimistic add — without the
        // filter the same thread shows as two tiles.
        setThreads((prev) =>
          sortChatThreads([
            created.value,
            ...prev.filter((t) => t.threadId !== created.value.threadId)
          ])
        );
        setActiveThreadId(threadId);
      }
      // Fresh turn: clear only the pending (in-flight) chips. Prior
      // turns' chips stay attached to their messages in the transcript.
      setPendingChips([]);
      const result = await dispatch("codex:libraryChat:send", {
        threadId,
        text,
        anchorCaptureId
      });
      if (!result.ok) {
        setCodexError(errorFor(result.error));
        return;
      }
      setActiveTurnId(result.value.turnId);
    },
    [anchorCaptureId]
  );

  const onCloseThread = useCallback(async (threadId: string): Promise<void> => {
    const result = await dispatch("codex:libraryChat:archive", { threadId, archived: true });
    if (!result.ok) {
      setCodexError(errorFor(result.error));
      return;
    }
    const next = threadsRef.current.filter((t) => t.threadId !== threadId);
    setThreads(next);
    if (activeThreadRef.current === threadId) {
      setActiveThreadId(next[0]?.threadId ?? null);
    }
  }, []);

  if (codexError !== null) {
    return (
      <div className="ps-libchat ps-libchat--empty" data-testid="library-chat-panel">
        <div className="ps-libchat-empty-title">Chat is unavailable</div>
        <p className="ps-libchat-empty-body">{codexError.message}</p>
        {codexError.showSettingsHint ? (
          <p className="ps-libchat-empty-body">
            Open <b>Settings → AI Providers</b> to configure Codex, Gemini, or
            another provider, then try again.
          </p>
        ) : null}
        <button
          type="button"
          className="ps-libchat-cta"
          onClick={() => {
            setCodexError(null);
            setLoading(true);
            void dispatch("codex:libraryChat:list", { anchorCaptureId }).then((r) => {
              if (r.ok) setThreads(sortChatThreads(r.value.threads));
              else setCodexError(errorFor(r.error));
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
            <div
              key={t.threadId}
              className={
                "ps-libchat-thread-shell" + (t.threadId === activeThreadId ? " is-active" : "")
              }
            >
              <button
                type="button"
                className="ps-libchat-thread"
                onClick={() => setActiveThreadId(t.threadId)}
                title={t.name}
              >
                <span className="ps-libchat-thread-name">{t.name}</span>
                {t.status.kind === "streaming" ? <span className="ps-libchat-dot" /> : null}
              </button>
              <button
                type="button"
                className="ps-libchat-thread-close"
                onClick={(event) => {
                  event.stopPropagation();
                  void onCloseThread(t.threadId);
                }}
                title="Close chat"
                aria-label={`Close ${t.name}`}
              >
                x
              </button>
            </div>
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
            activityByMessageId={activityByMsg}
            trailingActivity={
              activeTurnId !== null
                ? { chips: pendingChips, thinking: streamingMessageId === null }
                : null
            }
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

function errorFor(error: { code?: string; message: string }): ChatPanelError {
  const staleThread =
    error.code === "thread_not_found" ||
    error.message.includes("thread not found") ||
    error.message.includes("could not be reopened");
  return {
    message: staleThread
      ? "This chat could not be reopened. Start a new chat or close this chat chip."
      : error.message,
    showSettingsHint: !staleThread
  };
}

function sortChatThreads(threads: LibraryChatThreadView[]): LibraryChatThreadView[] {
  return [...threads].sort((a, b) => {
    const modified = dateValue(b.modifiedAt) - dateValue(a.modifiedAt);
    if (modified !== 0) return modified;
    const created = dateValue(b.createdAt) - dateValue(a.createdAt);
    if (created !== 0) return created;
    return b.threadId.localeCompare(a.threadId);
  });
}

function dateValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
