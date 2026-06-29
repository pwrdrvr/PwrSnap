import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { UpdateChannel } from "@pwrsnap/shared";

const SCHEMA_VERSION = 1;
const ATTEMPT_FILE_NAME = "pwrsnap-update-install-attempt.json";

export type AppUpdateInstallAttempt = {
  schemaVersion: typeof SCHEMA_VERSION;
  expectedVersion: string;
  fromVersion: string;
  channel: UpdateChannel;
  attemptedAt: string;
};

export type AppUpdateInstallAttemptStore = {
  clear(): void;
  filePath(): string;
  read(): AppUpdateInstallAttempt | undefined;
  write(attempt: Omit<AppUpdateInstallAttempt, "schemaVersion">): AppUpdateInstallAttempt;
};

function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === "latest" || value === "prerelease";
}

function parseAttempt(raw: string): AppUpdateInstallAttempt | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const value = parsed as Partial<AppUpdateInstallAttempt>;
  if (value.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (typeof value.expectedVersion !== "string" || value.expectedVersion.length === 0) {
    return undefined;
  }
  if (typeof value.fromVersion !== "string" || value.fromVersion.length === 0) {
    return undefined;
  }
  if (!isUpdateChannel(value.channel)) return undefined;
  if (typeof value.attemptedAt !== "string" || value.attemptedAt.length === 0) {
    return undefined;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    expectedVersion: value.expectedVersion,
    fromVersion: value.fromVersion,
    channel: value.channel,
    attemptedAt: value.attemptedAt
  };
}

export function createAppUpdateInstallAttemptStore(userDataDir: string): AppUpdateInstallAttemptStore {
  const path = join(userDataDir, ATTEMPT_FILE_NAME);
  return {
    clear(): void {
      rmSync(path, { force: true });
    },
    filePath(): string {
      return path;
    },
    read(): AppUpdateInstallAttempt | undefined {
      if (!existsSync(path)) return undefined;
      return parseAttempt(readFileSync(path, "utf8"));
    },
    write(attempt): AppUpdateInstallAttempt {
      const next: AppUpdateInstallAttempt = {
        schemaVersion: SCHEMA_VERSION,
        ...attempt
      };
      const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
      renameSync(tmp, path);
      return next;
    }
  };
}
