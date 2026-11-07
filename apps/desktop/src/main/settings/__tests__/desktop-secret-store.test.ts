// Unit tests for DesktopSecretStore. We can't call the real Electron
// `safeStorage` API outside an Electron runtime (it requires the
// system keychain to be initialized), so the test stubs the async trio --
// isAsyncEncryptionAvailable / encryptStringAsync / decryptStringAsync --
// with a reversible, but distinctive, wrapping that makes the
// encrypted-at-rest assertion meaningful. The stub has no synchronous
// methods: Electron 46 removes them, so a call to one fails here first.
//
// The wrapping is "PWR-ENC|<key>|" before base64, so the test's grep for
// the plaintext substring fails (the plaintext shows up b64-encoded after
// the marker) and the round-trip remains exact. `<key>` stands in for the
// key provider that sealed the payload: like the real async encryptor, the
// stub reports `shouldReEncrypt` for a payload sealed under any key other
// than the one it currently encrypts with. And like the real one, it is
// unusable until app `ready`: the availability check resolves false and
// encrypt / decrypt reject.
//
// The stubs are also the instrument for the keychain-access assertions
// below: on macOS the first safeStorage call in a process is what can make
// the OS prompt for the login-keychain password. The async API makes that
// true of `isAsyncEncryptionAvailable()` as well, since it initializes the
// encryptor. So "did this operation call safeStorage at all" is the
// property that matters, and counting mock calls is how we pin it.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const safeStorageMock = vi.hoisted(() => {
  let ready = true;
  let failDecrypt = false;
  let currentKey = "key-1";
  const notReady = "safeStorage cannot be used before app is ready";
  const seal = (s: string): Buffer => {
    const b64 = Buffer.from(s, "utf8").toString("base64");
    return Buffer.from(`PWR-ENC|${currentKey}|${b64}`, "utf8");
  };
  return {
    isAsyncEncryptionAvailable: vi.fn(async (): Promise<boolean> => ready),
    // Linux-only in Electron. Present on every host here so `basic_text` can
    // be tested; the store calls it optionally.
    getSelectedStorageBackend: vi.fn((): string => "gnome_libsecret"),
    encryptStringAsync: vi.fn(async (s: string): Promise<Buffer> => {
      if (!ready) throw new Error(notReady);
      return seal(s);
    }),
    decryptStringAsync: vi.fn(
      async (b: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }> => {
        if (!ready) throw new Error(notReady);
        // Simulates the keychain going away mid-session: a denied prompt, or
        // a copy of the file from another machine.
        if (failDecrypt) throw new Error("keychain access denied");
        const match = /^PWR-ENC\|([^|]+)\|(.*)$/s.exec(b.toString("utf8"));
        if (match === null) throw new Error("not a PWR-ENC blob");
        return {
          shouldReEncrypt: match[1] !== currentKey,
          result: Buffer.from(match[2] ?? "", "base64").toString("utf8")
        };
      }
    ),
    /** Seal without counting as an encrypt call: for writing fixtures. */
    __seal: seal,
    __setReady(value: boolean): void {
      ready = value;
    },
    __setFailDecrypt(value: boolean): void {
      failDecrypt = value;
    },
    /** Switch the key encrypts use, as a rotated or upgraded key provider
     *  would. Payloads sealed under the old one still decrypt. */
    __setCurrentKey(value: string): void {
      currentKey = value;
    }
  };
});

vi.mock("electron", () => ({
  safeStorage: safeStorageMock
}));

import {
  DesktopSecretStore,
  SecretUnavailableError
} from "../desktop-secret-store";

let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pwrsnap-secret-store-"));
  safeStorageMock.__setReady(true);
  safeStorageMock.__setFailDecrypt(false);
  safeStorageMock.__setCurrentKey("key-1");
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeStore(platform?: NodeJS.Platform): DesktopSecretStore {
  return new DesktopSecretStore({
    filePath: join(workDir, "secrets.bin"),
    ...(platform !== undefined ? { platform } : {})
  });
}

