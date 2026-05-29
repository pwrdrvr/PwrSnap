// MessageList — the shared streaming message-list primitive for every
// PwrSnap chat surface (Library DetailRail chat, editor chat). Pure
// presentational: props in, callbacks out, NO bus / IPC wiring. The
// parent owns the delta source (a Codex turn) and the message log; this
// component is responsible only for rendering them performantly.
//
// The load-bearing design constraint is HIGH-FREQUENCY STREAMING without
// O(n²) re-renders. A naive implementation re-renders the whole list on
// every token delta — at hundreds of deltas per turn over a growing
// transcript that's quadratic and janks. We avoid it with two moves:
//
//   1. The streaming message is rendered by a SEPARATE child component
//      (`StreamingBubble`) that owns its own local state. It subscribes
//      to deltas via `subscribeToStream`, buffers the latest full text in
//      a ref, and flushes to local state at most ONCE PER FRAME via
//      requestAnimationFrame. The static list above it never re-renders
//      while tokens stream — only the streaming bubble does. We further
//      run the buffered text through `useDeferredValue` so React can
//      interrupt / coalesce the bubble's own renders under load.
//
//   2. Every message bubble carries `contain: layout` (see MessageList.css)
//      so a streaming bubble growing at the bottom can't force a layout
//      recalculation of the completed bubbles above it.
//
// Content safety: text blocks render as PLAIN TEXT (React escapes by
// default — never dangerouslySetInnerHTML). Per plan §F4 M5 a model that
// emits `<img src=x onerror=...>` must render as literal characters.
//
// Sticky-bottom-only-if-at-bottom: we auto-scroll to the latest content
// ONLY when the user is already within ~64px of the bottom. If they've
// scrolled up to read history we never yank them down; instead a
// "Jump to latest ↓" affordance appears.

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from "react";
import type {
  ChatMessage,
  ChatMessageContent,
  ChatMessageStatus
} from "@pwrsnap/shared";
import "./MessageList.css";

/** A friendly, present-tense record of one tool the agent ran this turn
 *  ("Looked at the canvas", "Drew an arrow"). Rendered as a small chip in
 *  the transcript flow — distinct from the technical `tool_call` content
 *  cards. Kept in the parent's session state so it persists after the
 *  turn finishes. */
export interface ChatActivityChip {
  readonly callId: string;
  readonly summary: string;
  readonly ok: boolean;
}

export interface MessageListProps {
  readonly messages: readonly ChatMessage[];
  /** The id of the message currently streaming, if any. */
  readonly streamingMessageId?: string | null;
  /** Tool-activity chips to render INLINE, above each message's bubble,
   *  keyed by message id. These are the agent's actions for the turn that
   *  produced that message — they live in the transcript flow (not a
   *  fixed bar) and persist for the session. */
  readonly activityByMessageId?: Readonly<Record<string, readonly ChatActivityChip[]>>;
  /** Activity for the IN-FLIGHT turn whose assistant message doesn't
   *  exist yet (the agent is running tools before producing text), plus
   *  the "Thinking…" state. Rendered after the last message — i.e. where
   *  the next message will appear. */
  readonly trailingActivity?: {
    readonly chips: readonly ChatActivityChip[];
    readonly thinking: boolean;
  } | null;
  /** Subscribe to streaming deltas for the streaming message. The parent
   *  owns the delta source; MessageList coalesces via rAF. The callback
   *  receives the FULL accumulated text each delta (not an incremental
   *  chunk). Returns an unsubscribe fn. */
  readonly subscribeToStream?: (
    messageId: string,
    onDelta: (fullText: string) => void
  ) => () => void;
  /** Per-layer reject affordance during an open AI run (optional). When
   *  provided, assistant messages carrying an `aiRunId` show a small
   *  "Reject run" control wired to this callback. */
  readonly onRejectAiRun?: (aiRunId: string) => void;
  /** Retry a `failed` message (optional). */
  readonly onRetry?: (messageId: string) => void;
  /** Test-id prefix. Defaults to `message-list`. */
  readonly testIdPrefix?: string;
}

/** How close (px) to the bottom the user must be for new content to
 *  auto-scroll. Above this gap we show the "Jump to latest" pill instead. */
const STICK_THRESHOLD_PX = 64;

