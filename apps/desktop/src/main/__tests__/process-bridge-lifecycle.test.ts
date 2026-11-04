import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ok, type PwrSnapError, type Result } from "@pwrsnap/shared";
import { channelForChildProcess, channelForParentProcess, inMemoryChannelPair, type BridgeChannel } from "../process-bridge/channel";
import { BridgeEndpoint } from "../process-bridge/endpoint";
import { BRIDGE_PROTOCOL_VERSION, type BridgeMessage } from "../process-bridge/protocol";

const hello = { pwrsnapBridge: BRIDGE_PROTOCOL_VERSION, kind: "hello", role: "library", pid: 1 } as const;
const context = { principal: "bridge" } as const;

class ManualChannel implements BridgeChannel {
  messages = new Set<(message: unknown) => void>();
  closes = new Set<() => void>();
  send = vi.fn((_message: BridgeMessage) => true);
  onMessage(listener: (message: unknown) => void): () => void {
    this.messages.add(listener);
    return () => { this.messages.delete(listener); };
  }
  onClose(listener: () => void): () => void {
    this.closes.add(listener);
    return () => { this.closes.delete(listener); };
  }
  receive(message: BridgeMessage): void {
    for (const listener of [...this.messages]) listener(message);
  }
  disconnect(): void {
    for (const listener of [...this.closes]) listener();
  }
}

afterEach(() => vi.useRealTimers());

