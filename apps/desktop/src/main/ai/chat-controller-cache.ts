// A lazily-built, settings-aware cache for one chat surface's
// `ChatThreadController`. Both chat handlers (library + sizzle) share it so the
// "rebuild when the backend config changes" rule lives in exactly one place.
//
// THE BUG THIS FIXES: the controller used to be a build-once singleton. Its
// backend (Codex vs an ACP agent, plus model / reasoning / auth profile) was
// frozen from the settings snapshot read at first use. So after a user changed
// Settings → AI → Job Routing (say Gemini CLI → Codex) and started a NEW chat
// WITHOUT reloading the asset, the cached controller still pointed at Gemini —
// the new thread silently went to the old provider.
//
// THE FIX: every `get()` re-reads settings and compares a build SIGNATURE
// (`chatControllerSignature`). Unchanged → return the cached controller.
// Changed → dispose the old one (silences its broadcasts; closes an
// exclusively-ours Codex child) and build a fresh controller from current
// settings. Reads are cheap (settings is an in-memory snapshot) and rebuilds
// only happen on an actual backend-affecting change.

import type { Settings } from "@pwrsnap/shared";

export type ChatControllerCacheDeps<T> = {
  /** Reads the current settings snapshot (the same reader the surface uses). */
  readSettings: () => Promise<Settings>;
  /** Build signature over the backend-affecting slice of settings. */
  signature: (settings: Settings) => string;
  /** Build a fresh controller (+ its disposer) from a settings snapshot. */
  build: (settings: Settings) => Promise<{ controller: T; dispose: () => Promise<void> }>;
};

export type ChatControllerCache<T> = {
  /** Get the controller for the CURRENT settings, rebuilding if the
   *  backend-affecting slice changed since the last build. */
  get: () => Promise<T>;
  /** Drop and dispose any cached controller (shutdown / tests). */
  reset: () => Promise<void>;
};

type Entry<T> = { controller: T; dispose: () => Promise<void>; signature: string };

export function createChatControllerCache<T>(
  deps: ChatControllerCacheDeps<T>
): ChatControllerCache<T> {
  let entry: Entry<T> | null = null;
  // Serialize get()/reset() so two concurrent first-dispatches can't both
  // build (which would leak a backend) and a rebuild can't race a reset.
  let chain: Promise<unknown> = Promise.resolve();

  const serialize = <R>(task: () => Promise<R>): Promise<R> => {
    const run = chain.then(task, task);
    // Keep the chain alive regardless of task outcome.
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const get = (): Promise<T> =>
    serialize(async () => {
      const settings = await deps.readSettings();
      const signature = deps.signature(settings);
      if (entry !== null && entry.signature === signature) {
        return entry.controller;
      }
      const stale = entry;
      entry = null;
      if (stale !== null) {
        try {
          await stale.dispose();
        } catch {
          // best-effort teardown of the replaced controller.
        }
      }
      const built = await deps.build(settings);
      entry = { controller: built.controller, dispose: built.dispose, signature };
      return built.controller;
    });

  const reset = (): Promise<void> =>
    serialize(async () => {
      const stale = entry;
      entry = null;
      if (stale !== null) {
        try {
          await stale.dispose();
        } catch {
          // best-effort.
        }
      }
    });

  return { get, reset };
}

// ---- Keyed (per-thread-config) controller cache ------------------------
//
// Chat moved to per-thread Provider/Model/Reasoning, so a surface needs MORE
// than one live controller: one per distinct backend config in use. This keeps
// a controller per `(provider, model, reasoning)` key (ACP processes are still
// shared by the agent pool; only Codex spawns a child per config). When the
// SETTINGS-level backend bits change (codex command / auth profile / ACP agent
// paths) every controller is torn down and rebuilt, same as the single cache.

export type ChatBackendConfig = {
  /** Backend selector: "" / "codex" / "acp:<id>". null = surface default. */
  provider: string | null;
  /** Pinned model id. null = backend default. */
  model: string | null;
  /** Reasoning effort/mode token. null = backend default. */
  reasoning: string | null;
};

/** Stable key for a backend config (null normalized to ""). */
export function chatBackendConfigKey(config: ChatBackendConfig): string {
  return `${config.provider ?? ""}|${config.model ?? ""}|${config.reasoning ?? ""}`;
}

export type KeyedChatControllerCache<T> = {
  /** Get (build on first use) the controller for a specific backend config. */
  get: (config: ChatBackendConfig) => Promise<T>;
  /** Dispose every cached controller (shutdown / tests). */
  reset: () => Promise<void>;
};

export function createKeyedChatControllerCache<T>(deps: {
  readSettings: () => Promise<Settings>;
  /** Signature over the SETTINGS-level backend bits (codex command/profile/ACP
   *  paths) — NOT the per-thread config. A change disposes all controllers. */
  settingsSignature: (settings: Settings) => string;
  build: (
    config: ChatBackendConfig,
    settings: Settings
  ) => Promise<{ controller: T; dispose: () => Promise<void> }>;
}): KeyedChatControllerCache<T> {
  const entries = new Map<string, { controller: T; dispose: () => Promise<void> }>();
  let settingsSig: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <R>(task: () => Promise<R>): Promise<R> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const disposeAll = async (): Promise<void> => {
    for (const e of entries.values()) {
      try {
        await e.dispose();
      } catch {
        // best-effort
      }
    }
    entries.clear();
  };

  const get = (config: ChatBackendConfig): Promise<T> =>
    serialize(async () => {
      const settings = await deps.readSettings();
      const sSig = deps.settingsSignature(settings);
      if (settingsSig !== null && sSig !== settingsSig) {
        await disposeAll();
      }
      settingsSig = sSig;
      const key = chatBackendConfigKey(config);
      const existing = entries.get(key);
      if (existing) return existing.controller;
      const built = await deps.build(config, settings);
      entries.set(key, built);
      return built.controller;
    });

  const reset = (): Promise<void> =>
    serialize(async () => {
      await disposeAll();
      settingsSig = null;
    });

  return { get, reset };
}
