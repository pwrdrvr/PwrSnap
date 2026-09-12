// Plaintext NEVER crosses the IPC boundary — the renderer-visible
// API returns only `SecretStatus` (`{ configured, lastSetAt }`).
//
// ON-DISK LAYOUT (v2 envelope). The file is JSON with a PLAINTEXT index and
// an encrypted payload:
//
//   { "version": 2,
//     "index": { "openaiApiKey": { "lastSetAt": "2026-..." } },
//     "ciphertext": "<base64 of safeStorage.encryptString({name: value}) >" }
//
// Why the index is outside the ciphertext: on macOS, the FIRST safeStorage
// call in a process fetches the app's key from the login keychain, and for a
// binary that is not on that keychain item's access list the OS asks for the
// user's password. Before this split, every `settings:secretStatus` read
// decrypted — and `broadcastSettingsChanged` calls `getAllStatus()` after
// EVERY settings write — so merely opening Settings or toggling any
// preference could trigger that prompt, on an app the user had never given a
// secret to. Now only `getValue()` touches the keychain, which happens when a
// feature actually needs a secret.
//
// Nothing in the index is itself a secret, and none of it is newly exposed:
// `SecretStatus` (the name plus `lastSetAt`) is already broadcast to every
// BrowserWindow on every settings change, and the `localAgentToken:<clientId>`
// client ids already sit in cleartext in the settings file as
// `localAgents.grants[].id`. The VALUES remain encrypted at rest, and a unit
// test asserts the plaintext never appears in the file.
//
// v1 files (a bare `safeStorage` ciphertext buffer of the whole blob) are
// still read, and are rewritten as v2 on first access so the decrypt-per-
// status-read cost is paid at most once per install rather than forever.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import type { DesktopSettingsSecretName, SecretStatus } from "@pwrsnap/shared";
import { getMainLogger } from "../log";

type Logger = ReturnType<typeof getMainLogger>;

