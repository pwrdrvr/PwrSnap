import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { err, ok } from "@pwrsnap/shared";
import { BRIDGE_PROTOCOL_VERSION, type BridgeMessage } from "../../process-bridge/protocol";
import { LIBRARY_WINDOW_READY_CHANNEL } from "../event-relay";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), dispatch: vi.fn(), cancel: vi.fn(), broadcast: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("electron", () => ({ app: { getAppPath: () => "/fixture/app", isPackaged: false } }));
vi.mock("../../command-bus", () => ({ bus: { dispatch: mocks.dispatch, cancel: mocks.cancel } }));
vi.mock("../../events", () => ({ broadcastRendererEventToLocalWindows: mocks.broadcast }));
vi.mock("../../log", () => ({ getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

class FakeChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  pid = 100;
  send = vi.fn((_message: BridgeMessage) => true);
  kill = vi.fn(() => true);

  receive(message: Omit<BridgeMessage, "pwrsnapBridge">): void {
    this.emit("message", { pwrsnapBridge: BRIDGE_PROTOCOL_VERSION, ...message });
  }

  hello(): void {
    this.receive({ kind: "hello", role: "library", pid: this.pid } as BridgeMessage);
  }

  windowReady(): void {
    this.receive({ kind: "event", channel: LIBRARY_WINDOW_READY_CHANNEL, payload: {} } as BridgeMessage);
  }

  requests(): Extract<BridgeMessage, { kind: "request" }>[] {
    return this.send.mock.calls.map(([message]) => message).filter((message) => message.kind === "request");
  }

  respond(index = 0, result: ReturnType<typeof ok> | ReturnType<typeof err> = ok(null)): void {
    this.receive({ kind: "response", id: this.requests()[index]!.id, result } as BridgeMessage);
  }
}

const context = { principal: "ipc", cancellationKey: "capture-1", sourceWindowId: 7 } as const;
let supervisor: typeof import("../library-process-supervisor");
let children: FakeChild[];
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.clearAllMocks();
  children = [];
  mocks.spawn.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  mocks.dispatch.mockResolvedValue(ok(null));
  supervisor = await import("../library-process-supervisor");
});

afterEach(() => {
  supervisor.stopLibraryProcess();
  vi.useRealTimers();
});

