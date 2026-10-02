import { beforeEach, describe, expect, test, vi } from "vitest";
import { PLAN_SCOPE } from "../oauth-client";
const fixture = vi.hoisted(() => ({ record: {} as Record<string, unknown>, settings: { codex: {
  chatgptPlanEnabled: true, chatgptPlanGranted: true, chatgptAccountLabel: "Fixture", chatgptBackgroundConsent: false, chatgptWelcomeSeen: false
} }, fetch: vi.fn(), getValue: vi.fn(), getStatus: vi.fn(), save: vi.fn(), role: "agent" }));
vi.mock("../oauth-client", async importOriginal => {
  const actual = await importOriginal<typeof import("../oauth-client")>();
  return { ...actual, SiwcOAuthClient: class extends actual.SiwcOAuthClient {
    constructor() { super(fixture.fetch as typeof fetch); }
  } };
});
vi.mock("../../../settings/desktop-settings-store", () => ({ getDesktopSettingsStore: () => ({ read: async () => fixture.settings }) }));
vi.mock("../../../handlers/settings-handlers", () => ({ getDesktopSettingsServices: () => ({
  service: { read: async () => fixture.settings, write: async (patch: typeof fixture.settings) => { Object.assign(fixture.settings.codex, patch.codex); } },
  secrets: { getValue: fixture.getValue, getStatus: fixture.getStatus, replace: fixture.save }
}), broadcastSettingsChanged: vi.fn() }));
vi.mock("../../../process-role", () => ({ getRuntimeProcessRole: () => fixture.role }));
vi.mock("../../../command-bus", () => ({ bus: { dispatch: vi.fn() } }));
import { planRuntime, publicStatus, serializeSession, accountModels } from "../session";
beforeEach(() => {
  fixture.settings.codex = { chatgptPlanEnabled: true, chatgptPlanGranted: true, chatgptAccountLabel: "Fixture", chatgptBackgroundConsent: false, chatgptWelcomeSeen: false };
  fixture.record = { hostId: "urn:uuid:fixture", clientId: "oaiapp_fixture", subject: "fixture", label: "Fixture",
    accessToken: "fixture-expired", refreshToken: "fixture-original-refresh", expiresAt: 1, scope: PLAN_SCOPE };
  fixture.getValue.mockImplementation(async () => JSON.stringify(fixture.record));
  fixture.getStatus.mockResolvedValue({ configured: true, lastSetAt: null });
  fixture.save.mockImplementation(async (_name: string, value: string) => { fixture.record = JSON.parse(value); });
  fixture.fetch.mockReset(); fixture.getValue.mockClear(); fixture.role = "agent";
  fixture.fetch.mockImplementation(async (url: string) => url.includes("openid-configuration")
    ? new Response(JSON.stringify({ issuer: "https://auth.openai.com", authorization_endpoint: "https://auth.openai.com/authorize", token_endpoint: "https://auth.openai.com/token", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" }))
    : new Response(JSON.stringify({ access_token: "fixture-renewed", refresh_token: "fixture-rotated", expires_in: 3600, scope: PLAN_SCOPE })));
});
describe("single-owner SIWC session", () => {
  test("account choices come from authenticated GET models and preserve list visibility/order", async () => {
    fixture.record.expiresAt = Date.now() + 3_600_000;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ models: [
      { slug: "fixture-hidden", display_name: "Hidden", visibility: "hidden" },
      { slug: "fixture-visible", display_name: "Visible", visibility: "list", input_modalities: ["text", "image"] },
      { slug: "fixture-other", display_name: "Other", visibility: "list" }
    ] })));
    const models = await accountModels(fetcher as typeof fetch);
    expect(models.map(m => m.model)).toEqual(["fixture-visible", "fixture-other"]);
    expect(models[0]?.inputModalities).toEqual(["text", "image"]);
    const calls = fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe("https://api.openai.com/v1/models");
    expect(calls[0]![1].headers).toEqual({ Authorization: "Bearer fixture-expired" });
    expect(calls[0]![1].body).toBeUndefined();
  });
  test("concurrent refresh serializes and persists rotated token before the next reader", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => planRuntime()));
    expect(results.every(r => r?.accessToken === "fixture-renewed")).toBe(true);
    const posts = fixture.fetch.mock.calls.filter(([url]) => url.endsWith("/token"));
    expect(posts).toHaveLength(1);
    expect((posts[0]![1].body as URLSearchParams).get("refresh_token")).toBe("fixture-original-refresh");
    expect(fixture.record.refreshToken).toBe("fixture-rotated");
    fixture.record.expiresAt = 1;
    await planRuntime();
    expect((fixture.fetch.mock.calls.at(-1)![1].body as URLSearchParams).get("refresh_token")).toBe("fixture-rotated");
  });
  test("invalid refresh clears tokens but preserves issued registration and billing choice", async () => {
    fixture.fetch.mockImplementation(async (url: string) => url.endsWith("/token")
      ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      : new Response(JSON.stringify({ issuer: "https://auth.openai.com", authorization_endpoint: "https://auth.openai.com/authorize", token_endpoint: "https://auth.openai.com/token", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" })));
    await expect(planRuntime()).rejects.toThrow("renewal failed");
    expect(fixture.record.accessToken).toBeUndefined(); expect(fixture.record.refreshToken).toBeUndefined();
    expect(fixture.record.clientId).toBe("oaiapp_fixture"); expect(fixture.record.hostId).toBe("urn:uuid:fixture");
    expect(fixture.settings.codex.chatgptPlanEnabled).toBe(true);
    await expect(planRuntime()).rejects.toThrow("permission is required");
  });
  test("network failure retains credentials and a failed serialized task does not poison the queue", async () => {
    fixture.fetch.mockRejectedValueOnce(new Error("fixture offline"));
    await expect(planRuntime()).rejects.toThrow("renewal failed");
    expect(fixture.record.refreshToken).toBe("fixture-original-refresh");
    expect(await serializeSession(async () => "next")).toBe("next");
  });
  test("missing plan scope blocks inference even with a valid access token; disabled selection never decrypts", async () => {
    fixture.record.scope = "openid profile";
    await expect(planRuntime()).rejects.toThrow("permission is required");
    expect(fixture.fetch).not.toHaveBeenCalled();
    fixture.getValue.mockClear(); fixture.settings.codex.chatgptPlanEnabled = false;
    expect(await planRuntime()).toBeNull(); expect(fixture.getValue).not.toHaveBeenCalled();
  });
  test("status is labels and booleans only and does not decrypt", async () => {
    const status = await publicStatus();
    expect(Object.keys(status).sort()).toEqual(["backgroundConsent", "connected", "enabled", "label", "planGranted", "welcomeSeen"]);
    expect(JSON.stringify(status)).not.toContain("fixture-expired");
    expect(fixture.getValue).not.toHaveBeenCalled();
  });
});
