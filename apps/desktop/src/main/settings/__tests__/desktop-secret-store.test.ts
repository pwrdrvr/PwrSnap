// Unit tests for DesktopSecretStore. We can't call the real Electron
// `safeStorage` API outside an Electron runtime (it requires the
// system keychain to be initialized), so the test stubs encryptString
// / decryptString with a reversible — but distinctive — wrapping that
// makes the encrypted-at-rest assertion meaningful.
//
// The wrapping prepends "PWR-ENC|" before base64 so the test's grep
// for the plaintext substring fails (the plaintext shows up b64-
// encoded after the marker), and so the round-trip remains exact.
//
// The stubs are also the instrument for the keychain-access assertions
// below: on macOS the first safeStorage call in a process is what can make
// the OS prompt for the login-keychain password, so "did this operation call
// decryptString at all" is the property that matters, and counting mock calls
// is how we pin it.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const safeStorageMock = vi.hoisted(() => {
  let available = true;
  return {
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((s: string): Buffer => {
      const b64 = Buffer.from(s, "utf8").toString("base64");
      return Buffer.from(`PWR-ENC|${b64}`, "utf8");
    }),
    decryptString: vi.fn((b: Buffer): string => {
      const text = b.toString("utf8");
      if (!text.startsWith("PWR-ENC|")) {
        throw new Error("not a PWR-ENC blob");
      }
      const b64 = text.slice("PWR-ENC|".length);
      return Buffer.from(b64, "base64").toString("utf8");
    }),
    __setAvailable(value: boolean): void {
      available = value;
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
  safeStorageMock.__setAvailable(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeStore(): DesktopSecretStore {
  return new DesktopSecretStore({ filePath: join(workDir, "secrets.bin") });
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
    // The encryptString stub base64-encodes the plaintext after a marker,
    // so the raw plaintext substring MUST NOT appear in the file.
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
    safeStorageMock.__setAvailable(false);
    const store = makeStore();
    await expect(store.replace("openaiApiKey", "x")).rejects.toBeInstanceOf(
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
  test("status reads never decrypt, even with a secret configured", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "abc-123");
    safeStorageMock.decryptString.mockClear();

    const status = await store.getStatus("openaiApiKey");
    const all = await store.getAllStatus();

    expect(status.configured).toBe(true);
    expect(all.openaiApiKey.configured).toBe(true);
    expect(all.openaiApiKey.lastSetAt).toBe(status.lastSetAt);
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
  });

  test("status reads never decrypt after the secret is cleared", async () => {
    // The pre-envelope regression: `clear` kept an encrypted file, so once any
    // secret had ever been set, every status read decrypted forever.
    const store = makeStore();
    await store.replace("openaiApiKey", "abc-123");
    await store.clear("openaiApiKey");
    safeStorageMock.decryptString.mockClear();

    await store.getAllStatus();
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
  });

  test("clearing the last secret needs neither decrypt nor encrypt", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "abc-123");
    safeStorageMock.decryptString.mockClear();
    safeStorageMock.encryptString.mockClear();

    await store.clear("openaiApiKey");

    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
  });

  test("writing the first secret does not decrypt", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "abc-123");
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
  });

  test("overwriting the only secret does not decrypt", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "first");
    safeStorageMock.decryptString.mockClear();

    await store.replace("openaiApiKey", "second");

    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    expect(await store.getValue("openaiApiKey")).toBe("second");
  });

  test("getValue DOES decrypt — it is the one accessor that may reach the keychain", async () => {
    const store = makeStore();
    await store.replace("openaiApiKey", "abc-123");
    safeStorageMock.decryptString.mockClear();

    expect(await store.getValue("openaiApiKey")).toBe("abc-123");
    expect(safeStorageMock.decryptString).toHaveBeenCalled();
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
    writeFileSync(
      join(workDir, "secrets.bin"),
      safeStorageMock.encryptString(JSON.stringify(blob))
    );
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
    expect(safeStorageMock.decryptString).toHaveBeenCalled();

    await store.replace("localAgentToken:client-a", "token"); // settles the queue
    safeStorageMock.decryptString.mockClear();

    const all = await makeStore().getAllStatus();
    expect(all.openaiApiKey.configured).toBe(true);
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
  });

  test("an undecryptable v1 file is left alone rather than rewritten as empty", async () => {
    // Losing keychain access must not let a migration turn "unreadable" into
    // an authoritative empty store.
    writeFileSync(join(workDir, "secrets.bin"), Buffer.from("v10-not-our-ciphertext"));
    const store = makeStore();

    expect((await store.getAllStatus()).openaiApiKey.configured).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

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
    safeStorageMock.__setAvailable(false);

    const cleared = await store.clear("openaiApiKey");

    expect(cleared.configured).toBe(false);
    expect((await store.getAllStatus()).openaiApiKey.configured).toBe(false);
  });
});
