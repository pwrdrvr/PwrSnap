import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CommandContext } from "../../command-bus";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (req: unknown, ctx: CommandContext) => Promise<unknown>>(),
  status: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), token: vi.fn(), invalidate: vi.fn(), write: vi.fn(),
  ensure: vi.fn(), discover: vi.fn(), setModels: vi.fn(), savedModels: [] as unknown[]
}));
vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));
vi.mock("../../command-bus", () => ({ bus: {
  register: (name: string, handler: (req: unknown, ctx: CommandContext) => Promise<unknown>) => mocks.handlers.set(name, handler)
} }));
vi.mock("../settings-handlers", () => ({
  getDesktopSettingsServices: () => ({ service: { write: mocks.write, read: async () => ({ ai: { customModels: mocks.savedModels } }) }, secrets: {} }),
  broadcastSettingsChanged: vi.fn()
}));
vi.mock("../custom-model-handlers", () => ({ getCustomModelService: () => ({
  ensureChatgptConnection: mocks.ensure, discover: mocks.discover, setModels: mocks.setModels
}) }));
vi.mock("../../ai/chatgpt-plan/session", () => ({
  serializeSession: (task: () => Promise<unknown>) => task(),
  publicStatus: mocks.status, signIn: mocks.signIn, signOut: mocks.signOut,
  planAccessToken: mocks.token, invalidatePlanSession: mocks.invalidate
}));
import { registerChatgptPlanHandlers } from "../chatgpt-plan-handlers";

const context = (principal: CommandContext["principal"]): CommandContext => ({ principal, signal: new AbortController().signal });
const handler = (name: string) => mocks.handlers.get(`chatgptPlan:${name}`)!;
const STATUS = { accountLabel: "Fixture", planGranted: true, backgroundConsent: false, welcomeSeen: false, signedIn: true, connectionId: "fixture-conn" };

beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.clear(); mocks.savedModels = [];
  registerChatgptPlanHandlers();
  mocks.status.mockResolvedValue(STATUS);
  mocks.token.mockResolvedValue("fixture-access");
  mocks.ensure.mockResolvedValue({ id: "fixture-conn" });
  mocks.discover.mockResolvedValue({ models: [
    { id: "fixture-cereal-1", displayName: "Cereal One", vision: true },
    { id: "fixture-cereal-2", displayName: null, vision: null }
  ] });
});

describe("SIWC verbs", () => {
  test("only the bridge can read the access token", async () => {
    for (const principal of ["ipc", "rpc", "mcp", "seeder"] as const) {
      const result = await handler("runtime")({}, context(principal));
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).not.toContain("fixture-access");
    }
    expect(mocks.token).not.toHaveBeenCalled();
    expect(await handler("invalidate")({}, context("ipc"))).toMatchObject({ ok: false });
    expect(await handler("runtime")({}, context("bridge"))).toEqual({ ok: true, value: { accessToken: "fixture-access" } });
  });

  test("RPC and MCP cannot sign in, sign out, change consent or read status", async () => {
    for (const name of ["login", "logout", "configure", "status"]) {
      for (const principal of ["rpc", "mcp"] as const)
        expect(await handler(name)({}, context(principal))).toMatchObject({ ok: false });
    }
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  test("first sign-in creates the connection and fills the pickers from the account's list", async () => {
    const result = await handler("login")({}, context("ipc"));
    expect(result).toEqual({ ok: true, value: STATUS });
    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.setModels).toHaveBeenCalledWith("fixture-conn", [
      expect.objectContaining({ modelId: "fixture-cereal-1", displayName: "Cereal One", capabilities: { vision: true, streaming: true } }),
      expect.objectContaining({ modelId: "fixture-cereal-2", displayName: "fixture-cereal-2", capabilities: { vision: null, streaming: true } })
    ]);
  });

  test("sign-in leaves saved models alone, and lists nothing without plan permission", async () => {
    mocks.savedModels = [{ connectionId: "fixture-conn" }];
    await handler("login")({}, context("ipc"));
    mocks.savedModels = [];
    mocks.status.mockResolvedValue({ ...STATUS, planGranted: false });
    await handler("login")({}, context("ipc"));
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.setModels).not.toHaveBeenCalled();
  });

  test("configure accepts only the two booleans", async () => {
    for (const input of [{ accessToken: "fixture" }, { backgroundConsent: "yes" }, { planGranted: true }, { accountLabel: "x" }])
      expect(await handler("configure")(input, context("ipc"))).toMatchObject({ ok: false });
    expect(mocks.write).not.toHaveBeenCalled();
    expect(await handler("configure")({ backgroundConsent: true }, context("ipc"))).toMatchObject({ ok: true });
    expect(mocks.write).toHaveBeenCalledWith({ ai: { chatgptPlan: { backgroundConsent: true } } });
  });
});
