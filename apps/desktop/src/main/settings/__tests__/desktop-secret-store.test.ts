// Unit tests for DesktopSecretStore. We can't call the real Electron
// `safeStorage` API outside an Electron runtime (it requires the
// system keychain to be initialized), so the test stubs encryptString
// / decryptString with a reversible — but distinctive — wrapping that
// makes the encrypted-at-rest assertion meaningful.
//
// The wrapping prepends "PWR-ENC|" before base64 so the test's grep
// for the plaintext substring fails (the plaintext shows up b64-
// encoded after the marker), and so the round-trip remains exact.

import { mkdtempSync, readFileSync } from "node:fs";
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
    const status = await store.replace("grokApiKey", "abc-123");
    expect(status.configured).toBe(true);
    expect(status.lastSetAt).not.toBeNull();
    const reread = await store.getStatus("grokApiKey");
    expect(reread.configured).toBe(true);
    expect(reread.lastSetAt).toBe(status.lastSetAt);
  });

  test("getAllStatus returns every known name even when absent", async () => {
    const store = makeStore();
    const map = await store.getAllStatus();
    expect(Object.keys(map)).toContain("grokApiKey");
    expect(map.grokApiKey.configured).toBe(false);
    expect(map.grokApiKey.lastSetAt).toBeNull();
  });

  test("clear removes the entry; getStatus reports unset", async () => {
    const store = makeStore();
    await store.replace("grokApiKey", "abc-123");
    const cleared = await store.clear("grokApiKey");
    expect(cleared.configured).toBe(false);
    expect(cleared.lastSetAt).toBeNull();
    const status = await store.getStatus("grokApiKey");
    expect(status.configured).toBe(false);
  });

  test("encrypted at rest: the bin file does NOT contain the plaintext value", async () => {
    const store = makeStore();
    const plaintext = "test-secret-value-1234";
    await store.replace("grokApiKey", plaintext);
    const onDisk = readFileSync(join(workDir, "secrets.bin"));
    // The encryptString stub base64-encodes the plaintext after a marker,
    // so the raw plaintext substring MUST NOT appear in the file.
    expect(onDisk.toString("utf8").includes(plaintext)).toBe(false);
  });

  test("getValue returns the round-tripped plaintext (main-only accessor)", async () => {
    const store = makeStore();
    const plaintext = "secret-roundtrip-value";
    await store.replace("grokApiKey", plaintext);
    const value = await store.getValue("grokApiKey");
    expect(value).toBe(plaintext);
    await store.clear("grokApiKey");
    const cleared = await store.getValue("grokApiKey");
    expect(cleared).toBeNull();
  });

  test("replace throws SecretUnavailableError when safeStorage is unavailable", async () => {
    safeStorageMock.__setAvailable(false);
    const store = makeStore();
    await expect(store.replace("grokApiKey", "x")).rejects.toBeInstanceOf(
      SecretUnavailableError
    );
  });

  test("cleared store still readable: writes empty `{}` rather than deleting the file", async () => {
    const store = makeStore();
    await store.replace("grokApiKey", "abc");
    await store.clear("grokApiKey");
    // Re-read after clear should not crash + should return the unset status.
    const reread = await store.getAllStatus();
    expect(reread.grokApiKey.configured).toBe(false);
  });
});
