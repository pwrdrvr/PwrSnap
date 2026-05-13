// safeStorage-backed secret store. Persists a small set of named
// secrets to `<userData>/pwrsnap-secrets.bin` encrypted via Electron's
// `safeStorage` (Keychain on macOS, libsecret/DPAPI elsewhere).
//
// On-disk shape: the encrypted blob decrypts to a JSON object keyed
// by `DesktopSettingsSecretName`. Each value is
// `{ value: string; lastSetAt: string }`. Plaintext NEVER touches
// disk and NEVER crosses the IPC boundary — the renderer-visible
// API returns only `SecretStatus` (`{ configured, lastSetAt }`).
//
// Mirrors (not lifts) PwrAgnt's interface from
// ~/github/PwrAgnt/apps/desktop/src/main/settings/desktop-secret-store.ts.
// PwrAgnt ships the interface + an in-memory test implementation;
// the production safeStorage-backed implementation is what we need
// here, so this file is the real impl, not a port.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import type { DesktopSettingsSecretName, SecretStatus } from "@pwrsnap/shared";
import { getMainLogger } from "../log";

type Logger = ReturnType<typeof getMainLogger>;

/**
 * Every secret name persisted by the app. Used by `getAllStatus` to
 * project a default `{ configured: false, lastSetAt: null }` for
 * unset names — the renderer's AI Providers page needs every known
 * name in its initial render so the masked status rows can mount
 * without first-launch flicker.
 */
export const KNOWN_SECRET_NAMES = ["grokApiKey"] as const satisfies readonly DesktopSettingsSecretName[];

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

  getFilePath(): string {
    return this.filePath;
  }

  /** Mask a single secret to the status shape returned across the IPC
   *  boundary. Never includes the plaintext value. */
  async getStatus(name: DesktopSettingsSecretName): Promise<SecretStatus> {
    const blob = await this.readBlob();
    return toStatus(blob[name]);
  }

  /** Map of `{ name → status }` for every KNOWN secret, even if absent.
   *  Renderer relies on this so its mount-time render has every row
   *  ready. */
  async getAllStatus(): Promise<Record<DesktopSettingsSecretName, SecretStatus>> {
    const blob = await this.readBlob();
    const out = {} as Record<DesktopSettingsSecretName, SecretStatus>;
    for (const name of KNOWN_SECRET_NAMES) {
      out[name] = toStatus(blob[name]);
    }
    return out;
  }

  /**
   * Set or overwrite the named secret. Throws if `safeStorage` is not
   * available (e.g., on CI / first launch before the OS keychain is
   * up). Callers at the bus handler layer translate into a Result-err.
   */
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

  /**
   * Remove the named secret from the blob. If clearing leaves the
   * blob empty, we write an empty `{}` rather than deleting the file
   * so subsequent reads stay simple (one code path).
   */
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

  /**
   * Main-process-only accessor for the plaintext. Used by future
   * features that spawn a process needing the secret (e.g., Phase 4
   * Grok client). Renderer code MUST NEVER call this — it is not
   * registered on the command bus. Returns `null` when the secret
   * is unset.
   */
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
    const queued = this.writeQueue.then(task, task);
    this.writeQueue = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }
}

/** Distinguished error thrown when safeStorage is unavailable. The
 *  handler layer translates into a Result-err with code
 *  `secret_unavailable`. */
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

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}
