import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type { AiSurfaceDefault, CodexModelOption, EnrichmentResult, Settings } from "@pwrsnap/shared";
import { CustomModelService } from "../ai/direct-api/service";
import { CaptureEnrichmentClient, type CaptureEnrichmentRequest } from "../ai/capture-enrichment-client";
import type { CustomCredentials } from "../ai/direct-api/credentials";
import { body, json, model, server } from "../ai/direct-api/__tests__/fixtures";
import { ENRICHMENT_QUEUE_MAX_AGE_MS } from "../ai/direct-api/enrichment-queue";
import * as appleFmCli from "../ai/apple-fm/fm-cli";
import * as appleFmNative from "../ai/apple-fm/native";
import { getAppleFmStatusService } from "../ai/apple-fm/service";
import { projectLocalAgentSearchRows, toCaptureSearchRequest } from "../local-agents/local-agent-search";
import { buildInitialV2Tree, packBundleV2 } from "../persistence/bundle-store";
import { getCacheSourcePath } from "../persistence/paths";
import { purgeCacheForCapture } from "../persistence/source-store";

let testDb: Database.Database;
let tempRoot: string;

const electronMock = vi.hoisted(() => ({
  sentEvents: [] as Array<{ channel: string; payload: unknown }>,
  windows: [] as Array<{
    isDestroyed: () => boolean;
    webContents: { send: (channel: string, payload: unknown) => void };
  }>
}));

const bundleStoreMock = vi.hoisted(() => ({
  scheduleRepack: vi.fn<(captureId: string) => void>()
}));

vi.mock("../persistence/bundle-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../persistence/bundle-store")>()),
  scheduleRepack: bundleStoreMock.scheduleRepack
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
const customModelHandlers = await import("../handlers/custom-model-handlers");
const {
  registerCodexHandlers,
  enrichmentSelectedModel,
  withUsageModelLabels
} = await import("../handlers/codex-handlers");
const { getAiRun } = await import("../persistence/ai-runs-repo");
const { searchCaptures } = await import("../persistence/captures-repo");
const { getCaptureEnrichment } = await import("../persistence/enrichment-repo");
const { defaultSettings } = await import("../settings/desktop-settings-service");
const { DesktopSettingsStore, __setDesktopSettingsStoreForTests } =
  await import("../settings/desktop-settings-store");
