import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { CustomOAuth } from "@pwrsnap/shared";
import { boundedJson, DirectApiError, safeFetch } from "./transport";

export type OAuthTokens = { accessToken: string; refreshToken?: string; expiresAt?: number };

export async function exchangeTokens(config: CustomOAuth, fields: Record<string, string>, signal: AbortSignal): Promise<OAuthTokens> {
  const response = await safeFetch(config.tokenUrl, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, client_id: config.clientId, ...(config.resource ? { resource: config.resource } : {}) }),
    signal
  });
  const body = await boundedJson(response);
  if (typeof body.access_token !== "string" || !body.access_token || body.access_token.length > 16384 ||
      typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer") {
    throw new DirectApiError("OAuth server did not return a supported Bearer token.");
  }
  if (body.refresh_token !== undefined && (typeof body.refresh_token !== "string" || body.refresh_token.length > 16384)) {
    throw new DirectApiError("OAuth server returned an invalid refresh token.");
  }
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(typeof body.expires_in === "number" && body.expires_in >= 0 && Number.isFinite(body.expires_in)
      ? { expiresAt: Date.now() + body.expires_in * 1000 } : {})
  };
}

/** RFC 8252 loopback callback + S256 PKCE. Public native clients only; no client secret. */
export async function authorizeOAuth(config: CustomOAuth, openBrowser: (url: string) => Promise<void>, signal: AbortSignal): Promise<OAuthTokens> {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let accept: (code: string) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const codePromise = new Promise<string>((resolve, fail) => { accept = resolve; reject = fail; });
  // Attach immediately so abort during browser opening cannot become unhandled.
  void codePromise.catch(() => undefined);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-security-policy", "default-src 'none'");
    if (req.method !== "GET" || url.pathname !== "/oauth/callback" || url.searchParams.get("state") !== state) {
      res.writeHead(400).end("Invalid OAuth callback."); return;
    }
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error") || !code || code.length > 8192) {
      res.writeHead(400).end("Authorization failed. Return to PwrSnap.");
      reject(new DirectApiError("OAuth authorization was declined or invalid.")); return;
    }
    res.end("Authorization received. You may return to PwrSnap."); accept(code);
  });
  const abort = (): void => reject(new DirectApiError("OAuth sign-in cancelled or timed out."));
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new DirectApiError("OAuth sign-in cancelled.");
    await new Promise<void>((resolve, fail) => {
      server.once("error", fail);
      server.listen(config.callbackPort, "127.0.0.1", () => { server.off("error", fail); resolve(); });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new DirectApiError("OAuth callback could not start.");
    const redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
    const url = new URL(config.authorizationUrl);
    url.search = new URLSearchParams({ response_type: "code", client_id: config.clientId,
      redirect_uri: redirect, scope: config.scopes, state, code_challenge: challenge,
      code_challenge_method: "S256", ...(config.resource ? { resource: config.resource } : {}) }).toString();
    await openBrowser(url.href);
    const code = await codePromise;
    return await exchangeTokens(config, { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier }, signal);
  } catch (e) {
    if (e instanceof DirectApiError) throw e;
    throw new DirectApiError("OAuth sign-in failed. Check client registration and callback port.");
  } finally {
    signal.removeEventListener("abort", abort);
    server.close(); server.closeAllConnections();
  }
}
