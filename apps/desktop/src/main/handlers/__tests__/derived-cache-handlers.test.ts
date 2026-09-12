// The cleanup owner is the split-mode half of the derived-cache gate: the
// library forwards whole operations, the agent runs them. These tests pin the
// two things that are dangerous to get wrong — who may call it, and that the
// capture id reaching an `rm -rf` is actually a capture id.
//
// The cleanup functions themselves are mocked. What they delete is covered by
// their own suites; what matters here is the verb's boundary.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  purgeCacheForCapture: vi.fn(async (_id: string) => undefined),
  clearRenderCache: vi.fn(async () => undefined),
  trimRenderCache: vi.fn(async () => undefined)
}));

vi.mock("../../persistence/source-store", () => ({
  purgeCacheForCapture: mocks.purgeCacheForCapture
}));
vi.mock("../../persistence/render-cache-maintenance", () => ({
  clearRenderCache: mocks.clearRenderCache,
  trimRenderCache: mocks.trimRenderCache
}));

const { bus } = await import("../../command-bus");
const { registerDerivedCacheCleanupOwner } = await import("../derived-cache-handlers");
const { resetDerivedCacheCleanupForwarderForTests } = await import(
  "../../persistence/derived-cache-gate"
);
const { setRuntimeProcessRole } = await import("../../process-role");

beforeEach(() => {
  vi.clearAllMocks();
  resetDerivedCacheCleanupForwarderForTests();
  setRuntimeProcessRole("combined");
  registerDerivedCacheCleanupOwner("agent");
});

afterEach(() => {
  bus.unregister("storage:runCacheCleanup");
  resetDerivedCacheCleanupForwarderForTests();
  setRuntimeProcessRole("combined");
});

describe("storage:runCacheCleanup", () => {
  test("runs each operation against its cleanup function", async () => {
    await expect(
      bus.dispatch("storage:runCacheCleanup", { operation: "purge", captureId: "abc123" }, {
        principal: "bridge"
      })
    ).resolves.toMatchObject({ ok: true });
    expect(mocks.purgeCacheForCapture).toHaveBeenCalledWith("abc123");

    await bus.dispatch("storage:runCacheCleanup", { operation: "clear" }, { principal: "bridge" });
    expect(mocks.clearRenderCache).toHaveBeenCalledTimes(1);

    await bus.dispatch("storage:runCacheCleanup", { operation: "trim" }, { principal: "bridge" });
    expect(mocks.trimRenderCache).toHaveBeenCalledTimes(1);
  });

  test("refuses every principal but the bridge", async () => {
    // A renderer reaching this could delete any capture's derivatives by id.
    // The front doors are `storage:maintainRenderCache` and `library:purge`.
    for (const principal of ["ipc", "rpc", "seeder"] as const) {
      const result = await bus.dispatch(
        "storage:runCacheCleanup",
        { operation: "clear" },
        { principal }
      );
      expect(result).toMatchObject({ ok: false, error: { code: "internal_command" } });
    }
    // `mcp` never even reaches the handler — the bus refuses it earlier for
    // want of a local-agent context. Assert the refusal, not its shape.
    expect(
      await bus.dispatch("storage:runCacheCleanup", { operation: "clear" }, { principal: "mcp" })
    ).toMatchObject({ ok: false });
    expect(mocks.clearRenderCache).not.toHaveBeenCalled();
  });

  test("rejects a captureId that is not a capture id", async () => {
    // These all end up in a `join(cacheRoot, id)` followed by `rm -rf`.
    for (const captureId of ["../../etc", "a/b", "", "x".repeat(65), 42 as unknown as string]) {
      const result = await bus.dispatch(
        "storage:runCacheCleanup",
        { operation: "purge", captureId },
        { principal: "bridge" }
      );
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_capture_id" } });
    }
    expect(mocks.purgeCacheForCapture).not.toHaveBeenCalled();
  });

  test("rejects an unknown operation", async () => {
    const result = await bus.dispatch(
      "storage:runCacheCleanup",
      { operation: "wipe" } as never,
      { principal: "bridge" }
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });
});

describe("role wiring", () => {
  test("the library registers a forwarder and no handler", async () => {
    bus.unregister("storage:runCacheCleanup");
    resetDerivedCacheCleanupForwarderForTests();
    setRuntimeProcessRole("library");
    registerDerivedCacheCleanupOwner("library");

    const { forwardDerivedCacheCleanup } = await import("../../persistence/derived-cache-gate");
    // NOT registering locally is precisely what makes the bus hand the verb
    // to its remote forwarder. No bridge is installed in this test, so the
    // dispatch surfaces as `unknown_command` — the observable form of "this
    // process does not answer this verb, ask the peer".
    const local = await bus.dispatch(
      "storage:runCacheCleanup",
      { operation: "clear" },
      { principal: "bridge" }
    );
    expect(local).toMatchObject({ ok: false, error: { code: "unknown_command" } });

    // And the forwarder really does go through the bus: it surfaces the same
    // failure rather than quietly cleaning locally.
    const forwarded = forwardDerivedCacheCleanup({ operation: "clear" });
    expect(forwarded).not.toBeNull();
    await expect(forwarded).rejects.toThrow(/unknown command/);
    expect(mocks.clearRenderCache).not.toHaveBeenCalled();
  });

  test("the agent registers the handler and no forwarder", async () => {
    const { forwardDerivedCacheCleanup } = await import("../../persistence/derived-cache-gate");
    setRuntimeProcessRole("agent");
    // Agent-side callers clean locally; nothing to forward to.
    expect(forwardDerivedCacheCleanup({ operation: "clear" })).toBeNull();
    await bus.dispatch("storage:runCacheCleanup", { operation: "clear" }, { principal: "bridge" });
    expect(mocks.clearRenderCache).toHaveBeenCalledTimes(1);
  });
});
