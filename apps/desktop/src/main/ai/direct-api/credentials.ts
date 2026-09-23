import { customCredentialSecretName, type CustomConnection, type DesktopSettingsSecretName } from "@pwrsnap/shared";
import type { DesktopSecretStore } from "../../settings/desktop-secret-store";
import { authorizeOAuth, exchangeTokens, type OAuthTokens } from "./oauth";
import { DirectApiError, safeFetch } from "./transport";

type Credential = { binding: string; key?: string; tokens?: OAuthTokens };
/** What a credential needs to know about where it is used. A connection
 *  owns at most one credential, stored under its id. */
export type CustomEndpoint = Pick<CustomConnection, "baseUrl" | "protocol" | "auth"> & { connectionId: string };
export function endpointOf(connection: CustomConnection): CustomEndpoint {
  return { connectionId: connection.id, baseUrl: connection.baseUrl, protocol: connection.protocol, auth: connection.auth };
}
/** A stored credential is only ever sent to the endpoint it was saved for.
 *  Repointing a connection changes its binding, and the old key stops reading. */
export function credentialBinding(endpoint: Pick<CustomEndpoint, "baseUrl" | "auth">): string {
  return JSON.stringify([endpoint.baseUrl.replace(/\/+$/, ""), endpoint.auth.type,
    endpoint.auth.type === "oauth" ? endpoint.auth.oauth : null]);
}
export function credentialName(connectionId: string): DesktopSettingsSecretName { return customCredentialSecretName(connectionId); }

/** One instance per main process; refreshes coalesce per credential, not per model. */
export class CustomCredentials {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly logins = new Map<string, AbortController>();
  constructor(private readonly secrets: Pick<DesktopSecretStore, "getValue" | "replace" | "clear" | "getStatus">,
    private readonly openBrowser: (url: string) => Promise<void>) {}

  private serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
    const promise = (this.queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(task);
    this.queues.set(id, promise);
    void promise.finally(() => { if (this.queues.get(id) === promise) this.queues.delete(id); }).catch(() => undefined);
    return promise;
  }
  async configured(endpoint: CustomEndpoint): Promise<boolean> {
    return endpoint.auth.type === "none" || (await this.secrets.getStatus(credentialName(endpoint.connectionId))).configured;
  }
  private async read(model: CustomEndpoint): Promise<Credential> {
    if (model.auth.type === "none") return { binding: credentialBinding(model) };
    const raw = await this.secrets.getValue(credentialName(model.connectionId));
    if (!raw) throw new DirectApiError("Credentials are unavailable. Unlock secure storage or sign in again.");
    let value: Credential;
    try { value = JSON.parse(raw) as Credential; } catch { throw new DirectApiError("Stored credentials could not be read."); }
    if (value.binding !== credentialBinding(model)) throw new DirectApiError("The saved credential belongs to this connection's previous address or sign-in settings. Enter the key or sign in again.");
    return value;
  }
  async setKey(model: CustomEndpoint, key: string): Promise<void> {
    if (model.auth.type !== "api-key") throw new DirectApiError("Select API key authentication first.");
    const id = model.connectionId;
    await this.serialize(id, async () => {
      await this.secrets.replace(credentialName(id), JSON.stringify({ binding: credentialBinding(model), key }));
    });
  }
  async headers(model: CustomEndpoint, signal?: AbortSignal): Promise<Record<string, string>> {
    if (signal?.aborted) throw new DirectApiError("Model request cancelled.");
    if (model.auth.type === "none") return {};
    const auth = model.auth;
    const id = model.connectionId;
    const pending = this.serialize(id, async () => {
      const value = await this.read(model);
      if (auth.type === "api-key") {
        if (!value.key) throw new DirectApiError("API key is not configured.");
        return model.protocol === "anthropic-messages" ? { "x-api-key": value.key } : { Authorization: `Bearer ${value.key}` };
      }
      let tokens = value.tokens;
      if (!tokens) throw new DirectApiError("Sign in to this connection first.");
      if (tokens.expiresAt !== undefined && tokens.expiresAt <= Date.now() + 30_000) {
        if (!tokens.refreshToken) throw new DirectApiError("OAuth login expired. Sign in again.");
        const next = await exchangeTokens(auth.oauth, { grant_type: "refresh_token", refresh_token: tokens.refreshToken }, AbortSignal.timeout(30_000));
        tokens = { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken };
        await this.secrets.replace(credentialName(id), JSON.stringify({ binding: value.binding, tokens }));
      }
      return { Authorization: `Bearer ${tokens.accessToken}` };
    });
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const abort = (): void => reject(new DirectApiError("Model request cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async login(model: CustomEndpoint, signal: AbortSignal, stillReferenced: () => Promise<boolean> = async () => true): Promise<void> {
    if (model.auth.type !== "oauth") throw new DirectApiError("Configure OAuth authorization metadata first.");
    const auth = model.auth;
    const id = model.connectionId;
    if (this.logins.has(id)) throw new DirectApiError("A sign-in is already in progress for this connection.");
    const controller = new AbortController();
    this.logins.set(id, controller);
    try {
      const combined = AbortSignal.any([controller.signal, signal, AbortSignal.timeout(180_000)]);
      const tokens = await authorizeOAuth(auth.oauth, this.openBrowser, combined);
      await this.serialize(id, async () => {
        if (combined.aborted || !(await stillReferenced())) throw new DirectApiError("OAuth sign-in cancelled, or the connection changed or was removed.");
        await this.secrets.replace(credentialName(id), JSON.stringify({ binding: credentialBinding(model), tokens }));
      });
    } finally { if (this.logins.get(id) === controller) this.logins.delete(id); }
  }
  /** Clears the connection's credential locally (and revokes OAuth tokens
   *  best-effort). Runs for `auth: none` too: a connection switched to no
   *  auth must not keep the key it held before. */
  async logout(model: CustomEndpoint): Promise<void> {
    const auth = model.auth;
    const id = model.connectionId;
    this.logins.get(id)?.abort();
    await this.serialize(id, async () => {
      let value: Credential | null = null;
      try { value = await this.read(model); } catch { /* Local deletion must remain possible. */ }
      // Clear locally even if the server is offline. The UI explains local-only logout.
      await this.secrets.clear(credentialName(id));
      if (auth.type === "oauth" && auth.oauth.revocationUrl && value?.tokens) {
        for (const token of new Set([value.tokens.refreshToken, value.tokens.accessToken])) {
          if (!token) continue;
          try {
            const res = await safeFetch(auth.oauth.revocationUrl, { method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ token, client_id: auth.oauth.clientId }), signal: AbortSignal.timeout(5000) });
            await res.body?.cancel();
          } catch { /* Revocation is best effort; credentials have been erased locally. */ }
        }
      }
    });
  }
}
