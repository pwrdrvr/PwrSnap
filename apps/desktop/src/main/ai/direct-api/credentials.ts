import type { CustomModel, DesktopSettingsSecretName } from "@pwrsnap/shared";
import type { DesktopSecretStore } from "../../settings/desktop-secret-store";
import { authorizeOAuth, exchangeTokens, type OAuthTokens } from "./oauth";
import { DirectApiError, safeFetch } from "./transport";

type Credential = { binding: string; key?: string; tokens?: OAuthTokens };
export function credentialBinding(model: CustomModel): string {
  return JSON.stringify([model.baseUrl.replace(/\/+$/, ""), model.auth.type,
    model.auth.type === "oauth" ? model.auth.oauth : null]);
}
export function credentialName(id: string): DesktopSettingsSecretName { return `customModelCredential:${id}`; }

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
  async configured(model: CustomModel): Promise<boolean> {
    return model.auth.type === "none" || (await this.secrets.getStatus(credentialName(model.auth.credentialId))).configured;
  }
  private async read(model: CustomModel): Promise<Credential> {
    if (model.auth.type === "none") return { binding: credentialBinding(model) };
    const raw = await this.secrets.getValue(credentialName(model.auth.credentialId));
    if (!raw) throw new DirectApiError("Credentials are unavailable. Unlock secure storage or sign in again.");
    let value: Credential;
    try { value = JSON.parse(raw) as Credential; } catch { throw new DirectApiError("Stored credentials could not be read."); }
    if (value.binding !== credentialBinding(model)) throw new DirectApiError("These credentials belong to a different endpoint or OAuth configuration. Create a new credential.");
    return value;
  }
  async setKey(model: CustomModel, key: string): Promise<void> {
    if (model.auth.type !== "api-key") throw new DirectApiError("Select API key authentication first.");
    const id = model.auth.credentialId;
    await this.serialize(id, async () => {
      await this.secrets.replace(credentialName(id), JSON.stringify({ binding: credentialBinding(model), key }));
    });
  }
  async headers(model: CustomModel, signal?: AbortSignal): Promise<Record<string, string>> {
    if (signal?.aborted) throw new DirectApiError("Model request cancelled.");
    if (model.auth.type === "none") return {};
    const auth = model.auth;
    const pending = this.serialize(auth.credentialId, async () => {
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
        await this.secrets.replace(credentialName(auth.credentialId), JSON.stringify({ binding: value.binding, tokens }));
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
  async login(model: CustomModel, signal: AbortSignal, stillReferenced: () => Promise<boolean> = async () => true): Promise<void> {
    if (model.auth.type !== "oauth") throw new DirectApiError("Configure OAuth authorization metadata first.");
    const auth = model.auth;
    if (this.logins.has(auth.credentialId)) throw new DirectApiError("A sign-in is already in progress for this credential.");
    const controller = new AbortController();
    this.logins.set(auth.credentialId, controller);
    try {
      const combined = AbortSignal.any([controller.signal, signal, AbortSignal.timeout(180_000)]);
      const tokens = await authorizeOAuth(auth.oauth, this.openBrowser, combined);
      await this.serialize(auth.credentialId, async () => {
        if (combined.aborted || !(await stillReferenced())) throw new DirectApiError("OAuth sign-in cancelled or connection removed.");
        await this.secrets.replace(credentialName(auth.credentialId), JSON.stringify({ binding: credentialBinding(model), tokens }));
      });
    } finally { if (this.logins.get(auth.credentialId) === controller) this.logins.delete(auth.credentialId); }
  }
  async logout(model: CustomModel): Promise<void> {
    if (model.auth.type === "none") return;
    const auth = model.auth;
    this.logins.get(auth.credentialId)?.abort();
    await this.serialize(auth.credentialId, async () => {
      let value: Credential | null = null;
      try { value = await this.read(model); } catch { /* Local deletion must remain possible. */ }
      // Clear locally even if the server is offline. The UI explains local-only logout.
      await this.secrets.clear(credentialName(auth.credentialId));
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
