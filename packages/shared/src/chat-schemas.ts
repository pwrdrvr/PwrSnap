// Zod schemas for the Library Chat substrate. This file is the RUNTIME
// SOURCE OF TRUTH for chat message + thread shapes — `protocol.ts`
// re-exports the inferred types so the type and the validator can never
// drift (mirrors the overlay-schemas.ts ⇄ protocol.ts relationship).
//
// Three surfaces consume these:
//   • main: chat-thread-store validates `pwrsnap-thread.json` on read
//     (corrupt → quarantine, never crash) and the chat-thread-controller
//     re-validates every tool-call payload routed back from Codex.
//   • renderer: the Library chat panel narrows on the discriminated
//     unions to render text / tool-call cards / streaming bubbles.
//   • the command bus: `codex:libraryChat:*` req/res shapes reference
//     these types via protocol.ts.
//
// See docs/plans/2026-05-28-001-feat-library-chat-editor-interface-plan.md
// §F2 (TypeScript hygiene — zod-first source of truth) + §F9 (data
// integrity — corrupt sidecar quarantines).

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

// ---- Thread sidecar (pwrsnap-thread.json) ------------------------------
//
// PwrSnap-owned metadata that travels next to Codex's own rollout file
// under ~/Documents/PwrSnap/Chats/<thread-dir>/. Codex owns the message
// log (rollout); we own name / anchor / focus history / archive+pin
// flags. Defaults make older / partial sidecars normalize without a
// schemaVersion bump.

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
  pinned: z.boolean().default(false)
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

export type ChatApprovalRequest = {
  threadId: string;
  turnId: string;
  approvalId: string;
  /** Human-readable summary of what the agent wants to do. */
  summary: string;
  /** Optional longer detail (command text, file path, layer count). */
  detail?: string;
};

// ---- Region shapes (redaction, future shape annotations) ---------------
//
// A geometric region the agent can target. A DISCRIMINATED UNION on
// `type` so new shapes (circle / oval / square / triangle) slot in
// later as additional members WITHOUT a breaking change to the tool
// protocol — adding a member is backward-compatible. Today the only
// member is `rect`; that's intentional (the underlying EffectLayer
// clip is rectangular). When a non-rect region ships, add its member
// here AND teach the dispatch + the layer model how to clip it.
//
// All coordinates are NORMALIZED to [0,1] of the capture's canvas:
// (x, y) is the top-left corner, (w, h) the size. Resolution-
// independent — the tool dispatch multiplies by the capture's pixel
// dimensions at use time.

export const regionRectSchema = z.object({
  type: z.literal("rect"),
  /** Left edge, normalized [0,1]. */
  x: z.number().min(0).max(1),
  /** Top edge, normalized [0,1]. */
  y: z.number().min(0).max(1),
  /** Width, normalized [0,1]. */
  w: z.number().min(0).max(1),
  /** Height, normalized [0,1]. */
  h: z.number().min(0).max(1)
});

/** Extensible region shape. One member (`rect`) today; circle / oval /
 *  square / triangle are planned additions (member-only changes). */
export const regionShapeSchema = z.discriminatedUnion("type", [
  regionRectSchema
  // soon: regionCircleSchema { type:"circle", cx, cy, r },
  //       regionOvalSchema, regionTriangleSchema, …
]);
export type RegionShape = z.infer<typeof regionShapeSchema>;
