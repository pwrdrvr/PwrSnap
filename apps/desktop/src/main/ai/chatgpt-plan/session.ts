import { createHash, randomUUID } from "node:crypto";
// Sign in with ChatGPT session: the one SIWC registration this install holds,
// its rotating tokens, and the public projection Settings shows. PwrSnap
// uses the plan through the Direct API path (a `chatgpt` connection calling
// api.openai.com/v1/responses itself). No agent harness is involved.
import { isChatgptConnection, type ChatgptPlanSettings, type ChatgptPlanStatus } from "@pwrsnap/shared";
import { getDesktopSettingsStore } from "../../settings/desktop-settings-store";
import { getDesktopSettingsServices, broadcastSettingsChanged } from "../../handlers/settings-handlers";
import { getRuntimeProcessRole } from "../../process-role";
import { CHATGPT_USAGE_LIMIT_CODE, requiresPlanSignIn } from "./errors";
import { DirectApiError } from "../direct-api/transport";
import { SiwcOAuthClient, OAuthFailure, emptyRegistration, canUsePlan, needsSignIn, withoutTokens, type Registration } from "./oauth-client";

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
export async function updateProjection(record: Registration, reset: { backgroundConsent?: boolean; usagePaused?: boolean } = {}): Promise<void> {
  const { service, secrets } = getDesktopSettingsServices();
  const signedIn = record.idToken !== undefined || record.accessToken !== undefined;
  await service.write({ ai: { chatgptPlan: {
    accountLabel: signedIn ? record.label ?? "ChatGPT account" : "",
    planGranted: canUsePlan(record),
    ...reset
  } } });
  await broadcastSettingsChanged(service, secrets);
}

/** Browser OAuth. Persists the installation host id before the browser
 *  opens, and the issued client id as soon as it is known. */
export async function signIn(openExternal: (url: string) => Promise<void>, replaceAccount = false): Promise<void> {
  await serializeSession(async () => {
    const record = await readRegistration();
    await saveRegistration(record);
    const registration = replaceAccount ? { hostId: record.hostId } : record;
    const connected = await oauth.signIn(registration, openExternal,
      replaceAccount ? undefined : (clientId) => saveRegistration({ ...record, clientId }));
    if (replaceAccount) {
      // Revoke the old account's consent before committing the replacement
      // credential. A partial write must never let it authorize the new account.
      await updateProjection(record, { backgroundConsent: false, usagePaused: false });
    }
    await saveRegistration(connected);
    await updateProjection(connected);
    if (replaceAccount && record.refreshToken && record.clientId !== connected.clientId) {
      try { await oauth.revoke(await oauth.discovery(), record); } catch { /* Old credentials were replaced locally. */ }
    }
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
    await updateProjection(withoutTokens(record), { usagePaused: false });
    return { revocationConfirmed };
  });
}

/** Legacy records have no generation. Their token supplies a stable, local-only identity. */
export function planCredentialGeneration(record: Registration): string {
  return record.credentialGeneration ?? createHash("sha256").update(record.accessToken ?? "").digest("hex");
}

/** A current plan credential, refreshed when it is about to expire. */
export async function planCredential(): Promise<{ accessToken: string; generation: string }> {
  if (getRuntimeProcessRole() === "library") {
    throw new DirectApiError("The ChatGPT credential is only available to the agent process.");
  }
  return serializeSession(async () => {
    let record = await readRegistration();
    if (!record.accessToken || !record.clientId) {
      throw new DirectApiError("Sign in to ChatGPT in Settings → AI Providers → ChatGPT.");
    }
    if (!canUsePlan(record)) {
      throw new DirectApiError("PwrSnap doesn't have permission to use your ChatGPT plan. Continue with ChatGPT in Settings → AI Providers → ChatGPT to grant it.");
    }
    if ((record.expiresAt ?? 0) < Date.now() + 60_000) {
      try {
        const tokens = await oauth.tokens(await oauth.discovery(), { grant_type: "refresh_token",
          client_id: record.clientId, refresh_token: record.refreshToken! });
        record = { ...record, accessToken: tokens.access_token, credentialGeneration: randomUUID(), refreshToken: tokens.refresh_token!,
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
      if (!canUsePlan(record)) {
        throw new DirectApiError("PwrSnap doesn't have permission to use your ChatGPT plan. Continue with ChatGPT in Settings → AI Providers → ChatGPT to grant it.");
      }
    }
    return { accessToken: record.accessToken!, generation: planCredentialGeneration(record) };
  });
}

/** Apply a provider failure only to the credential that actually sent the request. */
export async function notePlanFailure(generation: string, code: string | undefined): Promise<void> {
  if (getRuntimeProcessRole() === "library" ||
      (!requiresPlanSignIn(code) && code !== CHATGPT_USAGE_LIMIT_CODE)) return;
  await serializeSession(async () => {
    const record = await readRegistration();
    if (!record.accessToken || planCredentialGeneration(record) !== generation) return;
    if (code === CHATGPT_USAGE_LIMIT_CODE) {
      await updateProjection(record, { usagePaused: true });
      return;
    }
    const cleared = withoutTokens(record);
    await saveRegistration(cleared);
    await updateProjection(cleared);
  });
}
