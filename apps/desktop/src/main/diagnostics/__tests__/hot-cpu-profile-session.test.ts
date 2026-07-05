import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearActiveHotCpuProfileSessionsForTests,
  listActiveHotCpuProfileSessionDirectoryNames
} from "../hot-cpu-profile-active-sessions";
import { createHotCpuProfileSession } from "../hot-cpu-profile-session";
import type { HotCpuProfileConfig } from "../hot-cpu-profile-config";

let root: string;

const config = (outputRoot: string): Extract<HotCpuProfileConfig, { enabled: true }> => ({
  captureHeapSnapshot: false,
  consecutiveSamples: 2,
  cooldownMs: 30_000,
  enabled: true,
  heapSnapshotLimit: 2,
  intervalMs: 1_000,
  maxProfiles: 1,
  outputRoot,
  profileDurationMs: 5_000,
  repoRoot: root,
  slowburnThresholdPercent: 15,
  startDelayMs: 0,
  thresholdPercent: 50,
  triggerMode: "sustained"
});

async function writeSession(name: string, createdAt: string): Promise<void> {
  const sessionPath = path.join(root, name);
  await fs.mkdir(sessionPath, { recursive: true });
  await fs.writeFile(
    path.join(sessionPath, "session.json"),
    `${JSON.stringify({ createdAt })}\n`,
    "utf8"
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pwrsnap-hot-cpu-session-"));
});

afterEach(async () => {
  clearActiveHotCpuProfileSessionsForTests();
  await fs.rm(root, { recursive: true, force: true });
});

describe("createHotCpuProfileSession", () => {
  test("runs retention during session creation and records the cleanup event", async () => {
    for (let index = 0; index < 11; index += 1) {
      await writeSession(
        `hot-cpu-2026-07-04-${String(10 + index).padStart(2, "0")}00-${index
          .toString(16)
          .padStart(6, "0")}`,
        `2026-07-04T${String(10 + index).padStart(2, "0")}:00:00.000Z`
      );
    }

    const result = await createHotCpuProfileSession({
      config: config(root),
      createdAt: new Date("2026-07-04T23:00:00.000Z"),
      sessionId: "abcdef",
      versions: {
        appVersion: "test",
        chromeVersion: "test",
        electronVersion: "test",
        nodeVersion: "test"
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    await expect(fs.stat(path.join(root, "hot-cpu-2026-07-04-1000-000000"))).rejects.toThrow();
    expect(await fs.stat(result.session.directoryPath)).toBeDefined();
    expect(listActiveHotCpuProfileSessionDirectoryNames()).toContain(result.session.directoryName);
    const events = await fs.readFile(result.session.eventsPath, "utf8");
    expect(events).toContain("\"type\":\"retention-pruned\"");
  });
});
