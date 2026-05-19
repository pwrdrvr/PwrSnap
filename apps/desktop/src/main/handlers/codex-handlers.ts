import { BrowserWindow } from "electron";
import {
  AcceptDescriptionRequestSchema,
  AcceptFilenameStemRequestSchema,
  AcceptTitleRequestSchema,
  AcceptTagRequestSchema,
  EVENT_CHANNELS,
  RejectTagRequestSchema,
  err,
  ok
} from "@pwrsnap/shared";
import type { AiRunSnapshot, CaptureEnrichment, PwrSnapError, Result, Settings } from "@pwrsnap/shared";
import { CodexAppServerClient } from "../ai/codex-client";
import {
  prepareEnrichmentImage,
  prepareEnrichmentVideoFrames,
  type PreparedEnrichmentImage,
  type PreparedEnrichmentVideoFrames
} from "../ai/enrichment-image";
import type { CaptureEnrichmentPromptMetadata } from "../ai/enrichment-schema";
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
import { getCaptureById } from "../persistence/captures-repo";
import {
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

const log = getMainLogger("pwrsnap:codex-handlers");

export type CodexClientFactory = (command: string) => CodexAppServerClient;
export type SettingsReader = () => Promise<Settings>;

const activeRuns = new Map<string, AbortController>();

function broadcastAiRunUpdated(payload: {
  run: AiRunSnapshot | null;
  enrichment: CaptureEnrichment | null;
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(EVENT_CHANNELS.aiRunUpdated, payload);
  }
}

function validationError(code: string, message: string): Result<never, PwrSnapError> {
  return err({ kind: "validation", code, message });
}

async function defaultSettingsReader(): Promise<Settings> {
  const result = await bus.dispatch("settings:read", {}, { principal: "ipc" });
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

function mapError(error: unknown): Result<never, PwrSnapError> {
  return err({
    kind: "unknown",
    code: "codex_enrichment_failed",
    message: error instanceof Error ? error.message : String(error),
    cause: error
  });
}

export function maybeEnqueueCaptureEnrichment(captureId: string): void {
  void defaultSettingsReader()
    .then((settings) => {
      if (!settings.ai.enabled || settings.ai.consentAcceptedAt === null) {
        return null;
      }
      return bus.dispatch("codex:enrich", { captureId }, { principal: "ipc", cancellationKey: captureId });
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
  settingsReader?: SettingsReader;
}): void {
  const clientFactory = params?.clientFactory ?? ((command) => new CodexAppServerClient({ command }));
  const settingsReader = params?.settingsReader ?? defaultSettingsReader;

  bus.register("codex:enrich", async (req, ctx) => {
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
    const run = createAiRun({
      captureId: capture.id,
      codexCommand,
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
    void runCaptureEnrichment({
      runId: run.id,
      captureId: capture.id,
      sourcePath: capture.src_path,
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
      settingsReader,
      ctx,
      clientFactory
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

  bus.register("codex:cancel", async (req) => {
    activeRuns.get(req.runId)?.abort();
    activeRuns.delete(req.runId);
    const run = cancelAiRun(req.runId);
    const enrichment = run ? getCaptureEnrichment(run.captureId) : null;
    broadcastAiRunUpdated({ run, enrichment });
    return ok(undefined);
  });

  for (const name of [
    "codex:annotate",
    "codex:describe",
    "codex:tag",
    "codex:filename",
    "codex:sensitiveScan"
  ] as const) {
    bus.register(name, async (req, ctx) => {
      return bus.dispatch("codex:enrich", req, {
        principal: ctx.principal,
        cancellationKey: req.captureId
      });
    });
  }

  bus.register("codex:ask", async () => {
    return validationError("not_implemented", "codex:ask lands after capture enrichment");
  });
}

async function runCaptureEnrichment(params: {
  runId: string;
  captureId: string;
  sourcePath: string;
  metadata: CaptureEnrichmentPromptMetadata;
  command: string;
  /**
   * Re-read just before the result is persisted so a `auto-accept`
   * toggle the user flipped DURING the run is honored — not the
   * value captured at enqueue. Reading at completion matches what
   * the float-over checkbox visibly promises.
   */
  settingsReader: SettingsReader;
  ctx: CommandContext;
  clientFactory: CodexClientFactory;
}): Promise<void> {
  const startedAt = performance.now();
  const abortController = new AbortController();
  const abortFromContext = (): void => abortController.abort();
  params.ctx.signal.addEventListener("abort", abortFromContext, { once: true });
  activeRuns.set(params.runId, abortController);

  let prepared: PreparedEnrichmentImage | PreparedEnrichmentVideoFrames | null = null;
  let client: CodexAppServerClient | null = null;

  try {
    const running = markAiRunRunning(params.runId);
    broadcastAiRunUpdated({
      run: running,
      enrichment: getCaptureEnrichment(params.captureId)
    });

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
      prepared = await prepareEnrichmentVideoFrames(params.sourcePath, {
        durationSec: metadata.videoDurationSec,
        abortSignal: abortController.signal
      });
      metadata.videoFrameSamples = prepared.frames.map(({ positionPct, timestampSec }) => ({
        positionPct,
        timestampSec
      }));
      imagePaths = prepared.frames.map((frame) => frame.path);
    } else {
      prepared = await prepareEnrichmentImage(params.sourcePath, {
        abortSignal: abortController.signal
      });
      imagePaths = [prepared.path];
    }

    client = params.clientFactory(params.command);
    const response = await client.enrichCapture({
      imagePaths,
      metadata,
      abortSignal: abortController.signal
    });

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
        captureId: params.captureId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    storeCompletedEnrichment({
      captureId: params.captureId,
      aiRunId: params.runId,
      result: response.result,
      autoAccept
    });
    const completed = completeAiRun(params.runId, response.result, latencyMs);
    broadcastAiRunUpdated({
      run: completed,
      enrichment: getCaptureEnrichment(params.captureId)
    });
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const isAbort = error instanceof DOMException && error.name === "AbortError";
    const run = isAbort
      ? cancelAiRun(params.runId)
      : failAiRun(
          params.runId,
          error instanceof Error ? error.message : String(error),
          latencyMs
        );
    broadcastAiRunUpdated({
      run,
      enrichment: getCaptureEnrichment(params.captureId)
    });
    if (!isAbort) {
      log.warn("capture enrichment failed", {
        runId: params.runId,
        captureId: params.captureId,
        message: error instanceof Error ? error.message : String(error)
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
    await client?.close().catch((error: unknown) => {
      log.warn("codex client close failed", {
        runId: params.runId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }
}
