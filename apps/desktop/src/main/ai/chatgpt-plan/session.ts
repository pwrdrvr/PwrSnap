// Sign in with ChatGPT session: the one SIWC registration this install holds,
// its rotating tokens, and the public projection Settings shows. PwrSnap
// uses the plan through the Direct API path (a `chatgpt` connection calling
// api.openai.com/v1/responses itself). No agent harness is involved.
import { isChatgptConnection, type ChatgptPlanSettings, type ChatgptPlanStatus } from "@pwrsnap/shared";
import { getDesktopSettingsStore } from "../../settings/desktop-settings-store";
import { getDesktopSettingsServices, broadcastSettingsChanged } from "../../handlers/settings-handlers";
import { getRuntimeProcessRole } from "../../process-role";
import { bus } from "../../command-bus";
import { DirectApiError } from "../direct-api/transport";
import { SiwcOAuthClient, OAuthFailure, emptyRegistration, hasPlanScope, needsSignIn, withoutTokens, type Registration } from "./oauth-client";

// The agent process alone owns writes and refresh, including in split mode:
// refresh tokens rotate, so two processes refreshing at once would lose one.
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

const EMPTY: ChatgptPlanSettings = { accountLabel: "", planGranted: false, backgroundConsent: false, welcomeSeen: false };
/** Labels and booleans from settings. Never decrypts. */
export async function publicStatus(): Promise<ChatgptPlanStatus> {
  const settings = await getDesktopSettingsStore().read();
  const plan = { ...EMPTY, ...settings.ai.chatgptPlan };
  const connection = (settings.ai.customConnections ?? []).find(isChatgptConnection);
  return { ...plan, signedIn: plan.accountLabel !== "", connectionId: connection?.id ?? null };
}
export async function updateProjection(record: Registration): Promise<void> {
  const { service, secrets } = getDesktopSettingsServices();
  const signedIn = record.accessToken !== undefined;
  await service.write({ ai: { chatgptPlan: {
    accountLabel: signedIn ? record.label ?? "ChatGPT account" : "",
    planGranted: signedIn && hasPlanScope(record.scope)
  } } });
  await broadcastSettingsChanged(service, secrets);
}

/** Browser OAuth. Persists the installation host id before the browser
 *  opens, and the issued client id as soon as it is known. */
export async function signIn(openExternal: (url: string) => Promise<void>): Promise<void> {
  await serializeSession(async () => {
    const record = await readRegistration();
    await saveRegistration(record);
    const connected = await oauth.signIn(record, openExternal, (clientId) => saveRegistration({ ...record, clientId }));
    await saveRegistration(connected);
    await updateProjection(connected);
  });
}

/** Clears local tokens even when the revocation endpoint can't be reached;
 *  keeps the registration so signing in again reuses it. */
export async function signOut(): Promise<{ revocationConfirmed: boolean }> {
  return serializeSession(async () => {
    const record = await readRegistration();
    let revocationConfirmed = false;
    try { revocationConfirmed = await oauth.revoke(await oauth.discovery(), record); } catch { /* still clear local tokens */ }
    await saveRegistration(withoutTokens(record));
    await updateProjection(withoutTokens(record));
    return { revocationConfirmed };
  });
}

/** A current plan access token, refreshed when it is about to expire. */
export async function planAccessToken(): Promise<string> {
  if (getRuntimeProcessRole() === "library") {
    const result = await bus.dispatch("chatgptPlan:runtime", {}, { principal: "bridge" });
    if (!result.ok) throw new DirectApiError(result.error.message);
    return result.value.accessToken;
  }
  return serializeSession(async () => {
    let record = await readRegistration();
    if (!record.accessToken || !record.refreshToken || !record.clientId) {
      throw new DirectApiError("Sign in to ChatGPT in Settings → AI Providers → ChatGPT.");
    }
    if (!hasPlanScope(record.scope)) {
      throw new DirectApiError("PwrSnap doesn't have permission to use your ChatGPT plan. Continue with ChatGPT in Settings → AI Providers → ChatGPT to grant it.");
    }
    if ((record.expiresAt ?? 0) < Date.now() + 60_000) {
      try {
        const tokens = await oauth.tokens(await oauth.discovery(), { grant_type: "refresh_token",
          client_id: record.clientId, refresh_token: record.refreshToken });
        record = { ...record, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + tokens.expires_in * 1000, scope: tokens.scope ?? record.scope! };
        await saveRegistration(record);
        await updateProjection(record);
      } catch (error) {
        if (error instanceof OAuthFailure && needsSignIn(error.code)) {
          await saveRegistration(withoutTokens(record));
          await updateProjection(withoutTokens(record));
          throw new DirectApiError("Your ChatGPT sign-in expired. Sign in again in Settings → AI Providers → ChatGPT.");
        }
        throw new DirectApiError("Couldn't renew the ChatGPT sign-in. Check your connection and try again.");
      }
      if (!hasPlanScope(record.scope)) {
        throw new DirectApiError("PwrSnap doesn't have permission to use your ChatGPT plan. Continue with ChatGPT in Settings → AI Providers → ChatGPT to grant it.");
      }
    }
    return record.accessToken!;
  });
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
    await updateProjection(record);
  });
}
