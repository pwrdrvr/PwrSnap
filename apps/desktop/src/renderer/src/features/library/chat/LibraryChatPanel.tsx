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
  ChatApprovalDecision,
  ChatApprovalRequest,
  ChatMessage,
  LibraryChatStreamDeltaEvent,
  LibraryChatMessageCommittedEvent,
  LibraryChatToolCallEvent,
  LibraryChatTurnInterruptedEvent,
  LibraryChatThreadView
} from "@pwrsnap/shared";
import { acpAgentIdFromThreadId, EVENT_CHANNELS } from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../../lib/pwrsnap";
import { MessageList, type ChatActivityChip } from "../../shared/chat/MessageList";
import { Composer, type ComposerAttachment } from "../../shared/chat/Composer";
import { ChatApprovalModal } from "../../shared/chat/ChatApprovalModal";
import { useChatApprovalSession } from "../../shared/chat/useChatApprovalSession";
import {
  NewChatConfigChips,
  LockedBackendChips,
  type ChatBackendChoice
} from "../../shared/chat/ChatBackendChips";
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
  const [codexError, setCodexError] = useState<ChatPanelError | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  // New-chat backend draft (editable chips until the first message locks it).
  const [providers, setProviders] = useState<string[]>(["codex"]);
  const [draftConfig, setDraftConfig] = useState<ChatBackendChoice>({
    provider: "codex",
    model: null,
    reasoning: "medium"
  });
  const [draftHint, setDraftHint] = useState<string | null>(null);
  const draftConfigRef = useRef<ChatBackendChoice>(draftConfig);
  draftConfigRef.current = draftConfig;
  // Tool-activity lives IN the transcript flow, not a fixed bar:
  //   • activityByMsg — chips for completed turns, keyed by the assistant
  //     message they produced (rendered above that bubble). Retained for
  //     the session; reset only on thread switch, never on turn end.
  //   • pendingChips — chips for the IN-FLIGHT turn whose assistant
  //     message id isn't known yet (the agent is running tools before any
  //     text streams). Rendered as the trailing group + "Thinking…", then
  //     flushed into activityByMsg once the message id is known.
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [stoppingTurnId, setStoppingTurnId] = useState<string | null>(null);
  const [activityByMsg, setActivityByMsg] = useState<Record<string, ChatActivityChip[]>>({});
  const [pendingChips, setPendingChips] = useState<ChatActivityChip[]>([]);

  const threadsRef = useRef<LibraryChatThreadView[]>([]);
  threadsRef.current = threads;
  const activeThreadRef = useRef<string | null>(null);
  activeThreadRef.current = activeThreadId;
  const activeTurnRef = useRef<string | null>(null);
  activeTurnRef.current = activeTurnId;
  const stoppingTurnRef = useRef<string | null>(null);
  stoppingTurnRef.current = stoppingTurnId;
  const stopInFlightRef = useRef<string | null>(null);
  const pendingChipsRef = useRef<ChatActivityChip[]>(pendingChips);
  pendingChipsRef.current = pendingChips;
  // turnId → the assistant message id that turn produced, learned from the
  // first stream delta (or the commit for tool-only turns). Lets a tool
  // chip attach to the right bubble in the transcript.
  const turnMsgRef = useRef<Map<string, string>>(new Map());
  const terminalStatusRef = useRef<Map<string, ChatMessage["status"]>>(new Map());
  const streamState = useRef<Map<string, StreamEntry>>(new Map());

  const submitApproval = useCallback(
    (request: ChatApprovalRequest, decision: ChatApprovalDecision) =>
      dispatch("codex:libraryChat:approval", {
        threadId: request.threadId,
        turnId: request.turnId,
        approvalId: request.approvalId,
        decision
      }),
    []
  );
  const approvalSession = useChatApprovalSession({
    activeThreadId,
    pendingApproval:
      activeThreadId === null
        ? null
        : (threads.find((thread) => thread.threadId === activeThreadId)?.pendingApproval ?? null),
    requestedChannel: EVENT_CHANNELS.libraryChatApprovalRequested,
    resolvedChannel: EVENT_CHANNELS.libraryChatApprovalResolved,
    supersededChannel: EVENT_CHANNELS.libraryChatApprovalSuperseded,
    submit: submitApproval
  });

  const updatePendingChips = useCallback(
    (
      update:
        | ChatActivityChip[]
        | ((previous: ChatActivityChip[]) => ChatActivityChip[])
    ): void => {
      setPendingChips((previous) => {
        const next = typeof update === "function" ? update(previous) : update;
        pendingChipsRef.current = next;
        return next;
      });
    },
    []
  );

  const updateActiveTurn = useCallback((turnId: string | null): void => {
    activeTurnRef.current = turnId;
    setActiveTurnId(turnId);
  }, []);

  const updateStoppingTurn = useCallback((turnId: string | null): void => {
    stoppingTurnRef.current = turnId;
    setStoppingTurnId(turnId);
  }, []);

  const clearTurnTracking = useCallback((): void => {
    updateActiveTurn(null);
    updateStoppingTurn(null);
    stopInFlightRef.current = null;
    turnMsgRef.current.clear();
    terminalStatusRef.current.clear();
    streamState.current.clear();
  }, [updateActiveTurn, updateStoppingTurn]);

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
    updatePendingChips([]);
  }, [updatePendingChips]);

  // Provider options + the new-chat draft defaults come from Settings → AI.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await dispatch("settings:read", {});
      if (cancelled || !r.ok || r.value === undefined) return;
      const enabled = r.value.ai?.acp?.enabledAgentIds ?? [];
      setProviders(["codex", ...enabled.map((id) => `acp:${id}`)]);
      const d = r.value.ai?.defaults?.libraryChat;
      setDraftConfig({
        provider: d?.provider !== undefined && d.provider !== "" ? d.provider : "codex",
        model: d?.model !== undefined && d.model !== "" ? d.model : null,
        reasoning: d?.reasoning ?? "medium"
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Thread list — SCOPED to the focused capture (chats are glued to
  // assets). Re-runs when the user navigates to a different capture:
  // resets the selection + working state, then lists that capture's
  // threads. `anchorCaptureId === null` lists library-wide threads.
  useEffect(() => {
    let cancelled = false;
    setActiveThreadId(null);
    setMessages([]);
    clearTurnTracking();
    setActivityByMsg({});
    updatePendingChips([]);
    setStreamingMessageId(null);
    setActionError(null);
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
      setThreads(sortChatThreads(found));
      // The list is now in CREATION order, so resume the most-recently-active
      // chat explicitly (by modified_at) rather than sorted[0] — reopens the
      // conversation on navigate-back / relaunch instead of the greeting.
      const resume = mostRecentlyModified(found);
      if (resume !== null) setActiveThreadId(resume.threadId);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [anchorCaptureId, clearTurnTracking, updatePendingChips]);

  // Load history when the active thread changes. Switching threads is a
  // fresh view: drop the prior thread's in-memory activity + turn state
  // (it isn't journaled, so it doesn't reload — that's fine).
  useEffect(() => {
    setMessages([]);
    setActivityByMsg({});
    updatePendingChips([]);
    updateStoppingTurn(null);
    stopInFlightRef.current = null;
    setStreamingMessageId(null);
    turnMsgRef.current.clear();
    terminalStatusRef.current.clear();
    streamState.current.clear();
    setActionError(null);
    const selected = threadsRef.current.find((thread) => thread.threadId === activeThreadId);
    updateActiveTurn(
      selected?.status.kind === "streaming" ? selected.status.turnId : null
    );
    if (activeThreadId === null) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await dispatch("codex:libraryChat:history", { threadId: activeThreadId });
      if (cancelled || !result.ok) return;
      for (const message of result.value.messages) {
        if (message.status === "streaming") continue;
        const matchingTurn = [...turnMsgRef.current].find(
          ([, messageId]) => messageId === message.id
        )?.[0];
        if (matchingTurn === undefined) continue;
        streamState.current.delete(message.id);
        setStreamingMessageId((current) => current === message.id ? null : current);
        terminalStatusRef.current.set(matchingTurn, message.status);
        if (activeTurnRef.current === matchingTurn) updateActiveTurn(null);
        if (
          stoppingTurnRef.current === matchingTurn &&
          stopInFlightRef.current !== matchingTurn
        ) {
          updateStoppingTurn(null);
        }
      }
      setMessages((current) => mergeHistoryWithLive(result.value.messages, current));
    })();
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, updateActiveTurn, updatePendingChips, updateStoppingTurn]);

  // Subscribe to the chat event stream.
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      subscribe(EVENT_CHANNELS.libraryChatThreadUpdated, (payload) => {
        const { thread } = payload as { thread: LibraryChatThreadView };
        if (
          anchorCaptureId !== null &&
          thread.anchorCaptureId !== anchorCaptureId
        ) {
          return;
        }
        if (
          thread.threadId === activeThreadRef.current &&
          thread.status.kind === "streaming" &&
          terminalStatusRef.current.has(thread.status.turnId)
        ) {
          return;
        }
        setThreads((prev) => {
          if (thread.archived) return prev.filter((t) => t.threadId !== thread.threadId);
          const idx = prev.findIndex((t) => t.threadId === thread.threadId);
          if (idx === -1) return sortChatThreads([thread, ...prev]);
          const next = [...prev];
          next[idx] = thread;
          return sortChatThreads(next);
        });
        if (
          thread.threadId === activeThreadRef.current &&
          thread.status.kind === "streaming"
        ) {
          updateActiveTurn(thread.status.turnId);
        }
      })
    );

    unsubs.push(
      subscribe(EVENT_CHANNELS.libraryChatStreamDelta, (payload) => {
        const e = payload as LibraryChatStreamDeltaEvent;
        if (e.threadId !== activeThreadRef.current) return;
        if (terminalStatusRef.current.has(e.turnId)) return;
        if (activeTurnRef.current === null) updateActiveTurn(e.turnId);
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
        const terminal = terminalStatusRef.current.has(e.turnId);
        // A tool fired → the agent is working. Adopt the turn id if we
        // didn't capture it from the send result.
        if (!terminal && activeTurnRef.current === null) updateActiveTurn(e.turnId);
        const chip: ChatActivityChip = { callId: e.callId, summary: e.summary, ok: e.ok };
        const msgId = turnMsgRef.current.get(e.turnId);
        if (msgId !== undefined) {
          // The turn's assistant message already exists → attach inline
          // above it.
          appendActivity(msgId, chip);
        } else if (!terminal) {
          // Message not known yet → hold in the trailing (pending) group.
          updatePendingChips((prev) =>
            prev.some((c) => c.callId === chip.callId) ? prev : [...prev, chip]
          );
        }
      })
    );

    unsubs.push(
      subscribe(EVENT_CHANNELS.libraryChatMessageCommitted, (payload) => {
        const e = payload as LibraryChatMessageCommittedEvent;
        if (e.threadId !== activeThreadRef.current) return;
        let turnId: string | null = e.turnId ?? null;
        if (turnId === null) {
          for (const [candidateTurnId, messageId] of turnMsgRef.current) {
            if (messageId === e.message.id) {
              turnId = candidateTurnId;
              break;
            }
          }
        }
        if (e.message.role === "assistant" && turnId === null) {
          const unassigned = [...terminalStatusRef.current.keys()]
            .reverse()
            .find((candidate) => !turnMsgRef.current.has(candidate));
          turnId = unassigned ?? activeTurnRef.current;
        }
        if (e.message.role === "assistant" && turnId !== null) {
          turnMsgRef.current.set(turnId, e.message.id);
        }
        const override = turnId !== null ? terminalStatusRef.current.get(turnId) : undefined;
        const committed =
          override === "interrupted" ? { ...e.message, status: "interrupted" as const } : e.message;
        streamState.current.delete(e.message.id);
        setStreamingMessageId((cur) => (cur === e.message.id ? null : cur));
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === e.message.id);
          if (idx === -1) return [...prev, committed];
          const next = [...prev];
          next[idx] = committed;
          return next;
        });
        // Assistant turn finished. Attach any still-pending chips to this
        // committed message (a tool-only turn that produced no streamed
        // text never learned its message id until now), then stop the
        // "Thinking…" indicator. The chips STAY in the transcript — they
        // are not cleared on turn end.
        if (committed.role === "assistant" && committed.status !== "streaming") {
          setActionError(null);
          if (turnId !== null && activeTurnRef.current === turnId) {
            flushPendingTo(committed.id);
          }
          if (turnId !== null) terminalStatusRef.current.set(turnId, committed.status);
          if (turnId !== null && activeTurnRef.current === turnId) {
            updateActiveTurn(null);
          }
          if (turnId !== null && stoppingTurnRef.current === turnId) {
            if (stopInFlightRef.current !== turnId) updateStoppingTurn(null);
          }
        }
      })
    );

    unsubs.push(
      subscribe(EVENT_CHANNELS.libraryChatTurnInterrupted, (payload) => {
        const e = payload as LibraryChatTurnInterruptedEvent;
        if (e.threadId !== activeThreadRef.current) return;
        const currentTurn = activeTurnRef.current;
        if (currentTurn !== null && currentTurn !== e.turnId) return;
        const existingTerminal = terminalStatusRef.current.get(e.turnId);
        if (
          currentTurn === null &&
          (existingTerminal === "complete" || existingTerminal === "failed") &&
          stoppingTurnRef.current !== e.turnId &&
          stopInFlightRef.current !== e.turnId
        ) {
          return;
        }

        terminalStatusRef.current.set(e.turnId, "interrupted");
        setActionError(null);
        const messageId = turnMsgRef.current.get(e.turnId);
        if (messageId !== undefined) {
          const partial = streamState.current.get(messageId)?.full ?? "";
          setMessages((prev) =>
            prev.map((message) => {
              if (message.id !== messageId) return message;
              const hasText = message.content.some(
                (block) => block.kind === "text" && block.text.length > 0
              );
              return {
                ...message,
                content:
                  !hasText && partial.length > 0
                    ? [{ kind: "text" as const, text: partial }]
                    : message.content,
                status: "interrupted"
              };
            })
          );
          streamState.current.delete(messageId);
          setStreamingMessageId((cur) => cur === messageId ? null : cur);
        }
        if (currentTurn === e.turnId) updateActiveTurn(null);
        if (
          stoppingTurnRef.current === e.turnId &&
          stopInFlightRef.current !== e.turnId
        ) {
          updateStoppingTurn(null);
        }
        // Drop the in-flight pending chips, but keep whatever already
        // attached to committed messages.
        updatePendingChips([]);
      })
    );

    return () => {
      for (const u of unsubs) u();
      streamState.current.clear();
      turnMsgRef.current.clear();
      terminalStatusRef.current.clear();
    };
  }, [anchorCaptureId, appendActivity, flushPendingTo, updateActiveTurn, updatePendingChips, updateStoppingTurn]);

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

  // "New" opens a DRAFT — no thread is created until the first message, so the
  // backend chips stay editable (and the provider isn't locked) until the turn
  // starts. Dropping to activeThreadId=null shows the draft greeting + chips.
  const onNewChat = useCallback(() => {
    activeThreadRef.current = null;
    setActiveThreadId(null);
    setMessages([]);
    setActivityByMsg({});
    updatePendingChips([]);
    setDraftHint(null);
    setActionError(null);
    setStreamingMessageId(null);
    clearTurnTracking();
  }, [clearTurnTracking, updatePendingChips]);

  const onSubmit = useCallback(
    async (text: string, _attachments: readonly ComposerAttachment[]): Promise<void> => {
      if (activeTurnRef.current !== null || stoppingTurnRef.current !== null) {
        throw new Error("A response is already in progress.");
      }
      setActionError(null);
      let threadId = activeThreadRef.current;
      if (threadId === null) {
        // First message of a new chat: lock in the chosen backend config. A
        // model is required.
        const cfg = draftConfigRef.current;
        if (cfg.model === null || cfg.model === "") {
          setDraftHint("Choose a model to start this chat.");
          throw new Error("Choose a model to start this chat.");
        }
        setDraftHint(null);
        const created = await dispatch("codex:libraryChat:create", {
          anchorCaptureId,
          provider: cfg.provider,
          model: cfg.model,
          ...(cfg.reasoning !== null && cfg.reasoning !== "" ? { reasoning: cfg.reasoning } : {})
        });
        if (!created.ok) {
          setActionError(`Message not sent: ${errorFor(created.error).message}`);
          throw new Error(created.error.message);
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
        activeThreadRef.current = threadId;
        setActiveThreadId(threadId);
      }
      // Fresh turn: clear only the pending (in-flight) chips. Prior
      // turns' chips stay attached to their messages in the transcript.
      updatePendingChips([]);
      const result = await dispatch("codex:libraryChat:send", {
        threadId,
        text,
        anchorCaptureId
      });
      if (!result.ok) {
        setActionError(`Message not sent: ${errorFor(result.error).message}`);
        throw new Error(result.error.message);
      }
      if (
        activeThreadRef.current === threadId &&
        !terminalStatusRef.current.has(result.value.turnId)
      ) {
        updateActiveTurn(result.value.turnId);
      }
    },
    [anchorCaptureId, updateActiveTurn, updatePendingChips]
  );

  const onStop = useCallback(async (): Promise<void> => {
    const threadId = activeThreadRef.current;
    const turnId = activeTurnRef.current;
    if (threadId === null || turnId === null) return;
    if (stopInFlightRef.current !== null) return;

    stopInFlightRef.current = turnId;
    updateStoppingTurn(turnId);
    setActionError(null);
    try {
      const result = await dispatch("codex:libraryChat:interrupt", { threadId });
      if (!result.ok) {
        if (activeTurnRef.current === turnId) {
          updateStoppingTurn(null);
          setActionError(`Couldn’t stop the response: ${result.error.message}`);
        }
      }
    } catch (cause) {
      if (activeTurnRef.current === turnId) {
        updateStoppingTurn(null);
        setActionError(
          `Couldn’t stop the response: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      }
    } finally {
      if (stopInFlightRef.current === turnId) {
        stopInFlightRef.current = null;
        if (
          stoppingTurnRef.current === turnId &&
          activeTurnRef.current !== turnId
        ) {
          updateStoppingTurn(null);
        }
      }
    }
  }, [updateStoppingTurn]);

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
  const activeThread =
    activeThreadId !== null ? (threads.find((t) => t.threadId === activeThreadId) ?? null) : null;
  // The active thread's locked config, falling back to the provider baked into
  // its id for legacy threads created before per-thread config.
  const lockedChoice: ChatBackendChoice | null =
    activeThread !== null
      ? {
          provider:
            activeThread.provider ??
            (acpAgentIdFromThreadId(activeThread.threadId) !== null
              ? `acp:${acpAgentIdFromThreadId(activeThread.threadId)}`
              : "codex"),
          model: activeThread.model,
          reasoning: activeThread.reasoning
        }
      : null;

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
              your library, and answer “how do I…”. Pick a provider + model, then
              type below to start.
            </p>
            <NewChatConfigChips providers={providers} value={draftConfig} onChange={setDraftConfig} />
            {draftHint !== null ? (
              <p className="ps-libchat-empty-body" style={{ color: "var(--accent)" }}>
                {draftHint}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            {lockedChoice !== null ? <LockedBackendChips choice={lockedChoice} /> : null}
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
          </>
        )}
        {actionError !== null ? (
          <div className="ps-libchat-action-error" role="alert">
            {actionError}
          </div>
        ) : null}
        <Composer
          onSubmit={onSubmit}
          onStop={onStop}
          turnState={
            stoppingTurnId !== null
              ? "stopping"
              : activeTurnId !== null
                ? "active"
                : "idle"
          }
          placeholder="Ask PwrSnap to edit, redact, or find…"
        />
      </div>

      {approvalSession.request !== null ? (
        <ChatApprovalModal
          request={approvalSession.request}
          submitting={approvalSession.phase === "submitting"}
          errorMessage={approvalSession.errorMessage}
          retryDecision={approvalSession.retryDecision}
          onResolve={approvalSession.resolve}
        />
      ) : null}
    </div>
  );
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

/** A delayed history read must never erase messages that arrived live while
 * it was in flight. Live copies also carry the freshest terminal status. */
function mergeHistoryWithLive(
  history: ChatMessage[],
  live: ChatMessage[]
): ChatMessage[] {
  const liveById = new Map(live.map((message) => [message.id, message]));
  const historyIds = new Set(history.map((message) => message.id));
  return [
    ...history.map((message) => {
      const liveMessage = liveById.get(message.id);
      if (liveMessage === undefined) return message;
      return liveMessage.status === "streaming" && message.status !== "streaming"
        ? message
        : liveMessage;
    }),
    ...live.filter((message) => !historyIds.has(message.id))
  ];
}

function sortChatThreads(threads: LibraryChatThreadView[]): LibraryChatThreadView[] {
  // Stable CREATION order (oldest → newest). Deliberately NOT modified_at, so a
  // thread never jumps to the front when you select it or send a message — its
  // position stays put, which is the only way to tell same-named chats apart.
  return [...threads].sort((a, b) => {
    const created = dateValue(a.createdAt) - dateValue(b.createdAt);
    if (created !== 0) return created;
    return a.threadId.localeCompare(b.threadId);
  });
}

/** The most-recently-active thread (by modified_at), for resume-on-open — the
 *  list itself stays in creation order, so this can't be sorted[0]. */
function mostRecentlyModified(
  threads: LibraryChatThreadView[]
): LibraryChatThreadView | null {
  if (threads.length === 0) return null;
  return threads.reduce((best, t) =>
    dateValue(t.modifiedAt) > dateValue(best.modifiedAt) ? t : best
  );
}

function dateValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
