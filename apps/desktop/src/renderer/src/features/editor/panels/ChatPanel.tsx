// ChatPanel — right-sidebar surface for the upcoming Codex
// dynamic-tools wiring ("delete that arrow", "make all arrows blue
// and Large"). This component is the SURFACE; the IPC ↔ Codex App
// Server plumbing lands in a follow-up. For now we render the
// context chip + a static welcome card + a fully wired local-only
// composer so the surface looks real, behaves real, and has a
// place for the dynamic-tools branch to land into.
//
// Data shape:
//
//   • Context chip:  reads the same `library:byId` + bundle layer
//     count surface that InfoPanel uses, no new IPC verbs.
//   • Messages:      local-only state today. The composer's Send
//     pushes a user message + a placeholder "Codex will land in a
//     follow-up — your prompt is logged for context." response so
//     the Send button has a visible effect. When the dynamic-tools
//     IPC lands, the placeholder response branch is replaced with
//     a real Codex turn.
//   • Composer:      textarea + Send. Enter sends; ⇧Enter inserts
//     a newline. Empty + whitespace-only sends are ignored.
//
// Why we ship this now (vs. waiting for the IPC):
//   • The right-sidebar refresh exposes a Chat tab; without a real
//     panel the user sees "available in Phase 7" forever.
//   • Wiring the composer + message list locally locks the surface
//     contract in (props, IDs, scroll behavior) so the IPC PR is a
//     plumbing-only change.

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
  type CaptureEnrichment,
  type CaptureRecord
} from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../../lib/pwrsnap";

export interface ChatPanelProps {
  captureId: string;
}

interface ChatMessage {
  id: string;
  author: "you" | "codex";
  body: string;
  ts: string;
  /** Model badge for codex responses ("codex" itself isn't enough —
   *  power users care which tier wrote the response). Unused for
   *  "you" rows. */
  model?: string;
}

interface ContextSummary {
  layerCount: number;
  widthPx: number;
  heightPx: number;
  /** OCR text preview, when available. Surfaces in the chat context
   *  chip area as a small "OCR ready" pill so the user can see Codex
   *  has the page text to work with. */
  hasOcr: boolean;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; record: CaptureRecord; context: ContextSummary }
  | { kind: "error"; message: string };

const COMPOSER_PLACEHOLDER =
  'reply to codex — e.g. "make all arrows orange", "delete the last one"';

const WELCOME_BODY =
  "Chat lives next to the canvas so Codex can act on layers. Once dynamic tools are wired, ask things like \"add an arrow pointing at Send\" or \"make all arrows orange and Large\" and your edits stick.";

/** Sentinel rendered in the Codex message header until the real
 *  dynamic-tools IPC lands. The IPC PR replaces every `MODEL_PLACEHOLDER`
 *  call site with the actual model id returned by the turn (e.g.
 *  `haiku-4.5`). Centralizing the literal here makes that swap a
 *  one-line grep. */
const MODEL_PLACEHOLDER = "pending";

