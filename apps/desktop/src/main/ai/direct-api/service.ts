import { randomUUID } from "node:crypto";
import {
  customConnectionInputSchema, customConnectionSchema, customModelInputSchema, customModelSchema, customProviderId,
  MAX_CUSTOM_CONNECTIONS, MAX_CUSTOM_MODELS, resolveCustomModel,
  type CustomConnection, type CustomConnectionInput, type CustomModel, type CustomModelDiscovery, type CustomModelInput,
  type DesktopSettingsSecretName, type ResolvedCustomModel, type SecretStatus, type Settings, type SettingsPatch
} from "@pwrsnap/shared";
import { credentialBinding, endpointOf, type CustomCredentials } from "./credentials";
import { DirectApiError, discoverApi, invokeApi } from "./transport";

type Store = { read(): Promise<Settings>; write(patch: SettingsPatch): Promise<Settings> };
/** Index-only secret reads, for the orphan sweep. Never decrypts. */
type SecretIndex = {
  getAllStatus(): Promise<Record<DesktopSettingsSecretName, SecretStatus>>;
  clear(name: DesktopSettingsSecretName): Promise<SecretStatus>;
};

/**
 * Main's owner of Direct API connections and the one credential each holds.
 * Every mutation is serialized, writes both lists together, and clears a
 * credential in the same step that stops referencing it — a connection
 * repointed at a new address or sign-in, or removed, never keeps its key.
 */
export class CustomModelService {
  private queue: Promise<unknown> = Promise.resolve();
  private swept = false;
  constructor(private readonly store: Store, readonly credentials: CustomCredentials,
    private readonly changed: () => Promise<void>, private readonly secrets?: SecretIndex) {}

