// Plaintext NEVER returns over IPC — the renderer-visible
// API returns only `SecretStatus` (`{ configured, lastSetAt }`).
//
// ON-DISK LAYOUT (v2 envelope). The file is JSON with a PLAINTEXT index and
// an encrypted payload:
//
//   { "version": 2,
//     "index": { "openaiApiKey": { "lastSetAt": "2026-..." } },
//     "ciphertext": "<base64 of safeStorage.encryptStringAsync({name: value}) >" }
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
// `localAgents.grants[].id`, as the `customModelCredential:<connectionId>`
// ids do as `ai.customConnections[].id`. The VALUES remain encrypted at rest, and a unit
// test asserts the plaintext never appears in the file.
//
// v1 files (a bare `safeStorage` ciphertext buffer of the whole blob) are
// still read, and are rewritten as v2 on first access so the decrypt-per-
// status-read cost is paid at most once per install rather than forever.
//
// ASYNC safeStorage. Electron 45 deprecates `isEncryptionAvailable` /
// `encryptString` / `decryptString` and Electron 46 removes them, so this
// store uses the async trio for normal operations. On Linux, KWallet's
// legacy entries use different names, so the migration can read `v11`
// ciphertext once through the sync backend and rewrite it asynchronously. The
// async methods reject before app `ready`; every caller of this store is
// wired inside `app.whenReady()`. Two things differ from the sync methods:
//
// - `isAsyncEncryptionAvailable()` resolves true as soon as the encryptor has
//   initialized, whether or not any key provider produced a usable key, so
//   it is not the gate it looks like. A missing key surfaces as a rejected
//   encrypt or decrypt, and on Linux as a fallback key (`writeBlob`).
// - `decryptStringAsync` reports `shouldReEncrypt` when the payload was
//   sealed with a key other than the one it now encrypts with
//   (`queueReEncrypt`).

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { app, safeStorage } from "electron";
import type { DesktopSettingsSecretName, SecretStatus } from "@pwrsnap/shared";
import { getMainLogger } from "../log";

type Logger = ReturnType<typeof getMainLogger>;

export const KNOWN_SECRET_NAMES = [
  "openaiApiKey"
] as const satisfies readonly Exclude<DesktopSettingsSecretName, `localAgentToken:${string}` | `customModelCredential:${string}`>[];

// Compile-time check the other direction: adding a new
// `DesktopSettingsSecretName` without appending it here fails to
// compile. `Exclude<>` returns `never` only when every union member
// appears in the tuple.
type _KnownSecretNamesExhaustive =
  Exclude<
    Exclude<DesktopSettingsSecretName, `localAgentToken:${string}` | `customModelCredential:${string}`>,
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
  /** Defaults to `process.platform`; injectable so the Linux fallback-key
   *  refusal is exercised on every CI host. */
  platform?: NodeJS.Platform;
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

/** A decrypted payload, plus safeStorage's verdict on the key it was sealed
 *  with. */
type Payload = { blob: SecretsBlob; shouldReEncrypt: boolean };

export class DesktopSecretStore {
  private readonly filePath: string;
  private readonly log: Logger;
  private readonly platform: NodeJS.Platform;
  private writeQueue: Promise<unknown> = Promise.resolve();
  /** Set once a v1 -> v2 rewrite has been queued, so a burst of status reads
   *  on a legacy file queues one migration rather than one per read. */
  private migrationQueued = false;
  /** Set once a re-encryption has been queued. Never reset: see
   *  `queueReEncrypt`. */
  private reEncryptQueued = false;

  constructor(config: DesktopSecretStoreConfig) {
    this.filePath = config.filePath;
    this.log = config.logger ?? getMainLogger("pwrsnap:secret-store");
    this.platform = config.platform ?? process.platform;
  }

  async getStatus(name: DesktopSettingsSecretName): Promise<SecretStatus> {
    const index = await this.readIndex();
    return toStatus(index[name]);
  }

  /** Every known name, plus each stored Direct API connection credential —
   *  the Settings sidebar reads "no key" / "sign in" off those. Local agent
   *  tokens are left out: nothing in a renderer reads them. Index only. */
  async getAllStatus(): Promise<Record<DesktopSettingsSecretName, SecretStatus>> {
    const index = await this.readIndex();
    const out = {} as Record<DesktopSettingsSecretName, SecretStatus>;
    for (const name of KNOWN_SECRET_NAMES) {
      out[name] = toStatus(index[name]);
    }
    for (const name of Object.keys(index) as DesktopSettingsSecretName[]) {
      if (name.startsWith("customModelCredential:")) out[name] = toStatus(index[name]);
    }
    return out;
  }

