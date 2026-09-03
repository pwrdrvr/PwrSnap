// Zod schemas for the Library Chat substrate. This file is the RUNTIME
// SOURCE OF TRUTH for chat message + thread shapes — `protocol.ts`
// re-exports the inferred types so the type and the validator can never
// drift (mirrors the overlay-schemas.ts ⇄ protocol.ts relationship).
//
// Three surfaces consume these:
//   • main: chat-thread-store keeps thread metadata in the SQLite
//     `chat_threads` index and validates legacy `pwrsnap-thread.json`
//     sidecars against `chatThreadSidecarSchema` when importing them once
//     into that index; the chat-thread-controller re-validates every
//     tool-call payload routed back from Codex.
//   • renderer: the Library chat panel narrows on the discriminated
//     unions to render text / tool-call cards / streaming bubbles.
//   • the command bus: `codex:libraryChat:*` req/res shapes reference
//     these types via protocol.ts.
//
// Two rules this module exists to hold: zod is the source of truth (the
// TypeScript types are inferred from the schemas, never hand-declared
// alongside them), and a sidecar that fails to parse is quarantined
// rather than silently dropped.

import { z } from "zod";

// ---- Message content blocks --------------------------------------------
//
// A single chat message carries one or more content blocks. `text` is
// plain prose; `tool_call` records an agent tool invocation; `tool_result`
// records what the bus returned (or a structured error the agent saw and
// self-corrected from). Streaming + lifecycle state lives on the wrapping
// `ChatMessage.status`, NOT as separate content kinds — keeps the content
// union about *what was said* and the message about *how it's doing*.

export const chatMessageContentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string()
  }),
  z.object({
    kind: z.literal("tool_call"),
    /** The dynamic-tool name as registered with Codex, e.g.
     *  `library_list`. */
    toolName: z.string(),
    /** Stringified JSON of the tool arguments. Stored as a string (not
     *  parsed) so the on-disk shape is stable regardless of the tool's
     *  arg schema; the renderer JSON.parses for display. */
    argsJson: z.string(),
    /** Codex's call id — pairs a tool_call with its tool_result. */
    callId: z.string()
  }),
  z.object({
    kind: z.literal("tool_result"),
    callId: z.string(),
    /** Stringified JSON of the bus Result (or structured error). */
    resultJson: z.string(),
    /** True for tool failures the agent saw and (typically) self-
     *  corrected from. Defaulted (not optional) to dodge the
     *  exactOptionalPropertyTypes construction trap (plan §F2 #2):
     *  builders never have to spread-in `undefined`. */
    isError: z.boolean().default(false)
  })
]);
export type ChatMessageContent = z.infer<typeof chatMessageContentSchema>;

// ---- Message wrapper ---------------------------------------------------

export const chatMessageRoleSchema = z.enum(["user", "assistant", "system"]);
export type ChatMessageRole = z.infer<typeof chatMessageRoleSchema>;

/** Per-message lifecycle. `streaming` = an assistant turn is mid-flight
 *  appending deltas; `failed` = the dispatch errored (Codex unreachable);
 *  `interrupted` = the connection dropped mid-turn (partial deltas kept).
 *  `complete` is the resting state and the parse default so older
 *  on-disk rows normalize cleanly. */
export const chatMessageStatusSchema = z.enum([
  "complete",
  "streaming",
  "failed",
  "interrupted"
]);
export type ChatMessageStatus = z.infer<typeof chatMessageStatusSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  role: chatMessageRoleSchema,
  content: z.array(chatMessageContentSchema),
  status: chatMessageStatusSchema.default("complete"),
  /** ISO-8601. */
  createdAt: z.string(),
  /** Present on assistant messages produced by a grouped AI run, so a
   *  single ⌘Z (or the per-layer ✕ badge) can reverse the whole run.
   *  Matches the `ai_run_id` field on BundleLayerNode. */
  aiRunId: z.string().optional()
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

// ---- Thread metadata (chat_threads index + legacy sidecar) -------------
//
// PwrSnap-owned thread metadata: name / anchor / focus history /
// archive + pin flags. This shape now lives in the SQLite `chat_threads`
// index (migration 0019); the per-turn message journal stays on disk
// under ~/Documents/PwrSnap/Chats/<dir>/. The schema is retained as both
// the `ChatThreadSidecar` domain type the store maps rows to AND the
// validated shape for the one-time import of pre-existing on-disk
// `pwrsnap-thread.json` sidecars. Defaults make older / partial sidecars
// normalize without a schemaVersion bump.

export const chatFocusEntrySchema = z.object({
  captureId: z.string(),
  /** ISO-8601 of when the user focused this capture in this thread. */
  at: z.string()
});
export type ChatFocusEntry = z.infer<typeof chatFocusEntrySchema>;

