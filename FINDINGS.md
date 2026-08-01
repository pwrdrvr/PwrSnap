# PR #216 Local Agent MCP Audit Findings

**Audit date:** 2026-08-01

**Audited branch:** `codex/local-agent-mcp-access-plan`

**Audited head:** `80ae3d76f8bbbd461460ac6c7292b66166014e5f`

**Base:** `origin/main` at `70213172a1cf5dd9f28e080ded912665230bf8b2`

**Pull request:** [#216 — `feat(desktop): expose PwrSnap to local agents`](https://github.com/pwrdrvr/PwrSnap/pull/216)

## Verdict

**Do not merge until the Critical and High findings are fixed.**

The branch is mechanically healthy and several important foundations are good:
PKCE verification, loopback binding and Host checks, stateless MCP transports,
direct search minimization, resource ownership, signed URL expiry, and grant
revocation. However, the browser consent ceremony can be bypassed completely,
and authorization does not survive entry into the command bus and PwrSnap-owned
chat tool catalogs.

## Resolution Notes

Implemented on `codex/local-agent-mcp-access-plan` after this audit:

### Re-audit remediation

- The cookie-bound HTTP consent form described below was removed after the
  re-audit correctly showed that browser continuity is not user presence.
  `GET /authorize` now creates the server-owned transaction and waits for a
  decision from a dedicated sandboxed PwrSnap `BrowserWindow`. The command bus
  binds read/decision access to that exact window ID; other PwrSnap windows and
  every loopback HTTP caller are denied. `POST /authorize` is now an inert
  `405` endpoint, the transaction ID is never exposed over HTTP, closing the
  native window denies the request, and aborted requests consume the pending
  transaction. Adversarial integration coverage reproduces the former
  headless cookie/form flow and verifies that it cannot create a grant.
- Image-edit send and status now both require `capture.edit` and
  `capture.composite.read`, matching their completed-composite result contract.
  An authenticated edit-only MCP client is denied before tool dispatch.

### Initial remediation (consent item superseded above)

- OAuth approval now uses a short-lived, server-issued, browser-cookie-bound,
  single-use consent transaction. The decision POST contains only that opaque
  transaction and the selected subset; the server retains the validated client,
  redirect URI, PKCE challenge, resource, state, scopes, and requested
  capabilities. Forged GET decisions, cookie mismatches, expiry, and replay are
  covered by integration tests.
- The command bus now default-denies MCP commands, reloads the current grant by
  client ID, replaces caller-supplied capabilities with the live grant, and
  applies command/request-specific capability policy before local execution or
  split-process forwarding. The receiving process performs the same check.
- Library and Sizzle model tool calls retain the originating command context for
  the full asynchronous turn. Whole-library/OCR reads and composite/Sizzle
  renders are independently authorized; Sizzle's model render tool requires an
  explicit `preview` or `full` mode.
- External Sizzle creation preflights every capture before project creation.
  Toggle, scene/sequence mutation, and render reject missing or trashed captures,
  with render validation occurring before TTS, artifact writes, or project
  updates.
- Render consent now discloses TTS/network access, possible provider charges,
  cache or Videos writes, and project-state changes. Preview and full remain
  separate capabilities.
- Original-derived exports record both `capture.export` and
  `capture.original.read`, including failed attempts; original export resources
  preserve the source-read audit on retrieval.
- MCP-created chats are **isolated per authenticated client**. The persisted
  `owner_client_id` is enforced for create, list/reuse, explicit selection,
  status, send, and preview resolution. Human-owned threads use `NULL` and are
  excluded from MCP reuse; externally owned threads are excluded from human
  thread lists. Capture/project anchoring remains an additional constraint.
- Signed media implements single HTTP byte ranges, video metadata omits
  image-only resources, and malformed local-agent grant/audit state now invokes
  the existing whole-file corruption quarantine rather than dropping entries.

No audit finding was disputed.

## Findings

### Critical — OAuth approval can be forged from request parameters

`LocalAgentOAuthProvider.handleAuthorizationRequest` treats
`pwrsnap_decision=allow` and repeated `capability` query parameters as proof of
user approval, then immediately creates an authorization code:

- [`local-agent-oauth.ts`](apps/desktop/src/main/local-agents/local-agent-oauth.ts#L184)
- [`local-agent-oauth.ts`](apps/desktop/src/main/local-agents/local-agent-oauth.ts#L244)
- [`local-agent-oauth.ts`](apps/desktop/src/main/local-agents/local-agent-oauth.ts#L262)

The consent form is itself an unsigned GET submission. There is no server-side
consent transaction, nonce, browser-bound cookie, CSRF protection, or other
user-presence proof:

- [`mcp-server.ts`](apps/desktop/src/main/local-agents/mcp-server.ts#L761)

A local process can therefore:

1. Dynamically register a public OAuth client and its own loopback callback.
2. Generate its own PKCE verifier and challenge.
3. Request `/authorize` with `pwrsnap_decision=allow` and every capability.
4. Receive the code at its registered callback and exchange it for a token.

No browser consent approval is required. The integration-test helper currently
performs this direct forged approval and treats it as the normal path:

- [`mcp-server.test.ts`](apps/desktop/src/main/local-agents/__tests__/mcp-server.test.ts#L231)

PKCE itself is not broken. The challenge is stored and the MCP SDK verifies the
verifier during token exchange:

- [`local-agent-oauth.ts`](apps/desktop/src/main/local-agents/local-agent-oauth.ts#L294)

The defect is consent integrity, not the authorization-code or PKCE mechanics.

### High — capability enforcement stops at the outer MCP tool registry

The server validates the authenticated grant before the initial MCP tool
dispatch:

- [`mcp-server.ts`](apps/desktop/src/main/local-agents/mcp-server.ts#L425)
- [`mcp-tool-registry.ts`](apps/desktop/src/main/local-agents/mcp-tool-registry.ts#L434)

The command bus only carries `principal` and `localAgent`; it does not enforce
any command policy:

- [`command-bus.ts`](apps/desktop/src/main/command-bus.ts#L145)

The split-process bridge preserves and shape-validates the context but does not
authorize it:

- [`protocol.ts`](apps/desktop/src/main/process-bridge/protocol.ts#L104)
- [`endpoint.ts`](apps/desktop/src/main/process-bridge/endpoint.ts#L219)

PwrSnap-owned chat catalogs then discard the client identity and capabilities
when they redispatch commands, using only `{ principal: "mcp" }`:

- [`library-tool-allowlist.ts`](apps/desktop/src/main/ai/library-tool-allowlist.ts#L54)
- [`sizzle-tool-allowlist.ts`](apps/desktop/src/main/ai/sizzle-tool-allowlist.ts#L33)

Concrete consequences:

- A client holding only `capture.edit` can instruct Library Chat to search the
  whole library, read metadata/OCR, render composites, and invoke capture-ID
  tools without `library.read` or the corresponding read capability.
  - [`library-tool-allowlist.ts`](apps/desktop/src/main/ai/library-tool-allowlist.ts#L143)
  - [`library-tool-allowlist.ts`](apps/desktop/src/main/ai/library-tool-allowlist.ts#L170)
  - [`library-tool-allowlist.ts`](apps/desktop/src/main/ai/library-tool-allowlist.ts#L209)
  - [`library-tool-allowlist.ts`](apps/desktop/src/main/ai/library-tool-allowlist.ts#L261)
- A client holding only `sizzle.compose` can instruct Sizzle Chat to search the
  whole library and read full metadata/OCR without `library.read`.
  - [`sizzle-tool-allowlist.ts`](apps/desktop/src/main/ai/sizzle-tool-allowlist.ts#L356)
- Sizzle Chat's `project_render` tool invokes `sizzle:render` with its default
  full mode without `sizzle.preview.read` or `sizzle.full.read`.
  - [`sizzle-tool-allowlist.ts`](apps/desktop/src/main/ai/sizzle-tool-allowlist.ts#L611)
- The Sizzle system prompt explicitly tells the model that whole-library search
  and project rendering are available, so this is not merely a hypothetical
  prompt-injection path.
  - [`sizzle-chat-system-prompt.ts`](apps/desktop/src/main/ai/sizzle-chat-system-prompt.ts#L14)

Model behavior cannot be the authorization boundary. Capability checks must be
revalidated at an execution floor that every direct and model-mediated command
crosses.

### High — Sizzle accepts and renders trashed captures

MCP Sizzle creation adds capture IDs without validating that they are live:

- [`local-agent-tool-service.ts`](apps/desktop/src/main/local-agents/local-agent-tool-service.ts#L329)

`sizzle:toggleScene` likewise accepts the capture ID without loading it or
checking `deleted_at`:

- [`sizzle-handlers.ts`](apps/desktop/src/main/handlers/sizzle-handlers.ts#L447)

The render path loads soft-deleted database rows as valid captures, and the
image resolver explicitly supports soft-deleted rows:

- [`sizzle-handlers.ts`](apps/desktop/src/main/handlers/sizzle-handlers.ts#L155)
- [`sizzle-handlers.ts`](apps/desktop/src/main/handlers/sizzle-handlers.ts#L165)
- [`sizzle-handlers.ts`](apps/desktop/src/main/handlers/sizzle-handlers.ts#L838)

A retained capture ID can therefore add trashed content to a new reel, and an
existing project continues rendering a capture after it is moved to Trash.
This bypasses the advertised live/non-trashed boundary and acts like an
unconsented trash-read capability.

### Medium — Sizzle render consent understates TTS, writes, and state changes

OAuth labels the permissions as reads:

- `sizzle.preview.read`: “Read low-resolution reel previews”
- `sizzle.full.read`: “Read full-resolution reels”

See [`local-agent-oauth.ts`](apps/desktop/src/main/local-agents/local-agent-oauth.ts#L67).

In reality, a render may:

- Read the user's stored OpenAI API key.
- Make billable/open-world TTS requests.
- Produce cached audio and video artifacts.
- Write previews under cache or full reels under the user's Videos directory.
- Update the Sizzle project's `outputPath` and `lastRenderedAt`.

Evidence:

- [`sizzle-handlers.ts`](apps/desktop/src/main/handlers/sizzle-handlers.ts#L930)
- [`sizzle-handlers.ts`](apps/desktop/src/main/handlers/sizzle-handlers.ts#L963)
- [`sizzle-handlers.ts`](apps/desktop/src/main/handlers/sizzle-handlers.ts#L1048)
- [`sizzle-handlers.ts`](apps/desktop/src/main/handlers/sizzle-handlers.ts#L1091)

The MCP annotations correctly mark the tools as non-read-only/open-world, but
the browser authorization copy does not disclose these material effects.

### Medium — original-derived exports are not audited distinctly

Capability enforcement on the direct export tool is correct: an original
export requires both `capture.export` and `capture.original.read`:

- [`mcp-tool-registry.ts`](apps/desktop/src/main/local-agents/mcp-tool-registry.ts#L258)

Audit behavior is not distinct. Every export is recorded only as
`capture.export`, without examining the requested variant:

- [`mcp-server.ts`](apps/desktop/src/main/local-agents/mcp-server.ts#L652)

The registered export resource has no `capture.original.read` audit metadata,
so fetching it does not add the missing original-access event:

- [`local-agent-tool-service.ts`](apps/desktop/src/main/local-agents/local-agent-tool-service.ts#L150)

Direct original retrieval does attach original-read audit metadata, proving the
gap is specific to original-derived exports:

- [`local-agent-tool-service.ts`](apps/desktop/src/main/local-agents/local-agent-tool-service.ts#L90)

The shared audit action union and Settings UI cannot currently express the
distinction:

- [`protocol.ts`](packages/shared/src/protocol.ts#L759)
- [`LocalAgentsPage.tsx`](apps/desktop/src/renderer/src/features/settings/pages/LocalAgentsPage.tsx#L187)

### Medium — capture/project anchoring works, but threads are not client-isolated

The suspected cross-capture explicit-thread bug is invalid. A supplied Library
Chat thread must appear in the capture-anchored thread list or it is rejected:

- [`local-agent-tool-service.ts`](apps/desktop/src/main/local-agents/local-agent-tool-service.ts#L208)

Sizzle applies the analogous project-anchor check:

- [`local-agent-tool-service.ts`](apps/desktop/src/main/local-agents/local-agent-tool-service.ts#L418)

However, neither thread type records or checks the originating MCP client.
Library Chat's `latest-compatible` policy can select a human-created or another
client's thread for the same capture:

- [`local-agent-tool-service.ts`](apps/desktop/src/main/local-agents/local-agent-tool-service.ts#L246)

Sizzle always selects the most recently modified project thread:

- [`local-agent-tool-service.ts`](apps/desktop/src/main/local-agents/local-agent-tool-service.ts#L424)

That permits cross-client conversation contamination and unintended
continuation of user chats. If shared PwrSnap-owned threads are intentional,
the ownership policy needs to be explicit and tested; it must not be mistaken
for MCP client isolation.

### Low — the signed media endpoint does not support HTTP byte ranges

The media endpoint always emits `200` with the entire file and ignores the
`Range` header:

- [`mcp-server.ts`](apps/desktop/src/main/local-agents/mcp-server.ts#L523)

The live audit confirmed that a `Range: bytes=0-0` request downloaded the full
small composite. This is tolerable for a small PNG but makes signed Sizzle video
playback/seeking inefficient and can turn an inspection probe into a full reel
download.

### Low — capture metadata advertises image resources for videos

Metadata advertises composite/original resource links based only on the client
grant, without considering the capture kind:

- [`local-agent-tool-service.ts`](apps/desktop/src/main/local-agents/local-agent-tool-service.ts#L42)

Preparing either resource later fails because `render:captureExport` supports
images only:

- [`export-coordinator.ts`](apps/desktop/src/main/render/export-coordinator.ts#L49)

The metadata response should not advertise workflows that cannot succeed.

### Low — malformed grant/audit entries are silently discarded

The settings parser silently drops malformed grants, duplicate IDs, and invalid
audit entries instead of invoking the settings substrate's corrupt-quarantine
behavior:

- [`desktop-settings-service.ts`](apps/desktop/src/main/settings/desktop-settings-service.ts#L969)

The test explicitly codifies drop-and-continue behavior:

- [`local-agent-grants.test.ts`](apps/desktop/src/main/local-agents/__tests__/local-agent-grants.test.ts#L252)

This fails closed, but it can silently lose grants and audit history and
contradicts the U1 test scenario in the implementation plan.

## Live Interface Observations

The branch build's `pwrsnap` MCP server was visible and authenticated from a
new PwrAgent child thread. The audit used only the expressly permitted
non-mutating surface. Capture content, capture IDs, and bearer URLs were not
recorded in this document.

### Advertised server instructions

> Use PwrSnap tools only for captures and sizzle assets the user authorized for
> this local client. Media tools return both a capability-protected MCP resource
> URI and a five-minute signed localhost URL. Prefer the signed URL when the
> client can consume binary URLs; otherwise use MCP resources/read. Never log,
> persist, or share a signed media URL.

### Advertised tools

- `pwrsnap_library_search`
- `pwrsnap_capture_delete_to_trash`
- `pwrsnap_capture_metadata`
- `pwrsnap_capture_resource`
- `pwrsnap_capture_export`
- `pwrsnap_image_edit_send`
- `pwrsnap_image_edit_status`
- `pwrsnap_sizzle_create`
- `pwrsnap_sizzle_send`
- `pwrsnap_sizzle_status`
- `pwrsnap_sizzle_render_preview`
- `pwrsnap_sizzle_render_full`

The schemas, descriptions, and annotations advertised by the running server
matched [`mcp-tool-registry.ts`](apps/desktop/src/main/local-agents/mcp-tool-registry.ts).

### Advertised resource templates

- `pwrsnap://capture/{captureId}/composite` — `image/png`
- `pwrsnap://capture/{captureId}/original` — `image/png`
- `pwrsnap://capture/{captureId}/export/{exportId}` — `application/octet-stream`
- `pwrsnap://capture/{captureId}/edit/{threadId}/composite` — `image/png`
- `pwrsnap://sizzle/{projectId}/{mode}/{renderId}` — `video/mp4`

There were no static PwrSnap resources, which is expected because the media
surface is template-backed.

### Non-mutating probe results

- Default library search returned structural summary fields only: kind,
  timestamp, dimensions, size, source application, alpha, and OCR presence.
  It omitted generated title, description, tags, match snippets, and OCR text.
- One explicit enriched search added title, description, tags, and match
  snippet, but still did not expose full OCR.
- Capture metadata returned a minimized capture projection, OCR length, and
  only the resource classes allowed by the current grant.
- Composite preparation returned a protected MCP URI and five-minute signed
  loopback URL.
- Signed-URL retrieval succeeded as a small `image/png`; the bytes were
  discarded without visual or content inspection.
- No original retrieval, export, Trash, image-edit, Sizzle, grant, or other
  state-changing operation was called.

## Verified Good / Invalid Prior Hypotheses

- **PKCE is valid.** The flaw is forgeable consent, not verifier validation.
- **Fixed-port loopback hardening is valid.** The server binds to
  `127.0.0.1:51729`, rejects non-loopback peers, validates exact Host after
  binding, restricts browser origins, and disables MCP visibly on port conflict.
- **MCP request sessions are isolated.** Each authenticated request receives a
  fresh stateless transport and MCP server instance.
- **Resource ownership and revocation are valid.** Owner-scoped resources are
  client-bound, reads revalidate current capabilities, signed URLs bind client,
  resource, and expiry with an HMAC, and revocation invalidates existing URLs.
- **Direct search minimization is valid.** Summary detail does not disclose
  generated text or OCR content.
- **Explicit image-edit thread anchoring is valid.** A thread anchored to a
  different capture is rejected. The remaining issue is lack of client-level
  ownership for same-capture threads.
- **Direct original-export capability gating is valid.** The remaining issue is
  distinct audit history, not missing read authorization.
- **Direct metadata/export/edit paths reject trashed captures.** The remaining
  trash defect is the Sizzle path.

## Required Tests and Acceptance Criteria

### OAuth consent integrity

- A request containing `pwrsnap_decision` or selected capabilities without a
  server-issued, single-use consent transaction is rejected.
- Consent approval is bound to the validated client, redirect URI, PKCE
  challenge, resource indicator, requested scope, and selected capabilities.
- The transaction is short-lived and consumed exactly once.
- Denial and approval require the same protected ceremony.
- Tests no longer approve OAuth by manually appending decision parameters to
  the original authorization URL.

### Capability execution floor

- Every external command is authorized at or below the command bus, including
  after split-process forwarding.
- Command handlers do not trust a caller-supplied `localAgent.capabilities`
  object without tying it to an authenticated grant context.
- Library and Sizzle chat catalogs retain the originating client identity and
  capabilities for every model tool call.
- `capture.edit` alone cannot perform whole-library search, metadata/OCR reads,
  or unauthorized resource reads.
- `sizzle.compose` alone cannot perform whole-library reads or render preview or
  full media.
- `project_render` requires an appropriate render capability and an explicit
  render mode; it must not silently default external requests to full render.

### Trash handling

- Sizzle creation rejects missing and trashed capture IDs before creating or
  mutating a project.
- `sizzle:toggleScene`, sequence-beat mutation, and render enforce live-capture
  policy for external callers.
- A project containing a capture that is later trashed cannot render that
  capture through an external request.
- No resolver used by the external Sizzle path treats soft-deleted rows as
  readable without a future explicit trash-read capability.

### Render consent and authorization

- OAuth copy clearly discloses TTS/network use, possible provider charges,
  cache/user-directory writes, and project-state changes.
- Preview and full renders remain separate capabilities.
- Tests cover TTS secret access, artifact writes, and project updates under
  insufficient and sufficient grants.

### Audit integrity

- An original-derived export records both the export and original-source access
  distinction, without logging filenames, prompts, OCR, bytes, or bearer URLs.
- Failed original-derived exports record the correct attempted access outcome.
- Resource retrieval does not erase or obscure the original-source distinction.
- Search audit summaries do not store query text.

### Thread ownership

- Decide and document whether PwrSnap-owned chats are shared across humans and
  authorized clients or isolated per MCP client.
- If isolated, store and enforce an owner client ID for create, reuse, explicit
  thread selection, status, and preview resolution.
- If intentionally shared, surface that in consent/product copy and add tests
  proving the exact allowed sharing boundary.
- Cross-capture and cross-project anchor rejection must remain intact.

### Workflow completeness

- Signed media supports HTTP byte ranges for video, or the advertised Sizzle
  signed-URL workflow explicitly documents that seeking/ranges are unsupported.
- Video metadata does not advertise image-only composite/original export
  resources.
- Malformed local-agent settings follow the existing corruption-quarantine
  behavior without silently losing audit history.

## Verification Performed

The focused local suite passed before this findings document was written:

- 13 test files
- 127 tests
- `git diff --check origin/main...HEAD`

At the audited head, GitHub Build, Lint, Test, Desktop E2E, and Windows checks
were also green. Those passing checks do not cover the authorization failures
above.
