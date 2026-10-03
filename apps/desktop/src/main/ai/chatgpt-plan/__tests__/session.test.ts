import { beforeEach, describe, expect, test, vi } from "vitest";
import { PLAN_SCOPE } from "../oauth-client";

const DISCOVERY = { issuer: "https://auth.openai.com", authorization_endpoint: "https://auth.openai.com/authorize",
  token_endpoint: "https://auth.openai.com/token", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" };
const signedInPlan = () => ({ accountLabel: "Fixture", planGranted: true, backgroundConsent: false, welcomeSeen: false });

const fixture = vi.hoisted(() => ({
  record: {} as Record<string, unknown>,
  settings: { ai: { chatgptPlan: {} as Record<string, unknown>, customConnections: [] as unknown[] } },
  fetch: vi.fn(), getValue: vi.fn(), save: vi.fn(), dispatch: vi.fn(), role: "agent"
}));
vi.mock("../oauth-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../oauth-client")>();
  return { ...actual, SiwcOAuthClient: class extends actual.SiwcOAuthClient {
    constructor() { super(fixture.fetch as typeof fetch); }
  } };
});
vi.mock("../../../settings/desktop-settings-store", () => ({ getDesktopSettingsStore: () => ({ read: async () => fixture.settings }) }));
vi.mock("../../../handlers/settings-handlers", () => ({ getDesktopSettingsServices: () => ({
  service: { read: async () => fixture.settings,
    write: async (patch: { ai: { chatgptPlan: Record<string, unknown> } }) => { Object.assign(fixture.settings.ai.chatgptPlan, patch.ai.chatgptPlan); } },
  secrets: { getValue: fixture.getValue, replace: fixture.save }
}), broadcastSettingsChanged: vi.fn() }));
vi.mock("../../../process-role", () => ({ getRuntimeProcessRole: () => fixture.role }));
vi.mock("../../../command-bus", () => ({ bus: { dispatch: fixture.dispatch } }));
import { invalidatePlanSession, planAccessToken, publicStatus, serializeSession, signOut } from "../session";

beforeEach(() => {
  fixture.settings.ai = { chatgptPlan: signedInPlan(), customConnections: [] };
  fixture.record = { hostId: "urn:uuid:fixture", clientId: "oaiapp_fixture", subject: "fixture", label: "Fixture",
    accessToken: "fixture-expired", refreshToken: "fixture-original-refresh", expiresAt: 1, scope: PLAN_SCOPE };
  fixture.getValue.mockReset().mockImplementation(async () => JSON.stringify(fixture.record));
  fixture.save.mockReset().mockImplementation(async (_name: string, value: string) => { fixture.record = JSON.parse(value); });
  fixture.dispatch.mockReset(); fixture.role = "agent";
  fixture.fetch.mockReset().mockImplementation(async (url: string) => url.includes("openid-configuration")
    ? new Response(JSON.stringify(DISCOVERY))
    : url.endsWith("/revoke") ? new Response(null, { status: 200 })
    : new Response(JSON.stringify({ access_token: "fixture-renewed", refresh_token: "fixture-rotated", expires_in: 3600, scope: PLAN_SCOPE })));
});

describe("SIWC session (direct API)", () => {
  test("concurrent requests refresh once and persist the rotated token before the next reader", async () => {
    const tokens = await Promise.all(Array.from({ length: 8 }, () => planAccessToken()));
    expect(tokens.every((t) => t === "fixture-renewed")).toBe(true);
    const posts = fixture.fetch.mock.calls.filter(([url]) => String(url).endsWith("/token"));
    expect(posts).toHaveLength(1);
    expect((posts[0]![1].body as URLSearchParams).get("refresh_token")).toBe("fixture-original-refresh");
    expect(fixture.record.refreshToken).toBe("fixture-rotated");
    fixture.record.expiresAt = 1;
    await planAccessToken();
    expect((fixture.fetch.mock.calls.at(-1)![1].body as URLSearchParams).get("refresh_token")).toBe("fixture-rotated");
  });

  test("a token that is not about to expire is used as is", async () => {
    fixture.record.expiresAt = Date.now() + 3_600_000;
    expect(await planAccessToken()).toBe("fixture-expired");
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  test("a rejected refresh clears tokens, keeps the registration, and asks the user to sign in again", async () => {
    fixture.fetch.mockImplementation(async (url: string) => String(url).endsWith("/token")
      ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      : new Response(JSON.stringify(DISCOVERY)));
    await expect(planAccessToken()).rejects.toThrow("sign-in expired");
    expect(fixture.record.accessToken).toBeUndefined();
    expect(fixture.record.refreshToken).toBeUndefined();
    expect(fixture.record.clientId).toBe("oaiapp_fixture");
    expect(fixture.record.hostId).toBe("urn:uuid:fixture");
    expect(fixture.settings.ai.chatgptPlan.accountLabel).toBe("");
    await expect(planAccessToken()).rejects.toThrow("Sign in to ChatGPT");
  });

  test("a network failure keeps the credentials and does not poison the queue", async () => {
    fixture.fetch.mockRejectedValueOnce(new Error("fixture offline"));
    await expect(planAccessToken()).rejects.toThrow("Couldn't renew");
    expect(fixture.record.refreshToken).toBe("fixture-original-refresh");
    expect(await serializeSession(async () => "next")).toBe("next");
  });

  test("a session without the plan scope is refused before any request", async () => {
    fixture.record.scope = "openid profile";
    await expect(planAccessToken()).rejects.toThrow("permission to use your ChatGPT plan");
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  test("the library process asks the agent over the bridge and never reads the secret", async () => {
    fixture.role = "library";
    fixture.dispatch.mockResolvedValue({ ok: true, value: { accessToken: "fixture-bridged" } });
    expect(await planAccessToken()).toBe("fixture-bridged");
    expect(fixture.dispatch).toHaveBeenCalledWith("chatgptPlan:runtime", {}, { principal: "bridge" });
    expect(fixture.getValue).not.toHaveBeenCalled();
  });

  test("status is labels and booleans only and does not decrypt", async () => {
    fixture.settings.ai.customConnections = [{ id: "fixture-conn", auth: { type: "chatgpt" } }];
    const status = await publicStatus();
    expect(status).toEqual({ ...signedInPlan(), signedIn: true, connectionId: "fixture-conn" });
    expect(fixture.getValue).not.toHaveBeenCalled();
  });

  test("sign out clears tokens even when revocation is unconfirmed", async () => {
    fixture.fetch.mockImplementation(async (url: string) => String(url).endsWith("/revoke")
      ? new Response(null, { status: 503 }) : new Response(JSON.stringify(DISCOVERY)));
    expect(await signOut()).toEqual({ revocationConfirmed: false });
    expect(fixture.record.accessToken).toBeUndefined();
    expect(fixture.record.refreshToken).toBeUndefined();
    expect(fixture.record.clientId).toBe("oaiapp_fixture");
    expect(fixture.settings.ai.chatgptPlan.accountLabel).toBe("");
    expect(fixture.settings.ai.chatgptPlan.planGranted).toBe(false);
  });

  test("invalidate drops the tokens so the next request asks for sign-in", async () => {
    await invalidatePlanSession();
    expect(fixture.record.accessToken).toBeUndefined();
    await expect(planAccessToken()).rejects.toThrow("Sign in to ChatGPT");
  });
});
