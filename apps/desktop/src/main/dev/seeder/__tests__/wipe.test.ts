// Wipe-safety regression tests. The wipe path is the seeder's
// destructive operation — refusing wrongly means dev-tool DoS;
// allowing wrongly means deleting user data. Lock down the layered
// guards: env override, banned-path defense (typo'd env vars),
// first-run bootstrap, and sentinel + mtime checks for non-empty
// trees.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => {
      if (name === "userData") return "/tmp/pwrsnap-test-userData";
      if (name === "documents") return "/tmp/pwrsnap-test-documents";
      throw new Error(`unexpected app.getPath: ${name}`);
    }
  }
}));

const ENV_KEY = "PWRSNAP_DATA_ROOT";
const originalEnv = process.env[ENV_KEY];

let scratchDir = "";

beforeEach(() => {
  delete process.env[ENV_KEY];
  scratchDir = mkdtempSync(join(tmpdir(), "pwrsnap-wipe-test-"));
  vi.resetModules();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe("assertCanWipe — primary guards", () => {
  test("refuses when PWRSNAP_DATA_ROOT is unset", async () => {
    const { assertCanWipe } = await import("../wipe");
    expect(() => assertCanWipe()).toThrow(/PWRSNAP_DATA_ROOT is unset/);
  });

  test("refuses when PWRSNAP_DATA_ROOT equals userData", async () => {
    process.env[ENV_KEY] = "/tmp/pwrsnap-test-userData";
    const { assertCanWipe } = await import("../wipe");
    expect(() => assertCanWipe()).toThrow(/equals app\.getPath/);
  });

  test("refuses when PWRSNAP_DATA_ROOT is the home directory", async () => {
    process.env[ENV_KEY] = homedir();
    const { assertCanWipe } = await import("../wipe");
    expect(() => assertCanWipe()).toThrow(/user-data directory/);
  });

  test("refuses when PWRSNAP_DATA_ROOT is ~/Documents", async () => {
    process.env[ENV_KEY] = join(homedir(), "Documents");
    const { assertCanWipe } = await import("../wipe");
    expect(() => assertCanWipe()).toThrow(/user-data directory/);
  });
});

describe("assertCanWipe — first-run bootstrap", () => {
  test("allows wipe when data root does not exist", async () => {
    process.env[ENV_KEY] = join(scratchDir, "nonexistent");
    const { assertCanWipe } = await import("../wipe");
    expect(() => assertCanWipe()).not.toThrow();
  });

  test("allows wipe when data root is empty", async () => {
    process.env[ENV_KEY] = scratchDir; // mkdtempSync creates it empty
    const { assertCanWipe } = await import("../wipe");
    expect(() => assertCanWipe()).not.toThrow();
  });
});

describe("assertCanWipe — crash recovery bootstrap", () => {
  test("allows wipe when only seeder-owned files are present", async () => {
    // Simulate a prior seed run that crashed after openDatabase but
    // before createSentinel — the dir holds pwrsnap.db + WAL siblings
    // but no sentinel. Wipe should proceed (it's about to delete
    // these anyway).
    process.env[ENV_KEY] = scratchDir;
    writeFileSync(join(scratchDir, "pwrsnap.db"), "");
    writeFileSync(join(scratchDir, "pwrsnap.db-shm"), "");
    writeFileSync(join(scratchDir, "pwrsnap.db-wal"), "");
    const { assertCanWipe } = await import("../wipe");
    expect(() => assertCanWipe()).not.toThrow();
  });

  test("refuses when seeder files coexist with non-seeder content", async () => {
    process.env[ENV_KEY] = scratchDir;
    writeFileSync(join(scratchDir, "pwrsnap.db"), "");
    writeFileSync(join(scratchDir, "user-photo.jpg"), "imagine an image");
    const { assertCanWipe } = await import("../wipe");
    expect(() => assertCanWipe()).toThrow(/non-seeder data but no .* sentinel/);
  });
});

describe("assertCanWipe — sentinel checks on non-empty roots", () => {
  test("refuses when data root has content but no sentinel", async () => {
    process.env[ENV_KEY] = scratchDir;
    writeFileSync(join(scratchDir, "stray.txt"), "user data");
    const { assertCanWipe } = await import("../wipe");
    expect(() => assertCanWipe()).toThrow(/no \.pwrsnap-perf-root sentinel/);
  });

  test("refuses when sentinel content is malformed JSON", async () => {
    process.env[ENV_KEY] = scratchDir;
    writeFileSync(join(scratchDir, ".pwrsnap-perf-root"), "not-json");
    const { assertCanWipe } = await import("../wipe");
    expect(() => assertCanWipe()).toThrow(/could not be parsed as JSON/);
  });

  test("refuses when sentinel uuid is malformed", async () => {
    process.env[ENV_KEY] = scratchDir;
    writeFileSync(
      join(scratchDir, ".pwrsnap-perf-root"),
      JSON.stringify({ uuid: "short", createdAt: new Date().toISOString() })
    );
    const { assertCanWipe } = await import("../wipe");
    expect(() => assertCanWipe()).toThrow(/malformed uuid/);
  });

  test("refuses when sentinel is older than 30 days", async () => {
    process.env[ENV_KEY] = scratchDir;
    const sentinelPath = join(scratchDir, ".pwrsnap-perf-root");
    writeFileSync(
      sentinelPath,
      JSON.stringify({ uuid: "a".repeat(32), createdAt: new Date().toISOString() })
    );
    const fortyDaysAgo = (Date.now() - 40 * 86_400_000) / 1000;
    utimesSync(sentinelPath, fortyDaysAgo, fortyDaysAgo);
    const { assertCanWipe } = await import("../wipe");
    expect(() => assertCanWipe()).toThrow(/40d old.*limit 30d/);
  });

  test("allows wipe with a valid, fresh sentinel", async () => {
    process.env[ENV_KEY] = scratchDir;
    writeFileSync(
      join(scratchDir, ".pwrsnap-perf-root"),
      JSON.stringify({ uuid: "a".repeat(32), createdAt: new Date().toISOString() })
    );
    const { assertCanWipe } = await import("../wipe");
    expect(() => assertCanWipe()).not.toThrow();
  });
});

describe("createSentinel + assertCanWipe round-trip", () => {
  test("a freshly-created sentinel passes assertCanWipe", async () => {
    process.env[ENV_KEY] = scratchDir;
    mkdirSync(scratchDir, { recursive: true });
    const { assertCanWipe, createSentinel } = await import("../wipe");
    createSentinel();
    expect(() => assertCanWipe()).not.toThrow();
  });
});
