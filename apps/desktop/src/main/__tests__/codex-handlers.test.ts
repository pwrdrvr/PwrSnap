import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type { CodexModelOption, EnrichmentResult, Settings } from "@pwrsnap/shared";

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
  app: {
    getPath: () => join(tempRoot, "Documents")
  },
  BrowserWindow: {
    getAllWindows: () => electronMock.windows
  }
}));

vi.mock("../persistence/db", () => ({
  getDb: () => testDb
}));

const { bus } = await import("../command-bus");
const {
  registerCodexHandlers,
  enrichmentSelectedModel,
  withThoughtsSuppressed,
  withUsageModelLabels
} = await import("../handlers/codex-handlers");
const { strategyById } = await import("@pwrdrvr/agent-acp");
const { getAiRun } = await import("../persistence/ai-runs-repo");
const { getCaptureEnrichment } = await import("../persistence/enrichment-repo");
const { defaultSettings } = await import("../settings/desktop-settings-service");
const { AiEnrichmentBudget } = await import("../ai/enrichment-budget");

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
        source_app_bundle_id, source_app_name, legacy_src_path,
        width_px, height_px, device_pixel_ratio,
        byte_size, sha256, edits_version, deleted_at
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
    "codex:acceptFilenameStem",
    "codex:acceptAllDrafts",
    "codex:acceptTag",
    "codex:rejectTag",
    "codex:runStatus",
    "codex:budgetStatus",
    "codex:models",
    "codex:usageSummary",
    "codex:usageRuns",
    "codex:usageRunDetail",
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
  lastRequest: { model?: string | null; effort?: string } | null = null;

  async enrichCapture(request: { model?: string | null; effort?: string }): Promise<{
    result: EnrichmentResult;
    threadId: string;
    turnId: string;
    userAgent: string;
    model: string;
    modelProvider: string;
    serviceTier: string | null;
    // The CaptureEnrichmentClient now returns the PwrSnap usage breakdown
    // directly (already mapped from the kit's NormalizedTokenUsage, carrying
    // contextWindow → modelContextWindow), rather than the raw Codex
    // ThreadTokenUsage `{ total, last, modelContextWindow }`.
    tokens: {
      totalTokens: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
      modelContextWindow: number | null;
    } | null;
  }> {
    this.lastRequest = request;
    return {
      threadId: "thread-1",
      turnId: "turn-1",
      userAgent: "codex-test",
      model: request.model ?? "gpt-5.4-mini",
      modelProvider: "openai",
      serviceTier: null,
      tokens: {
        totalTokens: 1200,
        inputTokens: 900,
        cachedInputTokens: 100,
        outputTokens: 300,
        reasoningOutputTokens: 25,
        modelContextWindow: 400_000
      },
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

function fakeCodexModels(): CodexModelOption[] {
  return [
    {
      id: "gpt-5.5",
      model: "gpt-5.5",
      displayName: "GPT-5.5",
      description: "Frontier model",
      hidden: false,
      inputModalities: ["text", "image"],
      defaultServiceTier: null,
      isDefault: true
    }
  ];
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    // Apply every migration in order so the captures table reflects
    // post-bundle-storage shape (legacy_src_path, edits_version, …).
    // The migration runner in main does the same — keeping this test
    // brittle to migration ordering caused real drift before.
    testDb.exec(migration("0001_init.sql"));
    testDb.exec(migration("0002_overlays.sql"));
    testDb.exec(migration("0003_perf_app_stats.sql"));
    testDb.exec(migration("0004_electron_source_app_repair.sql"));
    testDb.exec(migration("0005_video_captures.sql"));
    testDb.exec(migration("0006_ai_enrichment.sql"));
    // 0007_bundle_storage recreates `captures` via temp table — needs
    // foreign_keys=OFF to avoid tripping the render_cache FK during the
    // table swap, matching the main migration runner's @no-foreign-keys
    // handling.
    testDb.pragma("foreign_keys = OFF");
    testDb.exec(migration("0007_bundle_storage.sql"));
    testDb.pragma("foreign_keys = ON");
    testDb.exec(migration("0008_layers.sql"));
    testDb.exec(migration("0009_legacy_bundle_migration_attempts.sql"));
    testDb.exec(migration("0010_ai_enrichment_title.sql"));
    testDb.exec(migration("0011_ai_enrichment_filename.sql"));
    testDb.exec(migration("0019_chat_threads.sql"));
    testDb.exec(migration("0022_ai_usage_accounting.sql"));
    testDb.exec(migration("0023_ai_thread_usage.sql"));
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
            consentAcceptedAt: "2026-05-12T12:00:00.000Z",
            budgetSafetyDisabledAt: null,
            autoAcceptSuggestions: false,

            chat: { userGuidance: "", sensitiveDataPatterns: [], defaultRedactionStyle: "blackout", firstLaunchBannerDismissed: false },
            defaults: { libraryChat: {}, sizzleChat: {}, enrichment: {} },
            acp: { enabledAgentIds: [] }
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

  test("codex:enrich falls back to Codex when the saved ACP enrichment provider is disabled", async () => {
    const fakeClient = new FakeCodexClient();
    registerCodexHandlers({
      clientFactory: () => fakeClient as never,
      settingsReader: async () =>
        testSettings({
          codex: { ...defaultSettings().codex, captionModel: "gpt-5.5" },
          ai: {
            enabled: true,
            consentAcceptedAt: "2026-05-12T12:00:00.000Z",
            budgetSafetyDisabledAt: null,
            autoAcceptSuggestions: false,
            chat: { userGuidance: "", sensitiveDataPatterns: [], defaultRedactionStyle: "blackout", firstLaunchBannerDismissed: false },
            defaults: {
              ...defaultSettings().ai.defaults,
              enrichment: { provider: "acp:gemini", model: "gemini-2.5-pro" }
            },
            acp: { enabledAgentIds: [], agents: { gemini: { overridePath: "/custom/gemini" } } }
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
    await waitFor(() => getAiRun(result.value.runId)?.status === "completed");
    expect(fakeClient.lastRequest?.model).toBe("gpt-5.5");
    expect(getAiRun(result.value.runId)?.selectedModel).toBe("gpt-5.5");
  });

  test("usage commands expose token, cost, and media accounting", async () => {
    const fakeClient = new FakeCodexClient();
    registerCodexHandlers({
      clientFactory: () => fakeClient as never,
      settingsReader: async () =>
        testSettings({
          codex: {
            ...defaultSettings().codex,
            captionModel: "gpt-5.5"
          },
          ai: {
            ...defaultSettings().ai,
            enabled: true,
            consentAcceptedAt: "2026-05-12T12:00:00.000Z",
            budgetSafetyDisabledAt: null,
            autoAcceptSuggestions: false
          }
        })
    });

    const started = await bus.dispatch(
      "codex:enrich",
      { captureId: "cap_1", triggerSource: "library-regenerate" },
      { principal: "ipc", cancellationKey: "cap_1" }
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(() => getAiRun(started.value.runId)?.status === "completed");
    expect(fakeClient.lastRequest?.model).toBe("gpt-5.5");

    const detail = await bus.dispatch(
      "codex:usageRunDetail",
      { runId: started.value.runId },
      { principal: "ipc" }
    );
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value?.tokens?.cachedInputTokens).toBe(100);
    expect(detail.value?.mediaInputs[0]).toMatchObject({
      transform: "prepared-jpeg",
      sentMimeType: "image/jpeg",
      sentWidthPx: 640,
      sentHeightPx: 360,
      quality: 75
    });
    expect(detail.value?.cost.status).toBe("available");
    if (detail.value?.cost.status === "available") {
      expect(detail.value.cost.rateSnapshot.model).toBe("gpt-5.5");
      expect(detail.value.cost.totalCostMicros).toBe(13_050);
    }

    const summary = await bus.dispatch(
      "codex:usageSummary",
      { window: "24h" },
      { principal: "ipc" }
    );
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.value.runCount).toBe(1);
      expect(summary.value.totalTokens).toBe(1200);
      expect(summary.value.estimatedTotalCostMicros).toBe(13_050);
    }

    const page = await bus.dispatch(
      "codex:usageRuns",
      { limit: 10, offset: 0 },
      { principal: "ipc" }
    );
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.value.items[0]).toMatchObject({
        model: "gpt-5.5",
        usageStatus: "available",
        estimatedTotalCostMicros: 13_050
      });
    }
  });

  test("enrichment surface defaults (model + reasoning) reach the one-shot client", async () => {
    const fakeClient = new FakeCodexClient();
    registerCodexHandlers({
      clientFactory: () => fakeClient as never,
      settingsReader: async () =>
        testSettings({
          codex: {
            ...defaultSettings().codex,
            captionModel: "gpt-5.4-mini"
          },
          ai: {
            ...defaultSettings().ai,
            enabled: true,
            consentAcceptedAt: "2026-05-12T12:00:00.000Z",
            // The per-surface enrichment default overrides the legacy
            // captionModel and pins a non-default reasoning effort.
            defaults: {
              libraryChat: {},
              sizzleChat: {},
              enrichment: { model: "gpt-5.5", reasoning: "high" }
            },
            acp: { enabledAgentIds: [] }
          }
        })
    });

    const started = await bus.dispatch(
      "codex:enrich",
      { captureId: "cap_1", triggerSource: "library-regenerate" },
      { principal: "ipc", cancellationKey: "cap_1" }
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(() => getAiRun(started.value.runId)?.status === "completed");
    expect(fakeClient.lastRequest?.model).toBe("gpt-5.5");
    expect(fakeClient.lastRequest?.effort).toBe("high");
  });

  test("enrichment falls back to captionModel + low effort when no surface default is set", async () => {
    const fakeClient = new FakeCodexClient();
    registerCodexHandlers({
      clientFactory: () => fakeClient as never,
      settingsReader: async () =>
        testSettings({
          codex: {
            ...defaultSettings().codex,
            captionModel: "gpt-5.4-mini"
          },
          ai: {
            ...defaultSettings().ai,
            enabled: true,
            consentAcceptedAt: "2026-05-12T12:00:00.000Z"
            // defaults left at defaultSettings() (all empty).
          }
        })
    });

    const started = await bus.dispatch(
      "codex:enrich",
      { captureId: "cap_1", triggerSource: "library-regenerate" },
      { principal: "ipc", cancellationKey: "cap_1" }
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(() => getAiRun(started.value.runId)?.status === "completed");
    expect(fakeClient.lastRequest?.model).toBe("gpt-5.4-mini");
    expect(fakeClient.lastRequest?.effort).toBe("low");
  });

  test("codex:models returns Codex App Server model options", async () => {
    registerCodexHandlers({
      modelLister: async () => fakeCodexModels(),
      settingsReader: async () =>
        testSettings({
          codex: {
            ...defaultSettings().codex,
            captionModel: "gpt-5.5"
          }
      })
    });

    const result = await bus.dispatch("codex:models", {}, { principal: "ipc" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedModel).toBe("gpt-5.5");
    expect(result.value.models).toEqual([
      expect.objectContaining({
        id: "gpt-5.5",
        model: "gpt-5.5",
        inputModalities: ["text", "image"]
      })
    ]);
  });

  test("codex:models joins concurrent identical listings", async () => {
    const models = deferred<CodexModelOption[]>();
    const modelLister = vi.fn(() => models.promise);
    registerCodexHandlers({
      modelLister,
      settingsReader: async () =>
        testSettings({
          codex: {
            ...defaultSettings().codex,
            captionModel: "gpt-5.5"
          }
        })
    });

    const first = bus.dispatch("codex:models", {}, { principal: "ipc" });
    const second = bus.dispatch("codex:models", {}, { principal: "ipc" });
    await Promise.resolve();
    await Promise.resolve();

    expect(modelLister).toHaveBeenCalledTimes(1);
    models.resolve(fakeCodexModels());
    const [a, b] = await Promise.all([first, second]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.models.map((m) => m.id)).toEqual(["gpt-5.5"]);
    expect(b.value.models.map((m) => m.id)).toEqual(["gpt-5.5"]);
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

  test("codex:enrich reports safety-disabled state before generic AI disabled state", async () => {
    let clientCreated = false;
    electronMock.windows.push({
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => {
          electronMock.sentEvents.push({ channel, payload });
        }
      }
    });
    registerCodexHandlers({
      clientFactory: () => {
        clientCreated = true;
        return new FakeCodexClient() as never;
      },
      budget: new AiEnrichmentBudget(),
      settingsReader: async () =>
        testSettings({
          ai: {
            ...defaultSettings().ai,
            enabled: false,
            consentAcceptedAt: "2026-05-12T12:00:00.000Z",
            budgetSafetyDisabledAt: "2026-05-20T12:00:00.000Z",
            autoAcceptSuggestions: false
          }
        })
    });

    const result = await bus.dispatch(
      "codex:enrich",
      { captureId: "cap_1" },
      { principal: "ipc", cancellationKey: "cap_1" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ai_budget_safety_disabled");
    }
    expect(clientCreated).toBe(false);
    expect(electronMock.sentEvents).toContainEqual(
      expect.objectContaining({
        channel: EVENT_CHANNELS.aiBudgetUpdated,
        payload: expect.objectContaining({ mode: "safety_disabled" })
      })
    );
  });

  test("codex:enrich refuses to start a run when enrichment budget is empty", async () => {
    let clientCreated = false;
    registerCodexHandlers({
      clientFactory: () => {
        clientCreated = true;
        return new FakeCodexClient() as never;
      },
      budget: new AiEnrichmentBudget({ capacity: 0, disableThreshold: 10 }),
      settingsReader: async () =>
        testSettings({
          ai: {
            ...defaultSettings().ai,
            enabled: true,
            consentAcceptedAt: "2026-05-12T12:00:00.000Z",
            budgetSafetyDisabledAt: null,
            autoAcceptSuggestions: false
          }
        })
    });

    const result = await bus.dispatch(
      "codex:enrich",
      { captureId: "cap_1", triggerSource: "library-regenerate" },
      { principal: "ipc", cancellationKey: "cap_1" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ai_budget_limited");
    }
    expect(clientCreated).toBe(false);
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM ai_runs").get()).toEqual({ n: 0 });
  });

  test("codex:enrich auto-disables AI after repeated budget exhaustion", async () => {
    const writes: Settings[] = [];
    registerCodexHandlers({
      clientFactory: () => new FakeCodexClient() as never,
      budget: new AiEnrichmentBudget({ capacity: 0, disableThreshold: 2 }),
      settingsReader: async () =>
        testSettings({
          ai: {
            ...defaultSettings().ai,
            enabled: true,
            consentAcceptedAt: "2026-05-12T12:00:00.000Z",
            budgetSafetyDisabledAt: null,
            autoAcceptSuggestions: false
          }
        }),
      settingsWriter: async (patch) => {
        const next = testSettings({
          ai: {
            ...defaultSettings().ai,
            enabled: patch.ai?.enabled ?? true,
            consentAcceptedAt: "2026-05-12T12:00:00.000Z",
            budgetSafetyDisabledAt: patch.ai?.budgetSafetyDisabledAt ?? null,
            autoAcceptSuggestions: false
          }
        });
        writes.push(next);
        return next;
      }
    });

    await bus.dispatch(
      "codex:enrich",
      { captureId: "cap_1", triggerSource: "auto-enrichment" },
      { principal: "ipc", cancellationKey: "cap_1" }
    );
    const second = await bus.dispatch(
      "codex:enrich",
      { captureId: "cap_1", triggerSource: "auto-enrichment" },
      { principal: "ipc", cancellationKey: "cap_1" }
    );

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("ai_budget_safety_disabled");
    }
    await waitFor(() => writes.length === 1);
    expect(writes[0]?.ai.enabled).toBe(false);
    expect(writes[0]?.ai.budgetSafetyDisabledAt).toMatch(/^20/);
  });

  test("codex:cancel aborts an active background run", async () => {
    const client = new HangingCodexClient();
    registerCodexHandlers({
      clientFactory: () => client as never,
      settingsReader: async () =>
        testSettings({
          ai: {
            enabled: true,
            consentAcceptedAt: "2026-05-12T12:00:00.000Z",
            budgetSafetyDisabledAt: null,
            autoAcceptSuggestions: false,

            chat: { userGuidance: "", sensitiveDataPatterns: [], defaultRedactionStyle: "blackout", firstLaunchBannerDismissed: false },
            defaults: { libraryChat: {}, sizzleChat: {}, enrichment: {} },
            acp: { enabledAgentIds: [] }
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

  test("codex:enrich fails (not cancels) a run whose turn outruns the timeout", async () => {
    // The ACP enrichment path forwards an abort signal but enforces no
    // deadline, so a stalled agent would leave the run in `running`
    // forever — "Kimi is reading the snap…" with the Regenerate button
    // hidden. The handler's per-turn timeout must fail the run so the UI
    // recovers without an app restart.
    const client = new HangingCodexClient();
    registerCodexHandlers({
      clientFactory: () => client as never,
      // Tiny ceiling so the test doesn't actually wait the real default.
      turnTimeoutMs: 50,
      settingsReader: async () =>
        testSettings({
          ai: {
            enabled: true,
            consentAcceptedAt: "2026-05-12T12:00:00.000Z",
            budgetSafetyDisabledAt: null,
            autoAcceptSuggestions: false,

            chat: { userGuidance: "", sensitiveDataPatterns: [], defaultRedactionStyle: "blackout", firstLaunchBannerDismissed: false },
            defaults: { libraryChat: {}, sizzleChat: {}, enrichment: {} },
            acp: { enabledAgentIds: [] }
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

    // A timeout is a FAILURE, not a silent cancel — the run must land in
    // `failed` (CodexStatusPill → "could not read … Regenerate"), never
    // `cancelled` (which the pill renders as idle).
    await waitFor(() => getAiRun(started.value.runId)?.status === "failed");
    const run = getAiRun(started.value.runId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/timed out/i);

    // The timeout aborts the in-flight turn (best-effort stop of the agent).
    await waitFor(() => client.aborted);
    expect(client.aborted).toBe(true);
  });

  test("codex:enrich completes normally when the turn finishes within the timeout", async () => {
    // The timeout wrapper must not interfere with a fast, healthy turn.
    registerCodexHandlers({
      clientFactory: () => new FakeCodexClient() as never,
      turnTimeoutMs: 5_000,
      settingsReader: async () =>
        testSettings({
          ai: {
            enabled: true,
            consentAcceptedAt: "2026-05-12T12:00:00.000Z",
            budgetSafetyDisabledAt: null,
            autoAcceptSuggestions: false,

            chat: { userGuidance: "", sensitiveDataPatterns: [], defaultRedactionStyle: "blackout", firstLaunchBannerDismissed: false },
            defaults: { libraryChat: {}, sizzleChat: {}, enrichment: {} },
            acp: { enabledAgentIds: [] }
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
    await waitFor(() => getAiRun(started.value.runId)?.status === "completed");
    expect(getAiRun(started.value.runId)?.error).toBeNull();
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

describe("enrichmentSelectedModel", () => {
  test("Codex: uses the surface model, then captionModel, then the hardcoded default", () => {
    const withSurface = testSettings({
      codex: { ...defaultSettings().codex, captionModel: "gpt-5.5" },
      ai: {
        ...defaultSettings().ai,
        defaults: { ...defaultSettings().ai.defaults, enrichment: { model: "gpt-5.4" } }
      }
    });
    expect(enrichmentSelectedModel(withSurface, undefined)).toBe("gpt-5.4");

    const captionFallback = testSettings({
      codex: { ...defaultSettings().codex, captionModel: "gpt-5.5" }
    });
    expect(enrichmentSelectedModel(captionFallback, undefined)).toBe("gpt-5.5");
  });

  test("ACP: uses the per-surface model verbatim, with NO Codex caption fallback", () => {
    const withAcpModel = testSettings({
      codex: { ...defaultSettings().codex, captionModel: "gpt-5.5" },
      ai: {
        ...defaultSettings().ai,
        defaults: {
          ...defaultSettings().ai.defaults,
          enrichment: { provider: "acp:kimi", model: "kimi-k2" }
        }
      }
    });
    expect(enrichmentSelectedModel(withAcpModel, "kimi")).toBe("kimi-k2");
  });

  test("ACP with no model returns '' (→ the agent's own default at send time), not a Codex id", () => {
    const noModel = testSettings({
      codex: { ...defaultSettings().codex, captionModel: "gpt-5.5" },
      ai: {
        ...defaultSettings().ai,
        defaults: { ...defaultSettings().ai.defaults, enrichment: { provider: "acp:grok" } }
      }
    });
    expect(enrichmentSelectedModel(noModel, "grok")).toBe("");
  });

  test("disabled ACP enrichment provider falls back to the Codex caption model", () => {
    const disabledAcp = testSettings({
      codex: { ...defaultSettings().codex, captionModel: "gpt-5.5" },
      ai: {
        ...defaultSettings().ai,
        defaults: {
          ...defaultSettings().ai.defaults,
          enrichment: { provider: "acp:gemini", model: "gemini-2.5-pro" }
        },
        acp: { enabledAgentIds: [], agents: {} }
      }
    });
    expect(enrichmentSelectedModel(disabledAcp, undefined)).toBe("gpt-5.5");
  });
});

describe("withUsageModelLabels", () => {
  const base = {
    run: { selectedModel: "" },
    model: null
  } as unknown as import("@pwrsnap/shared").AiRunUsageDetail;
  // grok-build → "Grok Build", everything else unknown.
  const lookup = (id: string): string | undefined =>
    id === "grok-build" ? "Grok Build" : id === "grok-composer-2.5-fast" ? "Composer 2.5" : undefined;

  test("resolves the effective model's label; null when unknown / absent", () => {
    expect(withUsageModelLabels({ ...base, model: "grok-build" }, lookup).modelLabel).toBe(
      "Grok Build"
    );
    // Codex model not in the ACP caches → null (UI falls back to the raw id).
    expect(withUsageModelLabels({ ...base, model: "gpt-5.4-mini" }, lookup).modelLabel).toBeNull();
    // No effective model yet (in-flight) → null.
    expect(withUsageModelLabels({ ...base, model: null }, lookup).modelLabel).toBeNull();
  });

  test("resolves the REQUESTED model's label, falling back to the raw id", () => {
    const known = withUsageModelLabels(
      { ...base, run: { selectedModel: "grok-composer-2.5-fast" } } as typeof base,
      lookup
    );
    expect(known.selectedModelLabel).toBe("Composer 2.5");
    // Unknown id (Codex / unprobed) falls back to the id itself, not null, so the
    // strip can still show it while a run is in flight.
    const unknown = withUsageModelLabels(
      { ...base, run: { selectedModel: "gpt-5.4-mini" } } as typeof base,
      lookup
    );
    expect(unknown.selectedModelLabel).toBe("gpt-5.4-mini");
    // No requested model → null.
    expect(withUsageModelLabels(base, lookup).selectedModelLabel).toBeNull();
  });
});

describe("withThoughtsSuppressed", () => {
  test("forces surfaceThoughts off for an agent that surfaces them (Grok)", () => {
    const grok = strategyById("grok");
    expect(grok?.quirks.surfaceThoughts).toBe(true); // sanity: Grok surfaces thoughts
    const suppressed = withThoughtsSuppressed(grok!);
    expect(suppressed.quirks.surfaceThoughts).toBe(false);
    // Everything else is preserved (id, spawn, other quirks).
    expect(suppressed.id).toBe("grok");
    expect(suppressed.spawn).toEqual(grok!.spawn);
    expect(suppressed.quirks.titleFrom).toBe(grok!.quirks.titleFrom);
    // Does not mutate the shared strategy.
    expect(grok!.quirks.surfaceThoughts).toBe(true);
  });
});