export function ChatPanel({ captureId }: ChatPanelProps): ReactElement {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState<string>("");
  const listRef = useRef<HTMLDivElement | null>(null);

  // Capture + layer-count fetch.
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    setMessages([]); // reset between captures

    const refetch = async (): Promise<void> => {
      const recordResult = await dispatch("library:byId", { id: captureId });
      if (cancelled) return;
      if (!recordResult.ok) {
        setState({ kind: "error", message: recordResult.error.message });
        return;
      }
      const record = recordResult.value;
      if (record === null || record === undefined) {
        setState({
          kind: "error",
          message: `capture not found: ${captureId}`
        });
        return;
      }
      // Layer count: v2 only — read via `layers:list` and count the
      // BundleLayerNode array; v1 captures (and test fixtures that
      // don't carry `bundle_format_version`) fall back to 0.
      let layerCount = 0;
      const fmt = record.bundle_format_version ?? 1;
      if (fmt >= 2) {
        const layersResult = await dispatch("layers:list", { captureId });
        if (cancelled) return;
        if (layersResult.ok) {
          layerCount = layersResult.value.length;
        }
      }
      // OCR readiness — surfaced as a chip so the user sees "Codex has
      // the page text" at a glance. Failure to fetch enrichment is
      // non-fatal; we just hide the chip.
      const enrichmentResult = await dispatch("codex:enrichment", { captureId });
      if (cancelled) return;
      const hasOcr =
        enrichmentResult.ok &&
        ((enrichmentResult.value as CaptureEnrichment | null)?.ocrText ?? "")
          .trim().length > 0;
      setState({
        kind: "loaded",
        record,
        context: {
          layerCount,
          widthPx: record.width_px,
          heightPx: record.height_px,
          hasOcr
        }
      });
    };

    void refetch();
    const unsubscribe = subscribe(EVENT_CHANNELS.capturesChanged, () => {
      void refetch();
    });
    return (): void => {
      cancelled = true;
      unsubscribe();
    };
  }, [captureId]);

  // Auto-scroll to the bottom when a new message lands.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = useCallback((): void => {
    const body = draft.trim();
    if (body.length === 0) return;
    const now = new Date();
    const ts = formatClock(now);
    const userMsg: ChatMessage = {
      id: `u-${now.getTime()}`,
      author: "you",
      body,
      ts
    };
    // Local placeholder response — replaced by a real Codex turn
    // when the dynamic-tools IPC lands. Wired today so the Send
    // button has a visible effect and the layout proves out.
    const codexMsg: ChatMessage = {
      id: `c-${now.getTime() + 1}`,
      author: "codex",
      body:
        "Dynamic tools aren't wired to Codex yet — your prompt is queued for when this connects. Use the toolbar to keep editing in the meantime.",
      ts,
      model: MODEL_PLACEHOLDER
    };
    setMessages((prev) => [...prev, userMsg, codexMsg]);
    setDraft("");
  }, [draft]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter") return;
    if (event.shiftKey) return;
    event.preventDefault();
    send();
  };

  if (state.kind === "loading") {
    return (
      <div className="pse-chat" data-testid="chat-panel">
        <h3 className="pse-chat-title">Chat with Codex</h3>
        <div className="pse-info-loading" role="status">
          Loading…
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="pse-chat" data-testid="chat-panel">
        <h3 className="pse-chat-title">Chat with Codex</h3>
        <div className="pse-info-error" role="status">
          Couldn&apos;t load capture context.
        </div>
      </div>
    );
  }

  const { context } = state;
  return (
    <div className="pse-chat" data-testid="chat-panel">
      <h3 className="pse-chat-title">Chat with Codex</h3>

      <div className="pse-chat-context" data-testid="chat-context">
        <span className="pse-chat-context-chip">
          context · 1 capture · {context.layerCount}{" "}
          {context.layerCount === 1 ? "layer" : "layers"} · {context.widthPx}×
          {context.heightPx}
        </span>
        {context.hasOcr ? (
          <span
            className="pse-chat-context-chip is-ocr"
            data-testid="chat-context-ocr-chip"
            title="Codex sees the OCR-extracted text from this capture"
          >
            OCR
          </span>
        ) : null}
      </div>

      <div className="pse-chat-list" ref={listRef} data-testid="chat-list">
        {messages.length === 0 ? (
          <div className="pse-chat-welcome" role="note">
            <div className="pse-chat-welcome-eyebrow">Dynamic tools — preview</div>
            <p className="pse-chat-welcome-body">{WELCOME_BODY}</p>
          </div>
        ) : (
          messages.map((m) => (
            <ChatMessageRow key={m.id} message={m} />
          ))
        )}
      </div>

      <div className="pse-chat-composer">
        <textarea
          className="pse-chat-input"
          value={draft}
          placeholder={COMPOSER_PLACEHOLDER}
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          data-testid="chat-input"
        />
        <div className="pse-chat-composer-row">
          <span className="pse-chat-composer-meta" aria-hidden="true">
            ⏎ send · ⇧⏎ newline
          </span>
          <button
            type="button"
            className="pse-chat-send"
            onClick={send}
            disabled={draft.trim().length === 0}
            data-testid="chat-send"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatMessageRow({ message }: { message: ChatMessage }): ReactElement {
  const isYou = message.author === "you";
  return (
    <div
      className={"pse-chat-msg" + (isYou ? " is-you" : " is-codex")}
      data-testid={isYou ? "chat-msg-you" : "chat-msg-codex"}
    >
      <div className="pse-chat-msg-hdr">
        <span className="pse-chat-msg-author">
          {isYou ? "you" : "codex"}
        </span>
        {!isYou && message.model !== undefined ? (
          <span className="pse-chat-msg-model">{message.model}</span>
        ) : null}
        <span className="pse-chat-msg-ts">{message.ts}</span>
      </div>
      <p className="pse-chat-msg-body">{message.body}</p>
    </div>
  );
}

function formatClock(d: Date): string {
  const hour = d.getHours();
  const min = d.getMinutes();
  const hr12 = ((hour + 11) % 12) + 1;
  const ampm = hour >= 12 ? "PM" : "AM";
  return `${hr12}:${min.toString().padStart(2, "0")} ${ampm}`;
}
