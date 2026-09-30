import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const APP_UPDATE_FIRST_CHECK_DELAY_MS = 10 * 60 * 1_000;
export const APP_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

// Persist only fields the selector uses, not GitHub's full release bodies.
// GitHub permits null names/publication dates (notably on draft releases).
const optionalText = z.preprocess((value) => value === null ? undefined : value, z.string().optional());
const releaseSchema = z.object({
  assets: z.array(z.object({ name: optionalText, state: optionalText })).optional(),
  draft: z.boolean().optional(),
  html_url: optionalText,
  name: optionalText,
  prerelease: z.boolean().optional(),
  published_at: optionalText,
  tag_name: optionalText
});
export type GitHubRelease = z.infer<typeof releaseSchema>;
const timestamp = z.number().finite().nonnegative();
const cacheSchema = z.object({
  etags: z.record(z.string(), z.string()),
  fetchedAt: timestamp,
  latest: releaseSchema.optional(),
  releases: z.array(releaseSchema).max(1_001)
});
export type ReleaseCacheEntry = z.infer<typeof cacheSchema>;
const stateSchema = z.object({
  schemaVersion: z.literal(1),
  firstSeenAt: timestamp,
  lastAttemptAt: timestamp.nullable(),
  retryAt: timestamp.nullable(),
  rateLimitResetAt: timestamp.nullable(),
  failures: z.number().int().nonnegative(),
  cache: cacheSchema.nullable()
});
export type UpdateReleaseState = z.infer<typeof stateSchema>;

export function automaticReleaseCheckAt(state: UpdateReleaseState): number {
  return Math.max(
    state.firstSeenAt + APP_UPDATE_FIRST_CHECK_DELAY_MS,
    state.lastAttemptAt === null ? 0 : state.lastAttemptAt + APP_UPDATE_CHECK_INTERVAL_MS,
    state.cache === null ? 0 : state.cache.fetchedAt + APP_UPDATE_CHECK_INTERVAL_MS,
    state.retryAt ?? 0,
    state.rateLimitResetAt ?? 0
  );
}

/** Main-owned cache, not a user setting. One updater owner per userData is
 * enforced by the app's single-instance lock and split-process routing.
 * Nothing here coordinates separate profiles, OS users, machines or apps. */
export function createUpdateReleaseStateStore(userData: string) {
  if (!userData) throw new Error("Update release state requires a userData directory");
  const filePath = join(userData, "pwrsnap-update-release-state.json");
  return {
    async read(): Promise<UpdateReleaseState> {
      let raw: string | undefined;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (raw !== undefined) {
        try {
          return stateSchema.parse(JSON.parse(raw));
        } catch {
          // A missing/obsolete/corrupt cache starts a new grace period;
          // it must never turn a parse failure into immediate network traffic.
        }
      }
      return {
        schemaVersion: 1, firstSeenAt: Date.now(), lastAttemptAt: null,
        retryAt: null, rateLimitResetAt: null, failures: 0, cache: null
      };
    },
    async write(state: UpdateReleaseState): Promise<void> {
      await mkdir(userData, { recursive: true });
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(stateSchema.parse(state)), "utf8");
        await rename(temporary, filePath);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  };
}
