// Shared Library/Sizzle chat widget. Surface-specific wrappers provide only
// scope identity and root test id; this component owns the lifecycle once so
// Stop, drafts, streams, approvals, archive, and terminal races cannot drift.

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
import { MessageList, type ChatActivityChip } from "./MessageList";
import { Composer } from "./Composer";
import {
  chatDraftKey,
  clearChatDraftAtRevision,
  moveChatDraft,
  readChatDraftSnapshot,
  writeChatDraft
} from "./chat-draft-store";
import { ChatApprovalModal } from "./ChatApprovalModal";
import { useChatApprovalSession } from "./useChatApprovalSession";
import {
  NewChatConfigChips,
  LockedBackendChips,
  type ChatBackendAvailability,
  type ChatBackendChoice
} from "./ChatBackendChips";
import "./chat-panel.css";

type ChatSurface = "library" | "sizzle";

export type ChatPanelSurfaceProps =
  | {
      readonly surface: "library";
      readonly scopeId: string | null;
      readonly testId: string;
    }
  | {
      readonly surface: "sizzle";
      readonly scopeId: string;
      readonly testId: string;
    };

const SURFACE_CHANNELS = {
  library: {
    threadUpdated: EVENT_CHANNELS.libraryChatThreadUpdated,
    streamDelta: EVENT_CHANNELS.libraryChatStreamDelta,
    toolCall: EVENT_CHANNELS.libraryChatToolCall,
    messageCommitted: EVENT_CHANNELS.libraryChatMessageCommitted,
    turnInterrupted: EVENT_CHANNELS.libraryChatTurnInterrupted,
    approvalRequested: EVENT_CHANNELS.libraryChatApprovalRequested,
    approvalResolved: EVENT_CHANNELS.libraryChatApprovalResolved,
    approvalSuperseded: EVENT_CHANNELS.libraryChatApprovalSuperseded
  },
  sizzle: {
    threadUpdated: EVENT_CHANNELS.sizzleChatThreadUpdated,
    streamDelta: EVENT_CHANNELS.sizzleChatStreamDelta,
    toolCall: EVENT_CHANNELS.sizzleChatToolCall,
    messageCommitted: EVENT_CHANNELS.sizzleChatMessageCommitted,
    turnInterrupted: EVENT_CHANNELS.sizzleChatTurnInterrupted,
    approvalRequested: EVENT_CHANNELS.sizzleChatApprovalRequested,
    approvalResolved: EVENT_CHANNELS.sizzleChatApprovalResolved,
    approvalSuperseded: EVENT_CHANNELS.sizzleChatApprovalSuperseded
  }
} as const;

function listThreads(surface: ChatSurface, scopeId: string | null) {
  return surface === "library"
    ? dispatch("codex:libraryChat:list", { anchorCaptureId: scopeId })
    : dispatch("codex:sizzleChat:list", { anchorCaptureId: scopeId });
}

function loadHistory(surface: ChatSurface, threadId: string) {
  return surface === "library"
    ? dispatch("codex:libraryChat:history", { threadId })
    : dispatch("codex:sizzleChat:history", { threadId });
}

function createThread(
  surface: ChatSurface,
  scopeId: string | null,
  config: ChatBackendChoice
) {
  const request = {
    anchorCaptureId: scopeId,
    provider: config.provider,
    model: config.model ?? "",
    ...(config.reasoning !== null && config.reasoning !== ""
      ? { reasoning: config.reasoning }
      : {})
  };
  return surface === "library"
    ? dispatch("codex:libraryChat:create", request)
    : dispatch("codex:sizzleChat:create", request);
}

function sendMessage(
  surface: ChatSurface,
  scopeId: string | null,
  threadId: string,
  text: string
) {
  const request = { threadId, text, anchorCaptureId: scopeId };
  return surface === "library"
    ? dispatch("codex:libraryChat:send", request)
    : dispatch("codex:sizzleChat:send", request);
}

function interruptThread(surface: ChatSurface, threadId: string) {
  return surface === "library"
    ? dispatch("codex:libraryChat:interrupt", { threadId })
    : dispatch("codex:sizzleChat:interrupt", { threadId });
}

function archiveThread(surface: ChatSurface, threadId: string) {
  const request = { threadId, archived: true };
  return surface === "library"
    ? dispatch("codex:libraryChat:archive", request)
    : dispatch("codex:sizzleChat:archive", request);
}