/** Calls to every safeStorage method the store uses. Each one can initialize
 *  the async encryptor, which on macOS is the keychain read that prompts. */
function safeStorageCalls(): number {
  return (
    safeStorageMock.isAsyncEncryptionAvailable.mock.calls.length +
    safeStorageMock.encryptStringAsync.mock.calls.length +
    safeStorageMock.decryptStringAsync.mock.calls.length
  );
}

/** Wait for everything queued behind the store's write queue. `clear` of a
 *  name that is not set runs through the same FIFO queue and writes nothing,
 *  so awaiting it settles a background migration or re-encryption without
 *  guessing at timers. */
async function settleQueue(store: DesktopSecretStore): Promise<void> {
  await store.clear("localAgentToken:settle-queue");
}

describe("DesktopSecretStore", () => {
  test("replace + getStatus reports configured: true with a recent timestamp", async () => {
    const store = makeStore();
    const status = await store.replace("openaiApiKey", "abc-123");
    expect(status.configured).toBe(true);
    expect(status.lastSetAt).not.toBeNull();
    const reread = await store.getStatus("openaiApiKey");
    expect(reread.configured).toBe(true);
    expect(reread.lastSetAt).toBe(status.lastSetAt);
  });

  test("getAllStatus returns every known name even when absent", async () => {
    const store = makeStore();
    const map = await store.getAllStatus();
    expect(Object.keys(map)).toContain("openaiApiKey");
    expect(map.openaiApiKey.configured).toBe(false);
    expect(map.openaiApiKey.lastSetAt).toBeNull();
  });

  test("getAllStatus carries stored Direct API connection credentials, never local agent tokens", async () => {
    const store = makeStore();
    const connection = "customModelCredential:12345678-1234-4234-8234-123456789003" as const;
    await store.replace(connection, "synthetic-connection-key");
    await store.replace("localAgentToken:fixture-client", "synthetic-agent-token");
    const map = await store.getAllStatus();
    expect(map[connection]?.configured).toBe(true);
    expect(Object.keys(map).some((name) => name.startsWith("localAgentToken:"))).toBe(false);
    await store.clear(connection);
    expect(Object.keys(await store.getAllStatus())).not.toContain(connection);
  });

  test("clear removes the entry; getStatus reports unset", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "abc-123");
    const cleared = await store.clear("openaiApiKey");
    expect(cleared.configured).toBe(false);
    expect(cleared.lastSetAt).toBeNull();
    const status = await store.getStatus("openaiApiKey");
    expect(status.configured).toBe(false);
  });

  test("encrypted at rest: the bin file does NOT contain the plaintext value", async () => {
    const store = makeStore();
    const plaintext = "test-secret-value-1234";
    await store.replace("openaiApiKey", plaintext);
    const onDisk = readFileSync(join(workDir, "secrets.bin"));
    // The encryptStringAsync stub base64-encodes the plaintext after a
    // marker, so the raw plaintext substring MUST NOT appear in the file.
    expect(onDisk.toString("utf8").includes(plaintext)).toBe(false);
  });

  test("getValue returns the round-tripped plaintext (main-only accessor)", async () => {
    const store = makeStore();
    const plaintext = "secret-roundtrip-value";
    await store.replace("openaiApiKey", plaintext);
    const value = await store.getValue("openaiApiKey");
    expect(value).toBe(plaintext);
    await store.clear("openaiApiKey");
    const cleared = await store.getValue("openaiApiKey");
    expect(cleared).toBeNull();
  });

  test("replace throws SecretUnavailableError when safeStorage is unavailable", async () => {
    safeStorageMock.__setReady(false);
    const store = makeStore();
    await expect(store.replace("openaiApiKey", "x")).rejects.toBeInstanceOf(
      SecretUnavailableError
    );
    expect(safeStorageMock.encryptStringAsync).not.toHaveBeenCalled();
    await expect(readFile(join(workDir, "secrets.bin"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("getValue throws SecretUnavailableError when safeStorage is unavailable", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "abc-123");
    safeStorageMock.__setReady(false);
    await expect(store.getValue("openaiApiKey")).rejects.toBeInstanceOf(
      SecretUnavailableError
    );
  });

  test("cleared store stays readable: keeps the file with an empty envelope", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "abc");
    await store.clear("openaiApiKey");
    // Re-read after clear should not crash + should return the unset status.
    const reread = await store.getAllStatus();
    expect(reread.openaiApiKey.configured).toBe(false);
  });
});