export function MessageList(props: MessageListProps): ReactElement {
  const {
    messages,
    streamingMessageId = null,
    activityByMessageId,
    trailingActivity = null,
    subscribeToStream,
    onRejectAiRun,
    onRetry,
    testIdPrefix = "message-list"
  } = props;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // True while the viewport is pinned to the bottom. Drives whether new
  // content auto-scrolls. Starts true (fresh thread shows latest).
  const atBottomRef = useRef<boolean>(true);
  const [atBottom, setAtBottom] = useState<boolean>(true);

  const measureAtBottom = useCallback((): boolean => {
    const el = scrollRef.current;
    if (el === null) return true;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distance <= STICK_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const handleScroll = useCallback((): void => {
    const next = measureAtBottom();
    if (next !== atBottomRef.current) {
      atBottomRef.current = next;
      setAtBottom(next);
    }
  }, [measureAtBottom]);

  // On new messages (count change) — or new trailing activity — auto-
  // scroll only if we were pinned. Reads the ref, not the state, so we
  // react to the freshest position.
  const trailingSig = trailingActivity
    ? `${trailingActivity.chips.length}:${trailingActivity.thinking ? 1 : 0}`
    : "";
  useLayoutEffect(() => {
    if (atBottomRef.current) {
      scrollToBottom();
    }
  }, [messages.length, trailingSig, scrollToBottom]);

  // Called by the streaming bubble after each rAF flush so the viewport
  // tracks growing streamed content — but only while pinned.
  const handleStreamGrow = useCallback((): void => {
    if (atBottomRef.current) {
      scrollToBottom();
    }
  }, [scrollToBottom]);

  const jumpToLatest = useCallback((): void => {
    scrollToBottom();
    atBottomRef.current = true;
    setAtBottom(true);
  }, [scrollToBottom]);

  // Match tool_result blocks to their tool_call by callId across the
  // ENTIRE transcript. A tool_result can arrive in a later message than
  // its call (the agent calls, the bus replies on the next turn frame),
  // so we build one flat index rather than matching within a message.
  const resultsByCallId = useMemo(() => {
    const map = new Map<string, ToolResultBlock>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.kind === "tool_result") {
          map.set(block.callId, block);
        }
      }
    }
    return map;
  }, [messages]);

  return (
    <div
      className="ml"
      data-testid={testIdPrefix}
    >
      <div
        ref={scrollRef}
        className="ml__scroll"
        onScroll={handleScroll}
        data-testid={`${testIdPrefix}-scroll`}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {messages.map((message) => {
          const isStreaming =
            message.status === "streaming" &&
            streamingMessageId === message.id;
          return (
            <MessageBubble
              key={message.id}
              message={message}
              isStreaming={isStreaming}
              activity={activityByMessageId?.[message.id]}
              resultsByCallId={resultsByCallId}
              subscribeToStream={subscribeToStream}
              onStreamGrow={handleStreamGrow}
              onRejectAiRun={onRejectAiRun}
              onRetry={onRetry}
              testIdPrefix={testIdPrefix}
            />
          );
        })}

        {trailingActivity !== null &&
          (trailingActivity.chips.length > 0 || trailingActivity.thinking) && (
            <div
              className="ml__msg ml__msg--assistant ml__msg--pending"
              data-testid={`${testIdPrefix}-pending`}
            >
              <div className="ml__bubble">
                <ActivityChips chips={trailingActivity.chips} testIdPrefix={testIdPrefix} />
                {trailingActivity.thinking && (
                  <div className="ml__thinking" aria-live="polite">
                    <span className="ml__thinking-dot" aria-hidden="true" />
                    Thinking…
                  </div>
                )}
              </div>
            </div>
          )}
      </div>

      {!atBottom && (
        <button
          type="button"
          className="ml__jump"
          onClick={jumpToLatest}
          data-testid={`${testIdPrefix}-jump`}
        >
          Jump to latest
          <span className="ml__jump-arrow" aria-hidden="true">
            ↓
          </span>
        </button>
      )}
    </div>
  );
}

type ToolResultBlock = Extract<ChatMessageContent, { kind: "tool_result" }>;
type ToolCallBlock = Extract<ChatMessageContent, { kind: "tool_call" }>;

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming: boolean;
  activity: readonly ChatActivityChip[] | undefined;
  resultsByCallId: Map<string, ToolResultBlock>;
  subscribeToStream:
    | ((messageId: string, onDelta: (fullText: string) => void) => () => void)
    | undefined;
  onStreamGrow: () => void;
  onRejectAiRun: ((aiRunId: string) => void) | undefined;
  onRetry: ((messageId: string) => void) | undefined;
  testIdPrefix: string;
}

