import { shell } from "electron";
import { DEFAULT_CUSTOM_MAX_OUTPUT_TOKENS, ok, err } from "@pwrsnap/shared";
import { bus, type CommandContext } from "../command-bus";
import { getDesktopSettingsServices, broadcastSettingsChanged } from "./settings-handlers";
import { getCustomModelService } from "./custom-model-handlers";
import { DirectApiError } from "../ai/direct-api/transport";
import {
  invalidatePlanSession, planAccessToken, publicStatus, serializeSession, signIn, signOut
} from "../ai/chatgpt-plan/session";

// Sign in with ChatGPT. The plan is used through a Direct API connection
// (`auth: { type: "chatgpt" }`) that these verbs create on first sign-in;
// requests then go through the `customModels:*` path like any connection.

export function localSiwcRequest(ctx: Pick<CommandContext, "principal">): boolean {
  return ctx.principal === "ipc" || ctx.principal === "bridge";
}
const denied = () => err({ kind: "permission" as const, code: "local_settings_only", message: "Use local AI Providers settings." });
const failed = (e?: unknown) => err({ kind: "settings" as const, code: "chatgpt_plan_unavailable",
  message: e instanceof DirectApiError ? e.message : "Couldn't reach ChatGPT. Check your connection and try again." });
/** The most models a first sign-in puts in the pickers. */
const FIRST_SIGN_IN_MODELS = 20;

export function registerChatgptPlanHandlers(): void {
  bus.register("chatgptPlan:status", async (req, ctx) => {
    if (!localSiwcRequest(ctx) || Object.keys(req).length) return denied();
    try { return ok(await publicStatus()); } catch (e) { return failed(e); }
  });
  bus.register("chatgptPlan:runtime", async (req, ctx) => {
    if (ctx.principal !== "bridge" || Object.keys(req).length) return denied();
    try { return ok({ accessToken: await planAccessToken() }); } catch (e) { return failed(e); }
  });
  bus.register("chatgptPlan:invalidate", async (req, ctx) => {
    if (ctx.principal !== "bridge" || Object.keys(req).length) return denied();
    try { await invalidatePlanSession(); return ok(undefined); } catch (e) { return failed(e); }
  });
  bus.register("chatgptPlan:login", async (req, ctx) => {
    if (!localSiwcRequest(ctx) || Object.keys(req).length) return denied();
    try {
      await signIn((url) => shell.openExternal(url));
      const service = getCustomModelService();
      const connection = await service.ensureChatgptConnection();
      const status = await publicStatus();
      // A first sign-in fills the pickers from the account's own list, in
      // OpenAI's order. Image input comes only from what the list says.
      const settings = await getDesktopSettingsServices().service.read();
      const saved = (settings.ai.customModels ?? []).filter((m) => m.connectionId === connection.id);
      if (status.planGranted && saved.length === 0) {
        try {
          const listed = (await service.discover(connection.id)).models.slice(0, FIRST_SIGN_IN_MODELS);
          await service.setModels(connection.id, listed.map((m) => ({
            displayName: m.displayName ?? m.id, modelId: m.id,
            capabilities: { vision: m.vision, streaming: true }, maxOutputTokens: DEFAULT_CUSTOM_MAX_OUTPUT_TOKENS
          })));
        } catch { /* The connection page lists them on request. */ }
      }
      return ok(await publicStatus());
    } catch (e) { return failed(e); }
  });
  bus.register("chatgptPlan:logout", async (req, ctx) => {
    if (!localSiwcRequest(ctx) || Object.keys(req).length) return denied();
    try { return ok(await signOut()); } catch (e) { return failed(e); }
  });
  bus.register("chatgptPlan:configure", async (req, ctx) => {
    if (!localSiwcRequest(ctx) || !req || Object.entries(req).some(([key, value]) =>
      !["backgroundConsent", "welcomeSeen"].includes(key) || typeof value !== "boolean")) return denied();
    try {
      return await serializeSession(async () => {
        const { service, secrets } = getDesktopSettingsServices();
        await service.write({ ai: { chatgptPlan: {
          ...(req.backgroundConsent !== undefined ? { backgroundConsent: req.backgroundConsent } : {}),
          ...(req.welcomeSeen !== undefined ? { welcomeSeen: req.welcomeSeen } : {})
        } } });
        await broadcastSettingsChanged(service, secrets);
        return ok(await publicStatus());
      });
    } catch (e) { return failed(e); }
  });
}