describe("library process generations", () => {
  test("concurrent cold requests share one spawn and wait for hello before dispatch", async () => {
    const first = supervisor.dispatchToLibraryProcess("library:focus", { first: true }, context);
    const second = supervisor.dispatchToLibraryProcess("editor:open", { id: "a" }, context);
    const child = children[0]!;
    expect(children).toHaveLength(1);
    expect(child.requests()).toHaveLength(0);
    child.hello();
    await flush();
    expect(child.requests().map(({ name, req, context: sentContext }) => ({ name, req, context: sentContext }))).toEqual([
      { name: "library:focus", req: { first: true }, context },
      { name: "editor:open", req: { id: "a" }, context }
    ]);
    child.windowReady();
    child.respond(1, ok("second"));
    child.respond(0, ok("first"));
    expect(await Promise.all([first, second])).toEqual([ok("first"), ok("second")]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test("running-only dispatch, event and cancellation relays never spawn", async () => {
    expect(await supervisor.dispatchToRunningLibraryProcess("settings:setHotkeyRecorderInputScope", {}, context)).toMatchObject({ ok: false, error: { code: "bridge_unavailable" } });
    supervisor.forwardRendererEventToLibrary("events:test", {});
    supervisor.forwardCancellationToLibrary("a");
    expect(children).toHaveLength(0);
  });

  test("running-only dispatch preserves identity and event/cancellation relays", async () => {
    supervisor.ensureLibraryProcess();
    const child = children[0]!;
    child.hello();
    const request = supervisor.dispatchToRunningLibraryProcess("settings:setHotkeyRecorderInputScope", { active: false }, context);
    await flush();
    supervisor.forwardRendererEventToLibrary("events:test", { a: 1 });
    supervisor.forwardCancellationToLibrary("capture-1");
    child.receive({ kind: "cancel", key: "remote" } as BridgeMessage);
    child.receive({ kind: "event", channel: "events:test", payload: { b: 2 } } as BridgeMessage);
    child.respond();
    expect(await request).toEqual(ok(null));
    expect(child.requests()[0]).toMatchObject({ context });
    const frames = child.send.mock.calls.map(([message]) => message);
    expect(frames).toContainEqual(expect.objectContaining({ kind: "cancel", key: "capture-1" }));
    expect(frames).toContainEqual(expect.objectContaining({ kind: "event", channel: "events:test", payload: { a: 1 } }));
    expect(mocks.cancel).toHaveBeenCalledWith("remote");
    expect(mocks.broadcast).toHaveBeenCalledWith("events:test", { b: 2 });
  });

  test("boot timeout retires the child and a later intent gets a fresh generation without retry", async () => {
    const request = supervisor.dispatchToLibraryProcess("editor:open", {}, context);
    const old = children[0]!;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await request).toMatchObject({ ok: false, error: { code: "bridge_timeout" } });
    expect(old.requests()).toHaveLength(0);
    expect(old.kill).toHaveBeenCalledTimes(1);
    expect(supervisor.isLibraryProcessRunning()).toBe(false);
    supervisor.ensureLibraryProcess();
    expect(children).toHaveLength(2);
  });

  test.each(["disconnect", "exit", "error"] as const)("%s during dispatch settles all requests and permits a fresh generation", async (event) => {
    const first = supervisor.dispatchToLibraryProcess("editor:open", {}, context);
    const second = supervisor.dispatchToLibraryProcess("library:focus", {}, context);
    const old = children[0]!;
    old.hello();
    await flush();
    old.emit(event, event === "error" ? new Error("fixture death") : 1);
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "bridge_closed" }) }),
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "bridge_closed" }) })
    ]);
    supervisor.ensureLibraryProcess();
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children[1]!.kill).not.toHaveBeenCalled();
    expect(old.requests()).toHaveLength(2);
  });

  test("hello followed by stop before the continuation cannot arm a watchdog against the replacement", async () => {
    const request = supervisor.dispatchToLibraryProcess("editor:open", {}, context);
    const old = children[0]!;
    old.hello();
    supervisor.stopLibraryProcess();
    supervisor.ensureLibraryProcess();
    const replacement = children[1]!;
    expect(await request).toMatchObject({ ok: false, error: { code: "bridge_closed" } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(old.requests()).toHaveLength(0);
  });

  test("late old exit, error, hello and readiness cannot retire or bless the replacement", async () => {
    supervisor.ensureLibraryProcess();
    const old = children[0]!;
    supervisor.stopLibraryProcess();
    const request = supervisor.dispatchToLibraryProcess("editor:open", {}, context);
    const replacement = children[1]!;
    replacement.hello();
    await flush();
    old.emit("exit", 1);
    old.emit("error", new Error("late"));
    old.hello();
    old.windowReady();
    expect(supervisor.isLibraryProcessRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(replacement.kill).toHaveBeenCalledTimes(1);
    expect(await request).toMatchObject({ ok: false, error: { code: "bridge_closed" } });
  });

  test("failed window command disarms its watchdog instead of killing a healthy child", async () => {
    const request = supervisor.dispatchToLibraryProcess("editor:open", {}, context);
    const child = children[0]!;
    child.hello();
    await flush();
    child.respond(0, err({ kind: "validation", code: "not_found", message: "no capture" }));
    expect(await request).toMatchObject({ ok: false, error: { code: "not_found" } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test("concurrent window requests do not extend the oldest window deadline", async () => {
    const first = supervisor.dispatchToLibraryProcess("library:focus", {}, context);
    const child = children[0]!;
    child.hello();
    await flush();
    await vi.advanceTimersByTimeAsync(19_000);
    const second = supervisor.dispatchToLibraryProcess("editor:open", {}, context);
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect((await Promise.all([first, second])).every((result) => !result.ok)).toBe(true);
    expect(child.requests()).toHaveLength(2);
  });

  test("one failed concurrent window request cannot disarm another request's deadline", async () => {
    const first = supervisor.dispatchToLibraryProcess("library:focus", {}, context);
    const second = supervisor.dispatchToLibraryProcess("editor:open", {}, context);
    const child = children[0]!;
    child.hello();
    await flush();
    child.respond(1, err({ kind: "validation", code: "not_found", message: "missing" }));
    await second;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(await first).toMatchObject({ ok: false, error: { code: "bridge_closed" } });
  });

  test("a failed older window request leaves the newer request its own full budget", async () => {
    const first = supervisor.dispatchToLibraryProcess("library:focus", {}, context);
    const child = children[0]!;
    child.hello();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    const second = supervisor.dispatchToLibraryProcess("editor:open", {}, context);
    await flush();
    child.respond(0, err({ kind: "validation", code: "failed", message: "cannot open" }));
    await first;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(await second).toMatchObject({ ok: false, error: { code: "bridge_closed" } });
  });

  test("readiness disarms current demands but a later demand needs its own signal", async () => {
    const first = supervisor.dispatchToLibraryProcess("library:focus", {}, context);
    const child = children[0]!;
    child.hello();
    await flush();
    child.windowReady();
    child.respond();
    await first;
    const second = supervisor.dispatchToLibraryProcess("editor:open", {}, context);
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(await second).toMatchObject({ ok: false, error: { code: "bridge_closed" } });
  });

  test("a successful command still needs window-ready, and watchdog death never retries it", async () => {
    const request = supervisor.dispatchToLibraryProcess("editor:open", {}, context);
    const child = children[0]!;
    child.hello();
    await flush();
    child.respond();
    expect(await request).toEqual(ok(null));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.requests()).toHaveLength(1);
    expect(children).toHaveLength(1);
  });

  test("duplicate stop settles readiness waiters, kills once and leaves no timers", async () => {
    const first = supervisor.dispatchToLibraryProcess("editor:open", {}, context);
    const second = supervisor.dispatchToRunningLibraryProcess("settings:setHotkeyRecorderInputScope", {}, context);
    const child = children[0]!;
    supervisor.stopLibraryProcess();
    supervisor.stopLibraryProcess();
    expect((await Promise.all([first, second])).every((result) => !result.ok && result.error.code === "bridge_closed")).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
