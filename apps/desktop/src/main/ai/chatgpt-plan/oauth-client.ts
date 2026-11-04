// Independently authored public native OAuth client. No DevKit code or dependency.
import { createHash, randomBytes, randomUUID, createPublicKey, verify } from "node:crypto";
import { createServer } from "node:http";

export const RESOURCE = "https://api.openai.com/v1";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const ISSUER = "https://auth.openai.com";
export type Registration = {
  hostId: string;
  clientId?: string;
  subject?: string;
  label?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  scope?: string;
};
export type TokenReply = {
  access_token: string; refresh_token: string; id_token?: string;
  expires_in: number; scope?: string;
};
export type Discovery = {
  issuer: string; authorization_endpoint: string; token_endpoint: string;
  jwks_uri: string; revocation_endpoint: string;
};
export class OAuthFailure extends Error {
  constructor(readonly code: string) { super(`ChatGPT sign-in: ${code}`); }
}
export const needsSignIn = (code: string): boolean => [
  "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
  "refresh_token_invalidated", "refresh_token_reused"
].includes(code);
export const hasPlanScope = (scope: string | undefined): boolean =>
  scope?.split(/\s+/).includes(PLAN_SCOPE) === true;
export function newAttempt() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"), nonce: randomBytes(32).toString("base64url") };
}
export function authorizationUrl(discovery: Discovery, record: Registration,
  attempt: ReturnType<typeof newAttempt>, redirectUri: string): string {
  const url = new URL(discovery.authorization_endpoint);
  const params = new URLSearchParams({ client_id: record.clientId ?? "dynamic_agent_client",
    response_type: "code", redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE,
    state: attempt.state, nonce: attempt.nonce, code_challenge: attempt.challenge,
    code_challenge_method: "S256", ext_agent_host_id: record.hostId });
  if (!record.clientId) params.set("agent_name_hint", "PwrSnap");
  if (record.idToken) params.set("id_token_hint", record.idToken);
  if (record.clientId && !hasPlanScope(record.scope)) params.set("prompt", "consent");
  url.search = params.toString();
  return url.toString();
}
export function parseCallback(url: URL, state: string, existingClientId?: string) {
  if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state)
    throw new OAuthFailure("invalid_callback");
  if (url.searchParams.has("error")) throw new OAuthFailure("authorization_declined");
  const code = url.searchParams.get("code");
  const clientId = url.searchParams.get("client_id") ?? existingClientId;
  if (!code || !clientId || clientId === "dynamic_agent_client" || !/^oaiapp_[\w-]+$/.test(clientId))
    throw new OAuthFailure("registration_incomplete");
  if (existingClientId && clientId !== existingClientId) throw new OAuthFailure("client_mismatch");
  return { code, clientId };
}
function trustedEndpoint(url: string): string {
  if (new URL(url).origin !== ISSUER) throw new OAuthFailure("untrusted_endpoint");
  return url;
}
export class SiwcOAuthClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async discovery(): Promise<Discovery> {
    const data = await this.json(`${ISSUER}/.well-known/openid-configuration`) as Discovery;
    if (data.issuer !== ISSUER) throw new OAuthFailure("invalid_issuer");
    for (const endpoint of [data.authorization_endpoint, data.token_endpoint, data.jwks_uri, data.revocation_endpoint]) trustedEndpoint(endpoint);
    return data;
  }
  private async json(url: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    if (text.length > 1_000_000) throw new OAuthFailure("response_too_large");
    let data: Record<string, unknown>;
    try { data = JSON.parse(text) as Record<string, unknown>; } catch { throw new OAuthFailure("invalid_response"); }
    if (!response.ok) {
      const allowed = ["invalid_client", "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"];
      throw new OAuthFailure(typeof data.error === "string" && allowed.includes(data.error) ? data.error : "request_failed");
    }
    return data;
  }
  async tokens(discovery: Discovery, fields: Record<string, string>): Promise<TokenReply> {
    if (!/^oaiapp_[\w-]+$/.test(fields["client_id"] ?? "")) throw new OAuthFailure("invalid_client");
    const result = await this.json(trustedEndpoint(discovery.token_endpoint), { method: "POST",
      body: new URLSearchParams({ ...fields, resource: RESOURCE }) }) as TokenReply;
    if (typeof result.access_token !== "string" || !result.access_token || typeof result.refresh_token !== "string" || !result.refresh_token ||
      !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new OAuthFailure("invalid_token_response");
    return result;
  }
  async identity(discovery: Discovery, token: string, clientId: string, nonce: string) {
    const pieces = token.split(".");
    if (pieces.length !== 3) throw new OAuthFailure("invalid_id_token");
    const header = JSON.parse(Buffer.from(pieces[0]!, "base64url").toString()) as { alg?: string; kid?: string };
    const claims = JSON.parse(Buffer.from(pieces[1]!, "base64url").toString()) as { iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string; name?: string; email?: string };
    if (header.alg !== "RS256" || !header.kid) throw new OAuthFailure("invalid_id_token");
    const jwks = await this.json(trustedEndpoint(discovery.jwks_uri)) as { keys: Array<{ kid?: string; kty?: string; use?: string; alg?: string }> };
    const jwk = jwks.keys.find(k => k.kid === header.kid && k.kty === "RSA" && (k.use === undefined || k.use === "sig") && (k.alg === undefined || k.alg === "RS256"));
    if (!jwk || !verify("RSA-SHA256", Buffer.from(`${pieces[0]}.${pieces[1]}`),
      createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(pieces[2]!, "base64url")) ||
      claims.iss !== discovery.issuer || !(Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId) ||
      typeof claims.exp !== "number" || claims.exp <= Date.now() / 1000 || claims.nonce !== nonce || typeof claims.sub !== "string" || !claims.sub)
      throw new OAuthFailure("invalid_id_token");
    return { subject: claims.sub, label: (claims.email ?? claims.name ?? "ChatGPT account").slice(0, 200) };
  }
  async signIn(record: Registration, openExternal: (url: string) => Promise<void>, onIssued?: (clientId: string) => Promise<void>): Promise<Registration> {
    const discovery = await this.discovery();
    const attempt = newAttempt();
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); throw new OAuthFailure("callback_unavailable"); }
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const callback = new Promise<ReturnType<typeof parseCallback>>((resolve, reject) => {
        timeout = setTimeout(() => reject(new OAuthFailure("sign_in_timeout")), 5 * 60_000);
        timeout.unref();
        server.on("request", (request, response) => {
          const url = new URL(request.url ?? "/", redirectUri);
          if (request.method !== "GET" || request.url?.split("?")[0] !== "/auth/callback" || url.pathname !== "/auth/callback") { response.writeHead(404).end(); return; }
          if (url.searchParams.get("state") !== attempt.state) { response.writeHead(400).end("Invalid sign-in state"); return; }
          clearTimeout(timeout);
          try { const parsed = parseCallback(url, attempt.state, record.clientId); response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Return to PwrSnap."); resolve(parsed); }
          catch { response.writeHead(400).end("Sign-in was not completed."); reject(new OAuthFailure("invalid_callback")); }
        });
      });
      // Browser URL stays in main; it can contain an ID-token hint.
      void callback.catch(() => undefined);
      await openExternal(authorizationUrl(discovery, record, attempt, redirectUri));
      const { code, clientId } = await callback;
      if (!record.clientId && onIssued) await onIssued(clientId);
      const tokens = await this.tokens(discovery, { grant_type: "authorization_code", client_id: clientId,
        code, code_verifier: attempt.verifier, redirect_uri: redirectUri });
      if (!tokens.id_token) throw new OAuthFailure("missing_id_token");
      const identity = await this.identity(discovery, tokens.id_token, clientId, attempt.nonce);
      if (record.subject && identity.subject !== record.subject) throw new OAuthFailure("account_mismatch");
      return { ...record, clientId, ...identity, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
        idToken: tokens.id_token, expiresAt: Date.now() + tokens.expires_in * 1000, scope: tokens.scope ?? "" };
    } finally { clearTimeout(timeout); server.closeAllConnections(); server.close(); }
  }
  async revoke(discovery: Discovery, record: Registration): Promise<boolean> {
    if (!record.refreshToken || !record.clientId) return true;
    try {
      const response = await this.fetcher(trustedEndpoint(discovery.revocation_endpoint), { method: "POST", redirect: "error",
        signal: AbortSignal.timeout(20_000), body: new URLSearchParams({ token: record.refreshToken,
          token_type_hint: "refresh_token", client_id: record.clientId }) });
      return response.status === 200;
    } catch { return false; }
  }
}
export function emptyRegistration(): Registration { return { hostId: `urn:uuid:${randomUUID()}` }; }
export function withoutTokens(record: Registration): Registration {
  const { accessToken: _a, refreshToken: _r, idToken: _i, expiresAt: _e, scope: _s, ...retained } = record;
  return retained;
}
