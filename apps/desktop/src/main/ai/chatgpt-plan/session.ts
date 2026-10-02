import { planErrorMessage, requiresPlanSignIn } from "./errors";
import type { ChatgptPlanStatus, CodexModelOption } from "@pwrsnap/shared";
import { getDesktopSettingsStore } from "../../settings/desktop-settings-store";
import { getDesktopSettingsServices, broadcastSettingsChanged } from "../../handlers/settings-handlers";
import { getRuntimeProcessRole } from "../../process-role";
import { bus } from "../../command-bus";
import { SiwcOAuthClient, OAuthFailure, emptyRegistration, hasPlanScope, needsSignIn, withoutTokens, type Registration } from "./oauth-client";

// The agent process alone owns writes/refresh, including in split mode.
let queue: Promise<unknown> = Promise.resolve();
export function serializeSession<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(task); queue = next; return next;
}
const oauth = new SiwcOAuthClient();
export async function readRegistration(): Promise<Registration> {
  const { secrets } = getDesktopSettingsServices();
  const value = await secrets.getValue("chatgptPlanRegistration");
  return value ? JSON.parse(value) as Registration : emptyRegistration();
}
export async function saveRegistration(record: Registration): Promise<void> {
  const { service, secrets } = getDesktopSettingsServices();
  await secrets.replace("chatgptPlanRegistration", JSON.stringify(record));
  await broadcastSettingsChanged(service, secrets);
}
export async function publicStatus(): Promise<ChatgptPlanStatus> {
  const settings = await getDesktopSettingsStore().read();
  const { secrets } = getDesktopSettingsServices();
  const stored = await secrets.getStatus("chatgptPlanRegistration");
  return { label: settings.codex.chatgptAccountLabel ?? "ChatGPT account", connected: stored.configured && !!settings.codex.chatgptAccountLabel,
    planGranted: settings.codex.chatgptPlanGranted === true, enabled: settings.codex.chatgptPlanEnabled === true,
    backgroundConsent: settings.codex.chatgptBackgroundConsent === true, welcomeSeen: settings.codex.chatgptWelcomeSeen === true };
}
export async function updateProjection(record: Registration, enabled: boolean): Promise<void> {
  const { service, secrets } = getDesktopSettingsServices();
  await service.write({ codex: { chatgptAccountLabel: record.accessToken ? record.label ?? "ChatGPT account" : "",
    chatgptPlanGranted: hasPlanScope(record.scope), chatgptPlanEnabled: enabled } });
  await broadcastSettingsChanged(service, secrets);
}
export async function planRuntime(): Promise<{ accessToken: string; generation: string } | null> {
  if (getRuntimeProcessRole() === "library") {
    const result = await bus.dispatch("chatgptPlan:runtime", {}, { principal: "bridge" });
    if (!result.ok) throw new Error("ChatGPT plan session unavailable. Open AI Providers.");
    return result.value;
  }
  const settings = await getDesktopSettingsStore().read();
  if (!settings.codex.chatgptPlanEnabled) return null;
  return serializeSession(async () => {
    let record = await readRegistration();
    if (!hasPlanScope(record.scope) || !record.accessToken || !record.refreshToken || !record.clientId)
      throw new Error("ChatGPT plan permission is required. Continue with ChatGPT in AI Providers.");
    if ((record.expiresAt ?? 0) < Date.now() + 60_000) {
      try {
        const tokens = await oauth.tokens(await oauth.discovery(), { grant_type: "refresh_token",
          client_id: record.clientId, refresh_token: record.refreshToken });
        record = { ...record, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + tokens.expires_in * 1000, scope: tokens.scope ?? record.scope! };
        await saveRegistration(record);
        await updateProjection(record, true);
      } catch (error) {
        if (error instanceof OAuthFailure && needsSignIn(error.code)) {
          await saveRegistration(withoutTokens(record));
          // Keep billing selection, so revoked sessions never fall back to another account.
          await updateProjection(withoutTokens(record), true);
        }
        throw new Error("ChatGPT plan renewal failed. Open AI Providers to reconnect or retry.");
      }
    }
    if (!hasPlanScope(record.scope)) throw new Error("ChatGPT plan permission is required.");
    return { accessToken: record.accessToken!, generation: `${record.clientId}:${record.expiresAt}` };
  });
}
export async function accountModels(fetcher: typeof fetch = fetch): Promise<CodexModelOption[]> {
  const runtime = await planRuntime();
  if (!runtime) throw new Error("Enable ChatGPT plan usage first.");
  const response = await fetcher("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${runtime.accessToken}` },
    redirect: "error", signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("ChatGPT model catalog is too large.");
  if (!response.ok) {
    // Only known protocol codes leave main, never the provider's error body.
    const known = ["subscription_sharing_usage_limit_exceeded", "subscription_sharing_user_not_eligible",
      "subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable", "subscription_sharing_invalid_user",
      "chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context"];
    const code = known.find(code => text.includes(code));
    if (code && requiresPlanSignIn(code)) await invalidatePlanSession();
    throw new Error(code ? planErrorMessage(code) : "ChatGPT models unavailable. Open AI Providers or retry later.");
  }
  const data = JSON.parse(text) as { models: Array<{ slug: string; display_name: string; visibility: string; input_modalities?: string[] }> };
  if (!Array.isArray(data.models)) throw new Error("Invalid ChatGPT model catalog.");
  return data.models.filter(m => m && m.visibility === "list" && typeof m.slug === "string" && typeof m.display_name === "string").map((m, i) => ({ id: m.slug, model: m.slug,
    displayName: m.display_name, description: "ChatGPT plan", hidden: false, supportedReasoningEfforts: [],
    defaultReasoningEffort: null, inputModalities: (m.input_modalities ?? []).filter((s): s is "text" | "image" => s === "text" || s === "image"),
    defaultServiceTier: null, isDefault: i === 0 }));
}

/** Called only by the local main processes on an explicit revoked-grant signal. */
export async function invalidatePlanSession(): Promise<void> {
  if (getRuntimeProcessRole() === "library") {
    await bus.dispatch("chatgptPlan:invalidate", {}, { principal: "bridge" });
    return;
  }
  await serializeSession(async () => {
    const record = withoutTokens(await readRegistration());
    await saveRegistration(record);
    await updateProjection(record, true);
  });
}
