// Unit coverage for `capture:videoInteractive` — the verb behind the
// tray's Record button and the Library's Video chip. Guards the two
// things that would otherwise fail silently at runtime: that the verb
// is registered at all, and that a dispatch routes into the record flow
// with the correct per-trigger window-protection list.
//
// The registrar takes its deps as parameters precisely so this test
// needs no electron / persistence mocks — just spies and the real bus.

import { afterEach, describe, expect, test, vi } from "vitest";
import { bus, type CommandContext } from "../../command-bus";
import { registerCaptureVideoHandler } from "../capture-video-handler";

afterEach(() => {
  // The bus is a process singleton shared across tests in the worker;
  // unregister so repeated runs (and re-registration below) don't trip
  // the duplicate-handler guard.
  bus.unregister("capture:videoInteractive");
});

describe("capture:videoInteractive registration", () => {
  test("dispatch routes into the record flow with resolved protect ids and acks ok", async () => {
    const run = vi.fn(async () => undefined);
    const resolveProtectWindowIds = vi.fn(() => [42] as readonly number[]);
    registerCaptureVideoHandler(run, resolveProtectWindowIds);

    expect(bus.isRegistered("capture:videoInteractive")).toBe(true);

    const result = await bus.dispatch(
      "capture:videoInteractive",
      {},
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    expect(resolveProtectWindowIds).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith([42]);
  });

  test("the protect-id resolver sees the dispatch context", async () => {
    const run = vi.fn(async () => undefined);
    let seen: CommandContext | null = null;
    registerCaptureVideoHandler(run, (ctx) => {
      seen = ctx;
      return [];
    });

    await bus.dispatch("capture:videoInteractive", {}, { principal: "ipc" });

    expect(seen).not.toBeNull();
    expect(seen!.principal).toBe("ipc");
  });

  test("a rejected record flow is swallowed — dispatch still acks ok", async () => {
    const run = vi.fn(async () => {
      throw new Error("permission gate threw");
    });
    registerCaptureVideoHandler(run, () => []);

    const result = await bus.dispatch(
      "capture:videoInteractive",
      {},
      { principal: "ipc" }
    );

    // Fire-and-forget: the ack does not depend on the record flow
    // settling, and the rejection is logged, not surfaced.
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
