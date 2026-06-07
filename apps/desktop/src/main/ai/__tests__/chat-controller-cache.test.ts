// Regression coverage for the "stale chat backend after a settings change"
// bug: the chat controller used to be a build-once singleton, so switching
// providers in Settings → AI and then starting a NEW chat (without reloading
// the asset) silently kept talking to the OLD provider. The signature-aware
// cache must rebuild when the backend-affecting slice of settings changes —
// and must NOT rebuild when it doesn't.

import { describe, expect, test, vi } from "vitest";
import type { Settings } from "@pwrsnap/shared";
import {
  createChatControllerCache,
  createKeyedChatControllerCache,
  chatBackendConfigKey,
  type ChatBackendConfig
} from "../chat-controller-cache";

/** Minimal settings whose only meaningful axis here is the library provider. */
function settingsWithProvider(provider: string): Settings {
  return {
    codex: { mode: "auto", pinnedPath: "", profile: "" },
    ai: {
      acp: { enabledAgentIds: [], agents: {} },
      defaults: {
        libraryChat: { provider },
        sizzleChat: {}
      }
    }
  } as unknown as Settings;
}

describe("createChatControllerCache", () => {
  test("builds once and reuses while the signature is unchanged", async () => {
    const build = vi.fn(async () => ({
      controller: { id: "c1" },
      dispose: vi.fn(async () => undefined)
    }));
    const cache = createChatControllerCache({
      readSettings: async () => settingsWithProvider("acp:gemini"),
      signature: (s) => s.ai.defaults.libraryChat.provider ?? "",
      build
    });

    const a = await cache.get();
    const b = await cache.get();
    const c = await cache.get();

    expect(build).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("REBUILDS after the provider changes (the actual bug) and disposes the stale one", async () => {
    // The user switches Library Chat from Gemini → Codex in Settings, then
    // starts a new chat. The next get() MUST hand back a Codex-built
    // controller, not the cached Gemini one.
    let provider = "acp:gemini";
    const dispose1 = vi.fn(async () => undefined);
    const dispose2 = vi.fn(async () => undefined);
    const build = vi
      .fn()
      .mockResolvedValueOnce({ controller: { id: "gemini" }, dispose: dispose1 })
      .mockResolvedValueOnce({ controller: { id: "codex" }, dispose: dispose2 });

    const cache = createChatControllerCache({
      readSettings: async () => settingsWithProvider(provider),
      signature: (s) => s.ai.defaults.libraryChat.provider ?? "",
      build
    });

    const first = await cache.get();
    expect(first).toEqual({ id: "gemini" });

    provider = "codex"; // user changed Settings → AI → Job Routing

    const second = await cache.get();
    expect(second).toEqual({ id: "codex" }); // FAILS against the old singleton
    expect(build).toHaveBeenCalledTimes(2);
    expect(dispose1).toHaveBeenCalledTimes(1); // stale Gemini controller torn down
  });

  test("concurrent first-dispatches build exactly once (no leaked backend)", async () => {
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const build = vi.fn(async () => {
      await gate;
      return { controller: { id: "only" }, dispose: vi.fn(async () => undefined) };
    });
    const cache = createChatControllerCache({
      readSettings: async () => settingsWithProvider("codex"),
      signature: (s) => s.ai.defaults.libraryChat.provider ?? "",
      build
    });

    const p1 = cache.get();
    const p2 = cache.get();
    openGate();
    const [a, b] = await Promise.all([p1, p2]);

    expect(build).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  test("reset disposes and forces a rebuild on next get", async () => {
    const dispose1 = vi.fn(async () => undefined);
    const build = vi
      .fn()
      .mockResolvedValueOnce({ controller: { id: "a" }, dispose: dispose1 })
      .mockResolvedValueOnce({
        controller: { id: "b" },
        dispose: vi.fn(async () => undefined)
      });
    const cache = createChatControllerCache({
      readSettings: async () => settingsWithProvider("codex"),
      signature: () => "stable",
      build
    });

    await cache.get();
    await cache.reset();
    await cache.get();

    expect(dispose1).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe("createKeyedChatControllerCache", () => {
  const cfg = (provider: string, model: string | null = null, reasoning: string | null = null): ChatBackendConfig => ({
    provider,
    model,
    reasoning
  });
  const settings = () => ({ codex: { mode: "auto", pinnedPath: "", profile: "" } }) as unknown as Settings;

  test("builds ONE controller per distinct config and reuses by key", async () => {
    const build = vi
      .fn()
      .mockImplementation(async (c: ChatBackendConfig) => ({
        controller: { id: chatBackendConfigKey(c) },
        dispose: vi.fn(async () => undefined)
      }));
    const cache = createKeyedChatControllerCache({
      readSettings: async () => settings(),
      settingsSignature: () => "stable",
      build
    });

    const codex = await cache.get(cfg("codex"));
    const codexAgain = await cache.get(cfg("codex"));
    const gemini = await cache.get(cfg("acp:gemini", "gemini-2.5-pro"));

    expect(codexAgain).toBe(codex); // same key → same controller
    expect(gemini).not.toBe(codex); // different config → different controller
    expect(build).toHaveBeenCalledTimes(2); // codex once, gemini once
  });

  test("disposes ALL controllers when the settings signature changes", async () => {
    let sig = "v1";
    const disposes: Array<ReturnType<typeof vi.fn>> = [];
    const build = vi.fn().mockImplementation(async (c: ChatBackendConfig) => {
      const dispose = vi.fn(async () => undefined);
      disposes.push(dispose);
      return { controller: { id: chatBackendConfigKey(c) }, dispose };
    });
    const cache = createKeyedChatControllerCache({
      readSettings: async () => settings(),
      settingsSignature: () => sig,
      build
    });

    await cache.get(cfg("codex"));
    await cache.get(cfg("acp:gemini"));
    expect(build).toHaveBeenCalledTimes(2);

    sig = "v2"; // e.g. user pinned a different codex binary / auth profile
    await cache.get(cfg("codex"));
    // Both prior controllers torn down; codex rebuilt under the new signature.
    expect(disposes[0]).toHaveBeenCalledTimes(1);
    expect(disposes[1]).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(3);
  });
});
