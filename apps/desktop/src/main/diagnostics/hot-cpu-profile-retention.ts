import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { HotCpuProfileCleanupResult } from "@pwrsnap/shared";
import { isHotCpuSessionDirectoryName } from "./hot-cpu-profile-paths";

export const HOT_CPU_PROFILE_RETAIN_LATEST_SESSIONS = 10;

type HotCpuSessionCandidate = {
  createdAtMs: number;
  name: string;
  path: string;
};

type RetentionOptions = {
  currentSessionDirectoryName?: string;
  keepLatest?: number;
  root: string;
};

type ClearOptions = {
  root: string;
};

function emptyResult(): HotCpuProfileCleanupResult {
  return {
    deletedSessions: 0,
    errors: [],
    freedBytes: 0,
    skippedEntries: 0
  };
}

async function readCreatedAtMs(sessionPath: string): Promise<number | null> {
  try {
    const text = await fs.readFile(path.join(sessionPath, "session.json"), "utf8");
    const parsed = JSON.parse(text) as { createdAt?: unknown };
    if (typeof parsed.createdAt !== "string") return null;
    const ms = Date.parse(parsed.createdAt);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

async function directorySizeBytes(target: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(entryPath);
      continue;
    }
    try {
      const stat = await fs.stat(entryPath);
      total += stat.size;
    } catch {
      // Size is best-effort diagnostics for UI/status text.
    }
  }
  return total;
}

async function listSessionCandidates(
  root: string,
  result: HotCpuProfileCleanupResult
): Promise<HotCpuSessionCandidate[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }

  const candidates: HotCpuSessionCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isHotCpuSessionDirectoryName(entry.name)) {
      result.skippedEntries += 1;
      continue;
    }
    const sessionPath = path.join(root, entry.name);
    const createdAtMs = (await readCreatedAtMs(sessionPath)) ?? (await fs.stat(sessionPath)).mtimeMs;
    candidates.push({ createdAtMs, name: entry.name, path: sessionPath });
  }
  return candidates;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function removeSession(
  candidate: HotCpuSessionCandidate,
  result: HotCpuProfileCleanupResult
): Promise<void> {
  const size = await directorySizeBytes(candidate.path);
  try {
    await fs.rm(candidate.path, { recursive: true });
    result.deletedSessions += 1;
    result.freedBytes += size;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    result.errors.push(`${candidate.name}: ${reason}`);
  }
}

export async function pruneHotCpuProfileSessions(
  options: RetentionOptions
): Promise<HotCpuProfileCleanupResult> {
  const result = emptyResult();
  let candidates: HotCpuSessionCandidate[];
  try {
    candidates = await listSessionCandidates(options.root, result);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    result.errors.push(`list: ${reason}`);
    return result;
  }

  const keepLatest = options.keepLatest ?? HOT_CPU_PROFILE_RETAIN_LATEST_SESSIONS;
  const keep = new Set<string>(
    candidates
      .filter((candidate) => candidate.name !== options.currentSessionDirectoryName)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, keepLatest)
      .map((candidate) => candidate.name)
  );
  if (options.currentSessionDirectoryName !== undefined) {
    keep.add(options.currentSessionDirectoryName);
  }

  for (const candidate of candidates) {
    if (keep.has(candidate.name)) continue;
    await removeSession(candidate, result);
  }

  return result;
}

export async function clearHotCpuProfileSessions(
  options: ClearOptions
): Promise<HotCpuProfileCleanupResult> {
  const result = emptyResult();
  let candidates: HotCpuSessionCandidate[];
  try {
    candidates = await listSessionCandidates(options.root, result);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    result.errors.push(`list: ${reason}`);
    return result;
  }

  for (const candidate of candidates) {
    await removeSession(candidate, result);
  }

  return result;
}