  private async lists(): Promise<{ connections: CustomConnection[]; models: CustomModel[] }> {
    const ai = (await this.store.read()).ai;
    return { connections: ai.customConnections ?? [], models: ai.customModels ?? [] };
  }
  async connection(id: string): Promise<CustomConnection> {
    const connection = (await this.lists()).connections.find((c) => c.id === id);
    if (!connection) throw new DirectApiError("This connection was removed.");
    return connection;
  }
  async model(id: string): Promise<ResolvedCustomModel> {
    const { connections, models } = await this.lists();
    const model = resolveCustomModel(connections, models, id);
    if (!model) throw new DirectApiError("Custom model was removed or is not configured.");
    return model;
  }
  private mutate<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => undefined).then(async () => { await this.sweep(); return task(); });
    this.queue = result.catch(() => undefined); return result;
  }

  /** Once per process, before the first mutation: clear any stored
   *  connection credential no connection claims — left by a crash between a
   *  write and its logout. Local only; the connection that held it (and so
   *  any revocation URL) is gone. */
  private async sweep(): Promise<void> {
    if (this.swept || !this.secrets) return;
    this.swept = true;
    const ids = new Set((await this.lists()).connections.map((c) => c.id));
    const status = await this.secrets.getAllStatus();
    for (const name of Object.keys(status) as DesktopSettingsSecretName[]) {
      if (!name.startsWith("customModelCredential:") || !status[name].configured) continue;
      if (!ids.has(name.slice("customModelCredential:".length))) await this.secrets.clear(name);
    }
  }

  async saveConnection(input: CustomConnectionInput): Promise<CustomConnection> {
    const parsed = customConnectionInputSchema.safeParse(input);
    if (!parsed.success) throw new DirectApiError("Check the connection: it needs a name, and an HTTPS address (or HTTP on this Mac) with no query string.");
    return this.mutate(async () => {
      const { connections, models } = await this.lists();
      const prior = parsed.data.id === undefined ? undefined : connections.find((c) => c.id === parsed.data.id);
      if (parsed.data.id !== undefined && !prior) throw new DirectApiError("This connection was removed.");
      if (!prior && connections.length >= MAX_CUSTOM_CONNECTIONS) throw new DirectApiError(`At most ${MAX_CUSTOM_CONNECTIONS} connections can be saved.`);
      const next = customConnectionSchema.parse({ ...parsed.data, id: prior?.id ?? randomUUID() });
      await this.store.write({ ai: { customConnections: prior
        ? connections.map((c) => (c.id === next.id ? next : c)) : [...connections, next], customModels: models } });
      await this.changed();
      if (prior && credentialBinding(prior) !== credentialBinding(next)) {
        await this.credentials.logout(endpointOf(prior));
        await this.changed();
      }
      return next;
    });
  }

  async removeConnection(id: string): Promise<void> {
    return this.mutate(async () => {
      const { connections, models } = await this.lists();
      const connection = connections.find((c) => c.id === id);
      if (!connection) return;
      // Job defaults and chat threads keep pointing at the removed models: a
      // removed selection fails closed instead of sending its next prompt to
      // another vendor.
      await this.store.write({ ai: {
        customConnections: connections.filter((c) => c.id !== id),
        customModels: models.filter((m) => m.connectionId !== id) } });
      await this.changed();
      await this.credentials.logout(endpointOf(connection));
      await this.changed();
    });
  }

  /** Replaces the connection's models with exactly `inputs`. An entry with a
   *  known id keeps it, so jobs routed to that model stay routed. */
  async setModels(connectionId: string, inputs: CustomModelInput[]): Promise<CustomModel[]> {
    const parsed = inputs.map((m) => customModelInputSchema.safeParse(m));
    if (parsed.some((p) => !p.success)) throw new DirectApiError("Each model needs an id and a name in pickers.");
    return this.mutate(async () => {
      const { connections, models } = await this.lists();
      if (!connections.some((c) => c.id === connectionId)) throw new DirectApiError("This connection was removed.");
      const mine = new Set(models.filter((m) => m.connectionId === connectionId).map((m) => m.id));
      const seen = new Set<string>();
      const next: CustomModel[] = [];
      for (const p of parsed) {
        if (!p.success) continue;
        if (seen.has(p.data.modelId)) throw new DirectApiError(`${p.data.modelId} is listed twice.`);
        seen.add(p.data.modelId);
        const id = p.data.id !== undefined && mine.has(p.data.id) ? p.data.id : randomUUID();
        next.push(customModelSchema.parse({ ...p.data, id, connectionId }));
      }
      const others = models.filter((m) => m.connectionId !== connectionId);
      if (others.length + next.length > MAX_CUSTOM_MODELS) throw new DirectApiError(`At most ${MAX_CUSTOM_MODELS} models can be saved across all connections.`);
      await this.store.write({ ai: { customConnections: connections, customModels: [...others, ...next] } });
      await this.changed();
      return next;
    });
  }

  async setKey(connectionId: string, value: string): Promise<void> {
    await this.mutate(async () => { await this.credentials.setKey(endpointOf(await this.connection(connectionId)), value); });
    await this.changed();
  }
  async login(connectionId: string, signal: AbortSignal): Promise<void> {
    const connection = await this.connection(connectionId);
    await this.credentials.login(endpointOf(connection), signal, async () => {
      // The browser round-trip can outlast an edit. Tokens land only if the
      // connection still exists and still points where the sign-in began.
      const current = (await this.lists()).connections.find((c) => c.id === connectionId);
      return current !== undefined && credentialBinding(current) === credentialBinding(connection);
    });
    await this.changed();
  }
  async logout(connectionId: string): Promise<void> {
    await this.mutate(async () => { await this.credentials.logout(endpointOf(await this.connection(connectionId))); });
    await this.changed();
  }
  /** Lists what the endpoint serves. With a key, this is also the free check
   *  that the key works — no model turn, no tokens. */
  async discover(connectionId: string, signal?: AbortSignal): Promise<CustomModelDiscovery> {
    const endpoint = endpointOf(await this.connection(connectionId));
    return discoverApi(endpoint, await this.credentials.headers(endpoint, signal));
  }
  async test(id: string, signal: AbortSignal): Promise<{ message: string; ms: number }> {
    const model = await this.model(id);
    const started = performance.now();
    await invokeApi({ model, headers: await this.credentials.headers(model, signal), system: "This is a connection test.",
      messages: [{ role: "user", text: "Reply with OK." }], signal });
    return { message: "The model replied.", ms: Math.round(performance.now() - started) };
  }
  async selected(provider: string, modelId?: string): Promise<ResolvedCustomModel> {
    const model = await this.model(provider.slice("custom:".length));
    if (provider !== customProviderId(model.id) || (modelId && modelId !== model.modelId)) {
      throw new DirectApiError("This chat's model configuration changed. Start a new chat with the saved model.");
    }
    return model;
  }
}