// The reason the on-disk layout is an envelope rather than one ciphertext.
// Every one of these assertions is about NOT reaching the keychain: on macOS
// the first safeStorage call in a process is what can raise the OS password
// prompt, and `broadcastSettingsChanged` calls `getAllStatus()` after every
// settings write — so a status read that decrypts turns "user toggled a
// preference" into "macOS asked for your password".
describe("DesktopSecretStore keychain access", () => {
  test("status reads never touch safeStorage, even with a secret configured", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "abc-123");
    vi.clearAllMocks();

    const status = await store.getStatus("openaiApiKey");
    const all = await store.getAllStatus();

    expect(status.configured).toBe(true);
    expect(all.openaiApiKey.configured).toBe(true);
    expect(all.openaiApiKey.lastSetAt).toBe(status.lastSetAt);
    // Not even the availability check: `isAsyncEncryptionAvailable()`
    // initializes the encryptor, and on macOS that reads the keychain.
    expect(safeStorageCalls()).toBe(0);
  });

  test("status reads never touch safeStorage after the secret is cleared", async () => {
    // The pre-envelope regression: `clear` kept an encrypted file, so once any
    // secret had ever been set, every status read decrypted forever.
    const store = makeStore();
    await store.replace("openaiApiKey", "abc-123");
    await store.clear("openaiApiKey");
    vi.clearAllMocks();

    await store.getAllStatus();
    expect(safeStorageCalls()).toBe(0);
  });

  test("status reads work before app ready, when safeStorage cannot", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "abc-123");
    safeStorageMock.__setReady(false);
    vi.clearAllMocks();

    expect((await store.getAllStatus()).openaiApiKey.configured).toBe(true);
    expect(safeStorageCalls()).toBe(0);
  });

  test("clearing the last secret touches no safeStorage method", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "abc-123");
    vi.clearAllMocks();

    await store.clear("openaiApiKey");

    expect(safeStorageCalls()).toBe(0);
  });

  test("writing the first secret does not decrypt", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "abc-123");
    expect(safeStorageMock.decryptStringAsync).not.toHaveBeenCalled();
  });

  test("overwriting the only secret does not decrypt", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "first");
    vi.clearAllMocks();

    await store.replace("openaiApiKey", "second");

    expect(safeStorageMock.decryptStringAsync).not.toHaveBeenCalled();
    expect(await store.getValue("openaiApiKey")).toBe("second");
  });

  test("getValue DOES decrypt — it is the one accessor that may reach the keychain", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "abc-123");
    vi.clearAllMocks();

    expect(await store.getValue("openaiApiKey")).toBe("abc-123");
    expect(safeStorageMock.decryptStringAsync).toHaveBeenCalled();
  });
});

