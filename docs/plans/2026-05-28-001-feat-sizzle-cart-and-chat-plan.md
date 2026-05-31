# Sizzle Reels — Cart + Agent Chat — Plan

**Status:** plan only; no implementation yet. Three-PR sequence
proposed below.

The existing Sizzle Reels work (PR #124 MVP + PR #130 Phase 2+3a) is
the substrate this plan builds on — same on-disk format, same composer,
same Codex App Server connection. See
[2026-05-26-001-feat-sizzle-reels-plan.md](./2026-05-26-001-feat-sizzle-reels-plan.md)
for the shipped state.

This plan adds three connected capabilities, deepest-dependency first:

1. **Substrate** — single-shot bus surface for fetching capture records
   bundled with AI enrichment + OCR. Required by the agent's tools so
   it can search the library and reason about captures without an N+1
   fan-out of `library:byId` + `codex:enrichment` calls. Standalone
   refactor with no UI footprint.
2. **Project Asset Cart** — right-rail cart in the Library that collects
   captures via hover-revealed checkboxes, lets the user reorder/remove
   items, and terminates in **Create new Sizzle Reel** or **Add to
   existing Reel**. Standalone UX win without any AI dependency; ships
   the "good Add Scene picker" the existing in-composer modal couldn't.
3. **Sizzle Composer Chat** — per-project Codex agent that can search
   the library, propose scene lists, write per-scene scripts, set
   transitions, and kick off renders. Default Access (sandboxed) with
   inline per-request approval relay when the agent wants to escalate.
   This is the 🔥 piece — but PRs 1+2 derisk it.

## Source of inputs + prior art

- **PwrAgnt's Codex App Server integration** at
  `~/github/PwrAgnt`. PwrAgnt is the canonical reference
  for the multi-turn chat shape, the approval relay over JSON-RPC
  server-initiated requests, the scratch-directory pattern, and the
  inline transcript UI. We mirror its substrate but not its specifics
  (PwrAgnt is messaging-driven; PwrSnap is media-driven).
- **PwrSnap's existing Codex client** at
  `apps/desktop/src/main/ai/codex-client.ts`. Today it's enrichment-
  only — single-shot turns against ephemeral threads with no
  tool-call dispatch. Extending it to support persistent multi-turn
  threads + dynamic tools is the load-bearing refactor for PR-3.
- **Existing ChatPanel** at
  `apps/desktop/src/renderer/src/features/editor/panels/ChatPanel.tsx`
  is a UI shell today (local-only message state, hardcoded "pending"
  reply). Its layout + composer are reused; the IPC plumbing lands
  in this plan.

## Locked decisions

These were agreed up front and constrain the design throughout. Don't
revisit casually — each is referenced in the implementation phases.

1. **Cart persistence: survives app restart.** Sidecar JSON at
   `<userData>/draft-cart.json`. Mental model is Spotify queue / Amazon
   basket. Survives until **Create Project** or **Add to Existing** or
   explicit **Clear**.
2. **Cart UI: 5th DetailRail tab + auto-pop on first check.** Joins
   Info / OCR / Chat / Project as a 5th tab on the existing
   `RightActivityBar`. When the user checks their first item, the tab
   auto-selects so the cart slides into view without a manual click.
   Persists across captures and across grid/focus/reel modes —
   selecting a different capture doesn't lose the cart context.
3. **One global draft cart.** Single in-progress cart at any time; the
   user names it before committing (default `"Untitled draft"`). No
   tab strip of multiple drafts.
4. **Chat scope: this project only.** Mutation tools fixed to the one
   project whose chat this is. Agent can read the whole library
   (search / get-metadata across everything) but `scenes_set` /
   `scene_set_script` / etc. only mutate THIS project. Other projects
   need their own chat thread.
5. **Approval UX: inline transcript cards (mirrors PwrAgnt).** Every
   escalation request renders as a transcript entry with Approve /
   Approve-for-session / Decline / Cancel buttons. User sees the exact
   command/file/permission in context.
6. **Scratch directory cleanup: auto-delete with the project.**
   Deleting a Sizzle project takes its chat scratch directory with it.
   Clean, no orphan dirs.

## PR-1 — Substrate: capture-with-metadata bus surface

**Scope:** purely additive bus verbs. No UI. Lays the foundation that
both PR-2 (cart's right-rail display) and PR-3 (agent's library tools)
consume.

### New commands

- `library:listByIdsWithMetadata`
  - Request: `{ ids: string[] }`
  - Response: `{ rows: Array<{ record: CaptureRecord; enrichment: CaptureEnrichment | null }> }`
  - Returns rows in INPUT order (mirrors `library:listByIds`); drops
    soft-deleted + missing IDs silently. One batched
    `getCapturesByIds` (already exists) + one batched
    `listEnrichmentsByCaptureIds` (new helper in `enrichment-repo.ts`).
  - 500-id cap matching `library:listByIds`.

- `library:search`
  - Request: `{ query?: string; appBundleIds?: string[] | null;
    kinds?: Array<"image" | "video">; dateRange?: { start: string;
    end: string }; hasOcr?: boolean; limit?: number }` — every field
    optional, all conjunctive (AND-combined).
  - Response: `{ rows: Array<{ record: CaptureRecord; enrichment:
    CaptureEnrichment | null; matchSnippet?: string }> }`.
  - `query` performs SQLite FTS5 over a virtual table joining
    `capture_enrichments.suggested_title`,
    `accepted_title`, `suggested_description`, `accepted_description`,
    `ocr_text`, and source app names. `matchSnippet` is the
    `snippet(...)` function output highlighting the matched fragment.
  - The FTS5 virtual table is created in a new migration
    (`0012_capture_search_fts.sql`) populated on-write from the
    enrichment-repo upsert path. Backfill of existing rows runs
    once at app start under the same self-healing pattern as the
    other migrations.

### Tests

- `library-handlers.test.ts` (extend): order preservation, missing-ID
  drop, soft-deleted drop for the `WithMetadata` variant; per-row
  enrichment null when no enrichment row exists.
- `library-handlers.test.ts`: search filters compose conjunctively
  (query + appBundleId + dateRange combine correctly).
- `enrichment-repo.test.ts` (new if doesn't exist): batched
  `listEnrichmentsByCaptureIds` returns rows by capture id, missing
  rows return null (NOT omitted from the result map).
- `migrations.test.ts` (extend): the FTS5 virtual table is created
  on a fresh DB and backfilled on an upgraded DB; rebuild path
  recovers from a deleted FTS5 table without losing data.

### Out of scope for PR-1

- Any UI consuming these verbs (lands in PR-2 + PR-3).
- Embedding-based semantic search. FTS5 is plenty for v1; embeddings
  are a future enhancement if the agent struggles with conceptual
  queries.

## PR-2 — Project Asset Cart

**Scope:** the cart UI + main-process cart store + the two terminal
actions (Create new Sizzle Reel, Add to existing). Mostly renderer
work; one new main-process store.

### Data model

- New `DraftCart` type in `@pwrsnap/shared`:
  ```ts
  export type DraftCart = {
    name: string;              // "Untitled draft" default
    captureIds: string[];      // ordered, matches user check sequence
    createdAt: string;         // ISO
    modifiedAt: string;        // bumped on every mutation
  };
  ```
- One global draft. Stored at `<userData>/draft-cart.json` via the same
  atomic-rename + parse-fail-quarantine pattern as
  `sizzle-projects.json` (see `sizzle-store.ts` for the template).
- New module `apps/desktop/src/main/cart/cart-store.ts` — same in-memory
  cache + serialized write queue pattern as `SizzleStore`. Single
  global instance (singleton via `getCartStore()`).

### New commands

- `cart:get` → `DraftCart`
- `cart:toggle` `{ captureId }` → `DraftCart` (adds if absent, removes
  if present)
- `cart:reorder` `{ from: number; to: number }` → `DraftCart`
- `cart:remove` `{ captureId }` → `DraftCart`
- `cart:rename` `{ name }` → `DraftCart`
- `cart:clear` → `DraftCart` (empty)
- `cart:commitToNewProject` `{ name?: string }` → `SizzleProject`
  - Creates a new sizzle project, populates scenes from cart order via
    `sizzle:toggleScene` semantics (one append per id), then clears
    the cart, then returns the project for the renderer to open.
- `cart:commitToExisting` `{ projectId: string }` → `SizzleProject`
  - Appends cart items to an existing project's scenes (skips
    captureIds already in the project — duplicates are intentional
    elsewhere, but this is the "Add to existing" affordance and the
    user expects de-dup), then clears the cart.

### New event channel

- `EVENT_CHANNELS.cartChanged: "events:cart:changed"` — payload
  `{ cart: DraftCart }`. Broadcast on every mutation. Typed via the
  `EventPayloads` map.

### Renderer

- New `CartPanel` component in
  `apps/desktop/src/renderer/src/features/library/CartPanel.tsx`. Lives
  as the 5th tab on `RightActivityBar` — Info / OCR / Chat / Project /
  Cart. Tab visible only when DetailRail itself is mounted (Focus /
  Reel modes, same gating as today). Cart count badge on the tab
  label.
- New `useDraftCart()` hook in
  `apps/desktop/src/renderer/src/lib/useDraftCart.ts` —
  fetch-once-then-subscribe pattern mirroring `useSizzleProjects`.
- Cell hover checkbox in `Library.tsx`'s `CellRow`. Checkbox overlay
  at top-right of each `.psl__cell`. Visible on hover OR when the
  capture is already in the cart (so the user sees what's checked at
  a glance). Click toggles via `cart:toggle`.
- Auto-tab-pop logic: a `useEffect` watching the cart length —
  transitions `0 → 1` selects the Cart tab. Subsequent additions
  don't re-pop (so the user can switch away to look at the Info tab
  without the cart yanking focus back on every check).
