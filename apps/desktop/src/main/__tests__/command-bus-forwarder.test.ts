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
  bus.uninstallLocalAgentAuthorizerForTests();
  bus.unregister("capture:region" as never);
  bus.unregister("sizzle:render");
});

describe("command-bus remote forwarder", () => {
  test("forwards an unregistered command the forwarder claims", async () => {
    const forward = vi.fn(async () => ok({ from: "peer" }));
    bus.installRemoteForwarder({
      canForward: (name) => name === "library:list",
      forward
    });

    const result = await dispatch("library:list", { page: 2 });

    expect(forward).toHaveBeenCalledWith("library:list", { page: 2 }, { principal: "ipc" });
    expect(result).toEqual(ok({ from: "peer" }));
  });

  test("preserves authenticated command context when forwarding", async () => {
    const forward = vi.fn(async () => ok(null));
    bus.installRemoteForwarder({ canForward: () => true, forward });
    bus.installLocalAgentAuthorizer(async (clientId) => ({
      clientId,
      capabilities: ["library.read"]
    }));
    const options = {
      principal: "mcp" as const,
      cancellationKey: "capture-123",
      sourceWindowId: 7,
      sourceBounds: { x: 1, y: 2, width: 3, height: 4 },
      localAgent: {
        clientId: "agent-1",
        capabilities: ["library.read", "capture.composite.read"] as const
      }
    };

    await bus.dispatch("library:list", {} as never, options);

    expect(forward).toHaveBeenCalledWith("library:list", {}, {
      ...options,
      localAgent: { clientId: "agent-1", capabilities: ["library.read"] }
    });
  });

  test("rejects MCP commands without a live authenticated grant", async () => {
    const forward = vi.fn(async () => ok(null));
    bus.installRemoteForwarder({ canForward: () => true, forward });

    const result = await bus.dispatch("library:list", {} as never, {
      principal: "mcp",
      localAgent: { clientId: "forged", capabilities: ["library.read"] }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("local_agent_context_required");
    expect(forward).not.toHaveBeenCalled();
  });

  test("uses current grant capabilities instead of caller-supplied capabilities", async () => {
    const forward = vi.fn(async () => ok(null));
    bus.installRemoteForwarder({ canForward: () => true, forward });
    bus.installLocalAgentAuthorizer(async (clientId) => ({
      clientId,
      capabilities: ["capture.edit"]
    }));

    const result = await bus.dispatch("library:search", { query: "secret" } as never, {
      principal: "mcp",
      localAgent: {
        clientId: "agent-1",
        capabilities: ["library.read", "capture.edit"]
      }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("local_agent_capability_denied");
    expect(forward).not.toHaveBeenCalled();
  });

  test("capture.edit cannot read OCR or composite media", async () => {
    const forward = vi.fn(async () => ok(null));
    bus.installRemoteForwarder({ canForward: () => true, forward });
    bus.installLocalAgentAuthorizer(async (clientId) => ({
      clientId,
      capabilities: ["capture.edit"]
    }));
    const options = {
      principal: "mcp" as const,
      localAgent: { clientId: "agent-1", capabilities: ["capture.edit"] as const }
    };

    const ocr = await bus.dispatch("codex:enrichment", { captureId: "cap_1" }, options);
    const composite = await bus.dispatch(
      "render:composite",
      { captureId: "cap_1", maxEdgePx: 800 },
      options
    );

    expect(ocr.ok).toBe(false);
    expect(composite.ok).toBe(false);
    expect(forward).not.toHaveBeenCalled();
  });

  test("sizzle.compose cannot read the library or render media", async () => {
    const forward = vi.fn(async () => ok(null));
    bus.installRemoteForwarder({ canForward: () => true, forward });
    bus.installLocalAgentAuthorizer(async (clientId) => ({
      clientId,
      capabilities: ["sizzle.compose"]
    }));
    const options = {
      principal: "mcp" as const,
      localAgent: { clientId: "agent-1", capabilities: ["sizzle.compose"] as const }
    };

    const search = await bus.dispatch("library:search", { query: "secret" }, options);
    const render = await bus.dispatch(
      "sizzle:render",
      { id: "s1", mode: "preview" },
      options
    );

    expect(search.ok).toBe(false);
    expect(render.ok).toBe(false);
    expect(forward).not.toHaveBeenCalled();
  });

  test("render side effects run only under a sufficient live grant", async () => {
    const effects = { ttsSecretReads: 0, artifactWrites: 0, projectUpdates: 0 };
    let capabilities: readonly ("sizzle.compose" | "sizzle.preview.read")[] = [
      "sizzle.compose"
    ];
    bus.installLocalAgentAuthorizer(async (clientId) => ({ clientId, capabilities }));
    bus.register("sizzle:render", async () => {
      effects.ttsSecretReads += 1;
      effects.artifactWrites += 1;
      effects.projectUpdates += 1;
      return ok({
        outputPath: "/tmp/preview.mp4",
        durationSec: 1,
        renderId: "render_1",
        widthPx: 640,
        heightPx: 360
      });
    });
    const options = {
      principal: "mcp" as const,
      localAgent: { clientId: "agent-1", capabilities: ["sizzle.compose"] as const }
    };

    const denied = await bus.dispatch(
      "sizzle:render",
      { id: "s1", mode: "preview" },
      options
    );
    expect(denied.ok).toBe(false);
    expect(effects).toEqual({ ttsSecretReads: 0, artifactWrites: 0, projectUpdates: 0 });

    capabilities = ["sizzle.compose", "sizzle.preview.read"];
    const allowed = await bus.dispatch(
      "sizzle:render",
      { id: "s1", mode: "preview" },
      options
    );
    expect(allowed.ok).toBe(true);
    expect(effects).toEqual({ ttsSecretReads: 1, artifactWrites: 1, projectUpdates: 1 });
  });

  test("requires the render capability selected by explicit render mode", async () => {
    const forward = vi.fn(async () => ok(null));
    bus.installRemoteForwarder({ canForward: () => true, forward });
    bus.installLocalAgentAuthorizer(async (clientId) => ({
      clientId,
      capabilities: ["sizzle.compose", "sizzle.preview.read"]
    }));
    const options = {
      principal: "mcp" as const,
      localAgent: {
        clientId: "agent-1",
        capabilities: ["sizzle.compose", "sizzle.preview.read"] as const
      }
    };

    expect((await bus.dispatch("sizzle:render", { id: "s1", mode: "preview" }, options)).ok)
      .toBe(true);
    const full = await bus.dispatch("sizzle:render", { id: "s1", mode: "full" }, options);
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error.code).toBe("local_agent_capability_denied");
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
