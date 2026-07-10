import { join } from "node:path";
import { BrowserWindow, app } from "electron";
import {
  AcceptAllDraftsRequestSchema,
  AcceptDescriptionRequestSchema,
  AcceptFilenameStemRequestSchema,
  AcceptTitleRequestSchema,
  AcceptTagRequestSchema,
  EVENT_CHANNELS,
  DEFAULT_CODEX_CAPTION_MODEL,
  RejectTagRequestSchema,
  err,
  ok
} from "@pwrsnap/shared";
import type {
  AiEnrichmentBudgetStatus,
  AiEnrichmentTriggerSource,
  AiRunSnapshot,
  AiRunUsageDetail,
  CaptureEnrichment,
  CaptureRecord,
  CodexModelOption,
  PwrSnapError,
  Result,
  Settings,
  SettingsPatch
} from "@pwrsnap/shared";
import {
  CaptureEnrichmentClient,
  type EnrichmentBackend
} from "../ai/capture-enrichment-client";
import { broadcastRendererEventToLocalWindows } from "../events";
import { relayRendererEventToPeer } from "../process-split/event-relay";
import { AcpCaptureEnrichmentClient } from "../ai/acp-enrichment-client";
import { acpDiscoveryOptionsForEnabledAgent } from "../ai/acp-enabled-discovery";
import { resolveActiveAcpInstance } from "../ai/acp-instance-resolver";
import { findAcpModelLabel } from "../ai/acp-model-cache";
import { findCodexModelLabel, saveCodexModelLabels } from "../ai/codex-model-cache";
import { listCodexModels, type CodexModelLister } from "../ai/codex-model-client";
import {
  discoverLocalAcpAgentInstances,
  strategyById,
  type AcpAgentStrategy
} from "@pwrdrvr/agent-acp";
import { codexEnvForProfile } from "../ai/agent-kit-bindings";
import { agentErrorMessage } from "../ai/agent-error-message";
import { estimateAiUsageCost } from "../ai/ai-usage-cost";
import { aiEnrichmentBudget, type AiEnrichmentBudget } from "../ai/enrichment-budget";
import {
  prepareEnrichmentImage,
  prepareEnrichmentVideoFrames,
  type PreparedEnrichmentImage,
  type PreparedEnrichmentVideoFrames
} from "../ai/enrichment-image";
import {
  isEnrichmentResultEmpty,
  type CaptureEnrichmentPromptMetadata
} from "../ai/enrichment-schema";
import { bus, type CommandContext } from "../command-bus";
import { getMainLogger } from "../log";
import {
  cancelAiRun,
  completeAiRun,
  createAiRun,
  failAiRun,
  getAiRun,
  markAiRunRunning
} from "../persistence/ai-runs-repo";
import {
  getAiRunUsageDetail,
  getAiUsageSummary,
  listAiRunUsageRowsMissingPrice,
  listAiUsageRuns,
  replaceAiRunMediaInputs,
  saveAiRunUsage,
  updateAiRunUsageCost,
  type SaveAiRunMediaInput
} from "../persistence/ai-usage-repo";
import { getCaptureById } from "../persistence/captures-repo";
import { ensureEffectiveSrcPath } from "../persistence/source-store";
import {
  acceptAllDrafts,
  acceptDescription,
  acceptFilenameStem,
  acceptTitle,
  acceptSuggestedTag,
  getCaptureEnrichment,
  getEnrichmentSummaries,
  getTopUserTags,
  rejectSuggestedTag,
  setLatestEnrichmentRun,
  storeCompletedEnrichment
} from "../persistence/enrichment-repo";
import { renameBundleToEffectiveFilename } from "../persistence/bundle-filename-maintenance";
import { renameVideoSourceToEffectiveFilename } from "../persistence/video-filename-maintenance";

const log = getMainLogger("pwrsnap:codex-handlers");

export type CodexClientFactory = (
  command: string,
  env?: NodeJS.ProcessEnv
) => CaptureEnrichmentClient;
export type SettingsReader = () => Promise<Settings>;
export type SettingsWriter = (patch: SettingsPatch) => Promise<Settings>;

const activeRuns = new Map<string, AbortController>();

/**
 * Default ceiling for a single enrichment turn (the agent call itself,
 * not image prep). A turn that exceeds this is aborted and the run is
 * failed, so a stalled agent subprocess can't wedge the snap on
 * "… is reading the snap" until the next relaunch (the boot-time
 * `failOrphanedRunsOnBoot` sweep is the only other safety net).
 *
 * Deliberately generous: a genuine hang never returns, so even a long
 * ceiling catches it, while a too-short ceiling would kill legitimately
 * slow turns — ACP "thinking" models (Kimi with thinking on) can take
 * minutes. Biased toward "only fires on a true stall" to avoid
 * false-positive failures on slow-but-fine reads.
 */
export const ENRICHMENT_TURN_TIMEOUT_MS = 240_000;

/** Thrown by `withTurnTimeout` when an enrichment turn outruns its
 *  deadline. Distinct from an `AbortError` (user/context cancel) so the
 *  run handler routes a timeout to `failAiRun` ("could not read … →
 *  Regenerate"), not the silent `cancelAiRun` path. */
class EnrichmentTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`enrichment turn exceeded ${Math.round(timeoutMs / 1000)}s`);
    this.name = "EnrichmentTimeoutError";
  }
}

/**
 * Race `promise` against a deadline. If the deadline wins, `onTimeout`
 * fires (best-effort: abort the turn so the agent/subprocess is told to
 * stop) and the returned promise rejects with `EnrichmentTimeoutError`.
 *
 * The deadline is enforced HERE rather than relying on the backend to
 * honor the abort: a stalled ACP agent may never reject on abort, so a
 * race is the only thing guaranteed to unblock `runCaptureEnrichment`.
 * A non-positive / non-finite `timeoutMs` disables the timeout (returns
 * the promise unchanged). The `.then(…, …)` rejection handler also
 * absorbs the loser's late rejection (post-abort), so no
 * unhandledRejection escapes.
 */
function withTurnTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new EnrichmentTimeoutError(timeoutMs));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      }
    );
  });
}

function captureMetadataWorkspaceDir(): string {
  return join(app.getPath("documents"), "PwrSnap", "Chats", ".capture-metadata");
}

function broadcastAiRunUpdated(payload: {
  run: AiRunSnapshot | null;
  enrichment: CaptureEnrichment | null;
}): void {
  // Local windows + the peer process (split mode): enrichment runs in
  // the agent, but the Library's DetailRail subscribes to this channel
  // for the live "running → done, here's the text" transition — a run
  // the library didn't start must still land in its focused view.
  broadcastRendererEventToLocalWindows(EVENT_CHANNELS.aiRunUpdated, payload);
  relayRendererEventToPeer(EVENT_CHANNELS.aiRunUpdated, payload);
}

function preparedMediaShape(
  prepared: PreparedEnrichmentImage | PreparedEnrichmentVideoFrames | null
): Record<string, unknown> | null {
  if (prepared === null) return null;
  if ("frames" in prepared) {
    return {
      imageCount: prepared.frames.length,
      maxEdgePx: Math.max(0, ...prepared.frames.map((frame) => Math.max(frame.width, frame.height))),
      byteSizes: prepared.frames.map((frame) => frame.byteSize),
      videoFrameSamplePositions: prepared.frames.map((frame) => ({
        positionPct: frame.positionPct,
        timestampSec: frame.timestampSec
      }))
    };
  }
  return {
    imageCount: 1,
    maxEdgePx: Math.max(prepared.width, prepared.height),
    byteSizes: [prepared.byteSize],
    videoFrameSamplePositions: []
  };
}

function preparedMediaInputs(
  prepared: PreparedEnrichmentImage | PreparedEnrichmentVideoFrames
): SaveAiRunMediaInput[] {
  if ("frames" in prepared) {
    return prepared.frames.map((frame, index) => ({
      ...preparedImageAccountingBase(frame, index),
      role: "video-frame",
      transform: "video-frame",
      videoPositionPct: frame.positionPct,
      videoTimestampSec: frame.timestampSec
    }));
  }
  return [
    {
      ...preparedImageAccountingBase(prepared, 0),
      role: "capture",
      transform: "prepared-jpeg"
    }
  ];
}

function preparedImageAccountingBase(
  image: PreparedEnrichmentImage,
  ordinal: number
): Omit<SaveAiRunMediaInput, "role" | "transform"> {
  return {
    ordinal,
    sourceMimeType: image.sourceMimeType,
    sentMimeType: image.sentMimeType,
    format: image.format,
    encoder: image.encoder,
    quality: image.quality,
    sourceWidthPx: image.sourceWidth,
    sourceHeightPx: image.sourceHeight,
    sentWidthPx: image.width,
    sentHeightPx: image.height,
    sentByteSize: image.byteSize,
    maxEdgePx: image.maxEdgePx,
    maxBytes: image.maxBytes,
    scaleRatio: image.scaleRatio
  };
}

function broadcastAiBudgetUpdated(payload: AiEnrichmentBudgetStatus): void {
  // Same cross-process shape as aiRunUpdated — Settings → AI (a
  // library-process window) shows the live budget meter.
  broadcastRendererEventToLocalWindows(EVENT_CHANNELS.aiBudgetUpdated, payload);
  relayRendererEventToPeer(EVENT_CHANNELS.aiBudgetUpdated, payload);
}

function validationError(code: string, message: string): Result<never, PwrSnapError> {
  return err({ kind: "validation", code, message });
}

function isUsageSummaryWindow(value: unknown): value is "24h" | "7d" | "30d" {
  return value === "24h" || value === "7d" || value === "30d";
}

function parseUsageRunsPage(req: {
  limit?: number;
  offset?: number;
}): Result<{ limit: number; offset: number }, PwrSnapError> {
  const limit = req.limit ?? 25;
  const offset = req.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return validationError("invalid_request", "usage run limit must be an integer from 1 to 100");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return validationError("invalid_request", "usage run offset must be a non-negative integer");
  }
  return ok({ limit, offset });
}

function parseCodexModelsRequest(req: {
  includeHidden?: boolean;
}): Result<{ includeHidden: boolean }, PwrSnapError> {
  const includeHidden = req.includeHidden ?? false;
  if (typeof includeHidden !== "boolean") {
    return validationError("invalid_request", "includeHidden must be a boolean");
  }
  return ok({ includeHidden });
}

function refreshKnownAiUsagePrices(): void {
  for (const row of listAiRunUsageRowsMissingPrice()) {
    const cost = estimateAiUsageCost({
      model: row.model,
      provider: row.modelProvider,
      serviceTier: row.serviceTier,
      tokens: row.tokens
    });
    if (cost.status === "available") {
      updateAiRunUsageCost(row.aiRunId, cost);
    }
  }
}