- Cart panel body:
  - Editable name field at top (defaults `Untitled draft`).
  - Ordered list of capture thumbnails + script-line preview (pulled
    via `library:listByIdsWithMetadata`).
  - Drag-to-reorder via `react-dnd` or native HTML5 drag (use the
    same lib + pattern as any existing draggable in the codebase —
    if none exists, native HTML5 drag is enough for a 1-20 item list).
  - Per-row × to remove.
  - Auto-scroll the cart's internal scroll container to bottom on
    add — `useEffect` watching `cart.captureIds.length` with a
    `scrollIntoView({ block: "end" })` on the last item.
  - Footer: name input + two CTAs (**Create Sizzle Reel** primary,
    **Add to existing…** secondary opening a project picker).

### Persistence + cross-mode behavior

- Cart state lives in main; renderer subscribes. Switching between
  Library grid / focus / reel modes — same window, same cart, no
  state loss.
- Closing the Library window: cart persists on disk; reopening
  Library restores it.
- Clicking into an asset in Focus mode: cart panel stays open on
  the right rail (DetailRail tab persistence via the existing
  `library.sidebarTab` settings field — extended to allow `"cart"`).

### Tests

- `cart-store.test.ts` (new) — mirrors `sizzle-store.test.ts`:
  atomic write, in-memory cache, parse-fail quarantine, missing-file
  empty, write does not include `.tmp` sibling.
