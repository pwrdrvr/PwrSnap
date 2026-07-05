import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearHotCpuProfileSessions,
  pruneHotCpuProfileSessions
} from "../hot-cpu-profile-retention";

let root: string;

async function writeSession(name: string, createdAt: string): Promise<void> {
  const sessionPath = path.join(root, name);
  await fs.mkdir(sessionPath, { recursive: true });
  await fs.writeFile(
    path.join(sessionPath, "session.json"),
    `${JSON.stringify({ createdAt })}\n`,
    "utf8"
  );
  await fs.writeFile(path.join(sessionPath, "renderer-hot-0001.cpuprofile"), "profile", "utf8");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pwrsnap-hot-cpu-retention-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("hot CPU profile retention", () => {
  test("prunes oldest sessions while keeping newest and current", async () => {
    await writeSession("hot-cpu-2026-07-04-1000-000001", "2026-07-04T10:00:00.000Z");
    await writeSession("hot-cpu-2026-07-04-1100-000002", "2026-07-04T11:00:00.000Z");
    await writeSession("hot-cpu-2026-07-04-1200-000003", "2026-07-04T12:00:00.000Z");
    await writeSession("hot-cpu-2026-07-04-1300-000004", "2026-07-04T13:00:00.000Z");

    const result = await pruneHotCpuProfileSessions({
      currentSessionDirectoryName: "hot-cpu-2026-07-04-1300-000004",
      keepLatest: 2,
      root
    });

    await expect(fs.stat(path.join(root, "hot-cpu-2026-07-04-1000-000001"))).rejects.toThrow();
    expect(await fs.stat(path.join(root, "hot-cpu-2026-07-04-1100-000002"))).toBeDefined();
    expect(await fs.stat(path.join(root, "hot-cpu-2026-07-04-1200-000003"))).toBeDefined();
    expect(await fs.stat(path.join(root, "hot-cpu-2026-07-04-1300-000004"))).toBeDefined();
    expect(result.deletedSessions).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.freedBytes).toBeGreaterThan(0);
  });

  test("ignores non-session entries under the diagnostics root", async () => {
    await writeSession("hot-cpu-2026-07-04-1000-000001", "2026-07-04T10:00:00.000Z");
    await fs.mkdir(path.join(root, "not-a-session"));
    await fs.writeFile(path.join(root, "loose-file.txt"), "leave me", "utf8");

    const result = await pruneHotCpuProfileSessions({ keepLatest: 0, root });

    await expect(fs.stat(path.join(root, "hot-cpu-2026-07-04-1000-000001"))).rejects.toThrow();
    expect(await fs.stat(path.join(root, "not-a-session"))).toBeDefined();
    expect(await fs.stat(path.join(root, "loose-file.txt"))).toBeDefined();
    expect(result.deletedSessions).toBe(1);
    expect(result.skippedEntries).toBe(2);
  });

  test("manual clear removes only matching hot CPU session directories", async () => {
    await writeSession("hot-cpu-2026-07-04-1000-000001", "2026-07-04T10:00:00.000Z");
    await writeSession("hot-cpu-2026-07-04-1100-000002", "2026-07-04T11:00:00.000Z");
    await fs.mkdir(path.join(root, "not-a-session"));

    const result = await clearHotCpuProfileSessions({ root });

    await expect(fs.stat(path.join(root, "hot-cpu-2026-07-04-1000-000001"))).rejects.toThrow();
    await expect(fs.stat(path.join(root, "hot-cpu-2026-07-04-1100-000002"))).rejects.toThrow();
    expect(await fs.stat(path.join(root, "not-a-session"))).toBeDefined();
    expect(result.deletedSessions).toBe(2);
    expect(result.skippedEntries).toBe(1);
    expect(result.errors).toEqual([]);
  });
});