// Memoized so a completed bubble never re-renders while a later bubble
// streams. The streaming bubble is the ONLY child that re-renders per
// frame; its own internal state (not props) drives that, so this memo
// boundary holds even as the parent's `messages` array identity is stable.
const MessageBubble = memo(function MessageBubble(
  props: MessageBubbleProps
): ReactElement {
  const {
    message,
    isStreaming,
    activity,
    resultsByCallId,
    subscribeToStream,
    onStreamGrow,
    onRejectAiRun,
    onRetry,
    testIdPrefix
  } = props;

  const roleClass = `ml__msg ml__msg--${message.role}`;

  return (
    <div
      className={roleClass}
      data-testid={`${testIdPrefix}-msg-${message.id}`}
      data-role={message.role}
      data-status={message.status}
    >
      <div className="ml__bubble">
        {activity !== undefined && (
          <ActivityChips chips={activity} testIdPrefix={testIdPrefix} />
        )}
        {message.content.map((block, index) => (
          <ContentBlock
            // Content blocks are positional + immutable per message; index
            // is a stable key here (we never reorder/splice within a msg).
            key={`${message.id}:${index}`}
            block={block}
            resultsByCallId={resultsByCallId}
            testIdPrefix={testIdPrefix}
          />
        ))}

        {isStreaming && subscribeToStream !== undefined && (
          <StreamingBubble
            messageId={message.id}
            subscribeToStream={subscribeToStream}
            onGrow={onStreamGrow}
            testIdPrefix={testIdPrefix}
          />
        )}

        <StatusFooter
          status={message.status}
          messageId={message.id}
          aiRunId={message.aiRunId}
          onRejectAiRun={onRejectAiRun}
          onRetry={onRetry}
          testIdPrefix={testIdPrefix}
        />
      </div>
    </div>
  );
});

/** Friendly tool-activity chips ("Looked at the canvas", "Drew an
 *  arrow") rendered in the transcript flow. Presentational only. */
function ActivityChips({
  chips,
  testIdPrefix
}: {
  chips: readonly ChatActivityChip[];
  testIdPrefix: string;
}): ReactElement | null {
  if (chips.length === 0) return null;
  return (
    <div className="ml__activity" data-testid={`${testIdPrefix}-activity`}>
      {chips.map((chip) => (
        <span
          key={chip.callId}
          className={`ml__chip${chip.ok ? "" : " is-error"}`}
          data-testid={`${testIdPrefix}-chip`}
        >
          <span className="ml__chip-dot" aria-hidden="true" />
          {chip.summary}
        </span>
      ))}
    </div>
  );
}

interface ContentBlockProps {
  block: ChatMessageContent;
  resultsByCallId: Map<string, ToolResultBlock>;
  testIdPrefix: string;
}

function ContentBlock({
  block,
  resultsByCallId,
  testIdPrefix
}: ContentBlockProps): ReactElement | null {
  if (block.kind === "text") {
    // PLAIN TEXT. React escapes children by default — `<img ...>` renders
    // as literal characters. Never dangerouslySetInnerHTML here.
    return (
      <p className="ml__text" data-testid={`${testIdPrefix}-text`}>
        {block.text}
      </p>
    );
  }
  if (block.kind === "tool_call") {
    const result = resultsByCallId.get(block.callId);
    return (
      <ToolCard
        call={block}
        result={result}
        testIdPrefix={testIdPrefix}
      />
    );
  }
  // tool_result blocks fold into their matching tool_call card; never
  // rendered standalone.
  return null;
}

interface ToolCardProps {
  call: ToolCallBlock;
  result: ToolResultBlock | undefined;
  testIdPrefix: string;
}

type ToolCardState = "in_progress" | "success" | "error";