describe("DesktopSecretStore envelope format", () => {
  function readEnvelope(): { version: number; index: Record<string, { lastSetAt: string }>; ciphertext: string | null } {
    return JSON.parse(readFileSync(join(workDir, "secrets.bin"), "utf8"));
  }

  test("the index is plaintext and the values are not", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "super-secret-value");
    const envelope = readEnvelope();

    expect(envelope.version).toBe(2);
    expect(Object.keys(envelope.index)).toEqual(["openaiApiKey"]);
    expect(typeof envelope.index.openaiApiKey.lastSetAt).toBe("string");
    expect(envelope.ciphertext).not.toBeNull();
    expect(JSON.stringify(envelope).includes("super-secret-value")).toBe(false);
  });

  test("an emptied store writes a null payload rather than an encrypted empty object", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "abc");
    await store.clear("openaiApiKey");
    const envelope = readEnvelope();

    expect(envelope.index).toEqual({});
    expect(envelope.ciphertext).toBeNull();
  });

  test("clearing one of several secrets keeps the others' values AND timestamps", async () => {
    const store = makeStore();
    const first = await store.replace("openaiApiKey", "keep-me");
    await store.replace("localAgentToken:client-a", "drop-me");

    await store.clear("localAgentToken:client-a");

    expect(await store.getValue("openaiApiKey")).toBe("keep-me");
    expect(await store.getValue("localAgentToken:client-a")).toBeNull();
    // The payload carries values only, so a rewrite must stitch `lastSetAt`
    // back from the index or it silently blanks every surviving timestamp.
    const status = await store.getStatus("openaiApiKey");
    expect(status.lastSetAt).toBe(first.lastSetAt);
  });

  test("ignores index entries for names this build does not know", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "abc");
    const envelope = readEnvelope();
    envelope.index.somethingElse = { lastSetAt: "2026-01-01T00:00:00.000Z" };
    writeFileSync(join(workDir, "secrets.bin"), JSON.stringify(envelope));

    const all = await makeStore().getAllStatus();
    expect(Object.keys(all)).toEqual(["openaiApiKey"]);
  });
});

describe("DesktopSecretStore v1 migration", () => {
  /** Writes a pre-envelope file: the whole blob as one ciphertext buffer. */
  function writeLegacyFile(blob: Record<string, { value: string; lastSetAt: string }>): void {
    writeFileSync(join(workDir, "secrets.bin"), safeStorageMock.__seal(JSON.stringify(blob)));
  }

  const LEGACY_SET_AT = "2026-05-06T17:16:00.000Z";

  test("reads a v1 file and rewrites it as a v2 envelope", async () => {
    writeLegacyFile({ openaiApiKey: { value: "legacy-value", lastSetAt: LEGACY_SET_AT } });
    const store = makeStore();

    const status = await store.getStatus("openaiApiKey");
    expect(status.configured).toBe(true);
    expect(status.lastSetAt).toBe(LEGACY_SET_AT);
    expect(await store.getValue("openaiApiKey")).toBe("legacy-value");

    // Migration runs behind the write queue; a later write settles after it.
    await store.replace("localAgentToken:client-a", "token");

    const envelope = JSON.parse(readFileSync(join(workDir, "secrets.bin"), "utf8"));
    expect(envelope.version).toBe(2);
    expect(envelope.index.openaiApiKey.lastSetAt).toBe(LEGACY_SET_AT);
  });

  test("after migration, status reads stop decrypting", async () => {
    writeLegacyFile({ openaiApiKey: { value: "legacy-value", lastSetAt: LEGACY_SET_AT } });
    const store = makeStore();

    // First status read on a v1 file has no choice: the names live inside the
    // ciphertext. This is the one-off cost an upgrading install pays.
    await store.getAllStatus();
    expect(safeStorageMock.decryptStringAsync).toHaveBeenCalled();

    await store.replace("localAgentToken:client-a", "token"); // settles the queue
    vi.clearAllMocks();

    const all = await makeStore().getAllStatus();
    expect(all.openaiApiKey.configured).toBe(true);
    expect(safeStorageCalls()).toBe(0);
  });

  test("an undecryptable v1 file is left alone rather than rewritten as empty", async () => {
    // Losing keychain access must not let a migration turn "unreadable" into
    // an authoritative empty store.
    writeFileSync(join(workDir, "secrets.bin"), Buffer.from("v10-not-our-ciphertext"));
    const store = makeStore();

    expect((await store.getAllStatus()).openaiApiKey.configured).toBe(false);
    // Settle the write queue deterministically rather than guessing with a
    // timer: the migration task awaits an fs read, so a single macrotask turn
    // can finish before it has even looked at the file, and the assertion
    // below would then pass whether or not the guard exists. `clear` runs
    // through the same FIFO queue, and on a legacy file it writes nothing.
    await store.clear("openaiApiKey");

    expect(readFileSync(join(workDir, "secrets.bin")).toString("utf8")).toBe(
      "v10-not-our-ciphertext"
    );
  });

  test("a JSON file without the current version is treated as legacy, not as an empty store", async () => {
    writeFileSync(
      join(workDir, "secrets.bin"),
      JSON.stringify({ version: 99, index: {}, ciphertext: null })
    );
    const store = makeStore();
    // Decryption of that text fails, so it reads as empty — but crucially it
    // took the legacy branch rather than trusting an unknown envelope shape.
    expect((await store.getAllStatus()).openaiApiKey.configured).toBe(false);
  });
});