  async replace(name: DesktopSettingsSecretName, value: string): Promise<SecretStatus> {
    return this.serialize(async () => {
      if (!(await secureStorageAvailable())) {
        throw new SecretUnavailableError(
          "safeStorage is unavailable — system keychain not ready"
        );
      }
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
    if (!(await secureStorageAvailable())) throw new SecretUnavailableError("Secure storage is unavailable or insecure — unlock the system credential store");
    const payload = await this.readPayload(await this.readFileState());
    if (payload === null) {
      throw new SecretUnavailableError("Credentials are unavailable. Unlock the system credential store.");
    }
    if (payload.shouldReEncrypt) this.queueReEncrypt();
    return payload.blob[name]?.value ?? null;
  }

  // ---- internals ----

  /** Read + classify the file without decrypting anything. */
  private async readFileState(): Promise<FileState> {
    let raw: Buffer;
    try {
      raw = await readFile(this.filePath);
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return { kind: "absent" };
      this.log.warn("secret-store: read failed, refusing access", {
        path: this.filePath,
        message: "Secure credential operation failed"
      });
      throw new SecretUnavailableError("Secure credential file is unreadable — refusing to overwrite it");
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
    const payload = await this.readPayload(state);
    return payload === null ? {} : indexOf(payload.blob);
  }

  /** Full read, decrypting the payload. */
  private async blobFrom(state: FileState): Promise<SecretsBlob> {
    const payload = await this.readPayload(state);
    if (payload === null) {
      throw new SecretUnavailableError(
        "safeStorage could not decrypt the stored secrets — refusing to write, which would discard them"
      );
    }
    return payload.blob;
  }

  /** `blobFrom`, plus whether safeStorage asked for the payload to be
   *  re-encrypted. Only `getValue` acts on that; see `queueReEncrypt`. */
  private async readPayload(state: FileState): Promise<Payload | null> {
    if (state.kind === "absent") return { blob: {}, shouldReEncrypt: false };
    if (state.kind === "legacy") {
      // A v1 file is rewritten under the current key by its migration, so
      // its `shouldReEncrypt` needs no handling of its own.
      const payload = await this.decrypt(state.raw);
      if (payload === null) return null;
      this.queueMigration();
      return { blob: payload.blob, shouldReEncrypt: false };
    }
    if (state.ciphertext === null) return { blob: {}, shouldReEncrypt: false };

    const payload = await this.decrypt(Buffer.from(state.ciphertext, "base64"));
    if (payload === null) return null;

    // The payload carries values only; `lastSetAt` lives in the plaintext
    // index. Stitch it back so a rewrite (clearing one of several secrets)
    // preserves the surviving entries' timestamps instead of blanking them.
    for (const [name, entry] of Object.entries(payload.blob) as [
      DesktopSettingsSecretName,
      StoredSecret
    ][]) {
      entry.lastSetAt = state.index[name]?.lastSetAt ?? entry.lastSetAt;
    }
    return payload;
  }

  private async decrypt(ciphertext: Buffer): Promise<Payload | null> {
    try {
      const decrypted = await safeStorage.decryptStringAsync(ciphertext);
      const blob = parseBlob(decrypted.result);
      if (blob !== null) return { blob, shouldReEncrypt: decrypted.shouldReEncrypt };
    } catch {
      // A legacy KWallet key may still decrypt the payload.
    }
    const legacy = this.platform === "linux" ? decryptLegacyKWallet(ciphertext) : null;
    if (legacy !== null) return { blob: legacy, shouldReEncrypt: true };
    this.log.warn("secret-store: credential payload could not be read", {
      path: this.filePath,
      message: "Secure credential operation failed"
    });
    return null;
  }

  /** Refuse to rewrite the file when the plaintext index proves there are
   *  entries missing from an otherwise readable payload. */
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
      if (!(await secureStorageAvailable())) {
        throw new SecretUnavailableError(
          "safeStorage is unavailable — refusing to write"
        );
      }
      let sealed: Buffer;
      try {
        sealed = await safeStorage.encryptStringAsync(JSON.stringify(values));
      } catch {
        throw new SecretUnavailableError("Secure credential encryption failed — unlock the system credential store");
      }
      if (sealedWithLinuxFallbackKey(sealed, this.platform)) {
        throw new SecretUnavailableError(
          "safeStorage has no keyring key on this system — refusing to write secrets under its built-in fallback key"
        );
      }
      ciphertext = sealed.toString("base64");
    }

    const envelope = { version: SECRETS_FILE_VERSION, index, ciphertext };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(envelope), { mode: 0o600 });
      await rename(tmpPath, this.filePath);
    } catch {
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore */
      }
      throw new SecretUnavailableError("Secure credential write failed");
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
      const payload = await this.decrypt(state.raw);
      if (payload === null || Object.keys(payload.blob).length === 0) {
        // Nothing recovered — rewriting would turn an undecryptable file into
        // an authoritative empty one. Leave it alone.
        return;
      }
      const { blob } = payload;
      await this.writeBlob(blob);
      this.log.info("secret-store: migrated v1 secrets file to v2 envelope", {
        path: this.filePath,
        names: Object.keys(blob).length
      });
    }).catch(() => {
      this.migrationQueued = false;
      this.log.warn("secret-store: v1 -> v2 migration failed", {
        path: this.filePath,
        message: "Secure credential operation failed"
      });
    });
  }

  /** Rewrite the payload under safeStorage's current key, once, behind the
   *  write queue. `decryptStringAsync` sets `shouldReEncrypt` when the
   *  payload was sealed with a key provider other than the one it now
   *  encrypts with: a rotated key, or a stronger provider that has come
   *  online (on Linux, the Secret portal ahead of the keyring).
   *
   *  Only `getValue` needs this. `replace` and `clear` rewrite the payload
   *  anyway, and a v1 file is rewritten by its migration. It runs from
   *  `getValue` alone, so it adds no keychain access to any path that was not
   *  already decrypting.
   *
   *  Re-reads inside the task, because a write may have landed first and
   *  that write already used the current key. Never rewrites a payload it
   *  could not decrypt. The flag is not reset on failure, unlike the
   *  migration's: safeStorage settles its key providers once per process, so
   *  a failed rewrite would fail the same way on every later `getValue`. The
   *  next launch tries again. */
  private queueReEncrypt(): void {
    if (this.reEncryptQueued) return;
    this.reEncryptQueued = true;
    void this.serialize(async () => {
      const state = await this.readFileState();
      if (state.kind !== "envelope") return;
      const payload = await this.readPayload(state);
      if (payload === null || !payload.shouldReEncrypt) return;
      const { blob } = payload;
      this.assertPayloadRecovered(state, blob);
      await this.writeBlob(blob);
      this.log.info("secret-store: re-encrypted secrets under safeStorage's current key", {
        path: this.filePath,
        names: Object.keys(blob).length
      });
    }).catch(() => {
      this.log.warn("secret-store: re-encryption failed, keeping the readable payload", {
        path: this.filePath,
        message: "Secure credential operation failed"
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

const storesByPath = new Map<string, DesktopSecretStore>();

/** Every caller uses the process's shared store for its configured file:
 *  the write queue serializes only within an instance, and two
 *  instances on one file would interleave their read-modify-write cycles
 *  and share one `.tmp` path. `getValue()` can write too (`queueReEncrypt`),
 *  so even a read-only caller needs the shared queue. The timeline render
 *  handlers can use the developer data-root override. */
export function getDesktopSecretStore(root = app.getPath("userData")): DesktopSecretStore {
  const filePath = resolve(root, "pwrsnap-secrets.bin");
  const store = storesByPath.get(filePath);
  if (store !== undefined) return store;
  const created = new DesktopSecretStore({ filePath });
  storesByPath.set(filePath, created);
  return created;
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
    (KNOWN_SECRET_NAMES as readonly string[]).includes(name) || isLocalAgentTokenName(name) || /^customModelCredential:[0-9a-f-]{36}$/i.test(name)
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
function parseBlob(plaintext: string): SecretsBlob | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

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

/** Linux basic_text uses a hard-coded password and is not secure storage.
 *
 *  The backend check goes first because it is a plain read of a setting,
 *  while `isAsyncEncryptionAvailable()` initializes the async encryptor, and
 *  on macOS that is the keychain read that can raise the password prompt.
 *  Every caller is about to encrypt or decrypt anyway. That call is also a
 *  weak signal (see the header): it resolves false before app `ready`, and
 *  once the encryptor exists it says nothing about whether a key does. */
async function secureStorageAvailable(): Promise<boolean> {
  if (safeStorage.getSelectedStorageBackend?.() === "basic_text") return false;
  return safeStorage.isAsyncEncryptionAvailable();
}

/** Electron's synchronous KWallet backend used the Chromium wallet entry.
 *  The async backend uses an app-specific entry. Read only keyring ciphertext
 *  with the legacy key so the caller can rewrite it using the async backend.
 *  The runtime check also covers Electron versions that removed the method. */
function decryptLegacyKWallet(ciphertext: Buffer): SecretsBlob | null {
  if (ciphertext.subarray(0, 3).toString("latin1") !== "v11") return null;
  const backend = safeStorage.getSelectedStorageBackend?.();
  if (backend !== "kwallet" && backend !== "kwallet5" && backend !== "kwallet6") return null;
  if (!("decryptString" in safeStorage) || typeof safeStorage.decryptString !== "function") return null;
  try {
    return parseBlob(safeStorage.decryptString(ciphertext));
  } catch {
    return null;
  }
}

/** True when a Linux ciphertext was sealed with Chromium's built-in key.
 *
 *  The async encryptor ranks its key providers on Linux: the Secret portal
 *  (`v12`), then the keyring (`v11`), then a fixed key compiled into Chromium
 *  (`v10`) that is always available. When the keyring cannot produce a key it
 *  encrypts with the fixed one, and nothing reports it. That is plaintext
 *  by another name, which the sync `isEncryptionAvailable()` used to refuse.
 *  The tag is the only signal left, and on Linux `v10` means only that key.
 *  macOS and Windows tag their OS-backed keys `v10` as well, so the check is
 *  Linux-only. */
function sealedWithLinuxFallbackKey(ciphertext: Buffer, platform: NodeJS.Platform): boolean {
  return platform === "linux" && ciphertext.subarray(0, 3).toString("latin1") === "v10";
}
