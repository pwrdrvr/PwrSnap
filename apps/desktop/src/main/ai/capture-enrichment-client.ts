// Capture-enrichment client — a thin PwrSnap wrapper over the shared Codex
// App Server owner.
//
// Capture enrichment (annotate / describe / tag / filename / sensitive-scan)
// is a one-shot structured-output turn: one prompt + one or more local images
// in, one JSON object out (validated against `CAPTURE_ENRICHMENT_SCHEMA`). The
// pooled owner owns the persistent worker thread, `outputSchema` plumbing,
// localImage inputs, per-turn rollback, and token-usage normalization. This
// keeps capture enrichment from spawning a second Codex process alongside chat
// or model listing.
//
// This wrapper preserves the `enrichCapture(...)` / `close()` surface that
// `codex-handlers.ts` consumes, mapping PwrSnap's caller-supplied args (prompt
// + schema + image paths) onto a pooled one-shot request and the kit's
// `NormalizedTokenUsage` back onto PwrSnap's `AiUsageTokenBreakdown` (carrying
// `contextWindow → modelContextWindow`).

import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AiUsageTokenBreakdown, EnrichmentResult } from "@pwrsnap/shared";
import { resolveCodexThreadConfigForCommand } from "./codex-thread-config";
import { runCodexOneShotFromPool } from "./codex-agent-pool";
import {
  CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS,
  CAPTURE_ENRICHMENT_SCHEMA,
  buildCaptureEnrichmentPrompt,
  type CaptureEnrichmentPromptMetadata,
  parseCaptureEnrichmentResponse
} from "./enrichment-schema";

export type CaptureEnrichmentClientOptions = {
  command: string;
  /** Process env for the spawned Codex — carries CODEX_HOME for the selected
   *  auth profile (`codexEnvForProfile`). Omit for the default ~/.codex. */
  env?: NodeJS.ProcessEnv;
  captureMetadataWorkspaceDir?: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
};

export type CaptureEnrichmentRequest = {
  imagePaths: readonly string[];
  metadata: CaptureEnrichmentPromptMetadata;
  model?: string | null;
  /** Model provider, driven by the Settings → AI per-surface default
   *  `ai.defaults.enrichment.provider`. Omit for the Codex default. */
  modelProvider?: string | null;
  /** Reasoning effort for the enrichment turn. Defaults to "low" when
   *  omitted (enrichment is high-volume + cost-sensitive). Driven by the
   *  Settings → AI per-surface default `ai.defaults.enrichment.reasoning`. */
  effort?: string;
  abortSignal?: AbortSignal;
};

/** The backend-agnostic enrichment surface the handler depends on. Satisfied
 *  by both `CaptureEnrichmentClient` (Codex) and `AcpCaptureEnrichmentClient`
 *  (Gemini/Qwen), so `codex:enrich` routes to either by
 *  `ai.defaults.enrichment.provider`. */
export interface EnrichmentBackend {
  enrichCapture(request: CaptureEnrichmentRequest): Promise<CaptureEnrichmentResponse>;
  close(): Promise<void>;
}

export type CaptureEnrichmentResponse = {
  result: EnrichmentResult;
  threadId: string;
  turnId: string;
  userAgent: string;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  /** Already mapped to PwrSnap's persisted breakdown (incl. modelContextWindow). */
  tokens: AiUsageTokenBreakdown | null;
};

/** Map the kit's flat, all-optional `NormalizedTokenUsage` onto PwrSnap's
 *  flat, required `AiUsageTokenBreakdown`, carrying `contextWindow →
 *  modelContextWindow`. `null` in ⇒ `null` out (usage unavailable). */
function toBreakdown(
  usage: {
    totalTokens?: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    contextWindow?: number;
  } | null
): AiUsageTokenBreakdown | null {
  if (usage === null) return null;
  return {
    totalTokens: usage.totalTokens ?? 0,
    inputTokens: usage.inputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningOutputTokens: usage.reasoningOutputTokens ?? 0,
    modelContextWindow: usage.contextWindow ?? null
  };
}

export class CaptureEnrichmentClient {
  private readonly command: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly workspaceDir: string;
  private readonly requestTimeoutMs?: number;
  private readonly turnTimeoutMs?: number;
  private readonly threadConfig: Record<string, unknown>;

  constructor(options: CaptureEnrichmentClientOptions) {
    this.command = options.command;
    if (options.env !== undefined) this.env = options.env;
    this.workspaceDir =
      options.captureMetadataWorkspaceDir ??
      join(tmpdir(), "pwrsnap", "Chats", ".capture-metadata");
    if (options.requestTimeoutMs !== undefined) this.requestTimeoutMs = options.requestTimeoutMs;
    if (options.turnTimeoutMs !== undefined) this.turnTimeoutMs = options.turnTimeoutMs;
    // Pick the config overlay shape for the running Codex build (the schema
    // churns across releases). Probed once per command, cached.
    this.threadConfig = resolveCodexThreadConfigForCommand(options.command, options.env);
  }

  async enrichCapture(request: CaptureEnrichmentRequest): Promise<CaptureEnrichmentResponse> {
    if (request.imagePaths.length === 0) {
      throw new Error("capture enrichment requires at least one image input");
    }
    const response = await runCodexOneShotFromPool({
      command: this.command,
      ...(this.env !== undefined ? { env: this.env } : {}),
      workspaceDir: this.workspaceDir,
      workerThreadName: "PwrSnap Capture Metadata Worker",
      threadConfig: this.threadConfig,
      ...(this.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.requestTimeoutMs }
        : {}),
      ...(this.turnTimeoutMs !== undefined ? { turnTimeoutMs: this.turnTimeoutMs } : {}),
      prompt: buildCaptureEnrichmentPrompt(request.metadata),
      imagePaths: request.imagePaths,
      outputSchema: CAPTURE_ENRICHMENT_SCHEMA,
      baseInstructions: CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS,
      effort: request.effort ?? "low",
      model: request.model ?? null,
      modelProvider: request.modelProvider ?? null,
      ...(request.abortSignal !== undefined ? { abortSignal: request.abortSignal } : {})
    });
    return {
      result: parseCaptureEnrichmentResponse(response.rawText),
      threadId: response.threadId,
      turnId: response.turnId,
      userAgent: response.userAgent,
      model: response.model,
      modelProvider: response.modelProvider,
      serviceTier: response.serviceTier,
      tokens: toBreakdown(response.tokenUsage)
    };
  }

  async close(): Promise<void> {
    // The app-wide Codex owner owns the process lifecycle.
  }
}
