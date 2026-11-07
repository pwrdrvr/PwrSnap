# A new permission invalidated saved Full Access roles

PwrSnap 1.2.5 added `sizzle.assets.import` to the canonical Full Access role.
Existing settings retained the previous nine-permission built-in definition.
The policy resolver requires built-in definitions to match the current canonical
profile, so it correctly refused the old definition as `builtin_role_drift`.
The missing piece was an upgrade for the previously shipped definition.

Fresh OAuth approval was also misleading: issuance checked structural role
validity, while request authentication additionally checked canonical built-in
definitions. The token endpoint could return 200 and the very first MCP request
return 401. PwrAgent interpreted rejection of a non-expiring PwrSnap credential
as revocation, even though the session had not been revoked. Repeating approval
against the same obsolete role repeated the failure.

The repair recognizes only the exact shipped pre-import Full Access profile.
It preserves that profile as a custom role and moves its existing session
references together, retaining their nine approved permissions, history limits,
budgets, revocation status and metadata. The canonical Full Access role becomes
available for new approval. Existing sessions do not silently gain arbitrary
local-file import access. Unknown built-in drift remains rejected.

The migration operates on raw settings rows so unknown fields survive, and runs
both during normalization and before forward-field preservation. The latter is
necessary because that preservation intentionally retains unpatched raw arrays:
a session-only write must not persist migrated role IDs alongside obsolete roles.
One extra profile slot accommodates an installation with the old 100-role limit.

OAuth issuance now checks the same complete policy as authentication before
storing a token. An invalid role fails the token exchange with `invalid_grant`
instead of producing an unusable credential.

Regression coverage uses generated settings on real temporary files, including
revoked sessions, unknown fields, ID/name collisions, a full role table,
session-only writes and process restarts. A real loopback OAuth/MCP test covers
registration, approval, PKCE, token exchange and the first SDK `tools/list`, then
verifies that a separate import-capable approval leaves prior access unchanged.

When adding another permission to a built-in role, include an explicit upgrade
for its previously shipped definition. Clients with fixed OAuth scope lists
also need to request the new permission; fixing role migration cannot grant a
scope the client never requested.
