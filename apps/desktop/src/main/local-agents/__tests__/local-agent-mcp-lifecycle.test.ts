import { describe, expect, test, vi } from "vitest";
import {
  LocalAgentMcpLifecycle,
  type ManagedLocalAgentMcpServer
} from "../local-agent-mcp-lifecycle";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("LocalAgentMcpLifecycle", () => {
  test("starts once when enabled and stops once when disabled", async () => {
    const server: ManagedLocalAgentMcpServer = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    };
    const lifecycle = new LocalAgentMcpLifecycle({ createServer: () => server });

    await lifecycle.setEnabled(false);
    await lifecycle.setEnabled(true);
    await lifecycle.setEnabled(true);
    await lifecycle.setEnabled(false);

    expect(server.start).toHaveBeenCalledTimes(1);
    expect(server.stop).toHaveBeenCalledTimes(1);
  });

  test("honors a disable requested while startup is still pending", async () => {
    const started = deferred();
    const server: ManagedLocalAgentMcpServer = {
      start: vi.fn(() => started.promise),
      stop: vi.fn(async () => undefined)
    };
    const lifecycle = new LocalAgentMcpLifecycle({ createServer: () => server });

    const enabling = lifecycle.setEnabled(true);
    await vi.waitFor(() => {
      expect(server.start).toHaveBeenCalledTimes(1);
    });
    const disabling = lifecycle.setEnabled(false);
    started.resolve();
    await Promise.all([enabling, disabling]);

    expect(server.start).toHaveBeenCalledTimes(1);
    expect(server.stop).toHaveBeenCalledTimes(1);
  });

  test("cleans up failed starts and permits a later retry", async () => {
    const onStartError = vi.fn();
    const failed: ManagedLocalAgentMcpServer = {
      start: vi.fn(async () => {
        throw new Error("port occupied");
      }),
      stop: vi.fn(async () => undefined)
    };
    const healthy: ManagedLocalAgentMcpServer = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    };
    const createServer = vi.fn()
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(healthy);
    const lifecycle = new LocalAgentMcpLifecycle({ createServer, onStartError });

    await lifecycle.setEnabled(true);
    await lifecycle.setEnabled(true);

    expect(failed.stop).toHaveBeenCalledTimes(1);
    expect(onStartError).toHaveBeenCalledWith(expect.objectContaining({
      message: "port occupied"
    }));
    expect(healthy.start).toHaveBeenCalledTimes(1);
  });
});
