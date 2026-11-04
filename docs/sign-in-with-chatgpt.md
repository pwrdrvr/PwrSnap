# Sign in with ChatGPT

PwrSnap is a free MIT desktop app that runs locally. **Continue with ChatGPT**
lets an eligible ChatGPT plan pay for PwrSnap's AI, with no API key, no Codex
install and no paid PwrSnap upgrade.
[Learn more](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites).
Eligible Plus and Pro accounts can grant plan usage. Business and Enterprise
plans may not offer it, and signing in does not grant it on its own.

## Shape: a Direct API connection, not an agent

Sign in with ChatGPT (SIWC) is a Direct API connection whose auth is
`{ type: "chatgpt" }`. PwrSnap calls `https://api.openai.com/v1/responses`
itself, with the plan's access token as the bearer, through the same
`customModels:*` path as any API-key connection. The connection's address
and protocol are fixed, and there is at most one. Picking its models works
the same way: they appear in every picker as `custom:<id>`, and Settings → AI
Features routes jobs to them.

So everything Direct API means applies here:

- **No tools.** Chat on this connection can discuss text and the current
  image. It cannot edit captures, browse the library or change reels. Those
  need an agent (Codex or ACP), which keeps its own sign-in and billing.
- **No harness.** No Codex child, no app-server, no ACP process is started
  for it. The agent harnesses are unchanged and unrelated.
- **Images only where the model says so.** Vision comes from the catalog's
  `input_modalities`. A model with no stated modalities is "unknown", and its
  name is never used to guess. SIWC does not take audio or video, and does not
  do transcription or realtime voice.

Settings → AI Providers offers the plan on the Connections card until the
connection exists. A first sign-in creates the connection and fills the
pickers from the account's `GET /v1/models` list: rows with
`visibility: "list"`, in server order, at most 20.

## The request

`invokeApi` in `direct-api/transport.ts` builds the body. For a chatgpt
connection it always sends `stream: true` and `store: false`, puts the system
prompt in `instructions`, and sends `input` as an array. It omits
`max_output_tokens`, which the preview rejects. It never sends
`previous_response_id`, `background`, `conversation`, `max_tool_calls`,
`metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`,
`safety_identifier`, `temperature`, `top_p`, `truncation`, `user` or tools.
A turn succeeds only on `response.completed`.

`CustomCredentials.headers` sends the token only when the connection's
address is exactly `https://api.openai.com/v1`, so an edited settings file
cannot send the token anywhere else.

## Errors

OpenAI returns an HTTP status and an `error.code`; a stream ends in
`response.failed` with `response.error.code`. `chatgpt-plan/errors.ts` turns
each documented code into a sentence. The code itself stays on
`DirectApiError.code` and is never shown. A usage limit reads as
`CHATGPT_USAGE_LIMIT_MESSAGE`, and the chat surfaces recognize that sentence
and offer **Manage usage**, never a guessed reset time. A code that means only
a new sign-in will help (`subscription_sharing_invalid_user`,
`chatpass_v2_scope_not_authorized`, `chatpass_v2_invalid_authorization_context`)
clears the local tokens, so Settings shows the connection signed out.

## Consent and disclosure

Automatic post-capture enrichment does not run on the plan until **Allow
automatic use for new captures** is on (`ai.chatgptPlan.backgroundConsent`).
The `codex:enrich` gate refuses an `auto-enrichment` trigger routed to a
chatgpt model without it (`chatgpt_background_consent_required`). This is in
addition to the general AI consent. Clicked actions are the user's own
requests and run without it.

OpenAI's UI guidelines fix the wording:

- the sign-in button says **Continue with ChatGPT**;
- the first ready visit shows **You're using your ChatGPT plan**, with
  **Got it** focused;
- **Using ChatGPT plan** appears under the chat's backend chips and as the
  connection's status;
- wherever the plan is offered: "Eligible usage in this app uses your ChatGPT
  plan." and "Manage usage in your ChatGPT settings.";
- **Manage usage** opens [ChatGPT usage settings](https://chatgpt.com/settings/usage).

The two OpenAI pages are allowed in `external-url-allowlist.ts` as exact
URLs, not as hosts. **The ChatGPT logo is not in the tree.** The guidelines
require it on the sign-in button, the welcome and the limit message; it has
to come from OpenAI's brand kit before distribution.

PwrSnap never buys credits, rotates accounts to avoid limits, resells plan
access or offers a general API. The MCP tool registry exposes no
`chatgptPlan:*` verb.

## Credentials and sessions

Main implements the published public native-client protocol with Node crypto
and HTTP (`chatgpt-plan/oauth-client.ts`). It has no SIWC SDK dependency and
copies no DevKit code or logo. Registration uses `dynamic_agent_client`, PKCE
S256, random state and nonce, `agent_name_hint=PwrSnap`, a persisted opaque
installation host id, and `http://127.0.0.1:<port>/auth/callback`. Later
sign-ins reuse the issued `oaiapp_…` client id. ID-token validation checks the
JWKS signature, issuer, audience, expiry, nonce and returning identity.

- The registration and tokens are one `DesktopSecretStore` secret,
  `chatgptPlanRegistration`. It has no plaintext fallback, and no renderer or
  MCP caller can read it.
- `ai.chatgptPlan` in settings holds only the account label and the
  `planGranted` / `backgroundConsent` / `welcomeSeen` booleans. It is
  main-owned: `settings:write` refuses it, and `chatgptPlan:configure` takes
  only the two user booleans. Status reads never decrypt.
- Refresh tokens rotate, so the agent process alone refreshes, serialized.
  In split mode the Library main process gets a token over the bridge-only
  `chatgptPlan:runtime` verb.
- A token within 60 s of expiry is refreshed before the request. A rejected
  refresh clears the tokens but keeps the registration and host id. A network
  failure keeps everything.
- Sign-out revokes the refresh token at the discovered endpoint. If OpenAI
  doesn't confirm, the local tokens are still removed and the UI says so.

## Operator steps before distribution

Implementing this is not an OpenAI eligibility ruling or an acceptance of the
SIWC Terms. PwrSnap is free, MIT and runs locally, but PwrDrvr LLC
distributes signed builds, and OpenAI's docs do not settle whether that counts
as open source or commercial use.

The maintainer must decide whether to distribute under the
[SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/), which say
that integrating or using it means agreement. They may ask OpenAI to clarify,
or submit the
[interest form](https://openai.com/form/sign-in-with-chatgpt-interest/).
Nothing in this change submits the form, accepts terms, buys anything or
signs in on anyone's behalf. Verify by hand with a real Plus or Pro account:

- first registration, a declined plan scope, and a returning sign-in;
- the model list, and clicked image and text jobs;
- a new capture with consent off, and with consent on;
- token refresh, a usage limit, and remote disconnect and sign-out.

CI uses loopback fakes and fixtures only, never live OpenAI calls or tokens.

Protocol references: [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
[preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations),
[errors](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery),
[UI guidance](https://developers.openai.com/siwc/ui-ux-guidelines).