export const chatThreadSidecarSchema = z.object({
  schemaVersion: z.literal(1),
  /** Codex's ThreadId — the join key to the rollout file. */
  threadId: z.string(),
  /** User-renameable display name. */
  name: z.string(),
  createdAt: z.string(),
  modifiedAt: z.string(),
  /** The capture the thread is currently anchored to, or null when the
   *  user is looking at the Library grid / the anchor was deleted. */
  anchorCaptureId: z.string().nullable().default(null),
  /** Last N focus changes (capped by the store at write time). */
  focusHistory: z.array(chatFocusEntrySchema).default([]),
  archived: z.boolean().default(false),
  pinned: z.boolean().default(false),
  // ---- Per-thread backend config (chosen at New-Chat, locked on first
  // message; migration 0024). NULL = fall back to the surface's Settings
  // default. `provider` is the BACKEND selector ("codex" / "acp:<id>");
  // `reasoning` is the effort/mode token. All nullable so threads created
  // before this feature normalize cleanly.
  provider: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  reasoning: z.string().nullable().default(null),
  /** Authenticated local-agent owner. NULL identifies a human-owned thread. */
  ownerClientId: z.string().nullable().default(null)
});
export type ChatThreadSidecar = z.infer<typeof chatThreadSidecarSchema>;

// ---- Renderer view -----------------------------------------------------
//
// Derived, never parsed-from-disk, so it's a plain type (not a zod
// schema). Built by main from the sidecar + transient turn state. The
// discriminated `status` makes impossible states (streaming AND
// awaiting-approval) unrepresentable (plan §F2 #10).

export type LibraryChatThreadStatus =
  | { kind: "idle" }
  | { kind: "streaming"; turnId: string }
  | { kind: "awaiting_approval"; approvalId: string };

export type LibraryChatThreadView = {
  threadId: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  anchorCaptureId: string | null;
  archived: boolean;
  pinned: boolean;
  /** Short preview of the last message for the thread-list row. */
  lastMessagePreview: string;
  status: LibraryChatThreadStatus;
  /** The thread's locked backend config (NULL until chosen / for legacy
   *  threads). The renderer renders these as the locked Provider / Model /
   *  Reasoning chips once a thread has started. */
  provider: string | null;
  model: string | null;
  reasoning: string | null;
  /** Transient, main-process-owned approval awaiting this thread. This is
   *  replayed from memory when a panel/window remounts; it is deliberately
   *  never persisted because the backend resolver cannot survive app restart. */
  pendingApproval: ChatApprovalRequest | null;
};

// ---- Approval flow -----------------------------------------------------
//
// Codex emits approval ServerRequests mid-turn (sandbox write outside
// the chat dir, shell exec, etc.). The controller surfaces them to the
// renderer; the user resolves. The decision routes back through
// `codex:libraryChat:approval`. Every approval carries (threadId,
// turnId, approvalId) so a late resolution can't land in the wrong
// thread / turn (plan §F10 T3).

export const chatApprovalDecisionSchema = z.enum([
  "approve",
  "reject-layer",
  "reject-run",
  "deny"
]);
export type ChatApprovalDecision = z.infer<typeof chatApprovalDecisionSchema>;

export const CHAT_APPROVAL_ID_MAX_BYTES = 256;
export const CHAT_APPROVAL_SUMMARY_MAX_BYTES = 512;
export const CHAT_APPROVAL_SUMMARY_MAX_LINES = 2;
export const CHAT_APPROVAL_DETAIL_MAX_BYTES = 4_096;
export const CHAT_APPROVAL_DETAIL_MAX_LINES = 32;

// IDs round-trip to an exact backend resolver and therefore cannot be
// modified. Reject non-printing/format characters (including bidi controls),
// line separators, lone surrogates, and values beyond the wire budget.
const unsafeApprovalIdentityCharacter = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const chatApprovalIdentitySchema = z
  .string()
  .min(1)
  .max(CHAT_APPROVAL_ID_MAX_BYTES)
  .refine(
    (value) =>
      !unsafeApprovalIdentityCharacter.test(value) &&
      utf8ByteLength(value) <= CHAT_APPROVAL_ID_MAX_BYTES,
    { message: "approval identity is unsafe or too large" }
  );

/** Strict renderer/MCP → main response envelope. Runtime validation matters:
 *  an unknown decision must never fall through the protocol mapper as deny,
 *  and empty/mistyped ids must never enter the exact-request broker. */
export const chatApprovalResponseSchema = z.object({
  threadId: chatApprovalIdentitySchema,
  turnId: chatApprovalIdentitySchema,
  approvalId: chatApprovalIdentitySchema,
  decision: chatApprovalDecisionSchema
}).strict();
export type ChatApprovalResponse = z.infer<typeof chatApprovalResponseSchema>;

