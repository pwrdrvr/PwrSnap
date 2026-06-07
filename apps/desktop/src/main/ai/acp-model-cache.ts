// Persisted cache of the model lists ACP agents advertise. Listing models
// spawns the agent in ACP mode and opens a session (seconds), so without a
// durable cache every Settings open after an app restart pays that cost. We
// persist the last list per agent so Settings shows it INSTANTLY, and a
// `refresh` re-spawns to update.
//
// This is discovered metadata (not user-editable), so it lives in its own
// userData cache file rather than the Settings substrate (which is for
// renderer-changeable state). Atomic write (tmp → rename) so a crash mid-write
// can't corrupt it; a corrupt/missing file just yields an empty cache.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { AcpAgentModelOption } from "@pwrsnap/shared";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:acp-model-cache");
const CACHE_VERSION = 1;

export type AcpModelCacheEntry = {
  models: AcpAgentModelOption[];
  /** The agent command the list was read from — lets a caller treat the cache
   *  as stale if the active binary changed (an upgrade can change models). */
  command: string;
  discoveredAt: string;
};

type CacheFile = {
  version: number;
  agents: Record<string, AcpModelCacheEntry>;
};

function cachePath(): string {
  return join(app.getPath("userData"), "acp-model-cache.json");
}

// In-memory memo of the parsed cache, keyed by path. The file is written ONLY by
// this (main) process via saveAcpModelCacheEntry, which refreshes the memo, so a
// memo hit is always current — avoiding a synchronous readFileSync + JSON.parse
// on every read (e.g. findAcpModelLabel runs per codex:usageRunDetail). Keying
// by path keeps tests isolated: each uses a fresh userData dir, so the memo
// auto-invalidates when the path changes.
let memo: { path: string; file: CacheFile } | null = null;

function readFile(): CacheFile {
  const path = cachePath();
  if (memo !== null && memo.path === path) return memo.file;
  let file: CacheFile = { version: CACHE_VERSION, agents: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheFile>;
    if (parsed.version === CACHE_VERSION && parsed.agents && typeof parsed.agents === "object") {
      file = { version: CACHE_VERSION, agents: parsed.agents };
    }
  } catch {
    // missing / unreadable / corrupt → empty cache (re-discovered on demand).
    // Memoized too, so a missing file isn't re-stat'd on every call.
  }
  memo = { path, file };
  return file;
}

/** The persisted entry for an agent, or undefined when never discovered. */
export function loadAcpModelCacheEntry(agentId: string): AcpModelCacheEntry | undefined {
  return readFile().agents[agentId];
}

/** Friendly label for a model id, searched across ALL cached agents. Model ids
 *  are effectively unique across agents (`grok-build`, `gemini-3-flash-preview`,
 *  …), so this resolves a run's recorded model id → its display label without
 *  needing to know which agent produced it. Returns undefined when the id isn't
 *  in any cache (e.g. a Codex model, or an agent never probed). */
export function findAcpModelLabel(modelId: string): string | undefined {
  if (modelId.length === 0) return undefined;
  const { agents } = readFile();
  for (const entry of Object.values(agents)) {
    const match = entry.models.find((m) => m.id === modelId);
    if (match !== undefined && match.label.length > 0) return match.label;
  }
  return undefined;
}

/** Persist (replace) the model list for an agent. Best-effort — a write failure
 *  is logged, not thrown (the in-memory result is still returned to the UI). */
export function saveAcpModelCacheEntry(
  agentId: string,
  entry: AcpModelCacheEntry
): void {
  try {
    // Build a fresh object (don't mutate the memo'd one) so a mid-write failure
    // can't leave the in-memory memo ahead of what's on disk.
    const next: CacheFile = {
      version: CACHE_VERSION,
      agents: { ...readFile().agents, [agentId]: entry }
    };
    const path = cachePath();
    mkdirSync(app.getPath("userData"), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), "utf8");
    renameSync(tmp, path);
    memo = { path, file: next }; // refresh the memo only after a successful write
  } catch (cause) {
    log.warn("failed to persist ACP model cache", {
      agentId,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}
