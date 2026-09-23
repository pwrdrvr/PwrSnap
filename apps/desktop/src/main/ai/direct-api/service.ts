import { customModelSchema, customProviderId, type CustomModel, type Settings, type SettingsPatch } from "@pwrsnap/shared";
import { credentialBinding, type CustomCredentials } from "./credentials";
import { DirectApiError } from "./transport";

type Store = { read(): Promise<Settings>; write(patch: SettingsPatch): Promise<Settings> };
export class CustomModelService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: Store, readonly credentials: CustomCredentials,
    private readonly changed: () => Promise<void>) {}
  async model(id: string): Promise<CustomModel> {
    const model = (await this.store.read()).ai.customModels?.find((m) => m.id === id);
    if (!model) throw new DirectApiError("Custom model was removed or is not configured.");
    return model;
  }
  private mutate<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => undefined).then(task);
    this.queue = result.catch(() => undefined); return result;
  }
  async save(input: CustomModel): Promise<CustomModel> {
    const parsed = customModelSchema.safeParse(input);
    if (!parsed.success) throw new DirectApiError("Invalid custom model configuration. Check required fields and use HTTPS or loopback HTTP URLs without query strings.");
    const model = parsed.data;
    return this.mutate(async () => {
      const models = (await this.store.read()).ai.customModels ?? [];
      const prior = models.find((m) => m.id === model.id);
      if (!prior && models.length >= 100) throw new DirectApiError("At most 100 custom models can be saved.");
      if (model.auth.type !== "none") {
        const id = model.auth.credentialId;
        const owners = models.filter((m) => m.auth.type !== "none" && m.auth.credentialId === id);
        if (owners.some((m) => credentialBinding(m) !== credentialBinding(model))) {
          throw new DirectApiError("The endpoint or OAuth configuration changed. Choose a new credential instead of reusing the existing one.");
        }
      }
      await this.store.write({ ai: { customModels: [...models.filter((m) => m.id !== model.id), model] } });
      await this.changed();
      if (prior?.auth.type !== undefined && prior.auth.type !== "none" &&
          (model.auth.type === "none" || model.auth.credentialId !== prior.auth.credentialId) &&
          !models.some((m) => m.id !== model.id && m.auth.type !== "none" && m.auth.credentialId === (prior.auth.type !== "none" ? prior.auth.credentialId : ""))) {
        await this.credentials.logout(prior);
      }
      return model;
    });
  }
  async remove(id: string): Promise<void> {
    return this.mutate(async () => {
      const settings = await this.store.read();
      const model = settings.ai.customModels?.find((m) => m.id === id);
      if (!model) return;
      const remaining = (settings.ai.customModels ?? []).filter((m) => m.id !== id);
      // Keep references in existing threads/defaults: a removed selection fails
      // closed instead of unexpectedly sending its next prompt to another vendor.
      await this.store.write({ ai: { customModels: remaining } });
      await this.changed();
      if (model.auth.type !== "none" && !remaining.some((m) => m.auth.type !== "none" &&
          m.auth.credentialId === (model.auth.type !== "none" ? model.auth.credentialId : ""))) {
        await this.credentials.logout(model);
      }
    });
  }
  async status(id: string): Promise<{ configured: boolean; sharedBy: number }> {
    const model = await this.model(id);
    const models = (await this.store.read()).ai.customModels ?? [];
    return { configured: await this.credentials.configured(model), sharedBy: model.auth.type === "none" ? 0 :
      models.filter((m) => m.auth.type !== "none" && model.auth.type !== "none" && m.auth.credentialId === model.auth.credentialId).length };
  }
  async setKey(id: string, value: string): Promise<void> {
    await this.mutate(async () => { await this.credentials.setKey(await this.model(id), value); });
    await this.changed();
  }
  async login(id: string, signal: AbortSignal): Promise<void> {
    const model = await this.model(id);
    await this.credentials.login(model, signal, async () => {
      const current = (await this.store.read()).ai.customModels ?? [];
      return current.some((m) => m.auth.type !== "none" && model.auth.type !== "none" &&
        m.auth.credentialId === model.auth.credentialId && credentialBinding(m) === credentialBinding(model));
    });
    await this.changed();
  }
  async logout(id: string): Promise<void> {
    await this.credentials.logout(await this.model(id)); await this.changed();
  }
  async selected(provider: string, modelId?: string): Promise<CustomModel> {
    const model = await this.model(provider.slice("custom:".length));
    if (provider !== customProviderId(model.id) || (modelId && modelId !== model.modelId)) {
      throw new DirectApiError("This chat's model configuration changed. Start a new chat with the saved model.");
    }
    return model;
  }
}
