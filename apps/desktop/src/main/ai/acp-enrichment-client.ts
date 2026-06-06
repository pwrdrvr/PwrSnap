// ACP-backed capture enrichment — the same one-shot structured-output job as
// `CaptureEnrichmentClient`, but driven through a local ACP agent (Gemini /
// Qwen) via the kit's `AcpOneShotClient` instead of Codex.
//
// ACP has no `outputSchema` and no base-instructions on `session/new`, so this
// client folds the enrichment base instructions + the JSON-Schema contract +
// the per-capture metadata into ONE prompt and parses the agent's reply with
// the same fence-tolerant `parseCaptureEnrichmentResponse`. It exposes the same
// `enrichCapture(...)` / `close()` surface as the Codex client so the handler
// routes to either by `ai.defaults.enrichment.provider`.

import {
  AcpOneShotClient,
  AcpConnection,
  type AcpAgentStrategy
} from "@pwrdrvr/agent-acp";
import type { AiUsageTokenBreakdown } from "@pwrsnap/shared";
import {
  CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS,
  CAPTURE_ENRICHMENT_SCHEMA,
  buildCaptureEnrichmentPrompt,
  parseCaptureEnrichmentResponse
} from "./enrichment-schema";
import type {
  CaptureEnrichmentRequest,
  CaptureEnrichmentResponse
} from "./capture-enrichment-client";
import {
  PWRSNAP_CLIENT_NAME,
  PWRSNAP_CLIENT_TITLE,
  toAgentKitLogger
} from "./agent-kit-bindings";

export type AcpCaptureEnrichmentClientOptions = {
  /** Resolved agent executable (an absolute path or a bare command). */
  command: string;
  /** Spawn args that put the agent into ACP stdio mode. */
  args: readonly string[];
  /** Extra env for the spawn (merged over process.env). */
  env?: Record<string, string>;
  /** Kit strategy carrying the agent's normalization quirks + backend id. */
  strategy: AcpAgentStrategy;
  /** Scratch cwd for the agent session (keep enrichment out of any repo). */
  cwd: string;
};

/** Map the kit's token usage onto PwrSnap's persisted breakdown. */
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

/** Extract the first balanced top-level JSON object from a possibly-noisy
 *  agent reply (leading reasoning prose, ```json fences, trailing text).
 *  Returns the substring `{ … }`; falls back to the trimmed input when no
 *  object is found (so the downstream parse surfaces a real error). String
 *  literals are skipped so a `{`/`}` inside a value doesn't unbalance it.
 *  Exported for testing. */
export function extractJsonObject(rawText: string): string {
  const fence = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = (fence?.[1] ?? rawText).trim();
  const start = body.indexOf("{");
  if (start === -1) return body;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return body.slice(start);
}

/** Fold the Codex base instructions + the JSON-Schema contract + the
 *  per-capture metadata into one prompt (ACP has no outputSchema /
 *  baseInstructions seam). Exported for testing. */
export function buildAcpEnrichmentPrompt(request: CaptureEnrichmentRequest): string {
  return [
    CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS.trim(),
    "",
    buildCaptureEnrichmentPrompt(request.metadata),
    "",
    "Respond with ONLY a single JSON object that conforms to this JSON Schema.",
    "Do not call any tools, ask any questions, or emit any prose or markdown — JSON only:",
    JSON.stringify(CAPTURE_ENRICHMENT_SCHEMA)
  ].join("\n");
}

export class AcpCaptureEnrichmentClient {
  private readonly client: AcpOneShotClient;

  constructor(options: AcpCaptureEnrichmentClientOptions) {
    const logger = toAgentKitLogger("pwrsnap:acp-enrichment");
    const transport = new AcpConnection({
      command: options.command,
      args: [...options.args],
      ...(options.env !== undefined && Object.keys(options.env).length > 0
        ? { env: options.env }
        : {}),
      logger
    });
    this.client = new AcpOneShotClient({
      transport,
      strategy: options.strategy,
      clientName: PWRSNAP_CLIENT_NAME,
      clientTitle: PWRSNAP_CLIENT_TITLE,
      cwd: options.cwd,
      logger
    });
  }

  async enrichCapture(request: CaptureEnrichmentRequest): Promise<CaptureEnrichmentResponse> {
    if (request.imagePaths.length === 0) {
      throw new Error("capture enrichment requires at least one image input");
    }
    const response = await this.client.run({
      prompt: buildAcpEnrichmentPrompt(request),
      imagePaths: request.imagePaths,
      model: request.model ?? null,
      effort: request.effort ?? "low",
      ...(request.abortSignal !== undefined ? { abortSignal: request.abortSignal } : {})
    });
    return {
      // ACP agents (esp. "thinking" models like Gemini flash-preview) often
      // wrap the JSON in reasoning prose ("**Analyzing the image**…{…}") despite
      // the JSON-only instruction, so extract the JSON object before validating.
      result: parseCaptureEnrichmentResponse(extractJsonObject(response.rawText)),
      threadId: response.threadId,
      turnId: response.turnId,
      userAgent: response.modelProvider,
      model: response.model,
      modelProvider: response.modelProvider,
      serviceTier: response.serviceTier,
      tokens: toBreakdown(response.tokenUsage)
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