function submitApprovalDecision(
  surface: ChatSurface,
  request: ChatApprovalRequest,
  decision: ChatApprovalDecision
) {
  const payload = {
    threadId: request.threadId,
    turnId: request.turnId,
    approvalId: request.approvalId,
    decision
  };
  return surface === "library"
    ? dispatch("codex:libraryChat:approval", payload)
    : dispatch("codex:sizzleChat:approval", payload);
}

function threadBelongsToScope(
  surface: ChatSurface,
  scopeId: string | null,
  thread: LibraryChatThreadView
): boolean {
  return surface === "library" && scopeId === null
    ? true
    : thread.anchorCaptureId === scopeId;
}

type StreamEntry = { full: string; listeners: Set<(t: string) => void> };
type ThreadStreamState = Map<string, Map<string, StreamEntry>>;
type ChatPanelError = { message: string; showSettingsHint: boolean };

function streamsForThread(
  state: ThreadStreamState,
  threadId: string
): Map<string, StreamEntry> {
  let streams = state.get(threadId);
  if (streams === undefined) {
    streams = new Map();
    state.set(threadId, streams);
  }
  return streams;
}

function latestStreamMessageId(
  state: ThreadStreamState,
  threadId: string | null
): string | null {
  if (threadId === null) return null;
  const ids = state.get(threadId)?.keys();
  if (ids === undefined) return null;
  let latest: string | null = null;
  for (const id of ids) latest = id;
  return latest;
}

