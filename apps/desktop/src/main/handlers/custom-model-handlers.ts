import { shell } from "electron";
import { z } from "zod";
import { customModelIdSchema, customModelSchema, err, ok, type CommandName, type Req, type Res } from "@pwrsnap/shared";
import { bus, type CommandContext } from "../command-bus";
import { broadcastSettingsChanged, getDesktopSettingsServices } from "./settings-handlers";
import { CustomCredentials } from "../ai/direct-api/credentials";
import { CustomModelService } from "../ai/direct-api/service";
import { DirectApiError, discoverApi, invokeApi } from "../ai/direct-api/transport";

let singleton: CustomModelService | undefined;
export function getCustomModelService(): CustomModelService {
  if (!singleton) {
    const { service, secrets } = getDesktopSettingsServices();
    singleton = new CustomModelService(service, new CustomCredentials(secrets, async (url) => {
      // URL is generated from validated, explicitly saved OAuth metadata only.
      // Never relax the generic external URL/navigation allowlist for it.
      await shell.openExternal(url);
    }), () => broadcastSettingsChanged(service, secrets));
  }
  return singleton;
}
const idRequest = z.object({ id: customModelIdSchema }).strict();
export function registerCustomModelHandlers(): void {
  function register<C extends CommandName>(name: C, schema: z.ZodType<Req<C>>,
    handler: (req: Req<C>, ctx: CommandContext, service: CustomModelService) => Promise<Res<C>>): void {
    bus.register(name, async (req, ctx) => {
      const parsed = schema.safeParse(req);
      if (!parsed.success) return err({ kind: "validation", code: "invalid_custom_model_request", message: "Invalid custom model request." });
      try { return ok(await handler(parsed.data, ctx, getCustomModelService())); }
      catch (e) { return err({ kind: "settings", code: "custom_model_failed",
        message: e instanceof DirectApiError ? e.message : "Custom model operation failed. Check secure storage availability and connection configuration." }); }
    });
  }
  register("customModels:save", z.object({ model: customModelSchema }).strict(), (req, _ctx, service) => service.save(req.model));
  register("customModels:remove", idRequest, async (req, _ctx, service) => { await service.remove(req.id); return undefined; });
  register("customModels:status", idRequest, (req, _ctx, service) => service.status(req.id));
  register("customModels:setKey", idRequest.extend({ value: z.string().min(1).max(16384).regex(/^[^\r\n\x00]+$/) }), async (req, _ctx, service) => {
    await service.setKey(req.id, req.value);
    return undefined;
  });
  register("customModels:login", idRequest, async (req, ctx, service) => {
    await service.login(req.id, ctx.signal);
    return undefined;
  });
  register("customModels:logout", idRequest, async (req, _ctx, service) => {
    await service.logout(req.id);
    return undefined;
  });
  register("customModels:models", idRequest, async (req, _ctx, service) => {
    const m = await service.model(req.id); return { models: [{ id: m.modelId, label: m.displayName, isDefault: true }] };
  });
  register("customModels:discover", idRequest, async (req, _ctx, service) => {
    const model = await service.model(req.id);
    return discoverApi(model, await service.credentials.headers(model));
  });
  register("customModels:test", idRequest, async (req, ctx, service) => {
    const model = await service.model(req.id);
    await invokeApi({ model, headers: await service.credentials.headers(model, ctx.signal), system: "This is a connection test.",
      messages: [{ role: "user", text: "Reply with OK." }], signal: ctx.signal });
    return { message: "Connection successful. The model returned text." };
  });
}