async function defaultSettingsReader(): Promise<Settings> {
  const result = await bus.dispatch("settings:read", {}, { principal: "ipc" });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

async function defaultSettingsWriter(patch: SettingsPatch): Promise<Settings> {
  const result = await bus.dispatch("settings:write", patch, { principal: "ipc" });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function codexCommandForSettings(settings: Settings): string {
  return settings.codex.mode === "pinned" && settings.codex.pinnedPath !== ""
    ? settings.codex.pinnedPath
    : "codex";
}

/** Resolve the enrichment model from the per-surface AI default,
 *  falling back to the legacy `codex.captionModel` and then the
 *  hardcoded default. `parseV1` seeds `ai.defaults.enrichment.model`
 *  from `codex.captionModel` for upgraded settings, so existing
 *  behavior is preserved; a fresh install (empty enrichment.model)
 *  falls through to captionModel here. */
function enrichmentModelForSettings(settings: Settings): string {
  const surfaceModel = settings.ai.defaults.enrichment.model;
  if (surfaceModel !== undefined && surfaceModel.length > 0) return surfaceModel;
  return settings.codex.captionModel || DEFAULT_CODEX_CAPTION_MODEL;
}

/** Enrich a usage detail with friendly model labels for the UI. `lookupLabel`
 *  maps a model id → display label (the ACP model caches; `undefined` for Codex
 *  / unprobed agents). Resolves BOTH the effective `model` and the requested
 *  `run.selectedModel`: the effective label drives the strip's headline name,
 *  and the requested label is shown while a run is in flight (effective unknown)
 *  AND in the "you picked X — agent ran Y" override note. selectedModelLabel
 *  falls back to the raw id so a Codex model (no ACP label) still shows. Pure +
 *  dependency-injected for testing. Exported for testing. */
export function withUsageModelLabels(
  detail: AiRunUsageDetail,
  lookupLabel: (modelId: string) => string | undefined
): AiRunUsageDetail {
  const selected = detail.run.selectedModel;
  return {
    ...detail,
    modelLabel:
      typeof detail.model === "string" && detail.model.length > 0
        ? lookupLabel(detail.model) ?? null
        : null,
    selectedModelLabel:
      typeof selected === "string" && selected.length > 0 ? lookupLabel(selected) ?? selected : null
  };
}

/** Backend-aware enrichment model selection. For an ACP agent, use the
 *  per-surface model id verbatim ("" → the agent's own default) — the Codex
 *  caption-model fallback is meaningless there and a Codex id would be wrong.
 *  For Codex, keep the legacy fallback chain. Exported for testing. */
export function enrichmentSelectedModel(settings: Settings, acpAgentId: string | undefined): string {
  if (acpAgentId !== undefined) return settings.ai.defaults.enrichment.model ?? "";
  if (settings.ai.defaults.enrichment.provider?.startsWith("acp:") === true) {
    return settings.codex.captionModel || DEFAULT_CODEX_CAPTION_MODEL;
  }
  return enrichmentModelForSettings(settings);
}

/** Resolve the enrichment reasoning effort from the per-surface AI
 *  default. Enrichment is high-volume + cost-sensitive, so the
 *  historical default is "low" — preserved when the user hasn't pinned
 *  a reasoning value. */
function enrichmentEffortForSettings(settings: Settings): string {
  return settings.ai.defaults.enrichment.reasoning ?? "low";
}

/** The ACP agent id to run enrichment on, when `ai.defaults.enrichment.provider`
 *  selects one ("acp:<id>"); undefined → Codex (the default backend). */
function enrichmentAcpAgentId(settings: Settings): string | undefined {
  const provider = settings.ai.defaults.enrichment.provider;
  if (provider === undefined || !provider.startsWith("acp:")) return undefined;
  const agentId = provider.slice("acp:".length);
  return settings.ai.acp.enabledAgentIds.includes(agentId) ? agentId : undefined;
}

/** Discover the selected ACP agent + build an enrichment client bound to its
 *  active install (honoring the user's per-agent override / pick from
 *  `ai.acp.agents`). Returns null when the agent isn't installed. */
async function buildAcpEnrichmentClient(
  agentId: string,
  settings: Settings,
  cwd: string
): Promise<AcpCaptureEnrichmentClient | null> {
  const pref = settings.ai.acp.agents?.[agentId];
  const discoveryOptions = acpDiscoveryOptionsForEnabledAgent(settings, agentId);
  if (discoveryOptions === null) return null;
  const groups = await discoverLocalAcpAgentInstances(discoveryOptions);
  const group = groups.find((g) => g.strategyId === agentId);
  if (group === undefined || group.instances.length === 0) return null;
  const strategy = strategyById(agentId);
  if (strategy === undefined) return null;
  const active = resolveActiveAcpInstance(group.instances, pref);
  return new AcpCaptureEnrichmentClient({
    command: active.command,
    args: group.args,
    env: group.env,
    // Enrichment is a one-shot structured-JSON job — we want the agent's ANSWER,
    // not its chain-of-thought. With surfaceThoughts:true (Grok/Kimi/Gemini) the
    // normalizer folds thought chunks into the final agent_message, so the
    // model's reasoning ("The task is to analyze…") lands in rawText and buries
    // or corrupts the JSON (Grok especially rambles + echoes the schema). Force
    // thoughts off for enrichment so rawText is just the reply.
    strategy: withThoughtsSuppressed(strategy),
    cwd
  });
}

/** Clone a strategy with `surfaceThoughts` forced off — used for one-shot
 *  enrichment so the agent's reasoning isn't folded into the parsed reply.
 *  Exported for testing. */
export function withThoughtsSuppressed(strategy: AcpAgentStrategy): AcpAgentStrategy {
  return { ...strategy, quirks: { ...strategy.quirks, surfaceThoughts: false } };
}

function triggerSourceOrDefault(
  value: AiEnrichmentTriggerSource | undefined,
  fallback: AiEnrichmentTriggerSource
): AiEnrichmentTriggerSource {
  return value ?? fallback;
}

function mapError(error: unknown): Result<never, PwrSnapError> {
  return err({
    kind: "unknown",
    code: "codex_enrichment_failed",
    message: error instanceof Error ? error.message : String(error),
    cause: error
  });
}

async function tryRenameCaptureAssetToEffectiveFilename(captureId: string): Promise<void> {
  try {
    await renameBundleToEffectiveFilename(captureId);
  } catch (error) {
    log.warn("bundle filename rename skipped after enrichment update", {
      captureId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
  try {
    await renameVideoSourceToEffectiveFilename(captureId);
  } catch (error) {
    log.warn("video filename rename skipped after enrichment update", {
      captureId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export function maybeEnqueueCaptureEnrichment(captureId: string): void {
  void defaultSettingsReader()
    .then((settings) => {
      if (!settings.ai.enabled || settings.ai.consentAcceptedAt === null) {
        return null;
      }
      return bus.dispatch(
        "codex:enrich",
        { captureId, triggerSource: "auto-enrichment" },
        { principal: "ipc", cancellationKey: captureId }
      );
    })
    .then((result) => {
      if (result === null) return;
      if (!result.ok) {
        log.warn("auto enrichment skipped", {
          captureId,
          code: result.error.code,
          message: result.error.message
        });
      }
    })
    .catch((error: unknown) => {
      log.warn("auto enrichment settings read failed", {
        captureId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
}

export function registerCodexHandlers(params?: {
  clientFactory?: CodexClientFactory;
  modelLister?: CodexModelLister;
  settingsReader?: SettingsReader;
  settingsWriter?: SettingsWriter;
  budget?: AiEnrichmentBudget;
  /** Override the per-turn enrichment timeout (ms). Defaults to
   *  `ENRICHMENT_TURN_TIMEOUT_MS`; tests pass a tiny value. */
  turnTimeoutMs?: number;
}): void {
  const modelListInFlight = new Map<string, Promise<CodexModelOption[]>>();
  const clientFactory =
    params?.clientFactory ??
    ((command, env) => {
      return new CaptureEnrichmentClient({
        command,
        ...(env !== undefined ? { env } : {}),
        captureMetadataWorkspaceDir: captureMetadataWorkspaceDir()
      });
    });
  const modelLister = params?.modelLister ?? listCodexModels;
  const closeClientAfterRun = params?.clientFactory !== undefined;
  const settingsReader = params?.settingsReader ?? defaultSettingsReader;
  const settingsWriter = params?.settingsWriter ?? defaultSettingsWriter;
  const budget = params?.budget ?? aiEnrichmentBudget;
  const turnTimeoutMs = params?.turnTimeoutMs ?? ENRICHMENT_TURN_TIMEOUT_MS;

  bus.register("codex:enrich", async (req, ctx) => {
    const triggerSource = triggerSourceOrDefault(req.triggerSource, "unknown");
    let settings: Settings;
    try {
      settings = await settingsReader();
    } catch (error) {
      return err({
        kind: "settings",
        code: "read_failed",
        message: error instanceof Error ? error.message : String(error),
        cause: error
      });
    }
    if (settings.ai.budgetSafetyDisabledAt !== null) {
      const status = budget.status(settings);
      broadcastAiBudgetUpdated(status);
      return validationError(
        "ai_budget_safety_disabled",
        "AI enrichment was disabled after repeated budget exhaustion"
      );
    }
    if (!settings.ai.enabled) {
      return validationError("ai_disabled", "AI enrichment is disabled");
    }
    if (settings.ai.consentAcceptedAt === null) {
      return validationError("ai_consent_required", "AI enrichment consent is required");
    }

    const capture = getCaptureById(req.captureId);
    if (capture === null || capture.deleted_at !== null) {
      return validationError("not_found", `capture not found: ${req.captureId}`);
    }

    const codexCommand = codexCommandForSettings(settings);
    const budgetDecision = budget.consume(settings);
    broadcastAiBudgetUpdated(budgetDecision.after);
    if (!budgetDecision.allowed) {
      log.warn("capture enrichment budget limited", {
        captureId: capture.id,
        captureKind: capture.kind,
        sourceAppName: capture.source_app_name,
        sourceAppBundleId: capture.source_app_bundle_id,
        triggerSource,
        codexCommand,
        reason: budgetDecision.reason,
        bucketBefore: budgetDecision.before,
        bucketAfter: budgetDecision.after
      });
      if (budgetDecision.shouldDisableAi) {
        const disabledAt = new Date().toISOString();
        void settingsWriter({
          ai: {
            enabled: false,
            budgetSafetyDisabledAt: disabledAt
          }
        })
          .then((nextSettings) => {
            const status = budget.status(nextSettings);
            broadcastAiBudgetUpdated(status);
            log.warn("AI enrichment disabled by budget circuit breaker", {
              captureId: capture.id,
              triggerSource,
              disabledAt,
              limitedAttemptsLastHour: status.limitedAttemptsLastHour,
              disableThreshold: status.disableThreshold
            });
          })
          .catch((error: unknown) => {
            log.warn("AI enrichment budget auto-disable failed", {
              captureId: capture.id,
              triggerSource,
              message: error instanceof Error ? error.message : String(error)
            });
          });
      }
      return validationError(
        budgetDecision.shouldDisableAi ? "ai_budget_safety_disabled" : "ai_budget_limited",
        budgetDecision.shouldDisableAi
          ? "AI enrichment was disabled after repeated budget exhaustion"
          : "AI enrichment is in budget-limited slow mode"
      );
    }
    log.info("capture enrichment budget consumed", {
      captureId: capture.id,
      captureKind: capture.kind,
      sourceAppName: capture.source_app_name,
      sourceAppBundleId: capture.source_app_bundle_id,
      triggerSource,
      bucketBefore: budgetDecision.before,
      bucketAfter: budgetDecision.after
    });
    // `ai.defaults.enrichment.provider` is a BACKEND selector ("" / codex →
    // Codex; "acp:<id>" → an ACP agent). The selected model is resolved against
    // that backend so an ACP run carries its OWN model id (or "" → agent
    // default), not a Codex fallback. Computed here so the run record reports
    // the model that will actually run.
    const enrichmentAgent = enrichmentAcpAgentId(settings);
    const run = createAiRun({
      captureId: capture.id,
      codexCommand,
      triggerSource,
      selectedModel: enrichmentSelectedModel(settings, enrichmentAgent),
      request: {
        media: {
          maxLongEdgePx: 1024,
          format: "jpeg",
          samples:
            capture.kind === "video" && capture.video !== null && capture.video !== undefined
              ? [15, 50, 85]
              : undefined
        }
      }
    });
    const enrichment = setLatestEnrichmentRun(capture.id, run.id);
    broadcastAiRunUpdated({ run, enrichment });
    // Snapshot the caption-model setting at enqueue time. The user can
    // flip the picker mid-run, but the model passed to `thread/start`
    // must match what the run record reports — re-reading it inside
    // `runCaptureEnrichment` would mean a Settings flip during a run
    // silently swaps providers and skews run-level metrics.
    const captionModel = settings.codex.captionModel;
    // Source-path resolution (re-extracting source.png from the
    // bundle when Storage → Clear/Trim wiped the per-capture cache)
    // happens INSIDE runCaptureEnrichment so the extraction cost
    // doesn't block the bus dispatch and any extraction failure
    // flows through the same failAiRun + broadcast path as every
    // other enrichment error — no zombie "run started" state.
    void runCaptureEnrichment({
      runId: run.id,
      capture,
      metadata: {
        sourceAppName: capture.source_app_name,
        sourceAppBundleId: capture.source_app_bundle_id,
        captureKind: capture.kind,
        widthPx: capture.width_px,
        heightPx: capture.height_px,
        capturedAt: capture.captured_at,
        // Bias Codex toward tags the user already curates. 20 is enough
        // to cover common cases (workflow, content-type, screen-type
        // facets) without bloating the system prompt for every snap.
        existingUserTags: getTopUserTags(20),
        videoDurationSec: capture.kind === "video" ? capture.video?.durationSec ?? null : null
      },
      command: codexCommand,
      env: codexEnvForProfile(settings.codex.profile),
      settingsReader,
      // Don't apply the Codex caption-model default to an ACP run — "" means
      // "use the agent's own default" and is resolved to null at send time.
      selectedModel:
        run.selectedModel ?? (enrichmentAgent !== undefined ? "" : DEFAULT_CODEX_CAPTION_MODEL),
      effort: enrichmentEffortForSettings(settings),
      // When enrichment is routed to an ACP agent (Gemini/Qwen), pass its id +
      // the settings snapshot so the run resolves + spawns that agent instead
      // of Codex. Undefined → the Codex one-shot path.
      ...(enrichmentAgent !== undefined
        ? { acpAgentId: enrichmentAgent, acpSettings: settings }
        : {}),
      triggerSource,
      budgetBefore: budgetDecision.before,
      budgetAfter: budgetDecision.after,
      ctx,
      clientFactory,
      closeClientAfterRun,
      turnTimeoutMs
    });
    return ok({ runId: run.id });
  });

  bus.register("codex:enrichment", async (req) => {
    return ok(getCaptureEnrichment(req.captureId));
  });

  bus.register("codex:enrichmentsForCaptures", async (req) => {
    return ok(getEnrichmentSummaries(req.captureIds));
  });

  bus.register("codex:acceptTitle", async (req) => {
    const parsed = AcceptTitleRequestSchema.safeParse(req);
    if (!parsed.success) {
      return validationError("invalid_request", parsed.error.message);
    }
    try {
      const enrichment = acceptTitle(parsed.data.captureId, parsed.data.title);
      broadcastAiRunUpdated({ run: null, enrichment });
      return ok(enrichment);
    } catch (error) {
      return mapError(error);
    }
  });

  bus.register("codex:acceptDescription", async (req) => {
    const parsed = AcceptDescriptionRequestSchema.safeParse(req);
    if (!parsed.success) {
      return validationError("invalid_request", parsed.error.message);
    }
    try {
      const enrichment = acceptDescription(parsed.data.captureId, parsed.data.description);
      broadcastAiRunUpdated({ run: null, enrichment });
      return ok(enrichment);
    } catch (error) {
      return mapError(error);
    }
  });

  bus.register("codex:acceptFilenameStem", async (req) => {
    const parsed = AcceptFilenameStemRequestSchema.safeParse(req);
    if (!parsed.success) {
      return validationError("invalid_request", parsed.error.message);
    }
    try {
      const enrichment = acceptFilenameStem(parsed.data.captureId, parsed.data.filenameStem);
      await tryRenameCaptureAssetToEffectiveFilename(parsed.data.captureId);
      broadcastAiRunUpdated({ run: null, enrichment });
      return ok(enrichment);
    } catch (error) {
      return mapError(error);
    }
  });

  bus.register("codex:acceptAllDrafts", async (req) => {
    const parsed = AcceptAllDraftsRequestSchema.safeParse(req);
    if (!parsed.success) {
      return validationError("invalid_request", parsed.error.message);
    }
    try {
      // Spread `parsed.data` so undefined fields stay undefined rather
      // than being explicitly enumerated — keeps the repo signature
      // clean.
      const enrichment = acceptAllDrafts(parsed.data);
      if (parsed.data.filenameStem !== undefined) {
        await tryRenameCaptureAssetToEffectiveFilename(parsed.data.captureId);
      }
      broadcastAiRunUpdated({ run: null, enrichment });
      return ok(enrichment);
    } catch (error) {
      return mapError(error);
    }
  });

  bus.register("codex:acceptTag", async (req) => {
    const parsed = AcceptTagRequestSchema.safeParse(req);
    if (!parsed.success) {
      return validationError("invalid_request", parsed.error.message);
    }
    try {
      const enrichment = acceptSuggestedTag(parsed.data.captureId, parsed.data.tagId);
      broadcastAiRunUpdated({ run: null, enrichment });
      return ok(enrichment);
    } catch (error) {
      return mapError(error);
    }
  });

  bus.register("codex:rejectTag", async (req) => {
    const parsed = RejectTagRequestSchema.safeParse(req);
    if (!parsed.success) {
      return validationError("invalid_request", parsed.error.message);
    }
    try {
      const enrichment = rejectSuggestedTag(parsed.data.captureId, parsed.data.tagId);
      broadcastAiRunUpdated({ run: null, enrichment });
      return ok(enrichment);
    } catch (error) {
      return mapError(error);
    }
  });

  bus.register("codex:runStatus", async (req) => {
    return ok(getAiRun(req.runId));
  });

  bus.register("codex:budgetStatus", async () => {
    let settings: Settings;
    try {
      settings = await settingsReader();
    } catch (error) {
      return err({
        kind: "settings",
        code: "read_failed",
        message: error instanceof Error ? error.message : String(error),
        cause: error
      });
    }
    return ok(budget.status(settings));
  });

  bus.register("codex:models", async (req) => {
    const startedAt = performance.now();
    const parsed = parseCodexModelsRequest(req);
    if (!parsed.ok) return parsed;
    const includeHidden = parsed.value.includeHidden;
    log.info("codex:models request received", { includeHidden });
    let settings: Settings;
    try {
      settings = await settingsReader();
    } catch (error) {
      log.warn("codex:models settings read failed", {
        includeHidden,
        durationMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : String(error)
      });
      return err({
        kind: "settings",
        code: "read_failed",
        message: error instanceof Error ? error.message : String(error),
        cause: error
      });
    }
    const command = codexCommandForSettings(settings);
    const env = codexEnvForProfile(settings.codex.profile);
    const codexHome = env["CODEX_HOME"] ?? null;
    const profile = settings.codex.profile.length > 0 ? settings.codex.profile : "(default)";
    log.info("codex:models listing", {
      command,
      codexHome,
      profile,
      selectedModel: settings.codex.captionModel,
      includeHidden
    });
    try {
      const inFlightKey = JSON.stringify([command, codexHome ?? "", includeHidden]);
      let listing = modelListInFlight.get(inFlightKey);
      if (listing === undefined) {
        listing = modelLister({ command, env, includeHidden });
        modelListInFlight.set(inFlightKey, listing);
      } else {
        log.info("codex:models joined in-flight listing", {
          command,
          codexHome,
          profile,
          selectedModel: settings.codex.captionModel,
          includeHidden
        });
      }
      let models: CodexModelOption[];
      try {
        models = await listing;
      } finally {
        if (modelListInFlight.get(inFlightKey) === listing) {
          modelListInFlight.delete(inFlightKey);
        }
      }
      // Persist id → displayName so the usage strip can show a Codex run's
      // friendly model name (the run record only stores the id).
      saveCodexModelLabels(models);
      const modelIds = models.map((model) => model.id);
      const imageCapableModelIds = models
        .filter(
          (model) =>
            model.inputModalities.includes("text") && model.inputModalities.includes("image")
        )
        .map((model) => model.id);
      const logPayload = {
        command,
        codexHome,
        profile,
        selectedModel: settings.codex.captionModel,
        includeHidden,
        count: models.length,
        imageCapableCount: imageCapableModelIds.length,
        modelIds,
        imageCapableModelIds,
        durationMs: Math.round(performance.now() - startedAt)
      };
      if (models.length === 0) {
        log.warn("codex:models returned no models", logPayload);
      } else {
        log.info("codex:models listed models", logPayload);
      }
      return ok({ models, selectedModel: settings.codex.captionModel });
    } catch (error) {
      log.warn("codex:models failed", {
        command,
        codexHome,
        profile,
        selectedModel: settings.codex.captionModel,
        includeHidden,
        durationMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : String(error)
      });
      return err({
        kind: "unknown",
        code: "codex_models_failed",
        message: error instanceof Error ? error.message : String(error),
        cause: error
      });
    }
  });

  bus.register("codex:usageSummary", async (req) => {
    if (!isUsageSummaryWindow(req.window)) {
      return validationError("invalid_request", "usage summary window must be 24h, 7d, or 30d");
    }
    refreshKnownAiUsagePrices();
    return ok(getAiUsageSummary(req.window));
  });

  bus.register("codex:usageRuns", async (req) => {
    const parsed = parseUsageRunsPage(req);
    if (!parsed.ok) return parsed;
    refreshKnownAiUsagePrices();
    return ok(listAiUsageRuns(parsed.value));
  });

  bus.register("codex:usageRunDetail", async (req) => {
    if (typeof req.runId !== "string" || req.runId.trim() === "") {
      return validationError("invalid_request", "runId is required");
    }
    refreshKnownAiUsagePrices();
    const detail = getAiRunUsageDetail(req.runId);
    if (detail === null) return ok(null);
    // Resolve labels from the ACP caches first, then the Codex cache (ids are
    // distinct across the two, so order is just preference).
    return ok(
      withUsageModelLabels(detail, (id) => findAcpModelLabel(id) ?? findCodexModelLabel(id))
    );
  });

  bus.register("codex:cancel", async (req) => {
    activeRuns.get(req.runId)?.abort();
    activeRuns.delete(req.runId);
    const run = cancelAiRun(req.runId);
    const enrichment = run?.captureId ? getCaptureEnrichment(run.captureId) : null;
    broadcastAiRunUpdated({ run, enrichment });
    return ok(undefined);
  });

  const enrichAliases = {
    "codex:annotate": "annotate",
    "codex:describe": "describe",
    "codex:tag": "tag",
    "codex:filename": "filename",
    "codex:sensitiveScan": "sensitive-scan"
  } as const;
  for (const [name, fallbackTriggerSource] of Object.entries(enrichAliases) as Array<
    [keyof typeof enrichAliases, (typeof enrichAliases)[keyof typeof enrichAliases]]
  >) {
    bus.register(name, async (req, ctx) => {
      return bus.dispatch(
        "codex:enrich",
        {
          captureId: req.captureId,
          triggerSource: triggerSourceOrDefault(req.triggerSource, fallbackTriggerSource)
        },
        {
          principal: ctx.principal,
          cancellationKey: req.captureId
        }
      );
    });
  }

  bus.register("codex:ask", async () => {
    return validationError("not_implemented", "codex:ask lands after capture enrichment");
  });
}

async function runCaptureEnrichment(params: {
  runId: string;
  capture: CaptureRecord;
  metadata: CaptureEnrichmentPromptMetadata;
  command: string;
  /** Process env for the spawned Codex (CODEX_HOME for the selected profile). */
  env?: NodeJS.ProcessEnv;
  /**
   * Re-read just before the result is persisted so a `auto-accept`
   * toggle the user flipped DURING the run is honored — not the
   * value captured at enqueue. Reading at completion matches what
   * the float-over checkbox visibly promises.
   */
  settingsReader: SettingsReader;
  selectedModel: string;
  /** Model provider from `ai.defaults.enrichment.provider`; undefined = Codex default. */
  selectedProvider?: string;
  /** When set, enrichment runs on this ACP agent (Gemini/Qwen) instead of
   *  Codex. `acpSettings` carries the snapshot used to resolve the agent's
   *  active install (override / pick). */
  acpAgentId?: string;
  acpSettings?: Settings;
  /** Reasoning effort for the enrichment turn. Resolved from
   *  `ai.defaults.enrichment.reasoning` (default "low"). */
  effort: string;
  triggerSource: AiEnrichmentTriggerSource;
  budgetBefore: AiEnrichmentBudgetStatus;
  budgetAfter: AiEnrichmentBudgetStatus;
  ctx: CommandContext;
  clientFactory: CodexClientFactory;
  closeClientAfterRun: boolean;
  /** Per-turn deadline (ms). The agent call is aborted + the run failed
   *  if it outruns this, so a stalled agent can't wedge the run in
   *  `running` until relaunch. */
  turnTimeoutMs: number;
}): Promise<void> {
  const captureId = params.capture.id;
  // The backend actually running this enrichment, for the logs (enrichment is
  // no longer always Codex).
  const provider = params.acpAgentId !== undefined ? `acp:${params.acpAgentId}` : "codex";
  const startedAt = performance.now();
  const abortController = new AbortController();
  const abortFromContext = (): void => abortController.abort();
  params.ctx.signal.addEventListener("abort", abortFromContext, { once: true });
  activeRuns.set(params.runId, abortController);

  let prepared: PreparedEnrichmentImage | PreparedEnrichmentVideoFrames | null = null;
  let client: EnrichmentBackend | null = null;

  try {
    const running = markAiRunRunning(params.runId);
    broadcastAiRunUpdated({
      run: running,
      enrichment: getCaptureEnrichment(captureId)
    });

    // Resolve the on-disk source path now, inside the try block —
    // bundle-backed captures lazy-re-extract source.png when the
    // per-capture cache file has been wiped (Storage → Clear/Trim).
    // A failure here flows through the catch below as a failed run
    // with a clear message, not as an unhandled rejection that
    // leaves the broadcast in a "started" zombie state.
    const sourcePath = await ensureEffectiveSrcPath(params.capture);

    const metadata: CaptureEnrichmentPromptMetadata = { ...params.metadata };
    let imagePaths: string[];
    if (metadata.captureKind === "video") {
      if (
        typeof metadata.videoDurationSec !== "number" ||
        !Number.isFinite(metadata.videoDurationSec) ||
        metadata.videoDurationSec < 0
      ) {
        throw new Error("video capture enrichment requires duration metadata");
      }
      prepared = await prepareEnrichmentVideoFrames(sourcePath, {
        durationSec: metadata.videoDurationSec,
        sourceWidthPx: metadata.widthPx,
        sourceHeightPx: metadata.heightPx,
        abortSignal: abortController.signal
      });
      metadata.videoFrameSamples = prepared.frames.map(({ positionPct, timestampSec }) => ({
        positionPct,
        timestampSec
      }));
      imagePaths = prepared.frames.map((frame) => frame.path);
    } else {
      prepared = await prepareEnrichmentImage(sourcePath, {
        abortSignal: abortController.signal
      });
      imagePaths = [prepared.path];
    }

    replaceAiRunMediaInputs(params.runId, preparedMediaInputs(prepared));

    log.info("capture enrichment turn starting", {
      runId: params.runId,
      captureId,
      captureKind: params.metadata.captureKind,
      sourceAppName: params.metadata.sourceAppName,
      sourceAppBundleId: params.metadata.sourceAppBundleId,
      triggerSource: params.triggerSource,
      provider,
      preparedMedia: preparedMediaShape(prepared),
      bucketBefore: params.budgetBefore,
      bucketAfter: params.budgetAfter
    });

    const acpAgentId = params.acpAgentId;
    if (acpAgentId !== undefined) {
      const acpClient = await buildAcpEnrichmentClient(
        acpAgentId,
        params.acpSettings ?? (await params.settingsReader()),
        captureMetadataWorkspaceDir()
      );
      if (acpClient === null) {
        throw new Error(`ACP agent "${acpAgentId}" is not installed for enrichment`);
      }
      client = acpClient;
    } else {
      client = params.clientFactory(params.command, params.env);
    }
    // Bound the turn: a stalled agent (the ACP path forwards an abort
    // signal but enforces no deadline) would otherwise leave the run in
    // `running` forever. On timeout we abort the controller (best-effort
    // stop) and the race rejects with EnrichmentTimeoutError → the catch
    // fails the run so the UI shows "could not read … Regenerate".
    const response = await withTurnTimeout(
      client.enrichCapture({
        imagePaths,
        metadata,
        // Pass the resolved model for BOTH backends. For ACP this is the user's
        // chosen agent model (the kit ignores an unknown id and falls back to the
        // agent default, so a stale value can't break the run); "" → null → agent
        // default. For Codex it's the caption model.
        model: params.selectedModel.length > 0 ? params.selectedModel : null,
        ...(acpAgentId === undefined && params.selectedProvider !== undefined
          ? { modelProvider: params.selectedProvider }
          : {}),
        effort: params.effort,
        abortSignal: abortController.signal
      }),
      params.turnTimeoutMs,
      () => abortController.abort()
    );

    // A "completed but blank" reply is a failure, not a success. The result
    // schema defaults title/description/ocrText to "", so an agent that returns
    // {} or empty values (seen with Grok) would otherwise persist an all-empty
    // enrichment + mark the run completed → the toast/rail show nothing with no
    // way to retry. Treat all-empty as a failure so the UI surfaces "could not
    // read … Regenerate".
    if (isEnrichmentResultEmpty(response.result)) {
      throw new Error(
        `${response.modelProvider ?? provider} returned an empty enrichment ` +
          "(no title, description, tags, or text)"
      );
    }

    const latencyMs = Math.round(performance.now() - startedAt);
    // Read settings at completion (not at enqueue) so the auto-accept
    // checkbox the user just toggled in the float-over toast wins over
    // whatever was set when the capture happened. Soft-fail: if the
    // read errors, fall back to "don't auto-accept" — the user still
    // sees the suggestion in the toast and can click Use.
    let autoAccept = false;
    try {
      const settings = await params.settingsReader();
      autoAccept =
        settings.ai.enabled &&
        settings.ai.consentAcceptedAt !== null &&
        settings.ai.autoAcceptSuggestions === true;
    } catch (error) {
      log.warn("settings read failed during enrichment completion", {
        captureId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    storeCompletedEnrichment({
      captureId,
      aiRunId: params.runId,
      result: response.result,
      autoAccept
    });
    const tokens = response.tokens;
    saveAiRunUsage({
      aiRunId: params.runId,
      threadId: response.threadId,
      turnId: response.turnId,
      model: response.model ?? null,
      modelProvider: response.modelProvider ?? null,
      serviceTier: response.serviceTier ?? null,
      usageStatus: tokens === null ? "unavailable" : "available",
      usageUnavailableReason:
        tokens === null
          ? `${response.modelProvider ?? "the agent"} did not report token usage`
          : null,
      tokens,
      cost: estimateAiUsageCost({
        model: response.model ?? null,
        provider: response.modelProvider ?? null,
        serviceTier: response.serviceTier ?? null,
        tokens
      })
    });
    await tryRenameCaptureAssetToEffectiveFilename(captureId);
    const completed = completeAiRun(params.runId, response.result, latencyMs);
    broadcastAiRunUpdated({
      run: completed,
      enrichment: getCaptureEnrichment(captureId)
    });
    log.info("capture enrichment completed", {
      runId: params.runId,
      captureId,
      captureKind: params.metadata.captureKind,
      sourceAppName: params.metadata.sourceAppName,
      sourceAppBundleId: params.metadata.sourceAppBundleId,
      triggerSource: params.triggerSource,
      provider,
      userAgent: response.userAgent,
      threadId: response.threadId,
      turnId: response.turnId,
      latencyMs,
      preparedMedia: preparedMediaShape(prepared),
      outcome: "completed"
    });
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const isAbort = error instanceof DOMException && error.name === "AbortError";
    const isTimeout = error instanceof EnrichmentTimeoutError;
    try {
      saveAiRunUsage({
        aiRunId: params.runId,
        usageStatus: "unavailable",
        usageUnavailableReason: isAbort
          ? "AI run was cancelled before Codex reported token usage"
          : "Codex did not report token usage before the run failed",
        cost: { status: "unavailable", reason: "usage unavailable" }
      });
    } catch (usageError) {
      log.warn("AI usage accounting skipped after run failure", {
        runId: params.runId,
        message: usageError instanceof Error ? usageError.message : String(usageError)
      });
    }
    // A timeout is a failure, not a user cancel — phrase it to read after
    // CodexStatusPill's "{provider} could not read this snap: " prefix.
    const message = isTimeout
      ? `the read timed out after ${Math.round(error.timeoutMs / 1000)}s`
      : agentErrorMessage(error);
    const run = isAbort
      ? cancelAiRun(params.runId)
      : failAiRun(params.runId, message, latencyMs);
    broadcastAiRunUpdated({
      run,
      enrichment: getCaptureEnrichment(captureId)
    });
    if (!isAbort) {
      log.warn("capture enrichment failed", {
        runId: params.runId,
        captureId,
        captureKind: params.metadata.captureKind,
        sourceAppName: params.metadata.sourceAppName,
        sourceAppBundleId: params.metadata.sourceAppBundleId,
        triggerSource: params.triggerSource,
        codexCommand: params.command,
        provider,
        preparedMedia: preparedMediaShape(prepared),
        outcome: isTimeout ? "timed-out" : "failed",
        timedOut: isTimeout,
        message
      });
    } else {
      log.info("capture enrichment cancelled", {
        runId: params.runId,
        captureId,
        captureKind: params.metadata.captureKind,
        sourceAppName: params.metadata.sourceAppName,
        sourceAppBundleId: params.metadata.sourceAppBundleId,
        triggerSource: params.triggerSource,
        codexCommand: params.command,
        provider,
        preparedMedia: preparedMediaShape(prepared),
        outcome: "cancelled"
      });
    }
  } finally {
    activeRuns.delete(params.runId);
    params.ctx.signal.removeEventListener("abort", abortFromContext);
    await prepared?.cleanup().catch((error: unknown) => {
      log.warn("enrichment image cleanup failed", {
        runId: params.runId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
    // The default Codex enrichment wrapper is processless; the app-wide Codex
    // owner closes at app shutdown. Test-provided clients may still need close.
    // The ACP client is built fresh per run, so always close it.
    if (params.closeClientAfterRun || params.acpAgentId !== undefined) {
      await client?.close().catch((error: unknown) => {
        log.warn("enrichment client close failed", {
          runId: params.runId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }
}
