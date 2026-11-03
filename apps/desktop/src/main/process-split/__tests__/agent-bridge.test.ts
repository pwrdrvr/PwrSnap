import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ok } from "@pwrsnap/shared";
import { inMemoryChannelPair, type InMemoryBridgeChannel } from "../../process-bridge/channel";
import { BridgeEndpoint } from "../../process-bridge/endpoint";
import { LIBRARY_WINDOW_READY_CHANNEL } from "../event-relay";

const mocks = vi.hoisted(() => ({ channel: vi.fn(), windows: vi.fn(), quit: vi.fn(), dispatch: vi.fn(), cancel: vi.fn(), broadcast: vi.fn(), role: vi.fn() }));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: mocks.windows }, app: { quit: mocks.quit } }));
vi.mock("../../process-bridge/channel", async (original) => ({ ...await original<typeof import("../../process-bridge/channel")>(), channelForParentProcess: mocks.channel }));
vi.mock("../../command-bus", () => ({ bus: { dispatch: mocks.dispatch, cancel: mocks.cancel } }));
vi.mock("../../events", () => ({ broadcastRendererEventToLocalWindows: mocks.broadcast }));
vi.mock("../../process-role", () => ({ getRuntimeProcessRole: mocks.role }));
vi.mock("../../log", () => ({ getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

let bridge: typeof import("../agent-bridge");
let pipe: InMemoryBridgeChannel;
let parent: BridgeEndpoint;
const onEvent = vi.fn<(channel: string, payload: unknown) => void>();
const onCancel = vi.fn<(key: string) => void>();

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("process", { ...process, send: vi.fn(), connected: true });
  const [local, remote] = inMemoryChannelPair();
  pipe = local;
  mocks.channel.mockReturnValue(local);
  mocks.windows.mockReturnValue([]);
  mocks.dispatch.mockResolvedValue(ok("local"));
  mocks.role.mockReturnValue("library");
  parent = new BridgeEndpoint({ role: "agent", channel: remote, dispatchLocal: async () => ok("parent"), onRemoteEvent: onEvent, onRemoteCancel: onCancel });
  bridge = await import("../agent-bridge");
});

afterEach(() => {
  pipe.close();
  parent.close();
  vi.unstubAllGlobals();
});

describe("library-side agent bridge", () => {
  test("standalone role has no bridge and dispatch returns unavailable", async () => {
    vi.stubGlobal("process", { ...process, send: undefined });
    expect(bridge.connectAgentBridge()).toBe(false);
    expect(bridge.isAgentBridgeConnected()).toBe(false);
    expect(await bridge.dispatchToAgentProcess("capture:region", {}, { principal: "ipc" })).toMatchObject({ ok: false, error: { code: "bridge_unavailable" } });
    expect(mocks.channel).not.toHaveBeenCalled();
  });

  test("an already disconnected parent is not reported as connected", () => {
    vi.stubGlobal("process", { ...process, connected: false });
    expect(bridge.connectAgentBridge()).toBe(false);
    expect(bridge.isAgentBridgeConnected()).toBe(false);
  });

  test("connect is idempotent, preserves dispatch context, and relays readiness/cancellation/events", async () => {
    expect(bridge.connectAgentBridge()).toBe(true);
    expect(bridge.connectAgentBridge()).toBe(true);
    expect(mocks.channel).toHaveBeenCalledTimes(1);
    const context = { principal: "mcp", cancellationKey: "a", localAgent: { clientId: "client", capabilities: ["library.read"] } } as const;
    expect(await parent.dispatchRemote("library:focus", { a: 1 }, context)).toEqual(ok("local"));
    expect(mocks.dispatch).toHaveBeenCalledWith("library:focus", { a: 1 }, context);
    expect(await bridge.dispatchToAgentProcess("capture:region", {}, { principal: "ipc" })).toEqual(ok("parent"));
    bridge.forwardCancellationToAgent("a");
    bridge.forwardRendererEventToAgent("events:test", { a: 1 });
    bridge.signalLibraryWindowReady();
    await Promise.resolve();
    expect(onCancel).toHaveBeenCalledWith("a");
    expect(onEvent).toHaveBeenCalledWith("events:test", { a: 1 });
    expect(onEvent).toHaveBeenCalledWith(LIBRARY_WINDOW_READY_CHANNEL, {});
  });

  test("pipe closure settles in-flight work and quits an orphan with only hidden windows once", async () => {
    mocks.windows.mockReturnValue([{ isVisible: () => false }]);
    mocks.dispatch.mockReturnValue(new Promise(() => undefined));
    bridge.connectAgentBridge();
    const pending = parent.dispatchRemote("library:focus", {}, { principal: "ipc" });
    await Promise.resolve();
    pipe.close();
    pipe.close();
    expect(await pending).toMatchObject({ ok: false, error: { code: "bridge_closed" } });
    expect(bridge.isAgentBridgeConnected()).toBe(false);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
    expect(bridge.connectAgentBridge()).toBe(false);
    expect(await bridge.dispatchToAgentProcess("capture:region", {}, { principal: "ipc" })).toMatchObject({ ok: false, error: { code: "bridge_closed" } });
  });

  test("a visible orphan may finish its work and reports the dead bridge", () => {
    mocks.windows.mockReturnValue([{ isVisible: () => true }, { isVisible: () => false }]);
    bridge.connectAgentBridge();
    pipe.close();
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(bridge.isAgentBridgeConnected()).toBe(false);
  });

  test("ready signal is suppressed outside the library role", async () => {
    bridge.connectAgentBridge();
    mocks.role.mockReturnValue("combined");
    bridge.signalLibraryWindowReady();
    await Promise.resolve();
    expect(onEvent).not.toHaveBeenCalled();
  });
});