- `cart-handlers.test.ts` (new) — toggle add/remove, reorder bounds,
  commit-to-new-project clears + creates, commit-to-existing dedups
  + appends.
- `useDraftCart.test.ts` (new) — fetch-once-then-subscribe, defensive
  guards for test stubs without `cart:get` mocked (mirror
  `useSizzleProjects`).
- `Library.test.tsx` (extend) — hover checkbox renders, click
  dispatches `cart:toggle`, cart count badge updates, first-check
  auto-pops the Cart tab.

### Out of scope for PR-2

- Multi-cart support — explicitly single-cart per locked decision.
- The chat panel — lands in PR-3. The cart's "Create Sizzle Reel"
  button just opens the existing Sizzle window with the project
  pre-populated; chat affordance comes later.
- Per-capture "is this in the cart?" badge on the grid cells beyond
  the checkbox itself. Add later if the cart gets long.

## PR-3 — Sizzle Composer Chat

**Scope:** the biggest piece. Extends the Codex client to support
multi-turn persistent threads with dynamic tools + approval relay,
mints scratch directories per project, builds the chat UI in the
Sizzle composer, defines the per-project tool manifest.

### Codex App Server client refactor

Today `CodexAppServerClient` (`apps/desktop/src/main/ai/codex-client.ts`)
is single-purpose: `enrichCapture()` opens an ephemeral thread, runs
one turn, archives. The `pendingTurn` field enforces one in-flight
turn at a time PROCESS-WIDE — multiple chats would serialize.

