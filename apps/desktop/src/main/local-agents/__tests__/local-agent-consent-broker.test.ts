import { describe, expect, test, vi } from "vitest";

vi.mock("../../window", () => ({
  createLocalAgentConsentWindow: vi.fn()
}));

import type { CommandContext } from "../../command-bus";
import { LocalAgentConsentBroker } from "../local-agent-consent-broker";

function context(sourceWindowId?: number): CommandContext {
  return {
    principal: "ipc",
    signal: new AbortController().signal,
    ...(sourceWindowId === undefined ? {} : { sourceWindowId })
  };
}

function fakeWindow(id: number) {
  let destroyed = false;
  let closed: (() => void) | undefined;
  return {
    id,
    close: vi.fn(() => {
      destroyed = true;
      closed?.();
    }),
    isDestroyed: vi.fn(() => destroyed),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "closed") closed = listener;
      return undefined as never;
    })
  };
}

describe("LocalAgentConsentBroker", () => {
  test("only the exact native consent window can inspect and approve its request", async () => {
    const window = fakeWindow(41);
    const broker = new LocalAgentConsentBroker({
      createWindow: () => window,
      makeRequestId: () => "native-request-1"
    });
    const decision = broker.request({
      clientId: "lag_codex",
      clientName: "Codex",
      requestedCapabilities: ["library.read", "capture.composite.read"],
      signal: new AbortController().signal
    });
    await vi.waitFor(() => expect(broker.read(context(41)).ok).toBe(true));

    expect(broker.read(context(99))).toMatchObject({
      ok: false,
      error: { code: "untrusted_consent_window" }
    });
    expect(broker.decide(context(), {
      requestId: "native-request-1",
      decision: "allow",
      sessionName: "Codex",
      roleId: null,
      maxCaptureAgeDays: 7,
      capabilities: ["library.read"]
    })).toMatchObject({ ok: false, error: { code: "untrusted_consent_source" } });

    const prompt = broker.read(context(41));
    expect(prompt).toMatchObject({
      ok: true,
      value: {
        requestId: "native-request-1",
        clientName: "Codex"
      }
    });
    if (!prompt.ok) throw new Error("expected consent prompt");
    expect(prompt.value.permissions.filter((item) => item.requested).map((item) => item.capability))
      .toEqual(["library.read", "capture.composite.read"]);

    expect(broker.decide(context(41), {
      requestId: "native-request-1",
      decision: "allow",
      sessionName: "Codex Work",
      roleId: null,
      maxCaptureAgeDays: 30,
      capabilities: ["library.read", "trash.write"]
    })).toMatchObject({ ok: false, error: { code: "consent_scope_escalation" } });
    expect(broker.decide(context(41), {
      requestId: "native-request-1",
      decision: "allow",
      sessionName: "Codex Work",
      roleId: null,
      maxCaptureAgeDays: 30,
      capabilities: ["library.read"]
    })).toEqual({ ok: true, value: undefined });
    await expect(decision).resolves.toEqual({
      decision: "allow",
      sessionName: "Codex Work",
      roleId: null,
      capabilities: ["library.read"],
      maxCaptureAgeDays: 30
    });
    expect(window.close).toHaveBeenCalledOnce();
    expect(broker.read(context(41))).toMatchObject({
      ok: false,
      error: { code: "untrusted_consent_window" }
    });
  });

  test("closing or aborting the native prompt denies access", async () => {
    const window = fakeWindow(7);
    const controller = new AbortController();
    const broker = new LocalAgentConsentBroker({ createWindow: () => window });
    const decision = broker.request({
      clientId: "lag_agent",
      clientName: "Agent",
      requestedCapabilities: ["library.read"],
      signal: controller.signal
    });

    await vi.waitFor(() => expect(broker.read(context(7)).ok).toBe(true));
    controller.abort();
    await expect(decision).resolves.toEqual({
      decision: "deny",
      sessionName: "",
      roleId: null,
      capabilities: []
    });
    expect(window.close).toHaveBeenCalledOnce();
  });

  test("suggests a unique session name when an active grant already uses the client label", async () => {
    const window = fakeWindow(12);
    const broker = new LocalAgentConsentBroker({
      createWindow: () => window,
      makeRequestId: () => "native-request-unique-name",
      readGrants: async () => [
        { name: "PwrAgent", revokedAt: null },
        { name: "PwrAgent 2", revokedAt: null },
        { name: "PwrAgent 3", revokedAt: "2026-08-05T12:00:00.000Z" }
      ]
    });

    void broker.request({
      clientId: "lag_pwragent",
      clientName: "PwrAgent",
      requestedCapabilities: ["library.read"],
      signal: new AbortController().signal
    });
    await vi.waitFor(() => expect(broker.read(context(12)).ok).toBe(true));

    expect(broker.read(context(12))).toMatchObject({
      ok: true,
      value: { suggestedSessionName: "PwrAgent 3" }
    });
  });
});
