import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ContentTraceConfig } from "../content-trace-config";
import { createContentTraceSession } from "../content-trace-session";

const versions = {
  appVersion: "0.0.0-test",
  electronVersion: "41.10.3",
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

async function makeConfig(): Promise<Extract<ContentTraceConfig, { enabled: true }>> {
  outputRoot = await mkdtemp(join(tmpdir(), "pwrsnap-trace-"));
  return {
    enabled: true,
    outputRoot,
    categories: ["viz", "gpu"],
    durationMs: 15_000,
    autoStartDelayMs: 0
  };
}

describe("createContentTraceSession", () => {
  test("creates a hot-cpu-shaped session directory with a manifest", async () => {
    const config = await makeConfig();
    const result = await createContentTraceSession({
      config,
      createdAt: new Date("2026-08-20T16:22:00"),
      sessionId: "abc123",
      versions
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.directoryName).toBe("trace-2026-08-20-1622-abc123");

    const manifest = JSON.parse(
      await readFile(join(result.session.directoryPath, "session.json"), "utf8")
    );
    expect(manifest).toMatchObject({
      id: "abc123",
      artifacts: [],
      config: { categories: ["viz", "gpu"], durationMs: 15_000 },
      versions: { electronVersion: "41.10.3" }
    });
  });

  test("registered trace artifacts land in the manifest", async () => {
    const config = await makeConfig();
    const result = await createContentTraceSession({ config, sessionId: "abc123", versions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.session.createTracePath(1)).toBe(
      join(result.session.directoryPath, "trace-0001.json")
    );
    await result.session.registerArtifact("trace-0001.json");
    const manifest = JSON.parse(
      await readFile(join(result.session.directoryPath, "session.json"), "utf8")
    );
    expect(manifest.artifacts).toEqual(["trace-0001.json"]);
  });

  test("events append as NDJSON", async () => {
    const config = await makeConfig();
    const result = await createContentTraceSession({ config, sessionId: "abc123", versions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.session.appendEvent({ capturedAt: "2026-08-20T16:22:00.000Z", type: "trace-start" });
    await result.session.appendEvent({ capturedAt: "2026-08-20T16:22:15.000Z", type: "trace-stop" });

    const lines = (await readFile(result.session.eventsPath, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).type)).toEqual(["trace-start", "trace-stop"]);
  });

  test("reports a failure result when the output root cannot be created", async () => {
    // Rooted under a regular FILE, so `mkdir -p` fails on every
    // platform. `/dev/null/...` only works on POSIX — on Windows that
    // path is perfectly creatable and the assertion inverts.
    outputRoot = await mkdtemp(join(tmpdir(), "pwrsnap-trace-"));
    const blocker = join(outputRoot, "not-a-directory");
    await writeFile(blocker, "", "utf8");

    const result = await createContentTraceSession({
      config: {
        enabled: true,
        outputRoot: join(blocker, "root"),
        categories: ["viz"],
        durationMs: 1_000,
        autoStartDelayMs: 0
      },
      versions
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SESSION_CREATE_FAILED");
  });
});
