import { shell } from "electron";
import { z } from "zod";
import { customConnectionInputSchema, customModelIdSchema, customModelInputSchema, err, ok, type CommandName, type Req, type Res } from "@pwrsnap/shared";
import { bus, type CommandContext } from "../command-bus";
import { broadcastSettingsChanged, getDesktopSettingsServices } from "./settings-handlers";
import { CustomCredentials } from "../ai/direct-api/credentials";
import { CustomModelService } from "../ai/direct-api/service";
import { DirectApiError } from "../ai/direct-api/transport";

let singleton: CustomModelService | undefined;
export function getCustomModelService(): CustomModelService {
  if (!singleton) {
    const { service, secrets } = getDesktopSettingsServices();
    singleton = new CustomModelService(service, new CustomCredentials(secrets, async (url) => {
      // URL is generated from validated, explicitly saved OAuth metadata only.
      // Never relax the generic external URL/navigation allowlist for it.
      await shell.openExternal(url);
    }), () => broadcastSettingsChanged(service, secrets), secrets);
  }
  return singleton;
}
const idRequest = z.object({ id: customModelIdSchema }).strict();
const connectionRequest = z.object({ connectionId: customModelIdSchema }).strict();
export function registerCustomModelHandlers(): void {
  function register<C extends CommandName>(name: C, schema: z.ZodType<Req<C>>,
    handler: (req: Req<C>, ctx: CommandContext, service: CustomModelService) => Promise<Res<C>>): void {
    bus.register(name, async (req, ctx) => {
      const parsed = schema.safeParse(req);
      if (!parsed.success) return err({ kind: "validation", code: "invalid_custom_model_request", message: "Invalid custom model request." });
      try { return ok(await handler(parsed.data, ctx, getCustomModelService())); }
      catch (e) {
        const rejected = e instanceof DirectApiError && (e.status === 401 || e.status === 403);
        return err({ kind: "settings", code: rejected ? "custom_model_unauthorized" : "custom_model_failed",
          message: e instanceof DirectApiError ? e.message : "Custom model operation failed. Check secure storage availability and connection configuration." });
      }
    });
  }
  register("customModels:saveConnection", z.object({ connection: customConnectionInputSchema }).strict(),
    (req, _ctx, service) => service.saveConnection(req.connection));
  register("customModels:removeConnection", connectionRequest, async (req, _ctx, service) => {
    await service.removeConnection(req.connectionId);
    return undefined;
  });
  register("customModels:setModels", connectionRequest.extend({ models: z.array(customModelInputSchema).max(100) }),
    (req, _ctx, service) => service.setModels(req.connectionId, req.models));
  register("customModels:setKey", connectionRequest.extend({ value: z.string().min(1).max(16384).regex(/^[^\r\n\x00]+$/) }), async (req, _ctx, service) => {
    await service.setKey(req.connectionId, req.value);
    return undefined;
  });
  register("customModels:login", connectionRequest, async (req, ctx, service) => {
    await service.login(req.connectionId, ctx.signal);
    return undefined;
  });
  register("customModels:logout", connectionRequest, async (req, _ctx, service) => {
    await service.logout(req.connectionId);
    return undefined;
  });
  register("customModels:discover", connectionRequest, (req, ctx, service) => service.discover(req.connectionId, ctx.signal));
  register("customModels:models", idRequest, async (req, _ctx, service) => {
    const m = await service.model(req.id); return { models: [{ id: m.modelId, label: m.displayName, isDefault: true }] };
  });
  register("customModels:test", idRequest, (req, ctx, service) => service.test(req.id, ctx.signal));
}
