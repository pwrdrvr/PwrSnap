import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { expect, test, vi } from "vitest";
import { bus } from "../../command-bus";
import { registerCodexHandlers } from "../../handlers/codex-handlers";
import { getAiRun } from "../../persistence/ai-runs-repo";
import { getCaptureById } from "../../persistence/captures-repo";
import { getAiRunUsageDetail } from "../../persistence/ai-usage-repo";
import { closeDatabase, openDatabase } from "../../persistence/db";
import { defaultSettings } from "../../settings/desktop-settings-service";
import { AiEnrichmentBudget } from "../enrichment-budget";
import { CaptureEnrichmentClient, type CaptureEnrichmentResponse } from "../capture-enrichment-client";
import { closeCodexAgentPool } from "../codex-agent-pool";
import * as media from "../enrichment-image";
import { type Arm, type Fixture, balancedFixtures, initialFixtures, renderFixture } from "./still-sizing/fixtures";
import {
  BALANCED_DISPLAY_POINT_LIMITS, INITIAL_DISPLAY_POINT_LIMITS, displayPointEdge
} from "./still-sizing/policy";
import { readTransport, sha256 } from "./still-sizing/trace";

const electron = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => electron.root },
  BrowserWindow: { getAllWindows: () => [] }
}));

const MODEL = "gpt-6-luna";
const EFFORT = "medium";
const live = process.env.PWRSNAP_SIZING_LIVE === "1";

function armEdge(fixture: Fixture, arm: Arm): number | undefined {
  const stored = getCaptureById(fixture.id);
  if (!stored) throw new Error("Missing synthetic capture");
  const { width_px: width, height_px: height, device_pixel_ratio: dpr } = stored;
  switch (arm) {
    case "baseline": return undefined;
    case "points": return displayPointEdge(width, height, dpr, INITIAL_DISPLAY_POINT_LIMITS);
    case "balanced": return displayPointEdge(width, height, dpr, BALANCED_DISPLAY_POINT_LIMITS);
    case "near-points": return 1434; // Same patch grid, ~0.8% fewer pixels than 1440 × 933.
    case "large": return 1920;
    case "full": return Math.max(width, height);
  }
}