export function ChatPanelSurface({
  surface,
  scopeId,
  testId
}: ChatPanelSurfaceProps): ReactElement {
  const [threads, setThreads] = useState<LibraryChatThreadView[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [codexError, setCodexError] = useState<ChatPanelError | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draftResetVersion, setDraftResetVersion] = useState(0);
  const [loading, setLoading] = useState<boolean>(true);
  // New-chat backend draft (editable chips until the first message locks it).
  const [providers, setProviders] = useState<string[]>(["codex"]);
  const [draftConfig, setDraftConfig] = useState<ChatBackendChoice>({
    provider: "codex",
    model: null,
    reasoning: "medium"
  });
  const [draftHint, setDraftHint] = useState<string | null>(null);
  const [backendAvailability, setBackendAvailability] =
    useState<ChatBackendAvailability | null>(null);
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
  const streamState = useRef<ThreadStreamState>(new Map());
  const channels = SURFACE_CHANNELS[surface];

  const submitApproval = useCallback(
    (request: ChatApprovalRequest, decision: ChatApprovalDecision) =>
      submitApprovalDecision(surface, request, decision),
    [surface]
  );
  const approvalSession = useChatApprovalSession({
    activeThreadId,
    pendingApproval:
      activeThreadId === null
        ? null
        : (threads.find((thread) => thread.threadId === activeThreadId)?.pendingApproval ?? null),
    requestedChannel: channels.approvalRequested,
    resolvedChannel: channels.approvalResolved,
    supersededChannel: channels.approvalSuperseded,
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
      const d = surface === "library"
        ? r.value.ai?.defaults?.libraryChat
        : r.value.ai?.defaults?.sizzleChat;
      setDraftConfig({
        provider: d?.provider !== undefined && d.provider !== "" ? d.provider : "codex",
        model: d?.model !== undefined && d.model !== "" ? d.model : null,
        reasoning: d?.reasoning ?? "medium"
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [surface]);

  // Thread list is scoped to the focused capture or Sizzle project. A null
  // Library scope intentionally means library-wide chat.
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
      const result = await listThreads(surface, scopeId);
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
  }, [surface, scopeId, clearTurnTracking, updatePendingChips]);

  // Load history when the active thread changes. Activity chips are view-local,
  // but live stream buffers and turn identity stay partitioned by thread so a
  // navigation round-trip cannot truncate an uncommitted assistant response.
  useEffect(() => {
    const bufferedMessageId = latestStreamMessageId(streamState.current, activeThreadId);
    setMessages(
      bufferedMessageId === null
        ? []
        : [{
            id: bufferedMessageId,
            role: "assistant",
            content: [{ kind: "text", text: "" }],
            status: "streaming",
            createdAt: new Date().toISOString()
          }]
    );
    setActivityByMsg({});
    updatePendingChips([]);
    updateStoppingTurn(null);
    stopInFlightRef.current = null;
    setStreamingMessageId(bufferedMessageId);
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
      const result = await loadHistory(surface, activeThreadId);
      if (cancelled || !result.ok) return;
      for (const message of result.value.messages) {
        if (message.status === "streaming") continue;
        streamsForThread(streamState.current, activeThreadId).delete(message.id);
        setStreamingMessageId((current) => current === message.id ? null : current);
        const matchingTurn = [...turnMsgRef.current].find(
          ([, messageId]) => messageId === message.id
        )?.[0];
        if (matchingTurn === undefined) continue;
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
  }, [surface, activeThreadId, updateActiveTurn, updatePendingChips, updateStoppingTurn]);

  // Subscribe to the chat event stream.
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      subscribe(channels.threadUpdated, (payload) => {
        const { thread } = payload as { thread: LibraryChatThreadView };
        if (!threadBelongsToScope(surface, scopeId, thread)) return;
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
      subscribe(channels.streamDelta, (payload) => {
        const e = payload as LibraryChatStreamDeltaEvent;
        const isActiveThread = e.threadId === activeThreadRef.current;
        if (!isActiveThread && !threadsRef.current.some((thread) => thread.threadId === e.threadId)) {
          return;
        }
        if (terminalStatusRef.current.has(e.turnId)) return;
        let entry = streamsForThread(streamState.current, e.threadId).get(e.messageId);
        if (entry === undefined) {
          entry = { full: "", listeners: new Set() };
          streamsForThread(streamState.current, e.threadId).set(e.messageId, entry);
        }
        entry.full += e.delta;
        for (const listener of entry.listeners) listener(entry.full);
        const learnedMessageId = turnMsgRef.current.get(e.turnId) !== e.messageId;
        if (learnedMessageId) turnMsgRef.current.set(e.turnId, e.messageId);
        if (!isActiveThread) return;
        if (activeTurnRef.current === null) updateActiveTurn(e.turnId);
        // First delta tells us which assistant message this turn produced
        // → attach any chips that arrived before the text started.
        if (learnedMessageId) flushPendingTo(e.messageId);
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
      subscribe(channels.toolCall, (payload) => {
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
      subscribe(channels.messageCommitted, (payload) => {
        const e = payload as LibraryChatMessageCommittedEvent;
        if (
          e.threadId !== activeThreadRef.current &&
          !threadsRef.current.some((thread) => thread.threadId === e.threadId)
        ) {
          return;
        }
        streamState.current.get(e.threadId)?.delete(e.message.id);
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
      subscribe(channels.turnInterrupted, (payload) => {
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
          const partial = streamState.current.get(e.threadId)?.get(messageId)?.full ?? "";
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
          streamState.current.get(e.threadId)?.delete(messageId);
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
  }, [surface, scopeId, channels, appendActivity, flushPendingTo, updateActiveTurn, updatePendingChips, updateStoppingTurn]);

  const subscribeToStream = useCallback(
    (messageId: string, onDelta: (fullText: string) => void): (() => void) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return () => undefined;
      const streams = streamsForThread(streamState.current, threadId);
      let entry = streams.get(messageId);
      if (entry === undefined) {
        entry = { full: "", listeners: new Set() };
        streams.set(messageId, entry);
      }
      entry.listeners.add(onDelta);
      onDelta(entry.full);
      return () => {
        entry.listeners.delete(onDelta);
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
    async (text: string): Promise<void> => {
      if (activeTurnRef.current !== null || stoppingTurnRef.current !== null) {
        throw new Error("A response is already in progress.");
      }
      setActionError(null);
      let threadId = activeThreadRef.current;
      let migratedDraft: {
        key: string;
        revision: number;
        isSubmittedSnapshot: boolean;
      } | null = null;
      if (threadId === null) {
        const sourceDraftKey = chatDraftKey(surface, scopeId, null);
        const submittedDraftRevision = readChatDraftSnapshot(sourceDraftKey)?.revision ?? null;
        // First message of a new chat: lock in the chosen backend config. A
        // model is required.
        const cfg = draftConfigRef.current;
        if (cfg.model === null || cfg.model === "") {
          setDraftHint("Choose a model to start this chat.");
          throw new Error("Choose a model to start this chat.");
        }
        if (surface === "library" && backendAvailability?.status !== "available") {
          const message =
            backendAvailability?.message ??
            "The configured AI provider is not ready. Retry model discovery before sending.";
          setDraftHint(message);
          throw new Error(message);
        }
        setDraftHint(null);
        const created = await createThread(surface, scopeId, cfg);
        if (!created.ok) {
          setActionError(`Message not sent: ${errorFor(created.error).message}`);
          throw new Error(created.error.message);
        }
        threadId = created.value.threadId;
        const targetDraftKey = chatDraftKey(surface, scopeId, threadId);
        const movedDraft = moveChatDraft(sourceDraftKey, targetDraftKey, text);
        migratedDraft = {
          key: targetDraftKey,
          revision: movedDraft.revision,
          isSubmittedSnapshot: movedDraft.sourceRevision === submittedDraftRevision
        };
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
      const result = await sendMessage(surface, scopeId, threadId, text);
      if (!result.ok) {
        setActionError(`Message not sent: ${errorFor(result.error).message}`);
        throw new Error(result.error.message);
      }
      if (migratedDraft?.isSubmittedSnapshot === true) {
        if (clearChatDraftAtRevision(migratedDraft.key, migratedDraft.revision)) {
          setDraftResetVersion((version) => version + 1);
        }
      }
      if (
        activeThreadRef.current === threadId &&
        !terminalStatusRef.current.has(result.value.turnId)
      ) {
        updateActiveTurn(result.value.turnId);
      }
    },
    [surface, scopeId, backendAvailability, updateActiveTurn, updatePendingChips]
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
      const result = await interruptThread(surface, threadId);
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
  }, [surface, updateStoppingTurn]);

  const onCloseThread = useCallback(async (threadId: string): Promise<void> => {
    const result = await archiveThread(surface, threadId);
    if (!result.ok) {
      setCodexError(errorFor(result.error));
      return;
    }
    const next = threadsRef.current.filter((t) => t.threadId !== threadId);
    setThreads(next);
    if (activeThreadRef.current === threadId) {
      setActiveThreadId(next[0]?.threadId ?? null);
    }
  }, [surface]);

  if (codexError !== null) {
    return (
      <div className="ps-libchat ps-libchat--empty" data-testid={testId}>
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
            void listThreads(surface, scopeId).then((r) => {
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
      <div className="ps-libchat ps-libchat--empty" data-testid={testId}>
        Loading…
      </div>
    );
  }

  const showGreeting = activeThreadId === null;
  const composerDraftKey = chatDraftKey(surface, scopeId, activeThreadId);
  const composerDraft = readChatDraftSnapshot(composerDraftKey);
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
    <div className="ps-libchat" data-testid={testId}>
      <div className="ps-libchat-threads">
        <button
          type="button"
          className="ps-libchat-newchat"
          onClick={() => void onNewChat()}
          title={surface === "library"
            ? "Start a new chat for this capture"
            : "Start a new chat for this reel"}
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
            <div className="ps-libchat-empty-title">
              {surface === "library" ? "PwrSnap chat" : "Reel composer"}
            </div>
            <p className="ps-libchat-empty-body">
              {surface === "library"
                ? "I can edit the capture you’re viewing, redact sensitive data, browse your library, and answer “how do I…”. Pick a provider + model, then type below to start."
                : "Describe the video you want. I can search your library, propose scenes, write narrator scripts, set transitions, and render this reel. Pick a provider + model, then type below to start."}
            </p>
            <NewChatConfigChips
              providers={providers}
              value={draftConfig}
              onChange={surface === "library"
                ? (next) => {
                    setDraftHint(null);
                    // Availability belongs to the provider discovery result,
                    // not to the selected model or reasoning effort. Clearing
                    // it for either of those changes disables an otherwise
                    // ready new-chat composer until discovery happens again.
                    if (next.provider !== draftConfigRef.current.provider) {
                      setBackendAvailability(null);
                    }
                    setDraftConfig(next);
                  }
                : setDraftConfig}
              {...(surface === "library"
                ? { onAvailabilityChange: setBackendAvailability }
                : {})}
            />
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
          key={`${composerDraftKey}:${draftResetVersion}`}
          attachmentsEnabled={false}
          initialText={composerDraft?.text ?? ""}
          initialDraftRevision={composerDraft?.revision ?? null}
          onDraftChange={(text) => writeChatDraft(composerDraftKey, text)}
          onDraftClear={(revision) => {
            clearChatDraftAtRevision(composerDraftKey, revision);
          }}
          onSubmit={onSubmit}
          disabled={
            surface === "library" &&
            showGreeting &&
            backendAvailability?.status !== "available"
          }
          onStop={onStop}
          turnState={
            stoppingTurnId !== null
              ? "stopping"
              : activeTurnId !== null
                ? "active"
                : "idle"
          }
          placeholder={surface === "library"
            ? "Ask PwrSnap to edit, redact, or find…"
            : "Describe your reel or ask for changes…"}
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
