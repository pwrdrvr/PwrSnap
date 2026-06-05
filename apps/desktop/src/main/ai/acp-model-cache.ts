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

function readFile(): CacheFile {
  try {
    const raw = readFileSync(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<CacheFile>;
    if (parsed.version === CACHE_VERSION && parsed.agents && typeof parsed.agents === "object") {
      return { version: CACHE_VERSION, agents: parsed.agents };
    }
  } catch {
    // missing / unreadable / corrupt → empty cache (re-discovered on demand).
  }
  return { version: CACHE_VERSION, agents: {} };
}

/** The persisted entry for an agent, or undefined when never discovered. */
export function loadAcpModelCacheEntry(agentId: string): AcpModelCacheEntry | undefined {
  return readFile().agents[agentId];
}

/** Persist (replace) the model list for an agent. Best-effort — a write failure
 *  is logged, not thrown (the in-memory result is still returned to the UI). */
export function saveAcpModelCacheEntry(
  agentId: string,
  entry: AcpModelCacheEntry
): void {
  try {
    const file = readFile();
    file.agents[agentId] = entry;
    const path = cachePath();
    mkdirSync(app.getPath("userData"), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), "utf8");
    renameSync(tmp, path);
  } catch (cause) {
    log.warn("failed to persist ACP model cache", {
      agentId,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}
