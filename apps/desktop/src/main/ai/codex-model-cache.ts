// Persisted id → display-name map for Codex models. The Codex App Server reports
// a friendly `displayName` ("GPT-5.4-Mini") alongside the id ("gpt-5.4-mini")
// when the renderer lists models, but a usage detail only stores the model id.
// We persist the mapping (written whenever `codex:models` runs) so the usage
// strip can show the friendly name for a Codex run — the ACP analog of
// acp-model-cache, but a flat list (Codex isn't multi-agent).
//
// Atomic write (tmp → rename) so a crash mid-write can't corrupt it; a
// corrupt/missing file just yields an empty cache. Reads are memoized (keyed by
// path) so findCodexModelLabel doesn't re-read on every codex:usageRunDetail.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { CodexModelOption } from "@pwrsnap/shared";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:codex-model-cache");
const CACHE_VERSION = 1;

type CacheFile = {
  version: number;
  /** id → friendly display name (only entries whose name differs from the id). */
  models: Array<{ id: string; displayName: string }>;
};

function cachePath(): string {
  return join(app.getPath("userData"), "codex-model-cache.json");
}

let memo: { path: string; file: CacheFile } | null = null;

function readFile(): CacheFile {
  const path = cachePath();
  if (memo !== null && memo.path === path) return memo.file;
  let file: CacheFile = { version: CACHE_VERSION, models: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheFile>;
    if (parsed.version === CACHE_VERSION && Array.isArray(parsed.models)) {
      file = { version: CACHE_VERSION, models: parsed.models };
    }
  } catch {
    // missing / unreadable / corrupt → empty cache (re-written on next list).
  }
  memo = { path, file };
  return file;
}

/** Persist the id → displayName map from a fresh Codex model list. Only keeps
 *  entries with a friendlier name than the id (others add nothing). Best-effort
 *  — a write failure is logged, not thrown. */
export function saveCodexModelLabels(models: readonly CodexModelOption[]): void {
  try {
    const entries = models
      .filter((m) => m.displayName.length > 0 && m.displayName !== m.id)
      .map((m) => ({ id: m.id, displayName: m.displayName }));
    const next: CacheFile = { version: CACHE_VERSION, models: entries };
    const path = cachePath();
    mkdirSync(app.getPath("userData"), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), "utf8");
    renameSync(tmp, path);
    memo = { path, file: next };
  } catch (cause) {
    log.warn("failed to persist Codex model cache", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}

/** Friendly display name for a Codex model id, or undefined when unknown (never
 *  listed, or its name equals the id). The caller falls back to the raw id. */
export function findCodexModelLabel(id: string): string | undefined {
  if (id.length === 0) return undefined;
  return readFile().models.find((m) => m.id === id)?.displayName;
}