const { AiEnrichmentBudget } = await import("../ai/enrichment-budget");
const { EnrichmentPrimaryHealth } = await import("../ai/enrichment-fallback");
const { CodexTurnFailedError } = await import("../ai/codex-turn-error");
const {
  reportCodexCliTooOld,
  resetCodexCompatibilityAlertForTests
} = await import("../settings/codex-compatibility-alert");

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
    "codex:compatibilityAlert",
    "codex:models",
    "codex:usageSummary",
    "codex:usageRuns",
    "codex:usageRunDetail",
    "codex:cancel",
    "codex:annotate",
    "codex:describe",
    "codex:tag",
    "codex:filename",
    "codex:sensitiveScan"
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
  readonly stillImageFormat = "webp";
  imagePath: string | undefined;
  aborted = false;
  started = false;

  async enrichCapture(request: CaptureEnrichmentRequest): Promise<never> {
    this.started = true;
    this.imagePath = request.imagePaths[0];
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
    resetCodexCompatibilityAlertForTests();
    electronMock.sentEvents = [];
    electronMock.windows = [];
    bundleStoreMock.scheduleRepack.mockReset();
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
    testDb.exec(migration("0039_ai_run_fallback.sql"));
    await seedCapture();
  });

  afterEach(async () => {
    unregisterCodexHandlers();
    __setDesktopSettingsStoreForTests(null);
    resetCodexCompatibilityAlertForTests();
    testDb.close();
    await rm(tempRoot, { force: true, recursive: true });
  });

  test("does not register the obsolete codex:ask placeholder", () => {
    registerCodexHandlers();

    expect(bus.isRegistered("codex:ask")).toBe(false);
  });

  test.each([
    ["0.144.0", "webp"],
    ["0.169.0", "webp"],
    ["0.171.0", "webp"],
    ["0.172.0-alpha.1", "jpeg"]
  ])("codex:enrich prepares %s still inputs as %s", async (version, format) => {
    const settings = testSettings();
    settings.ai.enabled = true;
    settings.ai.consentAcceptedAt = "2026-05-12T12:00:00.000Z";
    const store = new DesktopSettingsStore({ filePath: join(tempRoot, "settings.json") });
    __setDesktopSettingsStoreForTests(store);
    const resolve = vi.spyOn(store, "resolveCompatibleCodexCommand")
      .mockResolvedValue({ command: "codex", source: "path", version });
    const observed = deferred<{ path: string; bytes: Buffer }>();
    const enrich = vi.spyOn(CaptureEnrichmentClient.prototype, "enrichCapture")
      .mockImplementation(async (request) => {
        const path = request.imagePaths[0]!;
        observed.resolve({ path, bytes: await readFile(path) });
        return new FakeCodexClient().enrichCapture(request);
      });
    try {
      registerCodexHandlers({ settingsReader: async () => settings, budget: new AiEnrichmentBudget() });
      const started = await bus.dispatch("codex:enrich", { captureId: "cap_1" }, { principal: "ipc" });
      if (!started.ok) throw new Error(started.error.message);
      const { runId } = started.value;
      await waitFor(() => getAiRun(runId)?.status === "completed");
      const { path, bytes } = await observed.promise;
      expect(await sharp(bytes).metadata()).toMatchObject({ format, width: 640, height: 360 });
      expect(path.endsWith(format === "webp" ? ".webp" : ".jpg")).toBe(true);
      const detail = await bus.dispatch("codex:usageRunDetail", { runId }, { principal: "ipc" });
      expect(detail.ok && detail.value?.mediaInputs).toEqual([expect.objectContaining({
        transform: `prepared-${format}`,
        sentMimeType: `image/${format}`,
        format,
        sentByteSize: bytes.length,
        maxEdgePx: 1024,
        maxBytes: 1_000_000
      })]);
      await vi.waitFor(async () => { await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" }); });
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally {
      enrich.mockRestore();
    }
  });

  test("codex:compatibilityAlert returns the durable guard snapshot", async () => {
    registerCodexHandlers();
    const alert = reportCodexCliTooOld("codex", "0.143.0", "0.144.0");

    const result = await bus.dispatch(
      "codex:compatibilityAlert",
      {},
      { principal: "ipc" }
    );

    expect(result).toEqual({ ok: true, value: alert });
  });

  test("accepted descriptions and bulk description drafts schedule bundle repacks", async () => {
    registerCodexHandlers();

    const description = await bus.dispatch(
      "codex:acceptDescription",
      { captureId: "cap_1", description: "Portable description" },
      { principal: "ipc" }
    );
    const bulk = await bus.dispatch(
      "codex:acceptAllDrafts",
      { captureId: "cap_1", title: "Title", description: "Bulk portable description" },
      { principal: "ipc" }
    );
    const titleOnly = await bus.dispatch(
      "codex:acceptAllDrafts",
      { captureId: "cap_1", title: "Title only" },
      { principal: "ipc" }
    );

    expect(description.ok).toBe(true);
    expect(bulk.ok).toBe(true);
    expect(titleOnly.ok).toBe(true);
    expect(bundleStoreMock.scheduleRepack.mock.calls).toEqual([
      ["cap_1"],
      ["cap_1"]
    ]);
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
            enrichmentRateLimit: null,
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
      (completedEvent!.payload as { enrichment?: { status?: string } | null }).enrichment?.status
    ).toBe("completed");
  });

  test.each(["success", "http-failure", "removed-model"] as const)(
    "custom enrichment uses direct HTTP and never creates a Codex client: %s",
    async (scenario) => {
      // This is a real Sharp + loopback HTTP + SQLite integration test. Await
      // the handler's terminal event instead of imposing a separate two-second
      // polling deadline on a loaded Windows runner. Persistence precedes this
      // broadcast, so the real database remains the completion oracle.
      let finish!: (run: { id: string; status: string }) => void;
      const finished = new Promise<{ id: string; status: string }>((resolve) => { finish = resolve; });
      electronMock.windows.push({
        isDestroyed: () => false,
        webContents: { send: (channel, payload) => {
          const run = (payload as { run?: { id: string; status: string } | null }).run;
          if (channel === EVENT_CHANNELS.aiRunUpdated && run && ["completed", "failed"].includes(run.status))
            finish(run);
        } }
      });
      const requests: Array<{ url: string | undefined; body: Record<string, unknown> }> = [];
      const http = await server(async (req, res) => {
        requests.push({ url: req.url, body: JSON.parse(await body(req)) as Record<string, unknown> });
        if (scenario === "http-failure") {
          res.writeHead(503).end();
          return;
        }
        json(res, { choices: [{ message: { content: JSON.stringify({
          title: "Direct fixture", description: "Synthetic image via direct HTTP", ocrText: "",
          filenameStem: "fixture", textAnchors: [], tags: []
        }) } }] });
      });
      const entry = model(`${http.url}/v1`);
      entry.modelId = "/fixture/models/local-model.gguf";
      entry.capabilities.streaming = false;
      const settings = testSettings();
      settings.ai.enabled = true;
      settings.ai.consentAcceptedAt = "2026-05-12T12:00:00.000Z";
      settings.ai.defaults.enrichment = { provider: `custom:${entry.id}`, model: entry.modelId };
      settings.ai.customConnections = [{ id: entry.connectionId, name: "Fixture connection",
        baseUrl: entry.baseUrl, protocol: entry.protocol, auth: entry.auth }];
      settings.ai.customModels = scenario === "removed-model" ? [] : [entry];
      // Only persistence/credential seams are replaced. The production handler,
      // selection, image preparation, protocol transport and run persistence run.
      const service = new CustomModelService({ read: async () => settings,
        write: async () => { throw new Error("Unexpected settings write"); } },
      { headers: async () => ({}) } as unknown as CustomCredentials, async () => undefined);
      const serviceSpy = vi.spyOn(customModelHandlers, "getCustomModelService").mockReturnValue(service);
      const clientFactory = vi.fn(() => { throw new Error("Custom selection reached Codex"); });
      try {
        registerCodexHandlers({ clientFactory, settingsReader: async () => settings });
        const result = await bus.dispatch("codex:enrich", { captureId: "cap_1" }, { principal: "ipc" });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(await finished).toMatchObject({ id: result.value.runId,
          status: scenario === "success" ? "completed" : "failed" });
        expect(getAiRun(result.value.runId)?.status).toBe(scenario === "success" ? "completed" : "failed");
        expect(clientFactory).not.toHaveBeenCalled();
        expect(requests).toHaveLength(scenario === "removed-model" ? 0 : 1);
        if (scenario !== "removed-model") {
          expect(requests[0]?.url).toBe("/v1/chat/completions");
          expect(requests[0]?.body.model).toBe(entry.modelId);
          expect(JSON.stringify(requests[0]?.body.messages)).toContain("data:image/jpeg;base64,");
          expect(JSON.stringify(requests[0]?.body.messages)).not.toContain(tempRoot);
        }
        if (scenario === "success") {
          expect(getCaptureEnrichment("cap_1")?.suggestedDescription).toBe("Synthetic image via direct HTTP");
        }
        const usage = await bus.dispatch("codex:usageRunDetail", { runId: result.value.runId }, { principal: "ipc" });
        expect(usage).toMatchObject({ ok: true, value: { modelProvider: `custom:${entry.id}` } });
        // Reading an existing result is also inert at the main-process boundary.
        for (let i = 0; i < 3; i++) {
          await bus.dispatch("codex:enrichment", { captureId: "cap_1" }, { principal: "ipc" });
        }
        expect(testDb.prepare("SELECT count(*) AS n FROM ai_runs").get()).toEqual({ n: 1 });
        expect(clientFactory).not.toHaveBeenCalled();
      } finally {
        serviceSpy.mockRestore();
        await http.close();
      }
    },
    10_000
  );

  // Production wiring for Apple's on-device model: the real handler, plan
  // resolution, image preparation, queue and run persistence; only the fm
  // process itself is scripted. The on-device selector never reaches Codex,
  // the tool is run with the fixed argv, and a failure is never moved to the
  // caption fallback. Native OCR reaches the Library index and MCP projection.
  test.each([
    { scenario: "success", expected: "completed" },
    { scenario: "native-success", expected: "completed" },
    { scenario: "native-no-text", expected: "completed" },
    { scenario: "guardrail", expected: "failed" },
    { scenario: "terms-with-fallback-armed", expected: "failed" }
  ] as const)("on-device Apple enrichment: $scenario → $expected", async ({ scenario, expected }) => {
    const native = scenario === "native-success" || scenario === "native-no-text";
    const query = "Zephyr 2749"; // Present only in the native helper's OCR field.
    const ocrText = scenario === "native-success" ? query : "";
    if (native) testDb.exec(migration("0032_capture_source_window_title.sql"));
    let finish!: (run: { id: string; status: string }) => void;
    const finished = new Promise<{ id: string; status: string }>((resolve) => { finish = resolve; });
    electronMock.windows.push({
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => {
        const run = (payload as { run?: { id: string; status: string } | null }).run;
        if (channel === EVENT_CHANNELS.aiRunUpdated && run && ["completed", "failed"].includes(run.status))
          finish(run);
      } }
    });
    const fmCalls: Array<{ args: string[]; stdin: string | undefined }> = [];
    const scriptedRun: appleFmCli.FmRunner = async (args, options) => {
      if (args[0] !== "caption") appleFmCli.assertAppleFmArgs(args);
      fmCalls.push({ args: [...args], stdin: options.stdin });
      if (args[0] === "config") return { code: 0, signal: null, stdout: "(none)\n", stderr: "" };
      const imagePath = args[0] === "caption"
        ? (JSON.parse(options.stdin ?? "") as { imagePaths: string[] }).imagePaths[0]!
        : args[args.indexOf("--image") + 1]!;
      expect(await sharp(await readFile(imagePath)).metadata()).toMatchObject({ format: "jpeg" });
      if (scenario === "guardrail") {
        return { code: 1, signal: null, stdout: "", stderr: "Error: The model's safety guardrails were triggered.\n" };
      }
      if (scenario === "terms-with-fallback-armed") {
        return { code: 1, signal: null, stdout: "", stderr: "Not agreed. Run 'sudo fm license' to review and agree.\n" };
      }
      return { code: 0, signal: null, stderr: "", stdout: JSON.stringify({
        title: "On-device fixture", description: "Synthetic image captioned on this Mac", ocrText,
        filenameStem: "on-device-fixture", tags: []
      }) };
    };
    const runSpy = vi.spyOn(appleFmCli, "runAppleFm").mockImplementation(scriptedRun);
    const nativeSpy = vi.spyOn(appleFmNative, "resolveNativeCaptionRunner")
      .mockResolvedValue(native ? scriptedRun : null);
    // The tool is macOS-only; the wiring under test is not.
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const invalidate = vi.spyOn(getAppleFmStatusService(), "invalidate");
    const settings = testSettings();
    settings.ai.enabled = true;
    settings.ai.consentAcceptedAt = "2026-05-12T12:00:00.000Z";
    settings.ai.defaults.enrichment = { provider: "apple:system" };
    if (scenario === "terms-with-fallback-armed") settings.ai.enrichmentFallback = {};
    const clientFactory = vi.fn(() => { throw new Error("On-device selection reached Codex"); });
    try {
      registerCodexHandlers({ clientFactory, settingsReader: async () => settings });
      const result = await bus.dispatch("codex:enrich", { captureId: "cap_1" }, { principal: "ipc" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(await finished).toMatchObject({ id: result.value.runId, status: expected });
      const run = getAiRun(result.value.runId);
      expect(run).toMatchObject({ status: expected, selectedModel: "system", fallbackFrom: null });
      expect(clientFactory).not.toHaveBeenCalled();

      expect(fmCalls.map((call) => call.args[0])).toEqual(native ? ["caption"] : ["config", "respond"]);
      const respond = fmCalls.at(-1)!;
      let images: Array<string | undefined>;
      if (native) {
        expect(runSpy).not.toHaveBeenCalled();
        expect(respond.args).toEqual(["caption"]);
        const payload = JSON.parse(respond.stdin ?? "") as {
          metadata: string; imagePaths: string[]; recognizeText: boolean
        };
        expect(payload.metadata).toContain("Capture metadata:");
        expect(payload.recognizeText).toBe(true);
        images = payload.imagePaths;
      } else {
        expect(respond.args.slice(0, 5)).toEqual(["respond", "--no-stream", "--greedy", "--model", "system"]);
        images = respond.args.flatMap((arg, i) => (arg === "--image" ? [respond.args[i + 1]] : []));
        expect(respond.stdin).toContain("Capture metadata:");
      }
      expect(images).toHaveLength(1);
      // An app-prepared bounded copy, never the capture's own file.
      // Absolute on every platform (a Windows path starts with a drive).
      expect(typeof images[0] === "string" && isAbsolute(images[0])).toBe(true);
      expect(images[0]).not.toContain(tempRoot);

      const usage = await bus.dispatch("codex:usageRunDetail", { runId: result.value.runId }, { principal: "ipc" });
      expect(usage).toMatchObject({ ok: true, value: { modelProvider: "apple:system" } });
      if (expected === "completed") {
        expect(getCaptureEnrichment("cap_1")?.suggestedDescription).toBe("Synthetic image captioned on this Mac");
        expect(usage).toMatchObject({ ok: true, value: { modelLabel: "Apple Intelligence (on-device)" } });
        expect(invalidate).not.toHaveBeenCalled();
        if (native) {
          const hasOcr = ocrText.length > 0;
          const mcpRequest = toCaptureSearchRequest({ query, hasOcr: true });
          expect(getCaptureEnrichment("cap_1")?.ocrText).toBe(ocrText);
          expect(searchCaptures({ query }).map(({ record }) => record.id))
            .toEqual(hasOcr ? ["cap_1"] : []);
          expect(projectLocalAgentSearchRows(searchCaptures(mcpRequest)))
            .toMatchObject(hasOcr ? [{ id: "cap_1", hasOcr: true }] : []);
          expect(searchCaptures(toCaptureSearchRequest({ hasOcr: true }))).toHaveLength(hasOcr ? 1 : 0);
          expect(projectLocalAgentSearchRows(searchCaptures({})))
            .toMatchObject([{ id: "cap_1", hasOcr }]);
        }
      } else if (scenario === "guardrail") {
        expect(run?.error).toContain("Apple's safety checks declined it");
        expect(invalidate).not.toHaveBeenCalled();
      } else {
        expect(run?.error).toContain("haven't been agreed to");
        // A setup failure makes the cached status stale.
        expect(invalidate).toHaveBeenCalledTimes(1);
      }
    } finally {
      nativeSpy.mockRestore();
      runSpy.mockRestore();
      platformSpy.mockRestore();
      invalidate.mockRestore();
    }
  }, 10_000);

  describe("native Apple caption refusal routing", () => {
    const caption = JSON.stringify({ title: "Refusal fixture", description: "Synthetic refusal example" });
    const refusal = { code: 1, signal: null, stdout: "", stderr: "refusal\n" };

    test.each([
      { outcome: "refusal", choice: "approved", status: "completed", hops: true },
      { outcome: "refusal", choice: "legacy", status: "failed", hops: false },
      { outcome: "refusal", choice: "off", status: "failed", hops: false },
      { outcome: "guardrail", choice: "approved", status: "failed", hops: false },
      { outcome: "not-ready", choice: "approved", status: "failed", hops: false },
      { outcome: "timeout", choice: "approved", status: "failed", hops: false },
      { outcome: "refusal with extra text", choice: "approved", status: "failed", hops: false },
      { outcome: "signalled exit", choice: "approved", status: "failed", hops: false },
      { outcome: "invalid JSON", choice: "approved", status: "failed", hops: false },
      { outcome: "caption containing refusal", choice: "approved", status: "completed", hops: false },
      { outcome: "CLI refusal text", choice: "approved", status: "failed", hops: false },
      { outcome: "cancel then refusal", choice: "approved", status: "cancelled", hops: false }
    ])("$outcome with fallback $choice", async ({ outcome, choice, status, hops }) => {
      const settings = testSettings();
      settings.ai.enabled = true;
      settings.ai.consentAcceptedAt = "2026-05-12T12:00:00.000Z";
      settings.ai.defaults.enrichment = { provider: "apple:system" };
      settings.ai.enrichmentFallback = choice === "off" ? null : {};
      if (choice === "approved") settings.ai.appleRefusalFallbackConsent = '["codex",""]';

      const primaryHealth = new EnrichmentPrimaryHealth(() => 0);
      const markDown = vi.spyOn(primaryHealth, "markDown");
      const noteUnreachable = vi.spyOn(primaryHealth, "noteUnreachable");
      const onPrimaryRecovered = vi.fn();
      const client = new FakeCodexClient();
      const clientFactory = vi.fn(() => client as never);
      const entered = deferred<void>();
      const finish = deferred<appleFmCli.FmRunResult>();
      const nativeRun = vi.fn<appleFmCli.FmRunner>().mockImplementation(async (args, options) => {
        expect(args).toEqual(["caption"]);
        const { imagePaths } = JSON.parse(options.stdin ?? "") as { imagePaths: string[] };
        expect(await sharp(await readFile(imagePaths[0]!)).metadata()).toMatchObject({ format: "jpeg" });
        if (nativeRun.mock.calls.length > 1 || outcome === "caption containing refusal") {
          return { ...refusal, code: 0, stdout: caption };
        }
        if (outcome === "cancel then refusal") {
          entered.resolve();
          return finish.promise;
        }
        if (outcome === "invalid JSON") return { ...refusal, code: 0, stdout: "refusal" };
        if (outcome === "signalled exit") return { ...refusal, code: null, signal: "SIGTERM" };
        return { ...refusal, stderr: `${outcome}\n` };
      });
      const native = vi.spyOn(appleFmNative, "resolveNativeCaptionRunner")
        .mockResolvedValue(outcome === "CLI refusal text" ? null : nativeRun);
      const legacy = vi.spyOn(appleFmCli, "runAppleFm").mockImplementation(async (args) =>
        args[0] === "config" ? { ...refusal, code: 0, stdout: "(none)\n", stderr: "" } : refusal);
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      try {
        registerCodexHandlers({ clientFactory, settingsReader: async () => settings,
          budget: new AiEnrichmentBudget(), primaryHealth, onPrimaryRecovered });
        const start = async (captureId: string): Promise<string> => {
          const reply = await bus.dispatch("codex:enrich", { captureId }, { principal: "ipc" });
          if (!reply.ok) throw new Error(reply.error.message);
          return reply.value.runId;
        };
        const runId = await start("cap_1");
        if (outcome === "cancel then refusal") {
          await entered.promise;
          expect((await bus.dispatch("codex:cancel", { runId }, { principal: "ipc" })).ok).toBe(true);
          finish.resolve(refusal);
        }
        await waitFor(() => ["completed", "failed", "cancelled"].includes(getAiRun(runId)?.status ?? ""));
        expect(getAiRun(runId)).toMatchObject({ status, fallbackFrom: hops ? "apple:system" : null });
        expect(clientFactory).toHaveBeenCalledTimes(hops ? 1 : 0);
        if (hops) {
          expect(getCaptureEnrichment("cap_1")).toMatchObject({
            fallbackFrom: "apple:system", suggestedDescription: "A screenshot with visible text."
          });
          const usage = await bus.dispatch("codex:usageRunDetail", { runId }, { principal: "ipc" });
          expect(usage).toMatchObject({ ok: true, value: { modelProvider: "openai" } });

          await seedCapture("cap_after_refusal");
          const nextId = await start("cap_after_refusal");
          await waitFor(() => getAiRun(nextId)?.status === "completed");
          expect(getAiRun(nextId)).toMatchObject({ selectedModel: "system", fallbackFrom: null });
          expect(nativeRun).toHaveBeenCalledTimes(2);
          expect(clientFactory).toHaveBeenCalledTimes(1);
        }
        if (outcome === "refusal with extra text") {
          expect(getAiRun(runId)?.error).toBe("the on-device model could not finish the caption.");
        }
        expect(markDown).not.toHaveBeenCalled();
        expect(noteUnreachable).not.toHaveBeenCalled();
        expect(onPrimaryRecovered).not.toHaveBeenCalled();
      } finally {
        platform.mockRestore();
        legacy.mockRestore();
        native.mockRestore();
      }
    });

    test("a selected loopback fallback can caption a refusal without off-device approval", async () => {
      const receive = vi.fn();
      const http = await server(async (req, res) => {
        receive(await body(req));
        json(res, { choices: [{ message: { content: caption } }] });
      });
      const entry = model(`${http.url}/v1`);
      entry.capabilities.streaming = false;
      const settings = testSettings();
      settings.ai.enabled = true;
      settings.ai.consentAcceptedAt = "2026-05-12T12:00:00.000Z";
      settings.ai.defaults.enrichment = { provider: "apple:system" };
      settings.ai.enrichmentFallback = { provider: `custom:${entry.id}` };
      settings.ai.customConnections = [{ id: entry.connectionId, name: "Local fixture",
        baseUrl: entry.baseUrl, protocol: entry.protocol, auth: entry.auth }];
      settings.ai.customModels = [entry];
      const service = new CustomModelService({ read: async () => settings,
        write: async () => { throw new Error("Unexpected settings write"); } },
      { headers: async () => ({}) } as unknown as CustomCredentials, async () => undefined);
      const serviceSpy = vi.spyOn(customModelHandlers, "getCustomModelService").mockReturnValue(service);
      const nativeRun = vi.fn<appleFmCli.FmRunner>().mockResolvedValue(refusal);
      const native = vi.spyOn(appleFmNative, "resolveNativeCaptionRunner").mockResolvedValue(nativeRun);
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      try {
        registerCodexHandlers({ settingsReader: async () => settings, budget: new AiEnrichmentBudget() });
        const reply = await bus.dispatch("codex:enrich", { captureId: "cap_1" }, { principal: "ipc" });
        if (!reply.ok) throw new Error(reply.error.message);
        await waitFor(() => ["completed", "failed"].includes(getAiRun(reply.value.runId)?.status ?? ""));
        expect(getAiRun(reply.value.runId)).toMatchObject({
          status: "completed", fallbackFrom: "apple:system", selectedModel: entry.modelId
        });
        expect(nativeRun).toHaveBeenCalledTimes(1);
        expect(receive).toHaveBeenCalledTimes(1);
      } finally {
        platform.mockRestore();
        native.mockRestore();
        serviceSpy.mockRestore();
        await http.close();
      }
    });

    test("when Apple refuses as the fallback, the run ends with the original hop", async () => {
      const settings = testSettings();
      settings.ai.enabled = true;
      settings.ai.consentAcceptedAt = "2026-05-12T12:00:00.000Z";
      settings.ai.enrichmentFallback = { provider: "apple:system" };
      const client = new FakeCodexClient();
      const turn = vi.spyOn(client, "enrichCapture").mockRejectedValue(new CodexTurnFailedError(
        "Synthetic offline turn", { httpConnectionFailed: { httpStatusCode: null } }
      ));
      const nativeRun = vi.fn<appleFmCli.FmRunner>().mockResolvedValue(refusal);
      const native = vi.spyOn(appleFmNative, "resolveNativeCaptionRunner").mockResolvedValue(nativeRun);
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      try {
        registerCodexHandlers({ clientFactory: () => client as never, settingsReader: async () => settings,
          budget: new AiEnrichmentBudget() });
        const reply = await bus.dispatch("codex:enrich", { captureId: "cap_1" }, { principal: "ipc" });
        if (!reply.ok) throw new Error(reply.error.message);
        await waitFor(() => getAiRun(reply.value.runId)?.status === "failed");
        expect(getAiRun(reply.value.runId)).toMatchObject({
          fallbackFrom: "codex", selectedModel: "system", error: expect.stringContaining("refused")
        });
        expect(turn).toHaveBeenCalledTimes(1);
        expect(nativeRun).toHaveBeenCalledTimes(1);
      } finally {
        platform.mockRestore();
        native.mockRestore();
      }
    });
  });

  // A stopped local server is what `ai.enrichmentFallback` exists for. The
  // primary's failure decides: nothing answered → the SAME run moves to the
  // fallback once; an answer of any other kind fails the run as before.
  test.each([
    { scenario: "refused", fallback: {}, expected: "fallback" },
    { scenario: "http-503", fallback: {}, expected: "fallback" },
    { scenario: "http-404", fallback: {}, expected: "fallback" },
    { scenario: "http-401", fallback: {}, expected: "failed" },
    { scenario: "refused", fallback: null, expected: "failed" }
  ] as const)(
    "direct primary $scenario with fallback $fallback → $expected",
    async ({ scenario, fallback, expected }) => {
      const http = await server((_req, res) => {
        res.writeHead(scenario === "http-401" ? 401 : scenario === "http-404" ? 404 : 503).end();
      });
      const entry = model(`${http.url}/v1`);
      entry.capabilities.streaming = false;
      // Nothing listens on a port whose server was closed: ECONNREFUSED.
      if (scenario === "refused") await http.close();
      const settings = testSettings();
      settings.ai.enabled = true;
      settings.ai.consentAcceptedAt = "2026-05-12T12:00:00.000Z";
      settings.ai.defaults.enrichment = { provider: `custom:${entry.id}` };
      settings.ai.enrichmentFallback = fallback;
      settings.ai.customConnections = [{ id: entry.connectionId, name: "Local fixture",
        baseUrl: entry.baseUrl, protocol: entry.protocol, auth: entry.auth }];
      settings.ai.customModels = [entry];
      const service = new CustomModelService({ read: async () => settings,
        write: async () => { throw new Error("Unexpected settings write"); } },
      { headers: async () => ({}) } as unknown as CustomCredentials, async () => undefined);
      const serviceSpy = vi.spyOn(customModelHandlers, "getCustomModelService").mockReturnValue(service);
      const codex = new FakeCodexClient();
      const clientFactory = vi.fn(() => codex as never);
      try {
        registerCodexHandlers({ clientFactory, settingsReader: async () => settings,
          budget: new AiEnrichmentBudget() });
        const result = await bus.dispatch("codex:enrich", { captureId: "cap_1" }, { principal: "ipc" });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        await waitFor(() => ["completed", "failed"].includes(getAiRun(result.value.runId)?.status ?? ""));
        const run = getAiRun(result.value.runId);
        if (expected === "failed") {
          expect(run?.status).toBe("failed");
          expect(run?.fallbackFrom).toBeNull();
          expect(clientFactory).not.toHaveBeenCalled();
          return;
        }
        expect(run).toMatchObject({ status: "completed", fallbackFrom: `custom:${entry.id}` });
        expect(clientFactory).toHaveBeenCalledTimes(1);
        // `{}` is Codex on its managed default: the run record names that
        // model, and the turn carries enrichment's low effort.
        expect(run?.selectedModel).toBe(codex.lastRequest?.model);
        expect(codex.lastRequest?.effort).toBe("low");
        expect(getCaptureEnrichment("cap_1")).toMatchObject({
          status: "completed",
          fallbackFrom: `custom:${entry.id}`
        });
        const usage = await bus.dispatch("codex:usageRunDetail", { runId: result.value.runId }, { principal: "ipc" });
        expect(usage).toMatchObject({ ok: true, value: { modelProvider: "openai" } });
        expect(testDb.prepare("SELECT count(*) AS n FROM ai_runs").get()).toEqual({ n: 1 });
      } finally {
        serviceSpy.mockRestore();
        if (scenario !== "refused") await http.close();
      }
    }
  );

  // The pre-run catalog listing only runs for a Codex PRIMARY. A Codex
  // fallback behind a local model learns the managed caption model at the
  // hop, so it runs the catalog's successor at an effort that model takes.
  test("a Codex fallback lists the catalog at the hop and runs the managed successor", async () => {
    const http = await server((_req, res) => { res.writeHead(503).end(); });
    const entry = model(`${http.url}/v1`);
    entry.capabilities.streaming = false;
    await http.close();
    const settings = testSettings();
    settings.ai.enabled = true;
    settings.ai.consentAcceptedAt = "2026-05-12T12:00:00.000Z";
    settings.ai.defaults.enrichment = { provider: `custom:${entry.id}` };
    settings.ai.enrichmentFallback = {};
    settings.ai.customConnections = [{ id: entry.connectionId, name: "Local fixture",
      baseUrl: entry.baseUrl, protocol: entry.protocol, auth: entry.auth }];
    settings.ai.customModels = [entry];
    const service = new CustomModelService({ read: async () => settings,
      write: async () => { throw new Error("Unexpected settings write"); } },
    { headers: async () => ({}) } as unknown as CustomCredentials, async () => undefined);
    const serviceSpy = vi.spyOn(customModelHandlers, "getCustomModelService").mockReturnValue(service);
    const codex = new FakeCodexClient();
    const modelLister = vi.fn(async () => [{ ...fakeCodexModels()[0]!, id: "gpt-6-luna", model: "gpt-6-luna",
      supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" }]);
    try {
      registerCodexHandlers({ clientFactory: () => codex as never, settingsReader: async () => settings,
        modelLister, modelDefaultsReconciler: async () => settings, budget: new AiEnrichmentBudget() });
      const result = await bus.dispatch("codex:enrich", { captureId: "cap_1" }, { principal: "ipc" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Enqueue listed nothing: the primary was not Codex.
      expect(modelLister).not.toHaveBeenCalled();
      await waitFor(() => ["completed", "failed"].includes(getAiRun(result.value.runId)?.status ?? ""));
      expect(modelLister).toHaveBeenCalledTimes(1);
      expect(getAiRun(result.value.runId)).toMatchObject({ status: "completed", selectedModel: "gpt-6-luna" });
      expect(codex.lastRequest).toMatchObject({ model: "gpt-6-luna", effort: "medium" });
    } finally {
      serviceSpy.mockRestore();
    }
  });


  // A primary nothing answered at is marked down: later captures skip it
  // until the window expires, then the next one probes it again.
  test("a down primary is skipped until its window expires", async () => {
    let hits = 0;
    const http = await server((_req, res) => { hits += 1; res.writeHead(503).end(); });
    const entry = model(`${http.url}/v1`);
    entry.capabilities.streaming = false;
    const settings = testSettings();
    settings.ai.enabled = true;
    settings.ai.consentAcceptedAt = "2026-05-12T12:00:00.000Z";
    settings.ai.defaults.enrichment = { provider: `custom:${entry.id}` };
    settings.ai.enrichmentFallback = {};
    settings.ai.customConnections = [{ id: entry.connectionId, name: "Local fixture",
      baseUrl: entry.baseUrl, protocol: entry.protocol, auth: entry.auth }];
    settings.ai.customModels = [entry];
    const service = new CustomModelService({ read: async () => settings,
      write: async () => { throw new Error("Unexpected settings write"); } },
    { headers: async () => ({}) } as unknown as CustomCredentials, async () => undefined);
    const serviceSpy = vi.spyOn(customModelHandlers, "getCustomModelService").mockReturnValue(service);
    let now = 0;
    const primaryHealth = new EnrichmentPrimaryHealth(() => now, 60_000);
    const enrich = async (): Promise<void> => {
      const result = await bus.dispatch("codex:enrich", { captureId: "cap_1" }, { principal: "ipc" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      await waitFor(() => ["completed", "failed"].includes(getAiRun(result.value.runId)?.status ?? ""));
      expect(getAiRun(result.value.runId)).toMatchObject({ status: "completed", fallbackFrom: `custom:${entry.id}` });
    };
    try {
      registerCodexHandlers({ clientFactory: () => new FakeCodexClient() as never,
        settingsReader: async () => settings, budget: new AiEnrichmentBudget(), primaryHealth });
      await enrich();
      expect(hits).toBe(1);
      await enrich();
      expect(hits).toBe(1);
      now = 60_000;
      await enrich();
      expect(hits).toBe(2);
    } finally {
      serviceSpy.mockRestore();
      await http.close();
    }
  });

  // A fallback that fails too still says it was a fallback run: the pill
  // explains both failures from `fallbackFrom` on the failed run.
  test("a failed fallback fails the run and keeps fallbackFrom", async () => {
    const http = await server((_req, res) => { res.writeHead(503).end(); });
    const entry = model(`${http.url}/v1`);
    entry.capabilities.streaming = false;
    await http.close();
    const settings = testSettings();
    settings.ai.enabled = true;
    settings.ai.consentAcceptedAt = "2026-05-12T12:00:00.000Z";
    settings.ai.defaults.enrichment = { provider: `custom:${entry.id}` };
    settings.ai.enrichmentFallback = {};
    settings.ai.customConnections = [{ id: entry.connectionId, name: "Local fixture",
      baseUrl: entry.baseUrl, protocol: entry.protocol, auth: entry.auth }];
    settings.ai.customModels = [entry];
    const service = new CustomModelService({ read: async () => settings,
      write: async () => { throw new Error("Unexpected settings write"); } },
    { headers: async () => ({}) } as unknown as CustomCredentials, async () => undefined);
    const serviceSpy = vi.spyOn(customModelHandlers, "getCustomModelService").mockReturnValue(service);
    const failing = {
      enrichCapture: async () => { throw new Error("model overloaded"); },
      close: async () => undefined
    };
    try {
      registerCodexHandlers({ clientFactory: () => failing as never, settingsReader: async () => settings,
        budget: new AiEnrichmentBudget() });
      const result = await bus.dispatch("codex:enrich", { captureId: "cap_1" }, { principal: "ipc" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      await waitFor(() => ["completed", "failed"].includes(getAiRun(result.value.runId)?.status ?? ""));
      expect(getAiRun(result.value.runId)).toMatchObject({ status: "failed", fallbackFrom: `custom:${entry.id}` });
      expect(getCaptureEnrichment("cap_1")).toMatchObject({ fallbackFrom: `custom:${entry.id}` });
    } finally {
      serviceSpy.mockRestore();
    }
  });

  // Codex primary, Apple's on-device model as the fallback (GPT-6-Luna →
  // Apple Intelligence). Only Codex's own "no HTTP answer at all" transport
  // classification moves the run; every other Codex failure fails it, and
  // the on-device model is never asked.
  describe("Codex primary with an on-device fallback", () => {
    const offline = (key: string, httpStatusCode: number | null = null) =>
      new CodexTurnFailedError("stream error: error sending request", { [key]: { httpStatusCode } } as never);
    const appleCaption = JSON.stringify({
      title: "Offline fixture", description: "Synthetic snap captioned on this Mac", ocrText: "",
      filenameStem: "offline-fixture", textAnchors: [], tags: []
    });
    const withApple = async (
      body: (respondCalls: () => number, paths: readonly string[]) => Promise<void>
    ): Promise<void> => {
      let respond = 0;
      const paths: string[] = [];
      const nativeSpy = vi.spyOn(appleFmNative, "resolveNativeCaptionRunner").mockResolvedValue(async (args, options) => {
        expect(args).toEqual(["caption"]);
        const input = JSON.parse(options.stdin ?? "") as { imagePaths: string[] };
        expect(input).toMatchObject({
          metadata: expect.stringContaining("Capture metadata:"),
          imagePaths: [expect.any(String)],
          recognizeText: true
        });
        expect(await sharp(await readFile(input.imagePaths[0]!)).metadata()).toMatchObject({ format: "jpeg" });
        paths.push(...input.imagePaths);
        respond += 1;
        return { code: 0, signal: null, stderr: "", stdout: appleCaption };
      });
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      try {
        await body(() => respond, paths);
      } finally {
        nativeSpy.mockRestore();
        platformSpy.mockRestore();
      }
    };
    const lunaSettings = (fallback: AiSurfaceDefault | null): Settings => {
      const settings = testSettings();
      settings.ai.enabled = true;
      settings.ai.consentAcceptedAt = "2026-05-12T12:00:00.000Z";
      settings.ai.defaults.enrichment = { provider: "codex", model: "gpt-6-luna" };
      settings.ai.enrichmentFallback = fallback;
      return settings;
    };
    const settle = async (runId: string): Promise<void> => {
      await waitFor(() => ["completed", "failed"].includes(getAiRun(runId)?.status ?? ""));
    };

    test("Apple can caption a bundle still after its source cache is evicted during Codex", async () => {
      vi.stubEnv("PWRSNAP_DATA_ROOT", tempRoot);
      try {
        const captureId = "bundle-cache-fixture";
        await seedCapture(captureId);
        const source = await readFile(join(tempRoot, `${captureId}.png`));
        const sha256 = createHash("sha256").update(source).digest("hex");
        const { manifest, layers } = buildInitialV2Tree({
          captureId,
          createdAt: "2026-05-12T12:00:00.000Z",
          sha256,
          widthPx: 640,
          heightPx: 360,
          pairedPngFilename: "fixture.png"
        });
        const bundlePath = join(tempRoot, "fixture.pwrsnap");
        await writeFile(bundlePath, await packBundleV2({
          manifest,
          document: { document_format_version: 1, edits_version: 0, layers, tags: [],
            description: null, ai_runs: [] },
          sources: new Map([[sha256, source]]),
          layerBytes: new Map()
        }));
        testDb.prepare("UPDATE captures SET bundle_path = ?, sha256 = ?, legacy_src_path = NULL WHERE id = ?")
          .run(bundlePath, sha256, captureId);
        const cachedSource = getCacheSourcePath(captureId);
        await mkdir(dirname(cachedSource), { recursive: true });
        await writeFile(cachedSource, source);

        await withApple(async (respondCalls) => {
          const codex = {
            stillImageFormat: "webp" as const,
            enrichCapture: vi.fn(async ({ imagePaths }: CaptureEnrichmentRequest) => {
              expect(await sharp(await readFile(imagePaths[0]!)).metadata()).toMatchObject({ format: "webp" });
              await purgeCacheForCapture(captureId);
              await expect(readFile(cachedSource)).rejects.toMatchObject({ code: "ENOENT" });
              throw offline("httpConnectionFailed");
            }),
            close: async () => undefined
          };
          registerCodexHandlers({ clientFactory: () => codex,
            settingsReader: async () => lunaSettings({ provider: "apple:system" }), budget: new AiEnrichmentBudget() });
          const started = await bus.dispatch("codex:enrich", { captureId }, { principal: "ipc" });
          if (!started.ok) throw new Error(started.error.message);
          await settle(started.value.runId);
          expect(getAiRun(started.value.runId)).toMatchObject({ status: "completed", fallbackFrom: "codex" });
          expect(respondCalls()).toBe(1);
          expect(await readFile(cachedSource)).toEqual(source);
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    test.each(["encoding", "accounting"])("a local %s failure preserves a concurrent Codex outage", async (failure) => {
      await withApple(async (respondCalls) => {
        await seedCapture("offline");
        await seedCapture("next");
        if (failure === "encoding") {
          await writeFile(join(tempRoot, "cap_1.png"), "invalid fixture image");
        } else {
          testDb.exec(`
            CREATE TRIGGER reject_fixture_media BEFORE INSERT ON ai_run_media_inputs
            WHEN (SELECT capture_id FROM ai_runs WHERE id = NEW.ai_run_id) = 'cap_1'
            BEGIN SELECT RAISE(ABORT, 'fixture media accounting failed'); END
          `);
        }
        const enteredFactory = deferred<void>();
        const releaseFactory = deferred<void>();
        let first = true;
        const codex = {
          stillImageFormat: "webp" as const,
          enrichCapture: vi.fn(async () => { throw offline("httpConnectionFailed"); }),
          close: async () => undefined
        };
        registerCodexHandlers({
          clientFactory: async () => {
            if (first) {
              first = false;
              enteredFactory.resolve();
              await releaseFactory.promise;
            }
            return codex;
          },
          settingsReader: async () => lunaSettings({ provider: "apple:system" }),
          budget: new AiEnrichmentBudget(),
          primaryHealth: new EnrichmentPrimaryHealth(() => 0, 60_000)
        });
        const start = async (captureId: string): Promise<string> => {
          const started = await bus.dispatch("codex:enrich", { captureId }, { principal: "ipc" });
          if (!started.ok) throw new Error(started.error.message);
          return started.value.runId;
        };

        const localRun = await start("cap_1");
        try {
          await enteredFactory.promise;
          const offlineRun = await start("offline");
          await settle(offlineRun);
          expect(getAiRun(offlineRun)).toMatchObject({ status: "completed", fallbackFrom: "codex" });
        } finally {
          releaseFactory.resolve();
          await settle(localRun);
        }
        expect(getAiRun(localRun)).toMatchObject({ status: "failed", fallbackFrom: null,
          error: expect.stringMatching(failure === "encoding" ? /unsupported image format/i : /fixture media accounting failed/) });
        const nextRun = await start("next");
        await settle(nextRun);
        expect(getAiRun(nextRun)).toMatchObject({ status: "completed", fallbackFrom: "codex" });
        expect(codex.enrichCapture).toHaveBeenCalledTimes(1);
        expect(respondCalls()).toBe(2);
      });
    });

    test.each([
      { scenario: "connection failed, no HTTP status", error: offline("httpConnectionFailed"), expected: "fallback" },
      { scenario: "stream never connected", error: offline("responseStreamConnectionFailed"), expected: "fallback" },
      { scenario: "retries exhausted, no answer", error: offline("responseTooManyFailedAttempts"), expected: "fallback" },
      { scenario: "connection failed with HTTP 503", error: offline("httpConnectionFailed", 503), expected: "failed" },
      { scenario: "stream disconnected mid-answer", error: offline("responseStreamDisconnected"), expected: "failed" },
      { scenario: "signed out", error: new CodexTurnFailedError("401", "unauthorized"), expected: "failed" },
      { scenario: "usage limit", error: new CodexTurnFailedError("limit", "usageLimitExceeded"), expected: "failed" },
      { scenario: "policy block", error: new CodexTurnFailedError("blocked", "cyberPolicy"), expected: "failed" },
      { scenario: "unclassified turn failure", error: new CodexTurnFailedError("boom", null), expected: "failed" },
      { scenario: "turn timeout", error: new Error("Codex one-shot turn timed out"), expected: "failed" },
      { scenario: "local setup error", error: new Error("spawn codex ENOENT"), expected: "failed" }
    ])("$scenario → $expected", async ({ error, expected }) => {
      await withApple(async (respondCalls, applePaths) => {
        const settings = lunaSettings({ provider: "apple:system" });
        let primaryImage: { path: string; bytes: Buffer } | undefined;
        const codex = {
          stillImageFormat: "webp" as const,
          enrichCapture: vi.fn(async ({ imagePaths }: CaptureEnrichmentRequest) => {
            const path = imagePaths[0]!;
            primaryImage = { path, bytes: await readFile(path) };
            throw error;
          }),
          close: async () => undefined
        };
        registerCodexHandlers({ clientFactory: () => codex, settingsReader: async () => settings,
          budget: new AiEnrichmentBudget(), primaryHealth: new EnrichmentPrimaryHealth(() => 0, 60_000) });
        const result = await bus.dispatch("codex:enrich", { captureId: "cap_1" }, { principal: "ipc" });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        await settle(result.value.runId);
        const run = getAiRun(result.value.runId);
        expect(codex.enrichCapture).toHaveBeenCalledTimes(1);
        expect(primaryImage).toBeDefined();
        expect(await sharp(primaryImage!.bytes).metadata()).toMatchObject({ format: "webp" });
        await vi.waitFor(async () => {
          await expect(readFile(primaryImage!.path)).rejects.toMatchObject({ code: "ENOENT" });
        });
        const detail = await bus.dispatch("codex:usageRunDetail", { runId: result.value.runId }, { principal: "ipc" });
        expect(detail.ok && detail.value?.mediaInputs.map((input) => input.transform))
          .toEqual([expected === "fallback" ? "prepared-jpeg" : "prepared-webp"]);
        if (expected === "failed") {
          expect(run).toMatchObject({ status: "failed", fallbackFrom: null });
          expect(respondCalls()).toBe(0);
          return;
        }
        expect(run).toMatchObject({ status: "completed", fallbackFrom: "codex", selectedModel: "system" });
        expect(respondCalls()).toBe(1);
        expect(applePaths).toHaveLength(1);
        expect(applePaths[0]).not.toBe(primaryImage!.path);
        await vi.waitFor(async () => {
          await expect(readFile(applePaths[0]!)).rejects.toMatchObject({ code: "ENOENT" });
        });
        expect(getCaptureEnrichment("cap_1")).toMatchObject({
          status: "completed", fallbackFrom: "codex", suggestedDescription: "Synthetic snap captioned on this Mac"
        });
      });
    }, 10_000);

    test("a Codex fallback behind a Codex primary is never armed: an offline turn just fails", async () => {
      const settings = lunaSettings({});
      const codex = { enrichCapture: vi.fn(async () => { throw offline("httpConnectionFailed"); }),
        close: async () => undefined };
      registerCodexHandlers({ clientFactory: () => codex as never, settingsReader: async () => settings,
        budget: new AiEnrichmentBudget(), primaryHealth: new EnrichmentPrimaryHealth(() => 0, 60_000) });
      const result = await bus.dispatch("codex:enrich", { captureId: "cap_1" }, { principal: "ipc" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      await settle(result.value.runId);
      expect(getAiRun(result.value.runId)).toMatchObject({ status: "failed", fallbackFrom: null });
      expect(codex.enrichCapture).toHaveBeenCalledTimes(1);
    });

    // During the turn, then before it (the down window), then recovery.
    test("offline during a turn, skipped while down, probed after the window, recovery reported once", async () => {
      await withApple(async (respondCalls) => {
        const settings = lunaSettings({ provider: "apple:system" });
        let online = false;
        const fake = new FakeCodexClient();
        const codex = {
          enrichCapture: vi.fn(async (request: { model?: string | null; effort?: string }) => {
            if (!online) throw offline("responseStreamConnectionFailed");
            return fake.enrichCapture(request);
          }),
          close: async () => undefined
        };
        let now = 1_000;
        const recoveries: Array<{ provider: string; downSince: string; upAt: string }> = [];
        registerCodexHandlers({ clientFactory: () => codex as never, settingsReader: async () => settings,
          budget: new AiEnrichmentBudget(), primaryHealth: new EnrichmentPrimaryHealth(() => now, 60_000),
          onPrimaryRecovered: (recovery) => { recoveries.push(recovery); } });
        const enrich = async (): Promise<string> => {
          const result = await bus.dispatch("codex:enrich", { captureId: "cap_1" }, { principal: "ipc" });
          if (!result.ok) throw new Error(result.error.message);
          await settle(result.value.runId);
          return result.value.runId;
        };

        // During: Codex is asked, reports no connection; Apple answers.
        expect(getAiRun(await enrich())).toMatchObject({ status: "completed", fallbackFrom: "codex" });
        expect(codex.enrichCapture).toHaveBeenCalledTimes(1);
        // Before: inside the window Codex is not asked at all.
        now = 30_000;
        expect(getAiRun(await enrich())).toMatchObject({ status: "completed", fallbackFrom: "codex" });
        expect(codex.enrichCapture).toHaveBeenCalledTimes(1);
        expect(respondCalls()).toBe(2);
        expect(recoveries).toEqual([]);
        // Back online after the window: Codex is probed, answers, and the
        // outage that began with the first offline turn is reported once.
        now = 61_000;
        online = true;
        expect(getAiRun(await enrich())).toMatchObject({ status: "completed", fallbackFrom: null });
        expect(codex.enrichCapture).toHaveBeenCalledTimes(2);
        expect(respondCalls()).toBe(2);
        expect(recoveries).toEqual([{ provider: "codex",
          downSince: new Date(1_000).toISOString(), upAt: new Date(61_000).toISOString() }]);
        await enrich();
        expect(recoveries).toHaveLength(1);
      });
    }, 15_000);
  });

  test("eight direct enrichments share the connection queue; queued and active cancellation never dispatch again", async () => {
    const received: Array<{ model: string; reply: () => void }> = [];
    let active = 0;
    let peak = 0;
    const http = await server(async (req, res) => {
      const request = JSON.parse(await body(req)) as { model: string };
      active++;
      peak = Math.max(peak, active);
      res.once("close", () => { active--; });
      // Send headers so cancellation also exercises reading the response body.
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      received.push({ model: request.model, reply: () => { res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "Fixture", description: "Queued fixture result", ocrText: "", filenameStem: "fixture", tags: [], textAnchors: []
      }) } }] })); } });
    });
    const entry = model(`${http.url}/v1`);
    entry.capabilities.streaming = false;
    const second = { ...entry, id: "12345678-1234-4234-8234-123456789002", modelId: "second-model" };
    const settings = testSettings();
    settings.ai.enabled = true;
    settings.ai.consentAcceptedAt = "2026-05-12T12:00:00.000Z";
    settings.ai.customConnections = [{ id: entry.connectionId, name: "Local fixture", baseUrl: entry.baseUrl, protocol: entry.protocol, auth: entry.auth }];
    settings.ai.customModels = [entry, second];
    const service = new CustomModelService({ read: async () => settings,
      write: async () => { throw new Error("Unexpected write"); } },
    { headers: async () => ({}) } as unknown as CustomCredentials, async () => undefined);
    const serviceSpy = vi.spyOn(customModelHandlers, "getCustomModelService").mockReturnValue(service);
    const clientFactory = vi.fn(() => { throw new Error("Custom selection reached Codex"); });
    const runs: string[] = [];
    try {
      registerCodexHandlers({ clientFactory, settingsReader: async () => settings, budget: new AiEnrichmentBudget() });
      for (let i = 0; i < 8; i++) {
        const captureId = `burst_${i}`;
        await seedCapture(captureId);
        const chosen = i % 2 === 0 ? entry : second;
        settings.ai.defaults.enrichment = { provider: `custom:${chosen.id}`, model: chosen.modelId };
        const result = await bus.dispatch("codex:enrich", { captureId }, { principal: "ipc" });
        expect(result.ok).toBe(true);
        if (result.ok) runs.push(result.value.runId);
      }
      await waitFor(() => received.length === 1);
      expect(runs.slice(1).map((id) => getAiRun(id)?.status)).toEqual(Array(7).fill("queued"));
      expect(runs.slice(1).map((id) => getAiRun(id)?.startedAt)).toEqual(Array(7).fill(null));
      await bus.dispatch("codex:cancel", { runId: runs[3]! }, { principal: "ipc" });
      expect(getAiRun(runs[3]!)?.status).toBe("cancelled");
      expect(received).toHaveLength(1);
      await bus.dispatch("codex:cancel", { runId: runs[0]! }, { principal: "ipc" });
      for (let i = 1; i < 7; i++) {
        await waitFor(() => received.length > i);
        received[i]!.reply();
      }
      await waitFor(() => runs.every((id) => ["completed", "cancelled"].includes(getAiRun(id)?.status ?? "")));
      expect(runs.map((id) => getAiRun(id)?.status)).toEqual([
        "cancelled", "completed", "completed", "cancelled", "completed", "completed", "completed", "completed"
      ]);
      expect(received.map((r) => r.model)).toEqual([
        entry.modelId, second.modelId, entry.modelId, entry.modelId, second.modelId, entry.modelId, second.modelId
      ]);
      expect(peak).toBe(1);
      expect(clientFactory).not.toHaveBeenCalled();
    } finally {
      for (const runId of runs) await bus.dispatch("codex:cancel", { runId }, { principal: "ipc" });
      serviceSpy.mockRestore();
      await http.close();
    }
  });

  test.each(["expires", "repointed"] as const)("queued direct enrichment is never dispatched when it %s", async (scenario) => {
    const replies: Array<() => void> = [];
    const http = await server((_req, res) => {
      replies.push(() => json(res, { choices: [{ message: { content: JSON.stringify({
        title: "Fixture", description: "Fixture description", ocrText: "", filenameStem: "fixture", tags: [], textAnchors: []
      }) } }] }));
    });
    const entry = model(`${http.url}/v1`);
    entry.capabilities.streaming = false;
    const settings = testSettings();
    settings.ai.enabled = true;
    settings.ai.consentAcceptedAt = "2026-05-12T12:00:00.000Z";
    settings.ai.defaults.enrichment = { provider: `custom:${entry.id}`, model: entry.modelId };
    settings.ai.customConnections = [{ id: entry.connectionId, name: "Fixture", baseUrl: entry.baseUrl, protocol: entry.protocol, auth: entry.auth }];
    settings.ai.customModels = [entry];
    const headers = vi.fn(async () => ({}));
    const service = new CustomModelService({ read: async () => settings,
      write: async () => { throw new Error("Unexpected write"); } },
    { headers } as unknown as CustomCredentials, async () => undefined);
    const serviceSpy = vi.spyOn(customModelHandlers, "getCustomModelService").mockReturnValue(service);
    const realNow = performance.now.bind(performance);
    let offset = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + offset);
    const runs: string[] = [];
    try {
      registerCodexHandlers({ settingsReader: async () => settings, budget: new AiEnrichmentBudget() });
      await seedCapture("cap_2");
      for (const captureId of ["cap_1", "cap_2"]) {
        const result = await bus.dispatch("codex:enrich", { captureId }, { principal: "ipc" });
        expect(result.ok).toBe(true);
        if (result.ok) runs.push(result.value.runId);
      }
      await waitFor(() => replies.length === 1);
      expect(getAiRun(runs[1]!)?.status).toBe("queued");
      if (scenario === "expires") offset = ENRICHMENT_QUEUE_MAX_AGE_MS;
      else settings.ai.customConnections[0] = { ...settings.ai.customConnections[0]!, baseUrl: `${http.url}/changed` };
      // Passing 15 minutes alone does not dispatch or fail a waiting item.
      expect(getAiRun(runs[1]!)?.status).toBe("queued");
      expect(headers).toHaveBeenCalledTimes(1);
      replies[0]!();
      await waitFor(() => getAiRun(runs[1]!)?.status === "failed");
      expect(getAiRun(runs[0]!)?.status).toBe("completed");
      expect(getAiRun(runs[1]!)?.error).toContain(scenario === "expires" ? "15 minutes" : "connection changed");
      expect(replies).toHaveLength(1);
      expect(headers).toHaveBeenCalledTimes(1);
    } finally {
      for (const runId of runs) await bus.dispatch("codex:cancel", { runId }, { principal: "ipc" });
      clock.mockRestore();
      serviceSpy.mockRestore();
      await http.close();
    }
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
            enrichmentRateLimit: null,
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
    expect(fakeClient.lastRequest?.model).toBe("gpt-5.6-luna");
    expect(getAiRun(result.value.runId)?.selectedModel).toBe("gpt-5.6-luna");
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
            autoAcceptSuggestions: false,
            defaults: {
              ...defaultSettings().ai.defaults,
              enrichment: { model: "gpt-5.5" }
            }
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

  test("enrichment ignores legacy captionModel and uses managed Luna Low", async () => {
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
            // `codex.captionModel` is retained only to read old settings. An
            // empty surface follows PwrSnap's managed enrichment default.
            defaults: {
              ...defaultSettings().ai.defaults,
              enrichment: {}
            }
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
    expect(fakeClient.lastRequest?.model).toBe("gpt-5.6-luna");
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
    expect(result.value.selectedModel).toBe("gpt-5.6-luna");
    expect(result.value.models).toEqual([
      expect.objectContaining({
        id: "gpt-5.5",
        model: "gpt-5.5",
        inputModalities: ["text", "image"]
      })
    ]);
  });

  test("live model listing persists replacements before returning the filtered picker catalog", async () => {
    const store = new DesktopSettingsStore({ filePath: join(tempRoot, "settings.json") });
    await store.write({ ai: { defaults: {
      libraryChat: { model: "gpt-6-astra" }, sizzleChat: { model: "gpt-5.6-terra" },
      enrichment: { model: "gpt-5.6-luna" }
    } } });
    const models = ["gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-sol",
      "gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"].map((id) => ({
      ...fakeCodexModels()[0]!, id, model: id, displayName: id, isDefault: id === "gpt-6-sol"
    }));
    registerCodexHandlers({ settingsReader: () => store.read(), modelLister: async () => models,
      modelDefaultsReconciler: async (catalogModels, catalog) =>
        (await store.reconcileCodexModelDefaults(catalogModels, catalog)).settings });
    const result = await bus.dispatch("codex:models", {}, { principal: "ipc" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedModel).toBe("gpt-6-luna");
    expect(result.value.models.map((value) => value.id)).toEqual([
      "gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"
    ]);
    expect((await store.read()).ai.defaults).toMatchObject({
      libraryChat: { model: "gpt-6-astra" }, sizzleChat: { model: "gpt-6.1-sol" },
      enrichment: { model: "gpt-6-luna" }
    });
    const hidden = await bus.dispatch("codex:models", { includeHidden: true }, { principal: "ipc" });
    expect(hidden.ok && hidden.value.models.filter((value) => value.hidden).map((value) => value.id))
      .toEqual(["gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"]);
  });

  test("codex:models names the resolved managed default without writing it", async () => {
    const store = new DesktopSettingsStore({ filePath: join(tempRoot, "settings.json") });
    await store.write({ ai: { enabled: true } });
    const models = ["gpt-5.6-luna", "gpt-6-luna"].map((id) => ({
      ...fakeCodexModels()[0]!, id, model: id, displayName: id
    }));
    registerCodexHandlers({ settingsReader: () => store.read(), modelLister: async () => models,
      modelDefaultsReconciler: async (catalogModels, catalog) =>
        (await store.reconcileCodexModelDefaults(catalogModels, catalog)).settings });
    const result = await bus.dispatch("codex:models", {}, { principal: "ipc" });
    expect(result.ok && result.value.selectedModel).toBe("gpt-6-luna");
    expect((await store.read()).ai.defaults.enrichment).toEqual({});
  });

  test("automatic enrichment resolves the managed Luna default at run time, unpinned", async () => {
    const store = new DesktopSettingsStore({ filePath: join(tempRoot, "settings.json") });
    await store.write({ ai: { enabled: true, consentAcceptedAt: "2026-10-01T00:00:00Z" } });
    const fakeClient = new FakeCodexClient();
    const modelLister = vi.fn(async () => [{ ...fakeCodexModels()[0]!, id: "gpt-6-luna", model: "gpt-6-luna" }]);
    registerCodexHandlers({ settingsReader: () => store.read(), clientFactory: () => fakeClient as never,
      modelLister, modelDefaultsReconciler: async (models, catalog) =>
        (await store.reconcileCodexModelDefaults(models, catalog)).settings });
    const started = await bus.dispatch("codex:enrich", { captureId: "cap_1" },
      { principal: "ipc", cancellationKey: "cap_1" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(() => getAiRun(started.value.runId)?.status === "completed");
    expect(modelLister).toHaveBeenCalledTimes(1);
    expect(getAiRun(started.value.runId)?.selectedModel).toBe("gpt-6-luna");
    expect(fakeClient.lastRequest).toMatchObject({ model: "gpt-6-luna", effort: "low" });
    // Nothing was pinned: a later managed-default change still applies.
    expect((await store.read()).ai.defaults.enrichment).toEqual({});
  });

  test("the managed default's effort follows what the resolved model advertises", async () => {
    const store = new DesktopSettingsStore({ filePath: join(tempRoot, "settings.json") });
    await store.write({ ai: { enabled: true, consentAcceptedAt: "2026-10-01T00:00:00Z" } });
    const fakeClient = new FakeCodexClient();
    registerCodexHandlers({ settingsReader: () => store.read(), clientFactory: () => fakeClient as never,
      modelLister: async () => [{ ...fakeCodexModels()[0]!, id: "gpt-6-luna", model: "gpt-6-luna",
        supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" }],
      modelDefaultsReconciler: async (models, catalog) =>
        (await store.reconcileCodexModelDefaults(models, catalog)).settings });
    const started = await bus.dispatch("codex:enrich", { captureId: "cap_1" },
      { principal: "ipc", cancellationKey: "cap_1" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(() => getAiRun(started.value.runId)?.status === "completed");
    expect(fakeClient.lastRequest).toMatchObject({ model: "gpt-6-luna", effort: "medium" });
  });

  test("a catalog without the replacement is listed once, not before every enrichment", async () => {
    const store = new DesktopSettingsStore({ filePath: join(tempRoot, "settings.json") });
    await store.write({ ai: { enabled: true, consentAcceptedAt: "2026-10-01T00:00:00Z" } });
    const fakeClient = new FakeCodexClient();
    // No gpt-6-luna: the managed gpt-5.6-luna default stays obsolete.
    const modelLister = vi.fn(async () => [{ ...fakeCodexModels()[0]!, id: "gpt-5.6-luna", model: "gpt-5.6-luna" }]);
    registerCodexHandlers({ settingsReader: () => store.read(), clientFactory: () => fakeClient as never,
      modelLister, modelDefaultsReconciler: async (models, catalog) =>
        (await store.reconcileCodexModelDefaults(models, catalog)).settings });
    for (let run = 0; run < 2; run += 1) {
      const started = await bus.dispatch("codex:enrich", { captureId: "cap_1" },
        { principal: "ipc", cancellationKey: "cap_1" });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      await waitFor(() => getAiRun(started.value.runId)?.status === "completed");
    }
    expect(modelLister).toHaveBeenCalledTimes(1);
    expect(fakeClient.lastRequest).toMatchObject({ model: "gpt-5.6-luna" });
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

  describe("operator-started re-runs (library repair)", () => {
    const enabledAi = (patch?: Partial<Settings["ai"]>): Settings =>
      testSettings({
        ai: {
          ...defaultSettings().ai,
          enabled: true,
          consentAcceptedAt: "2026-05-12T12:00:00.000Z",
          budgetSafetyDisabledAt: null,
          autoAcceptSuggestions: false,
          ...patch
        }
      });
    // Background turns write to the database; let each finish before the
    // test's database closes.
    const waitForRunToEnd = (runId: string | undefined): Promise<void> =>
      waitFor(() => ["completed", "failed", "cancelled"].includes(getAiRun(runId ?? "")?.status ?? ""));

    test("never spend a live token and never record a limited attempt", async () => {
      // An empty bucket whose breaker would trip on the second refusal.
      const budget = new AiEnrichmentBudget({ capacity: 0, disableThreshold: 2 });
      const writes: unknown[] = [];
      const settings = enabledAi();
      const repair = registerCodexHandlers({
        clientFactory: () => new FakeCodexClient() as never,
        budget,
        settingsReader: async () => settings,
        settingsWriter: async (patch) => {
          writes.push(patch);
          return settings;
        }
      });

      const runIds: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const result = await repair.enrich("cap_1");
        expect(result.ok).toBe(true);
        if (result.ok) runIds.push(result.value.runId);
        await waitForRunToEnd(runIds.at(-1));
      }

      expect(budget.status(settings)).toMatchObject({ limitedAttemptsLastHour: 0, mode: "slow" });
      expect(writes).toEqual([]);
      expect(runIds.map((id) => getAiRun(id)?.triggerSource)).toEqual(Array(4).fill("library-repair"));
      expect(electronMock.sentEvents.some((event) => event.channel === EVENT_CHANNELS.aiBudgetUpdated)).toBe(false);
    });

    test("a full bucket stays full while a re-run enqueues", async () => {
      const budget = new AiEnrichmentBudget({ capacity: 3 });
      const settings = enabledAi();
      const repair = registerCodexHandlers({
        clientFactory: () => new FakeCodexClient() as never,
        budget,
        settingsReader: async () => settings
      });

      const result = await repair.enrich("cap_1");
      expect(result.ok).toBe(true);
      expect(budget.status(settings).tokensAvailable).toBe(3);
      await waitForRunToEnd(result.ok ? result.value.runId : undefined);
    });

    test("a bus caller naming the library-repair trigger still spends a token", async () => {
      // The exemption is keyed on the in-process dispatcher, not on a
      // request field a renderer, HTTP or MCP caller could set.
      const budget = new AiEnrichmentBudget({ capacity: 0, disableThreshold: 10 });
      const settings = enabledAi();
      registerCodexHandlers({
        clientFactory: () => new FakeCodexClient() as never,
        budget,
        settingsReader: async () => settings
      });

      const result = await bus.dispatch(
        "codex:enrich",
        { captureId: "cap_1", triggerSource: "library-repair" },
        { principal: "ipc", cancellationKey: "cap_1" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("ai_budget_limited");
      expect(budget.status(settings).limitedAttemptsLastHour).toBe(1);
    });

    test("still refuse when the breaker has tripped, AI is off, or consent is missing", async () => {
      const cases: Array<[Partial<Settings["ai"]>, string]> = [
        [{ budgetSafetyDisabledAt: "2026-05-20T12:00:00.000Z" }, "ai_budget_safety_disabled"],
        [{ enabled: false }, "ai_disabled"],
        [{ consentAcceptedAt: null }, "ai_consent_required"]
      ];
      for (const [patch, code] of cases) {
        let clientCreated = false;
        const repair = registerCodexHandlers({
          clientFactory: () => {
            clientCreated = true;
            return new FakeCodexClient() as never;
          },
          budget: new AiEnrichmentBudget(),
          settingsReader: async () => enabledAi(patch)
        });
        const result = await repair.enrich("cap_1");
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe(code);
        expect(clientCreated).toBe(false);
        unregisterCodexHandlers();
      }
      expect(testDb.prepare("SELECT COUNT(*) AS n FROM ai_runs").get()).toEqual({ n: 0 });
    });

    test("deleting the capture aborts a re-run's turn, as it does a bus dispatch's", async () => {
      const client = new HangingCodexClient();
      const repair = registerCodexHandlers({
        clientFactory: () => client as never,
        budget: new AiEnrichmentBudget(),
        settingsReader: async () => enabledAi()
      });

      const started = await repair.enrich("cap_1");
      expect(started.ok).toBe(true);
      await waitFor(() => client.started);
      bus.cancel("cap_1");
      await waitFor(() => client.aborted);
      await waitForRunToEnd(started.ok ? started.value.runId : undefined);
      expect(started.ok && getAiRun(started.value.runId)?.status).toBe("cancelled");
    });

    test("pace one start per refill interval of the rate limit in force", async () => {
      let settings = enabledAi();
      const repair = registerCodexHandlers({ settingsReader: async () => settings });
      expect(await repair.dispatchIntervalMs()).toBe(6_000);
      settings = enabledAi({ enrichmentRateLimit: { burst: 5, perMinute: 30 } });
      expect(await repair.dispatchIntervalMs()).toBe(2_000);
    });
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
            enrichmentRateLimit: null,
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
    await waitFor(() => client.started);
    const path = client.imagePath!;
    expect(await sharp(await readFile(path)).metadata()).toMatchObject({ format: "webp" });

    const cancelled = await bus.dispatch(
      "codex:cancel",
      { runId: started.value.runId },
      { principal: "ipc" }
    );

    expect(cancelled.ok).toBe(true);
    await waitFor(() => getAiRun(started.value.runId)?.status === "cancelled");
    await waitFor(() => client.aborted);
    expect(client.aborted).toBe(true);
    await vi.waitFor(async () => { await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" }); });
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
            enrichmentRateLimit: null,
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
            enrichmentRateLimit: null,
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
      (broadcast!.payload as { enrichment?: { acceptedTitle?: string | null } | null })
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
  test("Codex: uses the surface model, then the managed default, ignoring captionModel", () => {
    const withSurface = testSettings({
      codex: { ...defaultSettings().codex, captionModel: "gpt-5.5" },
      ai: {
        ...defaultSettings().ai,
        defaults: { ...defaultSettings().ai.defaults, enrichment: { model: "gpt-5.4" } }
      }
    });
    expect(enrichmentSelectedModel(withSurface, undefined)).toBe("gpt-5.4");

    const managedFallback = testSettings({
      codex: { ...defaultSettings().codex, captionModel: "gpt-5.5" },
      ai: {
        ...defaultSettings().ai,
        defaults: { ...defaultSettings().ai.defaults, enrichment: {} }
      }
    });
    expect(enrichmentSelectedModel(managedFallback, undefined)).toBe("gpt-5.6-luna");
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

  test("disabled ACP enrichment provider falls back to the managed Codex model", () => {
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
    expect(enrichmentSelectedModel(disabledAcp, undefined)).toBe("gpt-5.6-luna");
  });
});

describe("withUsageModelLabels", () => {
  test("custom usage labels are scoped to the provider UUID, including in-flight and removed entries", () => {
    const modelId = "/fixture/models/weights.gguf";
    const models = ["one", "two"].map((id) => ({ id, connectionId: id, modelId, displayName: `Model ${id}`,
      capabilities: { vision: true, streaming: true }, maxOutputTokens: 4096 }));
    const detail = { run: { selectedModel: modelId }, model: modelId, modelProvider: "custom:two" } as unknown as import("@pwrsnap/shared").AiRunUsageDetail;
    const labeled = withUsageModelLabels(detail, () => "Wrong built-in label", models);
    expect(labeled.modelLabel).toBe("Model two");
    expect(labeled.selectedModelLabel).toBe("Model two");
    expect(labeled.model).toBe(modelId);
    expect(withUsageModelLabels({ ...detail, model: null }, () => undefined, models).selectedModelLabel).toBe("Model two");
    expect(withUsageModelLabels(detail, () => "Wrong built-in label", [models[0]!]).modelLabel).toBe("Custom model unavailable");
  });
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