describe("DesktopSecretStore envelope consistency", () => {
  test("an index with no payload reports unset rather than a value it cannot produce", async () => {
    // The two halves are always written together, so this shape only arises
    // from a hand-edited or truncated file. It must not claim `configured`.
    writeFileSync(
      join(workDir, "secrets.bin"),
      JSON.stringify({
        version: 2,
        index: { openaiApiKey: { lastSetAt: "2026-05-06T17:16:00.000Z" } },
        ciphertext: null
      })
    );
    const store = makeStore();

    expect((await store.getStatus("openaiApiKey")).configured).toBe(false);
    expect(await store.getValue("openaiApiKey")).toBeNull();
  });

  test("clearing the last secret works even when safeStorage is unavailable", async () => {
    // Removing a secret should never be blocked by a keychain we no longer
    // need: the resulting envelope has nothing left to encrypt.
    const store = makeStore();
    await store.replace("openaiApiKey", "abc");
    safeStorageMock.__setReady(false);

    const cleared = await store.clear("openaiApiKey");

    expect(cleared.configured).toBe(false);
    expect((await store.getAllStatus()).openaiApiKey.configured).toBe(false);
  });
});

// A write re-encrypts only the entries it holds, and a failed decrypt makes
// the read look empty — so without an explicit guard a write silently
// discards every secret it could not read back. The plaintext index is what
// makes that detectable, so these are the cases the envelope must not make
// worse than the single-ciphertext layout it replaced.
describe("DesktopSecretStore undecryptable payload", () => {
  async function storeWithTwoSecrets(): Promise<DesktopSecretStore> {
    const store = makeStore();
    await store.replace("openaiApiKey", "keep-me");
    await store.replace("localAgentToken:client-a", "token-a");
    return store;
  }

  test("replace refuses rather than destroying the secrets it cannot read", async () => {
    const store = await storeWithTwoSecrets();
    safeStorageMock.__setFailDecrypt(true);

    await expect(store.replace("openaiApiKey", "new-value")).rejects.toBeInstanceOf(
      SecretUnavailableError
    );

    // Both originals survive once keychain access comes back.
    safeStorageMock.__setFailDecrypt(false);
    expect(await store.getValue("openaiApiKey")).toBe("keep-me");
    expect(await store.getValue("localAgentToken:client-a")).toBe("token-a");
  });

  test("clear refuses rather than reporting a removal that did not happen", async () => {
    const store = await storeWithTwoSecrets();
    safeStorageMock.__setFailDecrypt(true);

    // Returning `{ configured: false }` here would contradict the very next
    // status broadcast, which reads the still-intact plaintext index.
    await expect(store.clear("openaiApiKey")).rejects.toBeInstanceOf(
      SecretUnavailableError
    );

    safeStorageMock.__setFailDecrypt(false);
    expect((await store.getStatus("openaiApiKey")).configured).toBe(true);
    expect(await store.getValue("openaiApiKey")).toBe("keep-me");
  });

  test("clearing the last secret still succeeds — it needs no payload", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "only-one");
    safeStorageMock.__setFailDecrypt(true);

    const cleared = await store.clear("openaiApiKey");

    expect(cleared.configured).toBe(false);
    expect((await store.getAllStatus()).openaiApiKey.configured).toBe(false);
  });

  test("overwriting the only secret still succeeds — it preserves nothing", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "first");
    safeStorageMock.__setFailDecrypt(true);

    await expect(store.replace("openaiApiKey", "second")).resolves.toMatchObject({
      configured: true
    });

    safeStorageMock.__setFailDecrypt(false);
    expect(await store.getValue("openaiApiKey")).toBe("second");
  });

  test("a v1 file keeps the older lenient behavior — it has no index to check", async () => {
    // The names live inside a v1 ciphertext, so "absent" and "undecryptable"
    // are indistinguishable there and the guard cannot apply.
    writeFileSync(join(workDir, "secrets.bin"), Buffer.from("v10-not-our-ciphertext"));
    const store = makeStore();

    await expect(store.clear("openaiApiKey")).resolves.toMatchObject({
      configured: false
    });
  });
});

