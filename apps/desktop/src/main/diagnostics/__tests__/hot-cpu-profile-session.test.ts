import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import type { HotCpuProfileConfig } from "../hot-cpu-profile-config";
import { createHotCpuProfileSession } from "../hot-cpu-profile-session";

const config: Extract<HotCpuProfileConfig, { enabled: true }> = {
  enabled: true,
  outputRoot: "",
  repoRoot: "/repo",
  startDelayMs: 0,
  triggerMode: "sustained",
  intervalMs: 2_000,
  thresholdPercent: 50,
  slowburnThresholdPercent: 15,
  consecutiveSamples: 2,
  profileDurationMs: 15_000,
  cooldownMs: 60_000,
  maxProfiles: 5,
  captureHeapSnapshot: false,
  heapSnapshotLimit: 2
};

const versions = {
  appVersion: "0.0.0-test",
  electronVersion: "unknown",
  chromeVersion: "unknown",
  nodeVersion: process.versions.node
};

let outputRoot: string | null = null;

afterEach(async () => {
  if (outputRoot !== null) {
    await rm(outputRoot, { recursive: true, force: true });
    outputRoot = null;
  }
});

async function createSession(target: "renderer" | "main") {
  outputRoot = await mkdtemp(join(tmpdir(), "pwrsnap-hot-cpu-session-test-"));
  const created = await createHotCpuProfileSession({
    config: { ...config, outputRoot },
    createdAt: new Date("2026-08-20T12:40:00Z"),
    sessionId: "19555b",
    target,
    versions
  });
  if (!created.ok) throw new Error(created.message);
  return created.session;
}

describe("createHotCpuProfileSession", () => {
  test("names artifacts after the profiled target", async () => {
    const session = await createSession("main");

    expect(session.target).toBe("main");
    expect(session.createProfilePath(3)).toBe(
      join(session.directoryPath, "main-hot-0003.cpuprofile")
    );
    expect(session.createHeapSnapshotPath(3, "start")).toBe(
      join(session.directoryPath, "main-hot-0003-start.heapsnapshot")
    );
  });

  test("keeps the renderer prefix for renderer sessions", async () => {
    const session = await createSession("renderer");

    expect(session.createProfilePath(1)).toBe(
      join(session.directoryPath, "renderer-hot-0001.cpuprofile")
    );
  });

  test("records the target in session.json", async () => {
    const session = await createSession("main");
    const manifest = JSON.parse(
      await readFile(join(session.directoryPath, "session.json"), "utf8")
    ) as { target?: string };

    expect(manifest.target).toBe("main");
  });

  test("concurrent CPU, heap and trace registrations publish one valid manifest", async () => {
    const session = await createSession("renderer");
    const path = join(session.directoryPath, "session.json");
    const seen = new Set<string>();
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 12 }),
      async (indexes) => {
        const names = indexes.flatMap((index) => [
          `renderer-hot-${index}.trace.json`, `renderer-hot-${index}.heapsnapshot`, `renderer-hot-${index}.cpuprofile`
        ]);
        const registrations = names.map((name) => {
          seen.add(name);
          return session.registerArtifact(name);
        });
        const duringWrite: { artifacts: string[] } = JSON.parse(await readFile(path, "utf8"));
        expect(duringWrite.artifacts.every((name) => seen.has(name))).toBe(true);
        await Promise.all(registrations);
        const afterWrite: { artifacts: string[] } = JSON.parse(await readFile(path, "utf8"));
        expect([...afterWrite.artifacts].sort()).toEqual([...seen].sort());
      }
    ), { numRuns: 10 });
  });

  test("appends samples with a per-process breakdown as NDJSON", async () => {
    const session = await createSession("renderer");
    await session.appendSample({
      capturedAt: "2026-08-20T12:40:02.000Z",
      pid: 100,
      cpuPercent: 43.2,
      consecutiveHotSamples: 1,
      processes: [
        { pid: 100, type: "Tab", cpuPercent: 43.2 },
        { pid: 200, type: "GPU", cpuPercent: 56.1 }
      ]
    });

    const lines = (await readFile(session.samplesPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const sample = JSON.parse(lines[0] ?? "") as {
      processes?: { pid: number; type: string; cpuPercent: number }[];
    };
    expect(sample.processes?.find((entry) => entry.type === "GPU")?.cpuPercent).toBe(56.1);
  });
});