Refactor to a session-aware shape:

```ts
class CodexAppServerClient {
  // Existing: enrichCapture() — keep as-is for the enrichment path.

  // New persistent-thread API:
  async startSession(params: {
    cwd: string;                       // scratch directory
    model?: string;
    sandbox?: SandboxMode;             // default: workspace-write
    approvalPolicy?: AskForApproval;   // default: on-request
    dynamicTools: DynamicToolDefinition[];
  }): Promise<{ threadId: string; sessionId: string }>;

  async submitTurn(params: {
    sessionId: string;
    input: TurnInput[];                // text + image content items
    onDelta: (delta: AgentMessageDelta) => void;
    onToolCall: (call: ToolCall) => Promise<ToolCallResult>;
    onApprovalRequest: (req: ApprovalRequest) => Promise<ApprovalResponse>;
    signal: AbortSignal;
  }): Promise<{ finalMessage: string; rawItems: RawResponseItem[] }>;

  async closeSession(sessionId: string): Promise<void>;
}
```

- `pendingTurn` moves from a single field to a per-session map keyed by
  `sessionId`. Cancellation goes to the right turn.
- `setRequestHandler` (the JSON-RPC server-initiated request handler)
  routes by `params.turnId` to the matching session's `onApprovalRequest`
  callback. Mirrors PwrAgnt's `backend-registry.handleServerRequest`.
- Tool-call dispatch (`item/tool/call`) likewise routes to the
  session's `onToolCall`. Today returns a hardcoded stub.

### New commands

- `codex:newSession` `{ projectId: string }` → `{ sessionId: string;
  threadId: string }`
  - Mints scratch dir at
    `~/Documents/PwrSnap/Chats/<YYYY-MM-DD>-<sanitized-project-name>/`.
  - Calls `startSession` with the project's tool manifest.
  - Stores `{ projectId, sessionId, threadId, scratchDir }` in
    new `apps/desktop/src/main/sizzle/chat-store.ts` — same atomic
    write + in-memory cache as `sizzle-store.ts`.
  - Sidecar JSON at
    `<userData>/sizzle-chat-sessions.json`. One row per project; if a
    project already has a session, returns it.

- `codex:sendTurn` `{ sessionId: string; input: TurnInput[] }`
  → `{ turnId: string }`
  - Kicks off a turn; main process drives the streaming via the
    callback set in `submitTurn`. Renderer subscribes to events for
    live updates (deltas, tool calls, approval requests, completion).
  - Returns the turnId immediately so the renderer can render an
    "in-progress" placeholder and cancel it later.

- `codex:submitApproval` `{ sessionId: string; turnId: string;
  requestId: string; response: ApprovalResponse }` → `void`
  - Resolves the pending JSON-RPC reply main is holding for the
    server-initiated approval request. Mirrors PwrAgnt's
    `submitServerRequest`.