// `decryptStringAsync` reports `shouldReEncrypt` when a payload was sealed
// with a key provider other than the one it now encrypts with (a rotated key,
// or a stronger provider that came online). The store answers by rewriting
// the payload under the current key, through the same queued atomic write as
// every other write.
describe("DesktopSecretStore re-encryption", () => {
  function readEnvelope(): { index: Record<string, { lastSetAt: string }>; ciphertext: string | null } {
    return JSON.parse(readFileSync(join(workDir, "secrets.bin"), "utf8"));
  }

  function sealedUnder(): string {
    const { ciphertext } = readEnvelope();
    if (ciphertext === null) throw new Error("expected a payload");
    return Buffer.from(ciphertext, "base64").toString("utf8").split("|")[1] ?? "";
  }

  test("getValue rewrites a payload sealed under a superseded key, keeping values and timestamps", async () => {
    const store = makeStore();
    const first = await store.replace("openaiApiKey", "keep-me");
    const second = await store.replace("localAgentToken:client-a", "token-a");
    expect(sealedUnder()).toBe("key-1");

    safeStorageMock.__setCurrentKey("key-2");
    expect(await store.getValue("openaiApiKey")).toBe("keep-me");
    await settleQueue(store);

    expect(sealedUnder()).toBe("key-2");
    const envelope = readEnvelope();
    expect(envelope.index.openaiApiKey?.lastSetAt).toBe(first.lastSetAt);
    expect(envelope.index["localAgentToken:client-a"]?.lastSetAt).toBe(second.lastSetAt);
    expect(JSON.stringify(envelope).includes("keep-me")).toBe(false);
    expect(await store.getValue("localAgentToken:client-a")).toBe("token-a");

    // Sealed under the current key now, so reads stop asking.
    vi.clearAllMocks();
    expect(await store.getValue("openaiApiKey")).toBe("keep-me");
    await settleQueue(store);
    expect(safeStorageMock.encryptStringAsync).not.toHaveBeenCalled();
  });

  test("a burst of reads queues one rewrite", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "keep-me");
    safeStorageMock.__setCurrentKey("key-2");
    vi.clearAllMocks();

    await Promise.all([
      store.getValue("openaiApiKey"),
      store.getValue("openaiApiKey"),
      store.getValue("openaiApiKey")
    ]);
    await settleQueue(store);

    expect(safeStorageMock.encryptStringAsync).toHaveBeenCalledTimes(1);
    expect(sealedUnder()).toBe("key-2");
  });

  test("status reads never re-encrypt", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "keep-me");
    safeStorageMock.__setCurrentKey("key-2");
    vi.clearAllMocks();

    await store.getAllStatus();
    await settleQueue(store);

    expect(safeStorageCalls()).toBe(0);
    expect(sealedUnder()).toBe("key-1");
  });

  test("the rewrite re-reads, and never rewrites a payload it can no longer decrypt", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "keep-me");
    safeStorageMock.__setCurrentKey("key-2");
    const before = readFileSync(join(workDir, "secrets.bin"), "utf8");

    expect(await store.getValue("openaiApiKey")).toBe("keep-me");
    // The queued task has not read the file yet: it waits on fs I/O, and
    // this continuation is a microtask. Lose the keychain in between.
    safeStorageMock.__setFailDecrypt(true);
    await settleQueue(store);

    expect(readFileSync(join(workDir, "secrets.bin"), "utf8")).toBe(before);
  });

  test("a failed rewrite leaves the readable payload and is not retried in the same process", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "keep-me");
    safeStorageMock.__setCurrentKey("key-2");
    const before = readFileSync(join(workDir, "secrets.bin"), "utf8");
    vi.clearAllMocks();
    safeStorageMock.encryptStringAsync.mockRejectedValueOnce(new Error("encryption failed"));

    expect(await store.getValue("openaiApiKey")).toBe("keep-me");
    await settleQueue(store);
    expect(readFileSync(join(workDir, "secrets.bin"), "utf8")).toBe(before);

    // safeStorage settles its key providers once per process, so a retry
    // would fail the same way on every read. The next launch tries again.
    expect(await store.getValue("openaiApiKey")).toBe("keep-me");
    await settleQueue(store);
    expect(safeStorageMock.encryptStringAsync).toHaveBeenCalledTimes(1);
  });
});