export const KNOWN_SECRET_NAMES = [
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

/** Current on-disk envelope version. Bump only for an incompatible layout
 *  change, and extend `readFileState` to keep reading the older one. */
export const SECRETS_FILE_VERSION = 2;

export type DesktopSecretStoreConfig = {
  filePath: string;
  logger?: Logger;
};

type StoredSecret = {
  value: string;
  lastSetAt: string;
};

type SecretsBlob = Partial<Record<DesktopSettingsSecretName, StoredSecret>>;

/** What the plaintext half of the envelope carries per name. */
type IndexEntry = { lastSetAt: string };
type SecretsIndex = Partial<Record<DesktopSettingsSecretName, IndexEntry>>;

type FileState =
  | { kind: "absent" }
  | { kind: "envelope"; index: SecretsIndex; ciphertext: string | null }
  /** A v1 file: the whole blob as one `safeStorage` ciphertext buffer. */
  | { kind: "legacy"; raw: Buffer };

export class DesktopSecretStore {
  private readonly filePath: string;
  private readonly log: Logger;
  private writeQueue: Promise<unknown> = Promise.resolve();
  /** Set once a v1 -> v2 rewrite has been queued, so a burst of status reads
   *  on a legacy file queues one migration rather than one per read. */
  private migrationQueued = false;

  constructor(config: DesktopSecretStoreConfig) {
    this.filePath = config.filePath;
    this.log = config.logger ?? getMainLogger("pwrsnap:secret-store");
  }

  async getStatus(name: DesktopSettingsSecretName): Promise<SecretStatus> {
    const index = await this.readIndex();
    return toStatus(index[name]);
  }

  async getAllStatus(): Promise<Record<DesktopSettingsSecretName, SecretStatus>> {
    const index = await this.readIndex();
    const out = {} as Record<DesktopSettingsSecretName, SecretStatus>;
    for (const name of KNOWN_SECRET_NAMES) {
      out[name] = toStatus(index[name]);
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
      const state = await this.readFileState();
      // Only decrypt when there is a value we must preserve. Writing the
      // first secret, or overwriting the only one, needs no read of the
      // existing payload.
      const skipRead = state.kind === "envelope" && onlyKeyIs(state.index, name);
      const blob = skipRead ? {} : await this.blobFrom(state);
      if (!skipRead) this.assertPayloadRecovered(state, blob);
      const nextEntry: StoredSecret = {
        value,
        lastSetAt: new Date().toISOString()
      };
      blob[name] = nextEntry;
      await this.writeBlob(blob);
      return toStatus(nextEntry);
    });
  }

  async clear(name: DesktopSettingsSecretName): Promise<SecretStatus> {
    return this.serialize(async () => {
      const state = await this.readFileState();

      // Clearing a name that is not set, or clearing the LAST remaining
      // secret, is answerable from the plaintext index alone -- so neither
      // touches the keychain. The second case matters because it is how a
      // store returns to "no secrets at all".
      if (state.kind === "envelope") {
        if (state.index[name] === undefined) {
          return toStatus(undefined);
        }
        if (onlyKeyIs(state.index, name)) {
          await this.writeBlob({});
          return toStatus(undefined);
        }
      }

      const blob = await this.blobFrom(state);
      this.assertPayloadRecovered(state, blob);
      if (blob[name] === undefined) {
        return toStatus(undefined);
      }
      delete blob[name];
      await this.writeBlob(blob);
      return toStatus(undefined);
    });
  }

  // Main-process-only accessor — NOT registered on the command bus,
  // plaintext must never leave the main process. This is the ONLY read that
  // decrypts, and therefore the only one that can reach the keychain.
  async getValue(name: DesktopSettingsSecretName): Promise<string | null> {
    const blob = await this.blobFrom(await this.readFileState());
    return blob[name]?.value ?? null;
  }

  // ---- internals ----

  /** Read + classify the file without decrypting anything. */
  private async readFileState(): Promise<FileState> {
    let raw: Buffer;
    try {
      raw = await readFile(this.filePath);
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return { kind: "absent" };
      this.log.warn("secret-store: read failed, returning empty", {
        path: this.filePath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return { kind: "absent" };
    }
    if (raw.length === 0) return { kind: "absent" };

    // A v2 envelope is JSON text, so it starts with `{`. A v1 file is a raw
    // safeStorage ciphertext: "v10"/"v11" on macOS and Linux, a DPAPI blob
    // starting 0x01 on Windows. Neither can start with `{`.
    if (raw[0] !== 0x7b) return { kind: "legacy", raw };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      // Started with `{` but is not JSON. Treat as legacy so the decrypt path
      // gets a chance rather than silently discarding a readable file.
      return { kind: "legacy", raw };
    }
    if (!isRecord(parsed) || parsed.version !== SECRETS_FILE_VERSION) {
      return { kind: "legacy", raw };
    }

    const ciphertext = typeof parsed.ciphertext === "string" ? parsed.ciphertext : null;
    // The two halves are always written together, so a null payload means no
    // secrets. Dropping the index in that case keeps a hand-edited or
    // truncated file from reporting `configured: true` for a name whose value
    // can never be produced.
    if (ciphertext === null) return { kind: "envelope", index: {}, ciphertext: null };
    return { kind: "envelope", index: sanitizeIndex(parsed.index), ciphertext };
  }

  /** Status-only read. Never decrypts for a v2 file. */
  private async readIndex(): Promise<SecretsIndex> {
    const state = await this.readFileState();
    if (state.kind === "envelope") return state.index;
    if (state.kind === "absent") return {};
    // Legacy: the names and timestamps are inside the ciphertext, so this one
    // read must decrypt. Rewriting as v2 is what stops it happening again.
    const blob = this.decryptLegacy(state.raw);
    this.queueMigration();
    return indexOf(blob);
  }

  /** Full read, decrypting the payload. */
  private async blobFrom(state: FileState): Promise<SecretsBlob> {
    if (state.kind === "absent") return {};
    if (state.kind === "legacy") {
      const blob = this.decryptLegacy(state.raw);
      this.queueMigration();
      return blob;
    }
    if (state.ciphertext === null) return {};

    let plaintext: string;
    try {
      plaintext = safeStorage.decryptString(Buffer.from(state.ciphertext, "base64"));
    } catch (cause) {
      // A read of an undecryptable payload stays lenient: callers of
      // `getValue` treat a missing secret as "not configured" and degrade.
      // WRITES do not -- `assertPayloadRecovered` compares this result
      // against the still-readable index and refuses, because re-encrypting
      // what we could not read back would destroy it.
      this.log.warn("secret-store: decrypt failed, returning empty", {
        path: this.filePath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return {};
    }
    // The payload carries values only; `lastSetAt` lives in the plaintext
    // index. Stitch it back so a rewrite (clearing one of several secrets)
    // preserves the surviving entries' timestamps instead of blanking them.
    const blob = parseBlob(plaintext, this.log);
    for (const [name, entry] of Object.entries(blob) as [
      DesktopSettingsSecretName,
      StoredSecret
    ][]) {
      entry.lastSetAt = state.index[name]?.lastSetAt ?? entry.lastSetAt;
    }
    return blob;
  }

  private decryptLegacy(raw: Buffer): SecretsBlob {
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
    return parseBlob(plaintext, this.log);
  }

  /** Refuse to rewrite the file when the plaintext index proves there are
   *  entries the payload would not give back.
   *
   *  A decrypt failure makes `blobFrom` read as empty, and every write
   *  re-encrypts only what it holds — so without this guard a write silently
   *  destroys every secret it could not decrypt, and `clear()` reports
   *  "removed" for an entry that is still on disk and still `configured` in
   *  the very next status broadcast. Failing with `secret_unavailable` (which
   *  the settings handler already surfaces) is recoverable: the user restores
   *  keychain access and retries. Overwriting is not.
   *
   *  Envelope-only by design. A v1 file keeps its names inside the ciphertext,
   *  so there is no way to tell "absent" from "undecryptable" there, and the
   *  pre-envelope leniency is preserved for it. */
  private assertPayloadRecovered(state: FileState, blob: SecretsBlob): void {
    if (state.kind !== "envelope") return;
    const missing = Object.keys(state.index).filter(
      (name) => blob[name as DesktopSettingsSecretName] === undefined
    );
    if (missing.length === 0) return;
    throw new SecretUnavailableError(
      `safeStorage could not decrypt ${missing.length} stored secret(s) — refusing to write, which would discard them`
    );
  }

  private async writeBlob(blob: SecretsBlob): Promise<void> {
    const values: Partial<Record<DesktopSettingsSecretName, string>> = {};
    const index: SecretsIndex = {};
    for (const [name, entry] of Object.entries(blob) as [
      DesktopSettingsSecretName,
      StoredSecret | undefined
    ][]) {
      if (entry === undefined) continue;
      values[name] = entry.value;
      index[name] = { lastSetAt: entry.lastSetAt };
    }

    let ciphertext: string | null = null;
    if (Object.keys(values).length > 0) {
      // Only an actual secret needs encryption. An empty store writes an
      // envelope with a null payload, so clearing the last secret -- and
      // every later status read -- stays off the keychain entirely.
      if (!safeStorage.isEncryptionAvailable()) {
        throw new SecretUnavailableError(
          "safeStorage is unavailable — refusing to write"
        );
      }
      ciphertext = safeStorage.encryptString(JSON.stringify(values)).toString("base64");
    }

    const envelope = { version: SECRETS_FILE_VERSION, index, ciphertext };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(envelope));
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

  /** Rewrite a v1 file as a v2 envelope, once, behind the write queue.
   *  Re-reads inside the task: a real write may have landed first, and that
   *  write already produced a v2 file. Failure is logged, never thrown — a
   *  migration that cannot run leaves the caller's read result untouched. */
  private queueMigration(): void {
    if (this.migrationQueued) return;
    this.migrationQueued = true;
    void this.serialize(async () => {
      const state = await this.readFileState();
      if (state.kind !== "legacy") return;
      const blob = this.decryptLegacy(state.raw);
      if (Object.keys(blob).length === 0) {
        // Nothing recovered — rewriting would turn an undecryptable file into
        // an authoritative empty one. Leave it alone.
        return;
      }
      await this.writeBlob(blob);
      this.log.info("secret-store: migrated v1 secrets file to v2 envelope", {
        path: this.filePath,
        names: Object.keys(blob).length
      });
    }).catch((cause: unknown) => {
      this.migrationQueued = false;
      this.log.warn("secret-store: v1 -> v2 migration failed", {
        path: this.filePath,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    });
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

function toStatus(entry: IndexEntry | StoredSecret | undefined): SecretStatus {
  if (entry === undefined) return { configured: false, lastSetAt: null };
  return { configured: true, lastSetAt: entry.lastSetAt };
}

/** True when `index` has exactly one entry and it is `name`. */
function onlyKeyIs(index: SecretsIndex, name: DesktopSettingsSecretName): boolean {
  const keys = Object.keys(index);
  return keys.length === 0 || (keys.length === 1 && keys[0] === name);
}

function indexOf(blob: SecretsBlob): SecretsIndex {
  const index: SecretsIndex = {};
  for (const [name, entry] of Object.entries(blob) as [
    DesktopSettingsSecretName,
    StoredSecret | undefined
  ][]) {
    if (entry !== undefined) index[name] = { lastSetAt: entry.lastSetAt };
  }
  return index;
}

/** Accept only names this build knows, exactly like the decrypted payload. */
function isAcceptedName(name: string): name is DesktopSettingsSecretName {
  return (
    (KNOWN_SECRET_NAMES as readonly string[]).includes(name) || isLocalAgentTokenName(name)
  );
}

function sanitizeIndex(value: unknown): SecretsIndex {
  if (!isRecord(value)) return {};
  const out: SecretsIndex = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isAcceptedName(name)) continue;
    if (isRecord(entry) && typeof entry.lastSetAt === "string") {
      out[name] = { lastSetAt: entry.lastSetAt };
    }
  }
  return out;
}

/** Parse a decrypted payload. Accepts BOTH shapes: the v2 payload is
 *  `{ name: value }`, the v1 file decrypted to `{ name: { value, lastSetAt } }`. */
function parseBlob(plaintext: string, log: Logger): SecretsBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (cause) {
    log.warn("secret-store: parse failed, returning empty", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return {};
  }
  if (!isRecord(parsed)) return {};

  const out: SecretsBlob = {};
  for (const [name, entry] of Object.entries(parsed)) {
    if (!isAcceptedName(name)) continue;
    if (typeof entry === "string") {
      // v2 payload. `lastSetAt` lives in the plaintext index; a caller that
      // wants it reads the index. Callers of the blob want `.value`.
      out[name] = { value: entry, lastSetAt: "" };
      continue;
    }
    if (isStoredSecret(entry)) out[name] = entry;
  }
  return out;
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