test.skipIf(!live)("Codex live still sizing measurement", async () => {
  const auth = process.env.PWRSNAP_SIZING_AUTH_FILE;
  const output = process.env.PWRSNAP_SIZING_RESULTS;
  const command = process.env.PWRSNAP_SIZING_CODEX ?? "codex";
  const batch = process.env.PWRSNAP_SIZING_BATCH ?? "initial";
  if (batch !== "initial" && batch !== "balanced") throw new Error("Expected initial or balanced batch");
  const fixtures: readonly Fixture[] = batch === "balanced" ? balancedFixtures : initialFixtures;
  const limits = batch === "balanced" ? BALANCED_DISPLAY_POINT_LIMITS : INITIAL_DISPLAY_POINT_LIMITS;
  if (!auth || !output || !isAbsolute(auth) || !isAbsolute(output)) {
    throw new Error("Set absolute PWRSNAP_SIZING_AUTH_FILE and PWRSNAP_SIZING_RESULTS paths");
  }
  const version = execFileSync(command, ["--version"], { encoding: "utf8" }).trim().split(" ")[1];
  if (version !== "0.169.0") throw new Error("This rollout-trace reader is calibrated for Codex 0.169.0");
  // Exclusive creation prevents accidentally mixing rows from different runs.
  await writeFile(output, "", { flag: "wx", mode: 0o600 });
  const root = await mkdtemp(join(tmpdir(), "pwrsnap-still-sizing-"));
  const codexHome = join(root, "codex-home");
  const traceRoot = join(root, "trace");
  const jail = join(root, "jail");
  electron.root = root;
  vi.stubEnv("PWRSNAP_DATA_ROOT", root);

  try {
    await mkdir(codexHome, { mode: 0o700 });
    await mkdir(traceRoot, { mode: 0o700 });
    await writeFile(join(codexHome, "auth.json"), await readFile(auth), { mode: 0o600 });
    await writeFile(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
    const db = await openDatabase();
    const insert = db.prepare(`INSERT INTO captures (
      id, kind, captured_at, legacy_src_path, width_px, height_px, device_pixel_ratio, byte_size, sha256
    ) VALUES (?, 'image', '2026-05-12T12:00:00.000Z', ?, ?, ?, ?, ?, ?)`);
    for (const fixture of fixtures) {
      const path = join(root, `${fixture.id}.png`);
      await renderFixture(fixture, path);
      const bytes = await readFile(path);
      const { width, height, dpr } = fixture.source;
      insert.run(fixture.id, path, width, height, dpr, bytes.length, sha256(bytes));
    }

    const settings = defaultSettings();
    settings.ai.enabled = true;
    settings.ai.consentAcceptedAt = "2026-05-12T12:00:00.000Z";
    settings.ai.defaults.enrichment = { provider: "codex", model: MODEL, reasoning: EFFORT };
    const client = new CaptureEnrichmentClient({
      command,
      codexVersion: version,
      captureMetadataWorkspaceDir: jail,
      env: { ...process.env, CODEX_HOME: codexHome, CODEX_ROLLOUT_TRACE_ROOT: traceRoot },
      turnTimeoutMs: 55_000
    });
    expect(client.stillImageFormat).toBe("webp");
    registerCodexHandlers({
      settingsReader: async () => settings,
      clientFactory: () => client,
      turnTimeoutMs: 60_000,
      budget: new AiEnrichmentBudget({ capacity: 24 })
    });

    const prepare = media.prepareEnrichmentImage;
    const enrich = client.enrichCapture.bind(client);
    const smoke = process.env.PWRSNAP_SIZING_SMOKE === "1";
    // Round two reverses each fixture's arms and the inner fixture order.
    const forward = [0, 1, 2, 3, 4].flatMap((index) => fixtures.flatMap((fixture) => {
      const arm: Arm | undefined = fixture.arms[index];
      return arm === undefined ? [] : [{ fixture, arm }];
    }));
    const schedule = smoke ? forward.slice(0, 1) : [...forward, ...forward.toReversed()];
    for (const [index, { fixture, arm }] of schedule.entries()) {
      let prepared: { path: string; hash: string; ms: number } | undefined;
      let caption: CaptureEnrichmentResponse | undefined;
      let modelMs = 0;
      const maxEdgePx = armEdge(fixture, arm);
      const prepSpy = vi.spyOn(media, "prepareEnrichmentImage").mockImplementation(async (path, options) => {
        const start = performance.now();
        const image = await prepare(path, {
          ...options,
          tempRoot: root,
          ...(maxEdgePx === undefined ? {} : { maxEdgePx, maxBytes: limits.maxBytes })
        });
        const ms = performance.now() - start;
        prepared = { path: image.path, hash: sha256(await readFile(image.path)), ms };
        return image;
      });
      const modelSpy = vi.spyOn(client, "enrichCapture").mockImplementation(async (request) => {
        const start = performance.now();
        caption = await enrich(request);
        modelMs = performance.now() - start;
        return caption;
      });

      try {
        const start = performance.now();
        const started = await bus.dispatch("codex:enrich", { captureId: fixture.id }, { principal: "ipc" });
        if (!started.ok) throw new Error(started.error.message);
        const { runId } = started.value;
        await vi.waitFor(() => {
          const run = getAiRun(runId);
          expect(run?.status).toMatch(/^(completed|failed|cancelled)$/);
        }, { timeout: 62_000, interval: 25 });
        const wallMs = performance.now() - start;
        const detail = getAiRunUsageDetail(runId);
        if (detail?.run.status !== "completed" || !caption || !prepared) {
          throw new Error(`${fixture.id}/${arm}: ${detail?.run.error ?? "Missing result"}`);
        }
        const derivative = detail.mediaInputs[0];
        if (!derivative) throw new Error("Missing prepared still measurements");
        expect([derivative.sourceWidthPx, derivative.sourceHeightPx]).toEqual([
          fixture.source.width, fixture.source.height
        ]);
        if (arm === "points" || arm === "balanced") {
          expect(derivative.sentWidthPx! * derivative.sentHeightPx!).toBeLessThanOrEqual(limits.maxPixels);
        }
        const transport = await readTransport(traceRoot, caption.threadId);
        expect(transport.model).toBe(MODEL);
        expect(transport.effort).toBe(EFFORT);
        expect(transport.width).toBeGreaterThan(0);
        expect(transport.height).toBeGreaterThan(0);
        const { title, description, ocrText, textAnchors } = caption.result;
        const row = {
          round: index < forward.length ? 1 : 2, fixture: fixture.id, arm, source: fixture.source,
          codex: version, model: caption.model, serviceTier: caption.serviceTier,
          prepared: {
            width: derivative.sentWidthPx, height: derivative.sentHeightPx,
            bytes: derivative.sentByteSize, mime: derivative.sentMimeType, sha256: prepared.hash
          },
          transport, tokens: caption.tokens, appCost: detail.cost,
          prepMs: prepared.ms, modelMs, wallMs, caption: { title, description, ocrText, textAnchors }
        };
        await appendFile(output, `${JSON.stringify(row)}\n`);
        const path = prepared.path;
        await vi.waitFor(async () => {
          await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
        });
        console.log(`Measured ${index + 1}/${schedule.length} ${fixture.id}/${arm} (${Math.round(wallMs)} ms)`);
      } finally {
        prepSpy.mockRestore();
        modelSpy.mockRestore();
      }
    }
  } finally {
    await closeCodexAgentPool();
    closeDatabase();
    vi.unstubAllEnvs();
    await rm(root, { force: true, recursive: true });
  }
}, 25 * 60_000);
