import { shell } from "electron";
import { ok, err } from "@pwrsnap/shared";
import { bus, type CommandContext } from "../command-bus";
import { getDesktopSettingsServices, broadcastSettingsChanged } from "./settings-handlers";
import { SiwcOAuthClient, withoutTokens, hasPlanScope } from "../ai/chatgpt-plan/oauth-client";
import { serializeSession, readRegistration, saveRegistration, updateProjection, publicStatus, planRuntime, accountModels, invalidatePlanSession } from "../ai/chatgpt-plan/session";

export function localSiwcRequest(ctx: Pick<CommandContext, "principal">): boolean {
  return ctx.principal === "ipc" || ctx.principal === "bridge";
}
const denied = () => err({ kind: "permission" as const, code: "local_settings_only", message: "Use local AI Providers settings." });
const failed = () => err({ kind: "settings" as const, code: "chatgpt_plan_unavailable",
  message: "ChatGPT plan connection unavailable. Reconnect in AI Providers or retry later." });
export function registerChatgptPlanHandlers(): void {
  const oauth = new SiwcOAuthClient();
  bus.register("chatgptPlan:status", async (req, ctx) => {
    if (!localSiwcRequest(ctx) || Object.keys(req).length) return denied();
    try { return ok(await publicStatus()); } catch { return failed(); }
  });
  bus.register("chatgptPlan:runtime", async (req, ctx) => {
    if (ctx.principal !== "bridge" || Object.keys(req).length) return denied();
    try { return ok(await planRuntime()); } catch { return failed(); }
  });
  bus.register("chatgptPlan:invalidate", async (req, ctx) => {
    if (ctx.principal !== "bridge" || Object.keys(req).length) return denied();
    try { await invalidatePlanSession(); return ok(undefined); } catch { return failed(); }
  });
  bus.register("chatgptPlan:login", async (req, ctx) => {
    if (!localSiwcRequest(ctx) || Object.keys(req).length) return denied();
    try {
      return await serializeSession(async () => {
        const record = await readRegistration();
        // Persist the opaque installation host id before opening the browser.
        await saveRegistration(record);
        const connected = await oauth.signIn(record, url => shell.openExternal(url), clientId => saveRegistration({ ...record, clientId }));
        await saveRegistration(connected);
        await updateProjection(connected, hasPlanScope(connected.scope));
        return ok(await publicStatus());
      });
    } catch { return failed(); }
  });
  bus.register("chatgptPlan:logout", async (req, ctx) => {
    if (!localSiwcRequest(ctx) || Object.keys(req).length) return denied();
    try {
      return await serializeSession(async () => {
        const record = await readRegistration();
        let revocationConfirmed = false;
        try { revocationConfirmed = await oauth.revoke(await oauth.discovery(), record); } catch { /* still clear local tokens */ }
        await saveRegistration(withoutTokens(record));
        await updateProjection(withoutTokens(record), false);
        return ok({ revocationConfirmed });
      });
    } catch { return failed(); }
  });
  bus.register("chatgptPlan:configure", async (req, ctx) => {
    if (!localSiwcRequest(ctx) || !req || Object.entries(req).some(([key, value]) =>
      !["enabled", "backgroundConsent", "welcomeSeen"].includes(key) || typeof value !== "boolean")) return denied();
    try {
      return await serializeSession(async () => {
        const { service, secrets } = getDesktopSettingsServices();
        await service.write({ codex: {
          ...(req.enabled !== undefined ? { chatgptPlanEnabled: req.enabled } : {}),
          ...(req.backgroundConsent !== undefined ? { chatgptBackgroundConsent: req.backgroundConsent } : {}),
          ...(req.welcomeSeen !== undefined ? { chatgptWelcomeSeen: req.welcomeSeen } : {})
        } });
        await broadcastSettingsChanged(service, secrets);
        return ok(await publicStatus());
      });
    } catch { return failed(); }
  });
  bus.register("chatgptPlan:models", async (req, ctx) => {
    if (!localSiwcRequest(ctx) || Object.keys(req).length) return denied();
    try { return ok(await accountModels()); } catch { return failed(); }
  });
}
