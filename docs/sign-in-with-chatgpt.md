# Sign in with ChatGPT

PwrSnap is a free MIT local desktop app. Settings → AI Providers → Sign in
with ChatGPT offers **Continue with ChatGPT** and **Use your ChatGPT plan**
without a paid PwrSnap upgrade. [Learn more](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites).
Eligible Plus and Pro accounts can grant plan usage. Business and Enterprise
plan usage must not be assumed available. Signing in alone does not grant it.

When enabled, existing Codex jobs use this connection: annotations,
descriptions, smart filenames, sensitive-data scan, Library and reel chat,
and other current Codex text/image jobs. ACP and custom API connections retain
their own billing. Model choices come from the authenticated account's
`GET https://api.openai.com/v1/models`, keeping `visibility=list` in server order.
Use only a model that accepts images for image-bearing jobs; model names do
not establish that capability. SIWC does not support audio/video input,
transcription or realtime voice. Those features must use another provider.

Automatic post-capture enrichment remains off on this connection until
**Allow automatic post-capture use** is explicitly checked. This is separate
from the existing AI consent. Clicked AI actions are ordinary user activity.
The first plan grant shows a welcome. **Using ChatGPT plan** and **Manage usage**
identify billing; manage per-app caps/access at
[ChatGPT usage settings](https://chatgpt.com/settings/usage). Usage-limit errors
must lead there without guessing a reset time. PwrSnap never buys credits,
rotates accounts to avoid limits, resells plan access or offers a general API.

## Local protocol and credentials

Main implements the published public native-client protocol with Node crypto
and HTTP, not the noncommercial DevKit. There is no SIWC SDK dependency or
copied DevKit code/logo. The separate custom-provider OAuth helper is unused.
Initial registration uses `dynamic_agent_client`, PKCE S256, random state and
nonce, `agent_name_hint=PwrSnap`, a persisted opaque installation host id,
and `http://127.0.0.1:<port>/auth/callback`. Only the port varies. Subsequent
sign-ins use the issued `oaiapp_…` client id. ID-token validation checks the
JWKS signature, issuer, audience, expiration, nonce and returning identity.

Registration and tokens stay in the existing encrypted OS-user secret store;
no plaintext fallback, remote persistence or renderer/MCP token projection.
Status reads use public settings and the secret index without decrypting.
The agent process alone serializes rotating refresh tokens. A private
bridge-only command can supply the local Library main process in split mode.
Refresh restarts app-server; the next turn resumes the thread. A refresh
invalid-grant clears local tokens while retaining the issued registration and
host id. Network failures retain credentials. Sign-out sends the refresh token,
`token_type_hint=refresh_token` and issued client id to the discovered revocation
endpoint. Even if remote revocation is unconfirmed, local tokens are removed
and the UI says so. Signing out retains registration metadata for reconnecting.

The Codex child receives `ACCESS_TOKEN` and the published
`openai_chatgpt_plan` provider (`https://api.openai.com/v1`, Responses wire API,
`requires_openai_auth=false`, `supports_websockets=false`). Its client identity
is `PwrSnap`. No inference is sent to ChatGPT's backend-api. Enrichment keeps
its existing transport-enforced jail, bounded image input and deny handlers.

PwrSnap makes no direct SIWC Responses call. Codex owns Responses serialization:
`store=false`, `stream=true`, array input, instructions/developer messages,
and success only on completed turns. The preview rejects system message items,
`previous_response_id`, `background`, `conversation`, `max_output_tokens`,
`max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`,
`prompt_cache_retention`, `safety_identifier`, `temperature`, `top_p`,
`truncation`, `user` and other fields in the published limitations. No image
generation, Code Interpreter, hosted MCP, file search, native computer use or
Responses tool_search is added. Local PwrSnap editing tools remain on
user-facing chat; automatic enrichment has no tools.

## Operator steps before distribution

Implementation authorization is not an OpenAI eligibility ruling or acceptance
of the SIWC Terms. PwrSnap is free, public MIT and locally run, but signed
company distribution by PwrDrvr LLC has an unresolved OSS-versus-commercial
classification ambiguity. OpenAI's docs do not expressly resolve that case.

Harold must decide whether to distribute under the
[SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/), which say
integration/use constitutes agreement. He may seek clarification or optionally
submit the [interest form](https://openai.com/form/sign-in-with-chatgpt-interest/).
This implementation does not submit it, accept terms in a browser, buy anything
or sign in as him. He must manually verify with his own Plus or Pro account:
first registration, declined plan scope, returning sign-in, model choices,
clicked image/text jobs, consent-off automatic capture, consent-on capture,
refresh/thread resume, usage limits and remote disconnect/sign-out. CI uses
fake endpoints and fixtures only, with no live OpenAI calls or tokens.

Protocol references: [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
[app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server),
[preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations),
[errors](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery),
[UI guidance](https://developers.openai.com/siwc/ui-ux-guidelines).
