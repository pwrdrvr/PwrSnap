// Sentinel-guarded data-root reset. Layered safety:
//   1. PWRSNAP_DATA_ROOT set AND not equal to userData (primary —
//      defends against running with no env var).
//   2. Path is not on the banned list (~, ~/Documents, ~/Desktop,
//      ~/Downloads — defends against typo'd env vars).
//   3. If the data root contains anything other than the sentinel,
//      the sentinel must be present + parseable + ≤30 days old
//      (defends against typos pointing at populated user dirs that
//      slipped past the banned list, and against Time Machine-
//      restored stale sentinels).
//
// First-run bootstrap: when the data root is missing or empty, the
// sentinel checks are skipped — there's nothing to wipe and nothing
// to protect. The runner then creates the sentinel before any data
// is written.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getDataRoot, isOverriddenDataRoot, SEEDER_SENTINEL } from "../../persistence/paths";

const SENTINEL_MAX_AGE_DAYS = 30;

type SentinelBlob = {
  uuid: string;
  createdAt: string;
};

function sentinelPath(): string {
  return join(getDataRoot(), SEEDER_SENTINEL);
}

/**
 * Files / directories the seeder + app produce. A data root that
 * contains ONLY entries from this set (no sentinel) is considered a
 * crash-recovery bootstrap: a prior seed run failed mid-flight,
 * leftover state is what we'd be wiping anyway, allow it through.
 */
const SEEDER_OWNED_ENTRIES: ReadonlySet<string> = new Set([
  "pwrsnap.db",
  "pwrsnap.db-shm",
  "pwrsnap.db-wal",
  "captures",
  "cache",
  "render-cache",
  ".trash",
  "perf",
  ".DS_Store" // macOS leaves these everywhere
]);

/**
 * Hard refuse paths that are commonly populated user-data directories.
 * Catches the typo case where `PWRSNAP_DATA_ROOT=$HOME` etc. slips
 * past the env-equals-userData check.
 */
function bannedPaths(): readonly string[] {
  const home = homedir();
  return [home, join(home, "Documents"), join(home, "Desktop"), join(home, "Downloads")];
}

/**
 * Throws if the configured data root is NOT safe to wipe. Call before
 * any destructive operation. Idempotent — does not mutate state.
 *
 * On a fresh / empty data root the sentinel checks are skipped: there
 * is nothing to wipe and nothing to lose. The first seed run creates
 * the sentinel before any data lands; subsequent runs find it and
 * pass the secondary checks.
 */
export function assertCanWipe(): void {
  // 1. Env override present.
  if (!isOverriddenDataRoot()) {
    throw new Error(
      "Refusing to wipe: PWRSNAP_DATA_ROOT is unset or equals app.getPath('userData'). " +
        "Set PWRSNAP_DATA_ROOT to a non-default location (e.g. /Volumes/Dev/pwrsnap-perf/10k) before wiping."
    );
  }
  // 2. Banned paths (typo defense).
  const root = resolve(getDataRoot());
  for (const banned of bannedPaths()) {
    if (root === resolve(banned)) {
      throw new Error(
        `Refusing to wipe: PWRSNAP_DATA_ROOT (${root}) is a user-data directory.`
      );
    }
  }
  // 3. Bootstrap paths — first run or recovery from a crashed run.
  //    `existsSync` may throw on some filesystems; treat any error as
  //    "doesn't exist."
  let entries: string[] = [];
  try {
    if (!existsSync(root)) return;
    entries = readdirSync(root);
  } catch {
    return;
  }
  // Empty → first-run bootstrap; allow wipe.
  if (entries.length === 0) return;
  // All entries are things the seeder owns AND no sentinel → recovery
  // bootstrap (prior run crashed before createSentinel). The wipe is
  // going to delete these anyway; allow.
  const hasSentinel = entries.includes(SEEDER_SENTINEL);
  if (!hasSentinel && entries.every((e) => SEEDER_OWNED_ENTRIES.has(e))) {
    return;
  }
  // 4. Sentinel exists.
  const path = sentinelPath();
  if (!existsSync(path)) {
    throw new Error(
      `Refusing to wipe: ${root} contains non-seeder data but no ${SEEDER_SENTINEL} sentinel. ` +
        `Run against an empty directory or remove conflicting contents first.`
    );
  }
  // 5. Sentinel content parses + matches expected shape.
  let blob: SentinelBlob;
  try {
    blob = JSON.parse(readFileSync(path, "utf8")) as SentinelBlob;
  } catch (cause) {
    throw new Error(
      `Refusing to wipe: sentinel at ${path} could not be parsed as JSON. ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`
    );
  }
  if (typeof blob.uuid !== "string" || blob.uuid.length !== 32) {
    throw new Error(
      `Refusing to wipe: sentinel at ${path} has malformed uuid (got ${JSON.stringify(blob.uuid)}).`
    );
  }
  // 6. Sentinel is fresh enough.
  const ageMs = Date.now() - statSync(path).mtimeMs;
  const ageDays = ageMs / 86_400_000;
  if (ageDays > SENTINEL_MAX_AGE_DAYS) {
    throw new Error(
      `Refusing to wipe: sentinel at ${path} is ${ageDays.toFixed(0)}d old ` +
        `(limit ${SENTINEL_MAX_AGE_DAYS}d). Touch a fresh sentinel by running a non-wipe seed.`
    );
  }
}

/**
 * Write the sentinel file under the current data root. Generates a
 * fresh UUID + timestamp every call (touching it bumps mtime, which
 * keeps long-running dev branches under the staleness limit). Caller
 * is responsible for ensuring the data root directory exists.
 */
export function createSentinel(): void {
  const blob: SentinelBlob = {
    uuid: createHash("sha256").update(randomBytes(16)).digest("hex").slice(0, 32),
    createdAt: new Date().toISOString()
  };
  writeFileSync(sentinelPath(), JSON.stringify(blob), "utf8");
}

/**
 * `rm -rf <dataRoot>/<entry>` for every standard entry. Stops short
 * of deleting the data root itself (keeps the sentinel + any user
 * artifacts in place). Idempotent.
 */
export async function wipeDataRoot(): Promise<void> {
  assertCanWipe();
  const root = getDataRoot();
  // Remove standard sub-trees the seeder + app produce. Leave the
  // root directory + sentinel in place; the next seed run rewrites
  // the sentinel via `createSentinel()` to bump mtime.
  const entries = [
    "pwrsnap.db",
    "pwrsnap.db-shm",
    "pwrsnap.db-wal",
    "captures",
    "cache",
    "render-cache",
    ".trash",
    "perf"
  ];
  for (const entry of entries) {
    await rm(join(root, entry), { recursive: true, force: true });
  }
}
