import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type { EnrichmentResult, Settings } from "@pwrsnap/shared";

let testDb: Database.Database;
let tempRoot: string;

const electronMock = vi.hoisted(() => ({
  sentEvents: [] as Array<{ channel: string; payload: unknown }>,
  windows: [] as Array<{
    isDestroyed: () => boolean;
    webContents: { send: (channel: string, payload: unknown) => void };
  }>
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => electronMock.windows
  }
}));

vi.mock("../persistence/db", () => ({
  getDb: () => testDb
}));

const { bus } = await import("../command-bus");
const { registerCodexHandlers } = await import("../handlers/codex-handlers");
const { getAiRun } = await import("../persistence/ai-runs-repo");
const { getCaptureEnrichment } = await import("../persistence/enrichment-repo");
const { defaultSettings } = await import("../settings/desktop-settings-service");

function testSettings(patch?: Partial<Settings>): Settings {
  return {
    ...defaultSettings(),
    ...patch
  };
}

function migration(name: string): string {
  return readFileSync(new URL(`../persistence/migrations/${name}`, import.meta.url), "utf8");
}

async function seedCapture(id = "cap_1"): Promise<void> {
  const sourcePath = join(tempRoot, `${id}.png`);
  await sharp({
    create: {
      width: 640,
      height: 360,
      channels: 3,
      background: "#ffffff"
    }
  })
    .png()
    .toFile(sourcePath);

  testDb
    .prepare(
      `INSERT INTO captures (
        id, kind, captured_at,
        source_app_bundle_id, source_app_name, src_path,
        width_px, height_px, device_pixel_ratio,
        byte_size, sha256, overlays_version, deleted_at
      ) VALUES (
        @id, 'image', '2026-05-12T12:00:00.000Z',
        NULL, NULL, @sourcePath,
        640, 360, 2,
        1000, @sha, 0, NULL
      )`
    )
    .run({ id, sourcePath, sha: `sha_${id}` });
}

function unregisterCodexHandlers(): void {
  for (const name of [
    "codex:enrich",
    "codex:enrichment",
    "codex:enrichmentsForCaptures",
    "codex:acceptTitle",
    "codex:acceptDescription",
    "codex:acceptTag",
    "codex:rejectTag",
    "codex:runStatus",
    "codex:cancel",
    "codex:annotate",
    "codex:describe",
    "codex:tag",
    "codex:filename",
    "codex:sensitiveScan",
    "codex:ask"
  ] as const) {
    bus.unregister(name);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class FakeCodexClient {
  async enrichCapture(): Promise<{ result: EnrichmentResult; threadId: string; turnId: string; userAgent: string }> {
    return {
      threadId: "thread-1",
      turnId: "turn-1",
      userAgent: "codex-test",
      result: {
        ocrText: "Visible text",
        title: "",
        description: "A screenshot with visible text.",
        tags: [{ label: "text", confidence: 0.8 }]
      }
    };
  }

  async close(): Promise<void> {
    return;
  }
}

class HangingCodexClient {
  aborted = false;

  async enrichCapture(request: { abortSignal?: AbortSignal }): Promise<never> {
    if (request.abortSignal?.aborted) {
      this.aborted = true;
      throw new DOMException("aborted", "AbortError");
    }
    return await new Promise<never>((_resolve, reject) => {
      request.abortSignal?.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true }
      );
    });
  }

  async close(): Promise<void> {
    return;
  }
}