- `codex:cancelTurn` `{ sessionId: string; turnId: string }` → `void`
  - Calls the session's abort signal. Codex App Server cleans up the
    in-progress turn.

- `codex:closeSession` `{ sessionId: string }` → `void`
  - Closes the thread. Called automatically when the user deletes the
    project (per locked decision #6 — scratch dir is removed too).

### New event channels

- `events:codex:streamDelta` — payload `{ sessionId: string;
  turnId: string; delta: AgentMessageDelta }`. Fires on every
  `item/agentMessage/delta` from Codex.
- `events:codex:toolCall` — payload `{ sessionId: string; turnId:
  string; toolCall: ToolCall }`. Fires when the agent invokes a tool;
  the renderer mirrors the call into the transcript while main is
  servicing it.
- `events:codex:approvalRequest` — payload `{ sessionId: string;
  turnId: string; requestId: string; request: ApprovalRequest }`.
  Fires when Codex sends a `*/requestApproval`. The renderer renders
  an inline transcript card; the user's click goes back via
  `codex:submitApproval`.
- `events:codex:turnComplete` — payload `{ sessionId: string;
  turnId: string; status: "ok" | "cancelled" | "failed"; error?:
  PwrSnapError }`.

All four go through the typed `EventPayloads` map.

### Sizzle agent tool manifest

The agent's `dynamicTools` parameter on `startSession`. Each tool is a
JSON schema the model can call.

| Tool | Purpose | Mutation? |
|---|---|---|
| `library_search` | Search captures by query, app, kind, date range, OCR presence. Returns list of `{ captureId, title, description, snippet, source_app_name, captured_at, kind }`. | no |
| `library_get_metadata` | Bulk lookup for specific captureIds. Returns the full enrichment + OCR. | no |
| `project_get` | Read the current project's scenes + voice + resolution + lastRenderedAt. | no |
| `scenes_set` | Replace the entire scenes array. Used when the agent drafts a fresh reel from scratch. | YES |
| `scenes_append` | Append one or more scenes to the end. | YES |
| `scenes_insert` | Insert at a specific index. | YES |
| `scenes_remove` | Remove by scene id (or by index). | YES |
| `scenes_reorder` | Reorder by scene ids. | YES |
| `scene_set_script` | Set one scene's scriptLine. | YES |
| `scene_set_transition` | Set transition. | YES |
| `scene_set_audio_source` | Set audioSource. | YES |
| `scene_set_media_trim` | Video scenes only — set trim range. | YES |
| `scene_set_duration_override` | Force a specific scene duration. | YES |
| `project_render` | Trigger a render of the current project. | YES |

Every mutation tool's handler scopes to the chat's `projectId` —
encoded in the closure when `startSession` was called. The agent
cannot pass a different `projectId` (it's not a parameter). Per locked
decision #4.

### Renderer — ChatPanel in Sizzle composer

- New `ChatPanel` component in
  `apps/desktop/src/renderer/src/features/sizzle/ChatPanel.tsx`. NOT
  the existing editor `ChatPanel.tsx` (which stays a stub for the
  per-capture chat surface, future work).
- Layout: bubble transcript like PwrAgnt's `ThreadView` (mirror the
  component structure from
  `~/github/PwrAgnt/apps/desktop/src/renderer/src/features/thread-detail/`).
- Transcript entries: text bubbles + tool-call cards + approval cards.
  Approval cards have Approve / Approve-for-session / Decline / Cancel
  buttons keyed off the `availableDecisions` enum on the request.
- Streaming: `events:codex:streamDelta` accumulates into an
  in-progress message; React re-renders. No per-character animation.
- Composer at the bottom: textarea + Send button. Cmd-Enter to send.
- "New chat" button in the panel header — closes the current session,
  starts a new one (preserves the scratch dir).
- Panel slot in the Sizzle composer:
  - Phase 1: replaces the right rail (today the right rail shows the
    selected scene's preview). Toggle button in the composer's title
    bar to flip back.
  - Phase 2 (post-PR-3): dual-pane mode, scene preview + chat
    side-by-side. Out of scope here.

### Tests

- `codex-client.test.ts` (extend) — session map, per-session pending
  turn, dispatch of `item/tool/call` to the right session's
  `onToolCall`, dispatch of `*/requestApproval` to the right
  session's `onApprovalRequest`, abort signal cancels the right turn.
- `chat-store.test.ts` (new) — atomic write, parse-fail quarantine,
  one session per project, get-or-create semantics.
- `codex-handlers.test.ts` (extend) — `newSession`, `sendTurn`,
  `submitApproval`, `cancelTurn`, `closeSession`. Mock the
  CodexAppServerClient.
- `sizzle-tools.test.ts` (new) — per-tool handler: each mutation
  tool calls the right `sizzle-handlers` underlying verb, scopes to
  the chat's projectId. Reject if the agent tries to pass a different
  projectId.
- `library-search.test.ts` (extend `library-handlers.test.ts`) — FTS5
  query, conjunctive filters.
- `ChatPanel.test.tsx` (new) — renders streaming deltas, renders
  tool-call cards, renders approval card with the right buttons,
  Approve click dispatches `codex:submitApproval` with the right
  decision, Cancel button dispatches `codex:cancelTurn`.

### Out of scope for PR-3

- Embedding-based search (still FTS5).
- Cross-project agent ops (locked decision #4).
- Voice input to the chat composer (Phase 5+).
- Diff cards ("Agent proposed N changes — Keep / Undo"). Add in PR-4
  (Phase F polish) once we see how the agent's output actually
  reads.
- The Sizzle window's "main pane" UX change (chat vs scene preview
  layout) — phase 1 is toggle, phase 2 is dual pane, this PR ships
  phase 1.

## Out of scope (all PRs)

- The standalone Sizzle composer window's window-management UX. The
  composer stays a singleton window. No multi-window chat.
- Voice transcription of user input into the chat composer.
- Agent-driven cross-project ops ("merge these two reels").
- AI-generated thumbnails for projects.
- Background rendering with chat continuing to drive iterations
  (today rendering blocks; chat would have to wait).
- Real-time WebCodecs preview while the agent is editing scenes.
  Tracked separately as Phase 3b on the parent sizzle plan.

## Verification

End-to-end manual flow after PR-3 lands:

1. `pnpm --filter @pwrsnap/desktop dev` → Library opens.
2. Hover over 4-5 captures, check each one. Right rail's Cart tab
   auto-pops on the first check; subsequent checks append to the
   list. Reorder by drag, remove one with ×.
3. Rename the cart to "Telegram + PwrAgent onboarding". Click
   **Create Sizzle Reel** → Sizzle window opens with the project
   pre-populated and the chat panel ready.
4. Paste a multi-paragraph prompt: "we're making a video that shows
   how to use Telegram with PwrAgent. Onboarding wizard first, then
   the pairing code generation, then Telegram with the code pasted,
   then the wizard's Accept button, then the main window with the
   Telegram chip top-right, then Messaging Activity, then starting
   a `help` thread in the Telegram DM, then approving an exec
   request."
5. Agent searches the library (visible as a `library_search` tool
   call in the transcript), proposes 8 scenes with scripts and
   transitions. Each `scenes_append` / `scene_set_script` lands in
   the project — sidebar updates live via the existing
   `events:sizzle:projects:changed` broadcast.
6. User says "the second scene should mention the QR code option
   too" — agent edits scene 2's script via `scene_set_script`.
7. Render → MP4 lands at `~/Movies/PwrSnap/...`.
8. Close Sizzle, return to Library. Cart is empty (committed).
9. Reopen Sizzle → chat thread is still there, transcript intact.
10. Delete the project from Library → chat scratch directory at
    `~/Documents/PwrSnap/Chats/...` is gone.

Automated:

- `pnpm typecheck` clean each PR.
- `pnpm test` adds ≥40 tests per PR (~120 total across the three).
- `pnpm --filter @pwrsnap/desktop build` clean.

## Files touched

### PR-1 — Substrate

```
packages/shared/src/protocol.ts                              — library:listByIdsWithMetadata, library:search,
                                                                CaptureSearchFilters, SearchResultRow
apps/desktop/src/main/handlers/library-handlers.ts           — listByIdsWithMetadata, search
apps/desktop/src/main/persistence/enrichment-repo.ts         — listEnrichmentsByCaptureIds bulk helper
apps/desktop/src/main/persistence/captures-repo.ts           — searchCaptures (FTS5 join)
apps/desktop/src/main/persistence/migrations/0012_capture_search_fts.sql  (new)
```

### PR-2 — Cart

```
packages/shared/src/protocol.ts                              — DraftCart, cart:* commands
packages/shared/src/ipc.ts                                   — events:cart:changed in EventPayloads
apps/desktop/src/main/cart/cart-store.ts                     (new — atomic write + cache)
apps/desktop/src/main/handlers/cart-handlers.ts              (new)
apps/desktop/src/main/handlers/cart-validators.ts            (new)
apps/desktop/src/renderer/src/lib/useDraftCart.ts            (new)
apps/desktop/src/renderer/src/features/library/CartPanel.tsx (new)
apps/desktop/src/renderer/src/features/library/Library.tsx   — hover checkbox in CellRow,
                                                                cart tab gating + auto-pop
apps/desktop/src/renderer/src/features/library/DetailRail.tsx — register cart as 5th tab
apps/desktop/src/renderer/src/styles/library.css             — cell-checkbox overlay, cart panel
```

### PR-3 — Chat

```
packages/shared/src/protocol.ts                              — codex:newSession/sendTurn/submitApproval/cancelTurn/closeSession,
                                                                ChatSession, AgentMessageDelta, ToolCall, ApprovalRequest, etc.
packages/shared/src/ipc.ts                                   — events:codex:streamDelta / toolCall / approvalRequest / turnComplete
apps/desktop/src/main/ai/codex-client.ts                     — session map refactor, dynamic tools, approval relay
apps/desktop/src/main/sizzle/chat-store.ts                   (new — one session per project)
apps/desktop/src/main/sizzle/sizzle-tools.ts                 (new — per-project tool manifest + dispatch)
apps/desktop/src/main/sizzle/scratch-dir.ts                  (new — mint + delete ~/Documents/PwrSnap/Chats/...)
apps/desktop/src/main/handlers/codex-handlers.ts             — chat verbs (replaces codex:ask stub)
apps/desktop/src/main/handlers/sizzle-handlers.ts            — on project delete, cascade to closeSession + delete scratch dir
apps/desktop/src/renderer/src/features/sizzle/ChatPanel.tsx  (new)
apps/desktop/src/renderer/src/features/sizzle/SizzleApp.tsx  — Chat toggle + slot
apps/desktop/src/renderer/src/features/sizzle/sizzle.css     — transcript bubbles, tool-call cards, approval cards
```

## Decisions deferred (write later)

- Whether to surface the chat panel in the Library DetailRail too
  (per-capture chat). Today there's a stub `ChatPanel.tsx` in the
  editor. After PR-3 lands and we see how the Sizzle chat reads, we
  decide whether the per-capture chat reuses the same plumbing.
- Where the per-render budget for OpenAI TTS calls lives. Today every
  render is a fresh TTS call (with content-addressed cache). If the
  agent starts driving renders, we may need a per-project monthly
  spend ceiling.
- Whether agent-edited scripts get a "draft / accepted" two-state UI
  (mirror the Codex enrichment Accept buttons) or just commit
  directly. PR-3 ships direct-commit; the diff/Accept pattern is PR-4
  polish.