function ToolCard({ call, result, testIdPrefix }: ToolCardProps): ReactElement {
  const [open, setOpen] = useState<boolean>(false);

  const state: ToolCardState =
    result === undefined
      ? "in_progress"
      : result.isError
        ? "error"
        : "success";

  const prettyArgs = useMemo(() => prettyJson(call.argsJson), [call.argsJson]);
  const prettyResult = useMemo(
    () => (result !== undefined ? prettyJson(result.resultJson) : null),
    [result]
  );

  return (
    <div
      className={`ml__tool ml__tool--${state}`}
      data-testid={`${testIdPrefix}-tool-${call.callId}`}
      data-state={state}
    >
      <button
        type="button"
        className="ml__tool-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid={`${testIdPrefix}-tool-toggle-${call.callId}`}
      >
        <span
          className={`ml__tool-tri${open ? " is-open" : ""}`}
          aria-hidden="true"
        >
          ▸
        </span>
        <span className="ml__tool-name">{call.toolName}</span>
        <span className="ml__tool-state" aria-hidden="true">
          {state === "in_progress" && (
            <span className="ml__spinner" data-testid={`${testIdPrefix}-tool-spinner`} />
          )}
          {state === "success" && <span className="ml__tool-ok">✓</span>}
          {state === "error" && <span className="ml__tool-err">✕</span>}
        </span>
      </button>

      {open && (
        <div className="ml__tool-body">
          <div className="ml__tool-section">
            <span className="ml__tool-label">Arguments</span>
            <pre className="ml__code" data-testid={`${testIdPrefix}-tool-args-${call.callId}`}>
              {prettyArgs}
            </pre>
          </div>
          {prettyResult !== null && (
            <div className="ml__tool-section">
              <span className="ml__tool-label">
                {state === "error" ? "Error" : "Result"}
              </span>
              <pre
                className="ml__code"
                data-testid={`${testIdPrefix}-tool-result-${call.callId}`}
              >
                {prettyResult}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Pretty-print a stringified-JSON arg/result for display. Falls back to
// the raw string when it isn't valid JSON (e.g. a partial stream snapshot)
// so we never throw at render time.
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

interface StreamingBubbleProps {
  messageId: string;
  subscribeToStream: (
    messageId: string,
    onDelta: (fullText: string) => void
  ) => () => void;
  onGrow: () => void;
  testIdPrefix: string;
}

// The ONLY component that re-renders per streamed delta. It subscribes to
// the parent's delta source, buffers the latest full text in a ref, and
// flushes that ref into local state on a SINGLE requestAnimationFrame per
// frame (coalescing a burst of deltas into one paint). `useDeferredValue`
// lets React further de-prioritize the bubble's own render under load.
function StreamingBubble({
  messageId,
  subscribeToStream,
  onGrow,
  testIdPrefix
}: StreamingBubbleProps): ReactElement {
  const [text, setText] = useState<string>("");

  // Latest full text seen from the delta source, awaiting a flush.
  const bufferRef = useRef<string>("");
  // Pending rAF handle (null = none scheduled).
  const rafRef = useRef<number | null>(null);
  // Set on unmount so a late rAF / late delta becomes a no-op.
  const canceledRef = useRef<boolean>(false);
  // Keep the latest onGrow without re-subscribing when it changes identity.
  const onGrowRef = useRef(onGrow);
  onGrowRef.current = onGrow;

  useEffect(() => {
    canceledRef.current = false;

    const flush = (): void => {
      rafRef.current = null;
      if (canceledRef.current) return;
      setText(bufferRef.current);
      // Let the list keep the viewport pinned as content grows.
      onGrowRef.current();
    };

    const onDelta = (fullText: string): void => {
      if (canceledRef.current) return;
      bufferRef.current = fullText;
      // At most one flush scheduled per frame — coalesces a delta burst.
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flush);
      }
    };

    const unsubscribe = subscribeToStream(messageId, onDelta);

    return () => {
      canceledRef.current = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      unsubscribe();
    };
  }, [messageId, subscribeToStream]);

  // Deferred so React can interrupt/coalesce the bubble's own renders when
  // deltas outpace paints.
  const deferred = useDeferredValue(text);

  return (
    <p
      className="ml__text ml__text--streaming"
      data-testid={`${testIdPrefix}-streaming`}
      aria-live="polite"
    >
      {deferred}
      <span className="ml__caret" aria-hidden="true" />
    </p>
  );
}

interface StatusFooterProps {
  status: ChatMessageStatus;
  messageId: string;
  aiRunId: string | undefined;
  onRejectAiRun: ((aiRunId: string) => void) | undefined;
  onRetry: ((messageId: string) => void) | undefined;
  testIdPrefix: string;
}

function StatusFooter({
  status,
  messageId,
  aiRunId,
  onRejectAiRun,
  onRetry,
  testIdPrefix
}: StatusFooterProps): ReactNode {
  const showReject =
    aiRunId !== undefined &&
    aiRunId !== "" &&
    onRejectAiRun !== undefined &&
    status !== "failed";

  if (status === "failed") {
    return (
      <div className="ml__status ml__status--failed">
        <span className="ml__status-text">Failed</span>
        {onRetry !== undefined && (
          <button
            type="button"
            className="ml__retry"
            onClick={() => onRetry(messageId)}
            data-testid={`${testIdPrefix}-retry-${messageId}`}
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (status === "interrupted") {
    return (
      <div
        className="ml__status ml__status--interrupted"
        data-testid={`${testIdPrefix}-interrupted-${messageId}`}
      >
        <span className="ml__status-text">Interrupted</span>
      </div>
    );
  }

  if (showReject) {
    return (
      <div className="ml__status ml__status--run">
        <button
          type="button"
          className="ml__reject-run"
          onClick={() => onRejectAiRun(aiRunId)}
          data-testid={`${testIdPrefix}-reject-run-${aiRunId}`}
        >
          Reject run
        </button>
      </div>
    );
  }

  return null;
}
