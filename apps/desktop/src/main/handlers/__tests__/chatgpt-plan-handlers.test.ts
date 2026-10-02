import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CommandContext } from "../../command-bus";
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (req: unknown, ctx: CommandContext) => Promise<unknown>>(),
  runtime: vi.fn(), status: vi.fn(), login: vi.fn(), revoke: vi.fn(), write: vi.fn(), save: vi.fn(), projection: vi.fn(), record: {
    hostId: "urn:uuid:fixture", clientId: "oaiapp_fixture", accessToken: "fixture-access", refreshToken: "fixture-refresh", idToken: "fixture-id", scope: "openid"
  } }));
vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));
vi.mock("../../command-bus", () => ({ bus: { register: (name: string, handler: (req: unknown, ctx: CommandContext) => Promise<unknown>) => mocks.handlers.set(name, handler) } }));
vi.mock("../settings-handlers", () => ({ getDesktopSettingsServices: () => ({ service: { write: mocks.write }, secrets: {} }), broadcastSettingsChanged: vi.fn() }));
vi.mock("../../ai/chatgpt-plan/session", () => ({ serializeSession: (task: () => Promise<unknown>) => task(),
  readRegistration: async () => mocks.record, saveRegistration: mocks.save, updateProjection: mocks.projection,
  publicStatus: mocks.status, planRuntime: mocks.runtime, accountModels: vi.fn(), invalidatePlanSession: vi.fn() }));
vi.mock("../../ai/chatgpt-plan/oauth-client", async importOriginal => {
  const actual = await importOriginal<typeof import("../../ai/chatgpt-plan/oauth-client")>();
  return { ...actual, SiwcOAuthClient: class { signIn = mocks.login; revoke = mocks.revoke; discovery = vi.fn(async () => ({})); } };
});
import { registerChatgptPlanHandlers } from "../chatgpt-plan-handlers";
const context = (principal: CommandContext["principal"]): CommandContext => ({ principal, signal: new AbortController().signal });
beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.clear(); registerChatgptPlanHandlers();
  mocks.status.mockResolvedValue({ label: "Fixture", connected: true, planGranted: false, enabled: false, backgroundConsent: false, welcomeSeen: false });
  mocks.login.mockResolvedValue(mocks.record);
  mocks.runtime.mockResolvedValue({ accessToken: "fixture-access", generation: "fixture" });
});
describe("SIWC command projections", () => {
  test("renderer/RPC/MCP cannot read runtime credentials, even after sign-in", async () => {
    const runtime = mocks.handlers.get("chatgptPlan:runtime")!;
    for (const principal of ["ipc", "rpc", "mcp", "seeder"] as const) {
      const result = await runtime({}, context(principal));
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).not.toContain("fixture-access");
    }
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(await mocks.handlers.get("chatgptPlan:invalidate")!({}, context("ipc"))).toMatchObject({ ok: false });
    expect(await runtime({}, context("bridge"))).toMatchObject({ ok: true, value: { accessToken: "fixture-access" } });
  });
  test("MCP/RPC cannot start browser OAuth, change consent, sign out or discover models", async () => {
    for (const name of ["login", "logout", "configure", "models", "status"]) {
      for (const principal of ["rpc", "mcp"] as const)
        expect(await mocks.handlers.get(`chatgptPlan:${name}`)!({}, context(principal))).toMatchObject({ ok: false });
    }
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  test("login never returns tokens or id-token-hint URLs and identity-only leaves plan disabled", async () => {
    const result = await mocks.handlers.get("chatgptPlan:login")!({}, context("ipc"));
    expect(result).toMatchObject({ ok: true, value: { planGranted: false } });
    expect(JSON.stringify(result)).not.toMatch(/fixture-access|fixture-refresh|fixture-id|id_token_hint/);
    expect(mocks.projection).toHaveBeenCalledWith(mocks.record, false);
    expect(mocks.save).toHaveBeenCalledWith(mocks.record);
  });
  test("unconfirmed revocation still clears local tokens and returns confirmation boolean", async () => {
    mocks.revoke.mockResolvedValueOnce(false);
    const result = await mocks.handlers.get("chatgptPlan:logout")!({}, context("ipc"));
    expect(result).toEqual({ ok: true, value: { revocationConfirmed: false } });
    const cleared = mocks.save.mock.calls.at(-1)![0];
    expect(cleared.accessToken).toBeUndefined(); expect(cleared.refreshToken).toBeUndefined(); expect(cleared.idToken).toBeUndefined();
    expect(cleared.clientId).toBe("oaiapp_fixture"); expect(cleared.hostId).toBe("urn:uuid:fixture");
  });
  test("configure rejects unknown keys and non-boolean consent at boundary", async () => {
    for (const input of [{ accessToken: "fixture" }, { backgroundConsent: "yes" }, { enabled: 1 }])
      expect(await mocks.handlers.get("chatgptPlan:configure")!(input, context("ipc"))).toMatchObject({ ok: false });
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
