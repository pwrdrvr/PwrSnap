// Plaintext NEVER crosses the IPC boundary — the renderer-visible
// API returns only `SecretStatus` (`{ configured, lastSetAt }`).

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import type { DesktopSettingsSecretName, SecretStatus } from "@pwrsnap/shared";
import { getMainLogger } from "../log";

type Logger = ReturnType<typeof getMainLogger>;

export const KNOWN_SECRET_NAMES = [
  "grokApiKey",
  "openaiApiKey"
] as const satisfies readonly Exclude<DesktopSettingsSecretName, `localAgentToken:${string}`>[];

// Compile-time check the other direction: adding a new
// `DesktopSettingsSecretName` without appending it here fails to
// compile. `Exclude<>` returns `never` only when every union member
// appears in the tuple.
type _KnownSecretNamesExhaustive =
  Exclude<
    Exclude<DesktopSettingsSecretName, `localAgentToken:${string}`>,
    typeof KNOWN_SECRET_NAMES[number]
  > extends never
    ? true
    : false;
const _knownSecretNamesExhaustive: _KnownSecretNamesExhaustive = true;
void _knownSecretNamesExhaustive;

export type DesktopSecretStoreConfig = {
  filePath: string;
  logger?: Logger;
};

type StoredSecret = {
  value: string;
  lastSetAt: string;
};

type SecretsBlob = Partial<Record<DesktopSettingsSecretName, StoredSecret>>;

export class DesktopSecretStore {
  private readonly filePath: string;
  private readonly log: Logger;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(config: DesktopSecretStoreConfig) {
    this.filePath = config.filePath;
    this.log = config.logger ?? getMainLogger("pwrsnap:secret-store");
  }

  async getStatus(name: DesktopSettingsSecretName): Promise<SecretStatus> {
    const blob = await this.readBlob();
    return toStatus(blob[name]);
  }

  async getAllStatus(): Promise<Record<DesktopSettingsSecretName, SecretStatus>> {
    const blob = await this.readBlob();
    const out = {} as Record<DesktopSettingsSecretName, SecretStatus>;
    for (const name of KNOWN_SECRET_NAMES) {
      out[name] = toStatus(blob[name]);
    }
    return out;
  }

  async replace(name: DesktopSettingsSecretName, value: string): Promise<SecretStatus> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new SecretUnavailableError(
        "safeStorage is unavailable — system keychain not ready"
      );
    }
    return this.serialize(async () => {
      const blob = await this.readBlob();
      const nextEntry: StoredSecret = {
        value,
        lastSetAt: new Date().toISOString()
      };
      blob[name] = nextEntry;
      await this.writeBlob(blob);
      return toStatus(nextEntry);
    });
  }

  // Clear writes an empty `{}` rather than deleting the file so the
  // read path has one shape to handle.
  async clear(name: DesktopSettingsSecretName): Promise<SecretStatus> {
    return this.serialize(async () => {
      const blob = await this.readBlob();
      if (blob[name] === undefined) {
        return toStatus(undefined);
      }
      delete blob[name];
      await this.writeBlob(blob);
      return toStatus(undefined);
    });
  }

  // Main-process-only accessor — NOT registered on the command bus,
  // plaintext must never leave the main process. Phase 4 Grok client
  // is the intended consumer.
  async getValue(name: DesktopSettingsSecretName): Promise<string | null> {
    const blob = await this.readBlob();
    const stored = blob[name];
    return stored?.value ?? null;
  }

  // ---- internals ----

  private async readBlob(): Promise<SecretsBlob> {
    let raw: Buffer;
    try {
      raw = await readFile(this.filePath);
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return {};
      this.log.warn("secret-store: read failed, returning empty", {
        path: this.filePath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return {};
    }
    if (raw.length === 0) return {};
    let plaintext: string;
    try {
      plaintext = safeStorage.decryptString(raw);
    } catch (cause) {
      this.log.warn("secret-store: decrypt failed, returning empty", {
        path: this.filePath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(plaintext);
      if (!isRecord(parsed)) return {};
      const out: SecretsBlob = {};
      for (const name of KNOWN_SECRET_NAMES) {
        const entry = parsed[name];
        if (isStoredSecret(entry)) out[name] = entry;
      }
      for (const [name, entry] of Object.entries(parsed)) {
        if (!isLocalAgentTokenName(name)) continue;
        if (isStoredSecret(entry)) out[name] = entry;
      }
      return out;
    } catch (cause) {
      this.log.warn("secret-store: parse failed, returning empty", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return {};
    }
  }

  private async writeBlob(blob: SecretsBlob): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new SecretUnavailableError(
        "safeStorage is unavailable — refusing to write"
      );
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const json = JSON.stringify(blob);
    const ciphertext = safeStorage.encryptString(json);
    const tmpPath = `${this.filePath}.tmp`;
    try {
      await writeFile(tmpPath, ciphertext);
      await rename(tmpPath, this.filePath);
    } catch (cause) {
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore */
      }
      throw cause;
    }
  }

  private async serialize<T>(task: () => Promise<T>): Promise<T> {
    // `catch(() => undefined).then(task)` so the queue's baton always
    // resolves regardless of prior outcome — the caller of `next`
    // still observes their own rejection; only the queue itself
    // swallows it so subsequent secret writes proceed.
    const next = this.writeQueue.catch(() => undefined).then(task);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

export class SecretUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretUnavailableError";
  }
}

function toStatus(entry: StoredSecret | undefined): SecretStatus {
  if (entry === undefined) return { configured: false, lastSetAt: null };
  return { configured: true, lastSetAt: entry.lastSetAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredSecret(value: unknown): value is StoredSecret {
  return (
    isRecord(value) &&
    typeof value.value === "string" &&
    typeof value.lastSetAt === "string"
  );
}

function isLocalAgentTokenName(value: string): value is `localAgentToken:${string}` {
  const prefix = "localAgentToken:";
  return value.startsWith(prefix) && value.length > prefix.length;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}
