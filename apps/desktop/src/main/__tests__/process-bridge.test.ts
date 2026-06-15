// Agent ↔ library process bridge: request/response correlation, event
// relay, and failure semantics over the in-memory channel pair (which
// JSON round-trips every frame, mimicking the real Node IPC pipe).
//
// The repo-wide contract under test: bridge calls NEVER reject — every
// transport failure surfaces as Result.err, same as ipcMain transport.

import { describe, expect, test, vi } from "vitest";
import { err, ok, type PwrSnapError, type Result } from "@pwrsnap/shared";
import { inMemoryChannelPair, type BridgeChannel } from "../process-bridge/channel";
import { BridgeEndpoint, type BridgeLocalDispatch } from "../process-bridge/endpoint";
import type { BridgeMessage } from "../process-bridge/protocol";

const flush = async (): Promise<void> => {
  // In-memory delivery is a microtask per hop; a macrotask drains all hops.
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const unhandled: BridgeLocalDispatch = async (name) =>
  err({ kind: "validation", code: "unknown_command", message: `unknown command: ${name}` });

function endpointPair(options?: {
  agentDispatch?: BridgeLocalDispatch;
  libraryDispatch?: BridgeLocalDispatch;
  onAgentEvent?: (channel: string, payload: unknown) => void;
}): { agent: BridgeEndpoint; library: BridgeEndpoint; severChannel: () => void } {
  const [agentSide, librarySide] = inMemoryChannelPair();
  const agent = new BridgeEndpoint({
    role: "agent",
    channel: agentSide,
    dispatchLocal: options?.agentDispatch ?? unhandled,
    ...(options?.onAgentEvent ? { onRemoteEvent: options.onAgentEvent } : {})
  });
  const library = new BridgeEndpoint({
    role: "library",
    channel: librarySide,
    dispatchLocal: options?.libraryDispatch ?? unhandled
  });
  return { agent, library, severChannel: () => agentSide.close() };
}

describe("BridgeEndpoint", () => {
  test("round-trips a request to the peer's local dispatch", async () => {
    const agentDispatch = vi.fn<BridgeLocalDispatch>(async () => ok({ rows: [1, 2] }));
    const { library } = endpointPair({ agentDispatch });

    const result = await library.dispatchRemote("library:list", { page: 1 });

    expect(agentDispatch).toHaveBeenCalledWith("library:list", { page: 1 });
    expect(result).toEqual(ok({ rows: [1, 2] }));
  });

  test("exchanges hello frames and exposes the peer role", async () => {
    const { agent, library } = endpointPair();
    await flush();
    expect(agent.peerRole).toBe("library");
    expect(library.peerRole).toBe("agent");
  });

  test("concurrent requests resolve to their own responses", async () => {
    const agentDispatch: BridgeLocalDispatch = async (_name, req) =>
      ok({ echoed: (req as { n: number }).n });
    const { library } = endpointPair({ agentDispatch });

    const [first, second] = await Promise.all([
      library.dispatchRemote("capture:whatever", { n: 1 }),
      library.dispatchRemote("capture:whatever", { n: 2 })
    ]);
    expect(first).toEqual(ok({ echoed: 1 }));
    expect(second).toEqual(ok({ echoed: 2 }));
  });

  test("error results cross the bridge with cause stripped", async () => {
    const agentDispatch: BridgeLocalDispatch = async () =>
      err({
        kind: "library",
        code: "not_found",
        message: "no such capture",
        cause: new Error("stack that must not cross the pipe")
      });
    const { library } = endpointPair({ agentDispatch });

    const result = await library.dispatchRemote("library:get", { id: "x" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: "library",
        code: "not_found",
        message: "no such capture"
      });
      expect("cause" in result.error).toBe(false);
    }
  });

  test("a throwing local dispatch surfaces as Result.err, not a hang", async () => {
    const agentDispatch: BridgeLocalDispatch = async () => {
      throw new Error("wiring mistake");
    };
    const { library } = endpointPair({ agentDispatch });

    const result = await library.dispatchRemote("capture:region", {});

    expect(result).toEqual(
      err({ kind: "unknown", code: "bridge_dispatch_threw", message: "wiring mistake" })
    );
  });

  test("relays events to the peer's onRemoteEvent without echoing back", async () => {
    const onAgentEvent = vi.fn();
    const { agent, library } = endpointPair({ onAgentEvent });

    library.emitEvent("events:captures:changed", { changedIds: ["a"] });
    await flush();

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(onAgentEvent).toHaveBeenCalledWith("events:captures:changed", {
      changedIds: ["a"]
    });
    // No automatic re-forwarding: the library side registered no event
    // listener, and the agent must not have bounced the event back.
    expect(agent.peerRole).toBe("library");
  });

  test("relays cancellation keys to the peer's onRemoteCancel", async () => {
    const onCancel = vi.fn();
    const [agentSide, librarySide] = inMemoryChannelPair();
    new BridgeEndpoint({
      role: "agent",
      channel: agentSide,
      dispatchLocal: unhandled,
      onRemoteCancel: onCancel
    });
    const library = new BridgeEndpoint({
      role: "library",
      channel: librarySide,
      dispatchLocal: unhandled
    });

    library.cancelRemote("capture-123");
    await flush();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith("capture-123");
  });

  test("ignores non-bridge and malformed pipe traffic", async () => {
    const agentDispatch = vi.fn<BridgeLocalDispatch>(async () => ok(null));
    const [agentSide, librarySide] = inMemoryChannelPair();
    new BridgeEndpoint({ role: "agent", channel: agentSide, dispatchLocal: agentDispatch });
    const library = new BridgeEndpoint({
      role: "library",
      channel: librarySide,
      dispatchLocal: unhandled
    });

    // Other process.send users, garbage, and future-version frames.
    librarySide.send("not even an object" as unknown as BridgeMessage);
    librarySide.send({ totally: "unrelated" } as unknown as BridgeMessage);
    librarySide.send({ pwrsnapBridge: 99, kind: "request", id: 1, name: "x" } as unknown as BridgeMessage);
    librarySide.send({ pwrsnapBridge: 1, kind: "request", id: "bad", name: 5 } as unknown as BridgeMessage);
    await flush();

    expect(agentDispatch).not.toHaveBeenCalled();
    // The endpoint is still healthy after the garbage.
    expect(await library.dispatchRemote("capture:region", {})).toEqual(ok(null));
  });

  test("severed channel fails in-flight requests with bridge_closed", async () => {
    let resolveHandler: ((value: Result<unknown, PwrSnapError>) => void) | null = null;
    const agentDispatch: BridgeLocalDispatch = () =>
      new Promise((resolve) => {
        resolveHandler = resolve;
      });
    const { library, severChannel } = endpointPair({ agentDispatch });

    const inFlight = library.dispatchRemote("library:export", {});
    await flush();
    expect(resolveHandler).not.toBeNull();
    severChannel();

    const result = await inFlight;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("bridge_closed");
  });

  test("dispatch after close resolves bridge_closed immediately", async () => {
    const { library, severChannel } = endpointPair();
    severChannel();

    const result = await library.dispatchRemote("library:list", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("bridge_closed");
  });

  test("waitForPeer resolves on hello and immediately once known", async () => {
    const { agent, library } = endpointPair();

    const awaited = await agent.waitForPeer(1_000);
    expect(awaited).toEqual(ok("library"));
    // Already-known peer resolves without waiting.
    expect(await library.waitForPeer(0)).toEqual(ok("agent"));
  });

  test("waitForPeer times out as a Result when no hello ever arrives", async () => {
    const deadChannel: BridgeChannel = {
      send: () => true,
      onMessage: () => () => undefined,
      onClose: () => () => undefined
    };
    const endpoint = new BridgeEndpoint({
      role: "agent",
      channel: deadChannel,
      dispatchLocal: unhandled
    });

    const result = await endpoint.waitForPeer(5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("bridge_timeout");
  });

  test("waitForPeer fails with bridge_closed when the channel dies first", async () => {
    const [agentSide] = inMemoryChannelPair();
    const endpoint = new BridgeEndpoint({
      role: "agent",
      channel: agentSide,
      dispatchLocal: unhandled
    });

    const waiting = endpoint.waitForPeer(10_000);
    agentSide.close();

    const result = await waiting;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("bridge_closed");
  });

  test("send failure on a degraded channel resolves bridge_send_failed", async () => {
    // A channel whose pipe is gone but whose close event hasn't fired
    // yet — the window between child death and the exit event.
    const deadChannel: BridgeChannel = {
      send: () => false,
      onMessage: () => () => undefined,
      onClose: () => () => undefined
    };
    const endpoint = new BridgeEndpoint({
      role: "agent",
      channel: deadChannel,
      dispatchLocal: unhandled
    });

    const result = await endpoint.dispatchRemote("library:list", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("bridge_send_failed");
  });
});
