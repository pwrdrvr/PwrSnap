import { BrowserWindow } from "electron";
import {
  AcceptDescriptionRequestSchema,
  AcceptTagRequestSchema,
  EVENT_CHANNELS,
  RejectTagRequestSchema,
  err,
  ok
} from "@pwrsnap/shared";
import type { AiRunSnapshot, CaptureEnrichment, PwrSnapError, Result, Settings } from "@pwrsnap/shared";
import { CodexAppServerClient } from "../ai/codex-client";
import { prepareEnrichmentImage } from "../ai/enrichment-image";
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
  acceptSuggestedTag,
  getCaptureEnrichment,
  getEnrichmentSummaries,
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
        image: {
          maxLongEdgePx: 1024,
          format: "jpeg"
        }
      }
    });
    const enrichment = setLatestEnrichmentRun(capture.id, run.id);
    broadcastAiRunUpdated({ run, enrichment });
    void runCaptureEnrichment({
      runId: run.id,
      captureId: capture.id,
      sourcePath: capture.src_path,
      command: codexCommand,
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
  command: string;
  ctx: CommandContext;
  clientFactory: CodexClientFactory;
}): Promise<void> {
  const startedAt = performance.now();
  const abortController = new AbortController();
  const abortFromContext = (): void => abortController.abort();
  params.ctx.signal.addEventListener("abort", abortFromContext, { once: true });
  activeRuns.set(params.runId, abortController);

  let prepared: Awaited<ReturnType<typeof prepareEnrichmentImage>> | null = null;
  let client: CodexAppServerClient | null = null;

  try {
    const running = markAiRunRunning(params.runId);
    broadcastAiRunUpdated({
      run: running,
      enrichment: getCaptureEnrichment(params.captureId)
    });

    prepared = await prepareEnrichmentImage(params.sourcePath);
    client = params.clientFactory(params.command);
    const response = await client.enrichCapture({
      imagePath: prepared.path,
      abortSignal: abortController.signal
    });

    const latencyMs = Math.round(performance.now() - startedAt);
    const enrichment = storeCompletedEnrichment({
      captureId: params.captureId,
      aiRunId: params.runId,
      result: response.result
    });
    const completed = completeAiRun(params.runId, response.result, latencyMs);
    broadcastAiRunUpdated({ run: completed, enrichment });
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