describe("bridge endpoint terminal ordering", () => {
  test("attaching to an already closed in-memory channel is terminal too", async () => {
    const [channel] = inMemoryChannelPair();
    channel.close();
    const endpoint = new BridgeEndpoint({ role: "agent", channel, dispatchLocal: async () => ok(null) });
    expect(await endpoint.dispatchRemote("x", {}, context)).toMatchObject({ ok: false, error: { code: "bridge_closed" } });
  });

  test("close after hello makes future readiness fail rather than blessing a dead peer", async () => {
    const channel = new ManualChannel();
    const endpoint = new BridgeEndpoint({ role: "agent", channel, dispatchLocal: async () => ok(null) });
    channel.receive(hello);
    expect(await endpoint.waitForPeer(100)).toEqual(ok("library"));
    channel.disconnect();
    expect(await endpoint.waitForPeer(100)).toMatchObject({ ok: false, error: { code: "bridge_closed" } });
    expect(channel.messages.size).toBe(0);
    expect(channel.closes.size).toBe(0);
  });

  test("close settles every pending request and waiter once and releases their timers", async () => {
    vi.useFakeTimers();
    const channel = new ManualChannel();
    const endpoint = new BridgeEndpoint({ role: "agent", channel, dispatchLocal: async () => ok(null) });
    const results = [endpoint.waitForPeer(10), endpoint.waitForPeer(20), endpoint.dispatchRemote("x", {}, context), endpoint.dispatchRemote("y", {}, context)];
    channel.disconnect();
    endpoint.close();
    channel.receive(hello);
    channel.receive({ pwrsnapBridge: BRIDGE_PROTOCOL_VERSION, kind: "response", id: 1, result: ok("late") });
    expect((await Promise.all(results)).every((result) => !result.ok && result.error.code === "bridge_closed")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(channel.messages.size).toBe(0);
  });

  test("one waiter timing out does not remove another waiter", async () => {
    vi.useFakeTimers();
    const channel = new ManualChannel();
    const endpoint = new BridgeEndpoint({ role: "agent", channel, dispatchLocal: async () => ok(null) });
    const first = endpoint.waitForPeer(10);
    const second = endpoint.waitForPeer(20);
    await vi.advanceTimersByTimeAsync(10);
    expect(await first).toMatchObject({ ok: false, error: { code: "bridge_timeout" } });
    channel.receive(hello);
    expect(await second).toEqual(ok("library"));
    expect(vi.getTimerCount()).toBe(0);
    endpoint.close();
  });

  test.each(["resolve", "reject"] as const)("an inbound handler that later %ss cannot send on a closed endpoint", async (settlement) => {
    const channel = new ManualChannel();
    let resolveHandler!: (result: Result<unknown, PwrSnapError>) => void;
    let rejectHandler!: (error: Error) => void;
    const handler = new Promise<Result<unknown, PwrSnapError>>((resolve, reject) => {
      resolveHandler = resolve;
      rejectHandler = reject;
    });
    const endpoint = new BridgeEndpoint({ role: "agent", channel, dispatchLocal: () => handler });
    channel.receive({ pwrsnapBridge: BRIDGE_PROTOCOL_VERSION, kind: "request", id: 1, name: "x", req: {}, context });
    endpoint.close();
    const sentAtClose = channel.send.mock.calls.length;
    if (settlement === "resolve") resolveHandler(ok("late"));
    else rejectHandler(new Error("late failure"));
    await handler.catch(() => undefined);
    await Promise.resolve();
    expect(channel.send).toHaveBeenCalledTimes(sentAtClose);
  });
});

class FakePipe extends EventEmitter {
  connected = true;
  callbacks: Array<(error: Error | null) => void> = [];
  send = vi.fn((_message: BridgeMessage, callback?: (error: Error | null) => void) => {
    if (callback) this.callbacks.push(callback);
    return true;
  });
}

describe.each(["child", "parent"] as const)("%s IPC channel", (side) => {
  function setup(): { pipe: FakePipe; channel: BridgeChannel } {
    const pipe = new FakePipe();
    const channel = side === "child"
      ? channelForChildProcess(pipe as unknown as ChildProcess)
      : channelForParentProcess(pipe as unknown as NodeJS.Process);
    return { pipe, channel };
  }

  test("backpressure still admits the queued request exactly once", async () => {
    const { pipe, channel } = setup();
    pipe.send.mockReturnValue(false);
    const endpoint = new BridgeEndpoint({ role: "agent", channel, dispatchLocal: async () => ok(null) });
    const request = endpoint.dispatchRemote("mutating:command", {}, context);
    pipe.emit("message", { pwrsnapBridge: BRIDGE_PROTOCOL_VERSION, kind: "response", id: 1, result: ok("committed") });
    expect(await request).toEqual(ok("committed"));
    expect(pipe.send.mock.calls.filter(([message]) => message.kind === "request")).toHaveLength(1);
    endpoint.close();
  });

  test("asynchronous send failure closes the channel and settles pending work without retry", async () => {
    const { pipe, channel } = setup();
    const closed = vi.fn();
    channel.onClose(closed);
    const endpoint = new BridgeEndpoint({ role: "agent", channel, dispatchLocal: async () => ok(null) });
    const request = endpoint.dispatchRemote("mutating:command", {}, context);
    expect(pipe.callbacks).toHaveLength(2);
    pipe.callbacks[1]!(new Error("pipe write failed"));
    expect(await request).toMatchObject({ ok: false, error: { code: "bridge_closed" } });
    pipe.emit("disconnect");
    if (side === "child") pipe.emit("exit", 1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(channel.send(hello)).toBe(false);
    expect(pipe.send.mock.calls.filter(([message]) => message.kind === "request")).toHaveLength(1);
  });

  test("a channel attached after disconnection is already terminal", async () => {
    const { pipe } = setup();
    pipe.connected = false;
    const channel = side === "child"
      ? channelForChildProcess(pipe as unknown as ChildProcess)
      : channelForParentProcess(pipe as unknown as NodeJS.Process);
    const endpoint = new BridgeEndpoint({ role: "agent", channel, dispatchLocal: async () => ok(null) });
    expect(await endpoint.dispatchRemote("x", {}, context)).toMatchObject({ ok: false, error: { code: "bridge_closed" } });
    expect(pipe.send).not.toHaveBeenCalled();
  });

  test("disconnect/exit are terminal once, and unsubscribing releases native listeners", () => {
    const { pipe, channel } = setup();
    const closed = vi.fn();
    const off = channel.onClose(closed);
    pipe.emit("disconnect");
    pipe.emit("exit", 1);
    expect(closed).toHaveBeenCalledTimes(1);
    off();
    expect(pipe.listenerCount("disconnect")).toBe(0);
    expect(pipe.listenerCount("exit")).toBe(0);
  });

  test("serialization failure settles only that request and never retries it", async () => {
    const { pipe, channel } = setup();
    const endpoint = new BridgeEndpoint({ role: "agent", channel, dispatchLocal: async () => ok(null) });
    const pending = endpoint.dispatchRemote("first", {}, context);
    pipe.send.mockImplementationOnce(() => { throw new Error("cannot serialize"); });
    expect(await endpoint.dispatchRemote("second", {}, context)).toMatchObject({ ok: false, error: { code: "bridge_send_failed" } });
    pipe.emit("message", { pwrsnapBridge: BRIDGE_PROTOCOL_VERSION, kind: "response", id: 1, result: ok("first committed") });
    expect(await pending).toEqual(ok("first committed"));
    expect(pipe.send.mock.calls.filter(([message]) => message.kind === "request")).toHaveLength(2);
    endpoint.close();
  });
});