// The sync `isEncryptionAvailable()` refused a Linux system with no keyring.
// Its async replacement does not: the async encryptor falls back to a key
// compiled into Chromium, tagged `v10`, and resolves availability true. The
// store refuses that ciphertext itself, so "never fall back to plaintext"
// still holds.
describe("DesktopSecretStore Linux fallback key", () => {
  const FALLBACK_SEALED = Buffer.from("v10-fixture-sealed-with-the-built-in-key");
  const KEYRING_SEALED = Buffer.from("v11-fixture-sealed-with-the-keyring-key");

  test("refuses to write a payload sealed with Chromium's built-in key", async () => {
    const store = makeStore("linux");
    safeStorageMock.encryptStringAsync.mockResolvedValueOnce(FALLBACK_SEALED);

    await expect(store.replace("openaiApiKey", "never-written")).rejects.toBeInstanceOf(
      SecretUnavailableError
    );
    await expect(readFile(join(workDir, "secrets.bin"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("refuses basic_text before initializing the encryptor", async () => {
    const store = makeStore("linux");
    safeStorageMock.getSelectedStorageBackend.mockReturnValueOnce("basic_text");

    await expect(store.replace("openaiApiKey", "never-written")).rejects.toBeInstanceOf(
      SecretUnavailableError
    );
    expect(safeStorageCalls()).toBe(0);
    await expect(readFile(join(workDir, "secrets.bin"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("accepts a payload sealed with the keyring's key", async () => {
    const store = makeStore("linux");
    safeStorageMock.encryptStringAsync.mockResolvedValueOnce(KEYRING_SEALED);

    await expect(store.replace("openaiApiKey", "written")).resolves.toMatchObject({
      configured: true
    });
  });

  test.each(["darwin", "win32"] as const)(
    "accepts v10 on %s, where it tags the OS-backed key",
    async (platform) => {
      const store = makeStore(platform);
      safeStorageMock.encryptStringAsync.mockResolvedValueOnce(FALLBACK_SEALED);

      await expect(store.replace("openaiApiKey", "written")).resolves.toMatchObject({
        configured: true
      });
    }
  );
});

describe("DesktopSecretStore is one instance per process", () => {
  test("production code constructs it only in getDesktopSecretStore", async () => {
    // The write queue serializes within an instance, and getValue() can write
    // (re-encryption). A second instance on the same file would interleave
    // its read-modify-write with the shared one's.
    const { readdirSync, readFileSync: read } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const mainRoot = fileURLToPath(new URL("../../", import.meta.url));
    const constructors: string[] = [];
    for (const entry of readdirSync(mainRoot, { recursive: true, withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name);
      if (!entry.isFile() || !entry.name.endsWith(".ts") || path.includes("__tests__")) continue;
      if (read(path, "utf8").includes("new DesktopSecretStore(")) {
        constructors.push(relative(mainRoot, path).split(sep).join("/"));
      }
    }
    expect(constructors).toEqual(["settings/desktop-secret-store.ts"]);
  });
});
