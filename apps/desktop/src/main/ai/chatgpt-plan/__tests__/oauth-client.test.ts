import { describe, expect, test, vi } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { SiwcOAuthClient, OAuthFailure, authorizationUrl, newAttempt, parseCallback, emptyRegistration, hasPlanScope, PLAN_SCOPE, SCOPES, RESOURCE, withoutTokens, needsSignIn, type Discovery } from "../oauth-client";
const discovery: Discovery = { issuer: "https://auth.openai.com", authorization_endpoint: "https://auth.openai.com/oauth/authorize",
  token_endpoint: "https://auth.openai.com/api/accounts/oauth/token", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/oauth/revoke" };
const redirect = "http://127.0.0.1:12345/auth/callback";
const fixture = { hostId: "urn:uuid:fixture", clientId: "oaiapp_fixture", subject: "subject", scope: PLAN_SCOPE,
  accessToken: "fixture-access", refreshToken: "fixture-refresh", idToken: "fixture-id", expiresAt: 123 };

describe("SIWC public native protocol", () => {
  test("first registration uses dynamic entrypoint, host and actual app name, S256 and complete scopes", () => {
    const attempt = newAttempt(); const host = emptyRegistration();
    const url = new URL(authorizationUrl(discovery, host, attempt, redirect));
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe("PwrSnap");
    expect(url.searchParams.get("ext_agent_host_id")).toBe(host.hostId);
    expect(host.hostId).toMatch(/^urn:uuid:/);
    expect(url.searchParams.get("redirect_uri")).toBe(redirect);
    expect(url.searchParams.get("resource")).toBe(RESOURCE);
    expect(url.searchParams.get("scope")).toBe(SCOPES);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(attempt.verifier).digest("base64url"));
    expect(attempt.verifier.length).toBeGreaterThanOrEqual(43);
    expect(newAttempt().state).not.toBe(attempt.state);
    expect(url.searchParams.get("nonce")).toBe(attempt.nonce);
  });
  test("returning registration uses issued id and private id-token hint, no name hint", () => {
    const url = new URL(authorizationUrl(discovery, fixture, newAttempt(), redirect));
    expect(url.searchParams.get("client_id")).toBe("oaiapp_fixture");
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
    expect(url.searchParams.get("id_token_hint")).toBe("fixture-id");
    const noScope = new URL(authorizationUrl(discovery, { ...fixture, scope: "openid" }, newAttempt(), redirect));
    expect(noScope.searchParams.get("prompt")).toBe("consent");
  });
  test("callback rejects wrong path/state and missing/dynamic/mismatched client ids", () => {
    const valid = new URL(`${redirect}?state=s&code=fixture-code&client_id=oaiapp_fixture`);
    expect(parseCallback(valid, "s")).toEqual({ code: "fixture-code", clientId: "oaiapp_fixture" });
    expect(() => parseCallback(valid, "other")).toThrow(OAuthFailure);
    for (const url of [redirect.replace("/auth/callback", "/oauth/callback") + "?state=s&code=x&client_id=oaiapp_fixture",
      `${redirect}?state=s&code=x`, `${redirect}?state=s&code=x&client_id=dynamic_agent_client`, `${redirect}?state=s&error=access_denied`])
      expect(() => parseCallback(new URL(url), "s")).toThrow(OAuthFailure);
    expect(() => parseCallback(valid, "s", "oaiapp_other")).toThrow(OAuthFailure);
    expect(parseCallback(new URL(`${redirect}?state=s&code=x`), "s", fixture.clientId).clientId).toBe(fixture.clientId);
  });
  test("identity alone never grants plan permission; scope matching is exact", () => {
    expect(hasPlanScope("openid profile email")).toBe(false);
    expect(hasPlanScope(`${PLAN_SCOPE}.other`)).toBe(false);
    expect(hasPlanScope(SCOPES)).toBe(true);
    expect(withoutTokens(fixture)).toEqual({ hostId: fixture.hostId, clientId: fixture.clientId, subject: fixture.subject });
    expect(needsSignIn("invalid_grant")).toBe(true);
    expect(needsSignIn("network_error")).toBe(false);
    expect(needsSignIn("invalid_client")).toBe(false);
  });
  test("code exchange and refresh use form encoding, issued id/resource, no secret or refresh scopes", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: "fixture-new", refresh_token: "fixture-rotated", expires_in: 3600, scope: PLAN_SCOPE })));
    const client = new SiwcOAuthClient(fetcher as typeof fetch);
    await client.tokens(discovery, { grant_type: "authorization_code", client_id: fixture.clientId, code: "fixture", code_verifier: "fixture-verifier", redirect_uri: redirect });
    await client.tokens(discovery, { grant_type: "refresh_token", client_id: fixture.clientId, refresh_token: fixture.refreshToken });
    const calls = fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe(discovery.token_endpoint);
    expect(calls[0]![1].body).toBeInstanceOf(URLSearchParams);
    expect((calls[0]![1].body as URLSearchParams).get("redirect_uri")).toBe(redirect);
    const refresh = calls[1]![1].body as URLSearchParams;
    expect(Object.fromEntries(refresh)).toEqual({ grant_type: "refresh_token", client_id: fixture.clientId, refresh_token: fixture.refreshToken, resource: RESOURCE });
    expect(calls[0]![1].redirect).toBe("error");
  });
  test("revocation posts refresh token and hint with issued id; empty 200 succeeds; failures reported", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    const client = new SiwcOAuthClient(fetcher as typeof fetch);
    expect(await client.revoke(discovery, fixture)).toBe(true);
    const calls = fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe(discovery.revocation_endpoint);
    expect(Object.fromEntries(calls[0]![1].body as URLSearchParams)).toEqual({ token: fixture.refreshToken, token_type_hint: "refresh_token", client_id: fixture.clientId });
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(await client.revoke(discovery, fixture)).toBe(false);
  });
  test("ID token verifies local RSA fixture, issuer/audience/expiry/nonce and signature", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-key", alg: "RS256", use: "sig" };
    const client = new SiwcOAuthClient(vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }))) as typeof fetch);
    const claims = { iss: discovery.issuer, aud: fixture.clientId, exp: Math.floor(Date.now() / 1000) + 300, nonce: "fixture-nonce", sub: "subject", email: "fixture@example.invalid" };
    function jwt(changes = {}, alg = "RS256") { const payload = [Buffer.from(JSON.stringify({ alg, kid: jwk.kid })).toString("base64url"), Buffer.from(JSON.stringify({ ...claims, ...changes })).toString("base64url")].join(".");
      return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}`; }
    expect(await client.identity(discovery, jwt(), fixture.clientId, claims.nonce)).toEqual({ subject: "subject", label: claims.email });
    for (const changes of [{ iss: "https://other.invalid" }, { aud: "oaiapp_other" }, { exp: 1 }, { nonce: "other" }, { sub: "" }])
      await expect(client.identity(discovery, jwt(changes), fixture.clientId, claims.nonce)).rejects.toThrow(OAuthFailure);
    await expect(client.identity(discovery, jwt({}, "none"), fixture.clientId, claims.nonce)).rejects.toThrow(OAuthFailure);
    const token = jwt(); await expect(client.identity(discovery, token.slice(0, -8) + "invalid", fixture.clientId, claims.nonce)).rejects.toThrow(OAuthFailure);
  });
});