describe("Codex handlers", () => {
  beforeEach(async () => {
    electronMock.sentEvents = [];
    electronMock.windows = [];
    tempRoot = join(tmpdir(), `pwrsnap-codex-handlers-test-${process.pid}-${Date.now()}`);
    await mkdir(tempRoot, { recursive: true });
    testDb = new Database(":memory:");
    testDb.pragma("foreign_keys = ON");
    testDb.exec(migration("0001_init.sql"));
    testDb.exec(migration("0006_ai_enrichment.sql"));
    testDb.exec(migration("0007_ai_enrichment_title.sql"));
    await seedCapture();
  });

  afterEach(async () => {
    unregisterCodexHandlers();
    testDb.close();
    await rm(tempRoot, { force: true, recursive: true });
  });

  test("codex:enrich queues and completes a capture enrichment run", async () => {
    electronMock.windows.push({
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => {
          electronMock.sentEvents.push({ channel, payload });
        }
      }
    });
    registerCodexHandlers({
      clientFactory: () => new FakeCodexClient() as never,
      settingsReader: async () =>
        testSettings({
          ai: {
            enabled: true,
            consentAcceptedAt: "2026-05-12T12:00:00.000Z"
          }
        })
    });

    const result = await bus.dispatch(
      "codex:enrich",
      { captureId: "cap_1" },
      { principal: "ipc", cancellationKey: "cap_1" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getAiRun(result.value.runId)?.status).toBe("running");

    await waitFor(() => getAiRun(result.value.runId)?.status === "completed");
    const enrichment = getCaptureEnrichment("cap_1");
    expect(enrichment?.status).toBe("completed");
    expect(enrichment?.ocrText).toBe("Visible text");
    expect(enrichment?.suggestedDescription).toBe("A screenshot with visible text.");
    expect(enrichment?.suggestedTags.map((tag) => tag.label)).toEqual(["text"]);

    const aiRunEvents = electronMock.sentEvents.filter(
      (event) => event.channel === EVENT_CHANNELS.aiRunUpdated
    );
    const completedEvent = [...aiRunEvents].reverse().find((event) => {
      const payload = event.payload as { run?: { status?: string } | null };
      return payload.run?.status === "completed";
    });
    expect(completedEvent).toBeDefined();
    expect(
      (completedEvent?.payload as { enrichment?: { status?: string } | null }).enrichment?.status
    ).toBe("completed");
  });

  test("codex:enrich refuses to run without consent", async () => {
    registerCodexHandlers({
      clientFactory: () => new FakeCodexClient() as never,
      settingsReader: async () => testSettings()
    });

    const result = await bus.dispatch(
      "codex:enrich",
      { captureId: "cap_1" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ai_disabled");
    }
  });

  test("codex:cancel aborts an active background run", async () => {
    const client = new HangingCodexClient();
    registerCodexHandlers({
      clientFactory: () => client as never,
      settingsReader: async () =>
        testSettings({
          ai: {
            enabled: true,
            consentAcceptedAt: "2026-05-12T12:00:00.000Z"
          }
        })
    });

    const started = await bus.dispatch(
      "codex:enrich",
      { captureId: "cap_1" },
      { principal: "ipc", cancellationKey: "cap_1" }
    );

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(() => getAiRun(started.value.runId)?.status === "running");

    const cancelled = await bus.dispatch(
      "codex:cancel",
      { runId: started.value.runId },
      { principal: "ipc" }
    );

    expect(cancelled.ok).toBe(true);
    await waitFor(() => getAiRun(started.value.runId)?.status === "cancelled");
    await waitFor(() => client.aborted);
    expect(client.aborted).toBe(true);
  });

  test("codex:acceptTitle persists the title and broadcasts enrichment", async () => {
    registerCodexHandlers({
      clientFactory: () => new FakeCodexClient() as never,
      settingsReader: async () => testSettings()
    });
    electronMock.windows.push({
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => {
          electronMock.sentEvents.push({ channel, payload });
        }
      }
    });

    const result = await bus.dispatch(
      "codex:acceptTitle",
      { captureId: "cap_1", title: "User-edited title" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.acceptedTitle).toBe("User-edited title");
    expect(getCaptureEnrichment("cap_1")?.acceptedTitle).toBe("User-edited title");

    const broadcast = electronMock.sentEvents.find(
      (event) => event.channel === EVENT_CHANNELS.aiRunUpdated
    );
    expect(broadcast).toBeDefined();
    expect(
      (broadcast?.payload as { enrichment?: { acceptedTitle?: string | null } | null })
        .enrichment?.acceptedTitle
    ).toBe("User-edited title");
  });

  test("codex:acceptTitle rejects empty and oversize requests", async () => {
    registerCodexHandlers({
      clientFactory: () => new FakeCodexClient() as never,
      settingsReader: async () => testSettings()
    });

    const empty = await bus.dispatch(
      "codex:acceptTitle",
      { captureId: "cap_1", title: "   " },
      { principal: "ipc" }
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe("invalid_request");
    }

    const tooLong = await bus.dispatch(
      "codex:acceptTitle",
      { captureId: "cap_1", title: "x".repeat(121) },
      { principal: "ipc" }
    );
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) {
      expect(tooLong.error.code).toBe("invalid_request");
    }
  });
});
