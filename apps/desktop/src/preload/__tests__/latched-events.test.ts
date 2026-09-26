import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";

import { createEventSubscriber, type IpcEventSource } from "../latched-events";

const LATCHED = "events:library:open-capture";
const PLAIN = "events:captures:changed";

function fakeIpc(): IpcEventSource & { emit(channel: string, payload: unknown): void } {
  const emitter = new EventEmitter();
  return {
    on: (channel, listener) => emitter.on(channel, listener),
    off: (channel, listener) => emitter.off(channel, listener),
    emit: (channel, payload) => {
      emitter.emit(channel, {}, payload);
    }
  };
}

describe("createEventSubscriber — latched channel", () => {
  test("an event that lands before anyone subscribes reaches the first subscriber", () => {
    // The Library's subscriber is a React passive effect, and main's one
    // send routinely reaches the renderer before that effect has run. On
    // a plain channel the user's "open this capture" intent is gone.
    const ipc = fakeIpc();
    const subscribe = createEventSubscriber(ipc, [LATCHED]);

    ipc.emit(LATCHED, { captureId: "cap-early" });
    const handler = vi.fn();
    subscribe(LATCHED, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ captureId: "cap-early" });
  });

  test("keeps only the latest unconsumed event", () => {
    const ipc = fakeIpc();
    const subscribe = createEventSubscriber(ipc, [LATCHED]);

    ipc.emit(LATCHED, { captureId: "cap-first" });
    ipc.emit(LATCHED, { captureId: "cap-second" });
    const handler = vi.fn();
    subscribe(LATCHED, handler);

    expect(handler.mock.calls).toEqual([[{ captureId: "cap-second" }]]);
  });

  test("a latched event is handed out once, not replayed to a resubscriber", () => {
    // A React effect whose deps change unsubscribes and resubscribes. The
    // second subscription must not open the same capture again.
    const ipc = fakeIpc();
    const subscribe = createEventSubscriber(ipc, [LATCHED]);

    ipc.emit(LATCHED, { captureId: "cap-once" });
    const first = vi.fn();
    subscribe(LATCHED, first)();
    const second = vi.fn();
    subscribe(LATCHED, second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  test("delivers live to every current subscriber and latches nothing meanwhile", () => {
    const ipc = fakeIpc();
    const subscribe = createEventSubscriber(ipc, [LATCHED]);
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = subscribe(LATCHED, a);
    subscribe(LATCHED, b);

    ipc.emit(LATCHED, { captureId: "cap-live" });
    unsubscribeA();
    ipc.emit(LATCHED, { captureId: "cap-live-2" });

    expect(a.mock.calls).toEqual([[{ captureId: "cap-live" }]]);
    expect(b.mock.calls).toEqual([[{ captureId: "cap-live" }], [{ captureId: "cap-live-2" }]]);
    const late = vi.fn();
    subscribe(LATCHED, late);
    expect(late).not.toHaveBeenCalled();
  });

  test("latches again once every subscriber has gone", () => {
    const ipc = fakeIpc();
    const subscribe = createEventSubscriber(ipc, [LATCHED]);
    subscribe(LATCHED, vi.fn())();

    ipc.emit(LATCHED, { captureId: "cap-between-mounts" });
    const handler = vi.fn();
    subscribe(LATCHED, handler);

    expect(handler).toHaveBeenCalledWith({ captureId: "cap-between-mounts" });
  });
});

describe("createEventSubscriber — plain channel", () => {
  test("an event with no subscriber is dropped, as before", () => {
    const ipc = fakeIpc();
    const subscribe = createEventSubscriber(ipc, [LATCHED]);

    ipc.emit(PLAIN, { n: 1 });
    const handler = vi.fn();
    const unsubscribe = subscribe(PLAIN, handler);
    ipc.emit(PLAIN, { n: 2 });
    unsubscribe();
    ipc.emit(PLAIN, { n: 3 });

    expect(handler.mock.calls).toEqual([[{ n: 2 }]]);
  });
});
