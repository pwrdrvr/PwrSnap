// Remote-forwarder fallback on the command bus (two-process split
// §D4): commands without a local handler route to the peer process
// when the routing table says the peer owns them; everything else
// keeps the existing unknown_command behavior. Local handlers always
// win over the forwarder.

import { afterEach, describe, expect, test, vi } from "vitest";
import { err, ok } from "@pwrsnap/shared";

vi.mock("../log", () => ({
  getMainLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

const { bus } = await import("../command-bus");

// Names only need to be real CommandNames at the type level; the bus
// stores them in a plain Map, so any string exercises the same paths.
const dispatch = (name: string, req: unknown = {}) =>
  bus.dispatch(name as never, req as never, { principal: "ipc" });

afterEach(() => {
  bus.uninstallRemoteForwarderForTests();
  bus.unregister("capture:region" as never);
});

describe("command-bus remote forwarder", () => {
  test("forwards an unregistered command the forwarder claims", async () => {
    const forward = vi.fn(async () => ok({ from: "peer" }));
    bus.installRemoteForwarder({
      canForward: (name) => name === "library:list",
      forward
    });

    const result = await dispatch("library:list", { page: 2 });

    expect(forward).toHaveBeenCalledWith("library:list", { page: 2 });
    expect(result).toEqual(ok({ from: "peer" }));
  });

  test("a local handler wins over the forwarder", async () => {
    const forward = vi.fn(async () => ok("remote"));
    bus.installRemoteForwarder({ canForward: () => true, forward });
    bus.register("capture:region" as never, (async () => ok("local")) as never);

    const result = await dispatch("capture:region");

    expect(result).toEqual(ok("local"));
    expect(forward).not.toHaveBeenCalled();
  });

  test("unclaimed unknown commands still fail with unknown_command", async () => {
    bus.installRemoteForwarder({
      canForward: () => false,
      forward: async () => ok(null)
    });

    const result = await dispatch("not:aRealCommand");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unknown_command");
  });

  test("a throwing forwarder degrades to bridge_forward_failed, not a rejection", async () => {
    bus.installRemoteForwarder({
      canForward: () => true,
      forward: async () => {
        throw new Error("spawn failed");
      }
    });

    const result = await dispatch("library:list");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bridge_forward_failed");
      expect(result.error.message).toBe("spawn failed");
    }
  });

  test("forwarded error results pass through unchanged", async () => {
    bus.installRemoteForwarder({
      canForward: () => true,
      forward: async () => err({ kind: "library", code: "not_found", message: "nope" })
    });

    const result = await dispatch("library:byId", { id: "x" });

    expect(result).toEqual(err({ kind: "library", code: "not_found", message: "nope" }));
  });

  test("isRegistered counts forwardable names (the ipc transport gate)", () => {
    expect(bus.isRegistered("settings:read")).toBe(false);
    bus.installRemoteForwarder({
      canForward: (name) => name.startsWith("settings:"),
      forward: async () => ok(null)
    });
    expect(bus.isRegistered("settings:read")).toBe(true);
    expect(bus.isRegistered("library:list")).toBe(false);
  });

  test("double install throws (one forwarder per process)", () => {
    const forwarder = { canForward: () => false, forward: async () => ok(null) };
    bus.installRemoteForwarder(forwarder);
    expect(() => bus.installRemoteForwarder(forwarder)).toThrow(/already installed/);
  });
});