export type ChatApprovalRequest = {
  threadId: string;
  turnId: string;
  approvalId: string;
  /** Human-readable summary of what the agent wants to do. */
  summary: string;
  /** Optional longer detail (command text, file path, layer count). */
  detail?: string;
};

const chatApprovalRequestInputSchema = z.object({
  threadId: chatApprovalIdentitySchema,
  turnId: chatApprovalIdentitySchema,
  approvalId: chatApprovalIdentitySchema,
  summary: z.string(),
  detail: z.string().optional()
}).strict();

/** Parse the only approval payload allowed to cross into the broker/renderer.
 *  Exact IDs are rejected rather than rewritten; display text is stripped of
 *  control/format/bidi characters and prefix-bounded by UTF-8 bytes + lines.
 *  This preserves the existing summary/detail-only chat disclosure policy. */
export function parseChatApprovalRequest(input: unknown): ChatApprovalRequest | null {
  const parsed = chatApprovalRequestInputSchema.safeParse(input);
  if (!parsed.success) return null;

  const summary = sanitizeApprovalDisplayText(
    parsed.data.summary,
    CHAT_APPROVAL_SUMMARY_MAX_BYTES,
    CHAT_APPROVAL_SUMMARY_MAX_LINES
  );
  const detail = parsed.data.detail === undefined
    ? ""
    : sanitizeApprovalDisplayText(
        parsed.data.detail,
        CHAT_APPROVAL_DETAIL_MAX_BYTES,
        CHAT_APPROVAL_DETAIL_MAX_LINES
      );
  return {
    threadId: parsed.data.threadId,
    turnId: parsed.data.turnId,
    approvalId: parsed.data.approvalId,
    summary: summary.length > 0 ? summary : "Approval requested",
    ...(detail.length > 0 ? { detail } : {})
  };
}

function sanitizeApprovalDisplayText(
  value: string,
  maxBytes: number,
  maxLines: number
): string {
  // Bound work as well as output when a backend sends a hostile huge value.
  // Eight UTF-16 code units per output byte leaves ample room for stripped
  // controls while preventing an unbounded normalization/allocation pass.
  const boundedInput = value.slice(0, maxBytes * 8).normalize("NFC");
  let output = "";
  let bytes = 0;
  let lines = 1;

  for (let index = 0; index < boundedInput.length;) {
    let codePoint = boundedInput.codePointAt(index)!;
    let character = String.fromCodePoint(codePoint);
    index += character.length;

    // Normalize every supported line separator before applying the line cap.
    if (codePoint === 0x0d) {
      if (boundedInput.codePointAt(index) === 0x0a) index += 1;
      codePoint = 0x0a;
      character = "\n";
    } else if (codePoint === 0x2028 || codePoint === 0x2029) {
      codePoint = 0x0a;
      character = "\n";
    }

    if (codePoint === 0x0a) {
      if (lines >= maxLines || bytes + 1 > maxBytes) break;
      output += "\n";
      bytes += 1;
      lines += 1;
      continue;
    }
    if (unsafeApprovalIdentityCharacter.test(character)) continue;

    const characterBytes = utf8CodePointBytes(codePoint);
    if (bytes + characterBytes > maxBytes) break;
    output += character;
    bytes += characterBytes;
  }

  return output.trim();
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    bytes += utf8CodePointBytes(character.codePointAt(0)!);
  }
  return bytes;
}

function utf8CodePointBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/** Main acknowledged an exact approval response. Every eligible window sees
 *  this terminal event so a response in one surface clears the others. */
export type ChatApprovalResolvedEvent = {
  threadId: string;
  turnId: string;
  approvalId: string;
  decision: ChatApprovalDecision;
};

/** An exact pending request can no longer be answered. No response from a
 *  stale renderer may be applied to a later turn/request. */
export type ChatApprovalSupersededEvent = {
  threadId: string;
  turnId: string;
  approvalId: string;
  reason:
    | "request_replaced"
    | "request_stale"
    | "thread_closed"
    | "controller_disposed";
};

// Drawing shapes are modeled as one tool PER primitive (draw_arrow,
// draw_text, draw_highlight, draw_rect — and draw_circle / draw_oval /
// draw_square / draw_triangle as they ship) rather than a single
// polymorphic tool taking a discriminated `shape` union. Models pick a
// named tool more reliably than they populate a discriminated-union
// arg, and each tool exposes only its own flat settings. The tool arg
// schemas live with the tools (apps/desktop/.../ai/library-tool-
// allowlist.ts), so there's no shared shape union here.
