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
  type AcpAgentStrategy,
  type AcpOneShotResponse
} from "@pwrdrvr/agent-acp";
import type { AiUsageTokenBreakdown } from "@pwrsnap/shared";
import type { EnrichmentResult } from "@pwrsnap/shared";
import {
  CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS,
  CAPTURE_ENRICHMENT_EXAMPLE,
  buildCaptureEnrichmentPrompt,
  isEnrichmentResultEmpty,
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

/** Fold the Codex base instructions + the output contract + the per-capture
 *  metadata into one prompt (ACP has no outputSchema / baseInstructions seam).
 *
 *  IMPORTANT: we describe the keys in prose and hand a CONCRETE EXAMPLE
 *  instance — NOT a raw JSON Schema. Telling a weaker model to "conform to this
 *  JSON Schema" made Grok echo the schema's type names (`"ocrText": string`),
 *  which isn't valid JSON. An example it copies the shape of (with its own real
 *  values) parses reliably across Gemini / Qwen / Grok / Kimi. Exported for
 *  testing. */
export function buildAcpEnrichmentPrompt(request: CaptureEnrichmentRequest): string {
  return [
    CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS.trim(),
    "",
    buildCaptureEnrichmentPrompt(request.metadata),
    "",
    "Respond with ONLY a single JSON object describing THIS image — REAL values,",
    "not a schema and not type names. Do not call any tools, ask any questions, or",
    "emit any prose or markdown — JSON only. Required keys:",
    '  • "ocrText": short visible text anchors only; "" if not essential.',
    '  • "title": short headline (≤120 chars), no trailing punctuation.',
    '  • "description": 1–3 sentences on what is visible + why it is useful later.',
    '  • "filenameStem": lowercase kebab-case stem, no extension; "" if none.',
    '  • "textAnchors": array of up to 5 short visible text strings.',
    '  • "tags": array of up to 4 objects, each with a "label" and a "confidence" (0–1, or null).',
    "",
    "Return an object shaped EXACTLY like this example, but with your own real",
    'values for this image (never output the words "string"/"number" or any type):',
    JSON.stringify(CAPTURE_ENRICHMENT_EXAMPLE, null, 2),
    "",
    // Weak instruction-followers (Grok, Qwen) trip the JSON parser in
    // characteristic ways: literal placeholder ellipses (`"textAnchors": [...]`),
    // JS-style comments, and trailing commas. Call them out explicitly.
    "Strict output rules — the reply is fed straight to a JSON parser:",
    "  • Output ONE JSON object and nothing else. No prose, no markdown, no code fences.",
    '  • Fill every field with REAL values for THIS image. Never emit a placeholder',
    '    like "...", "[...]", "TODO", or a type name — fill arrays with real strings',
    "    or leave them empty ([]).",
    "  • Valid JSON only: double-quoted keys + strings, no comments, no trailing commas."
  ].join("\n");
}

/** Corrective re-prompt after a reply that failed to parse or came back empty.
 *  ACP one-shot opens a FRESH session per `run()`, so the agent has no memory of
 *  the prior attempt — the bad reply + the full task must be restated here.
 *  Re-sends the image so the agent can produce real values (not just reformat a
 *  placeholder). Exported for testing. */
export function buildAcpEnrichmentRepairPrompt(
  request: CaptureEnrichmentRequest,
  badOutput: string,
  reason: string
): string {
  const trimmed = badOutput.trim();
  const shown = trimmed.length > 1500 ? `${trimmed.slice(0, 1500)}…` : trimmed;
  return [
    `Your previous reply could not be used: ${reason}.`,
    "Previous reply (do NOT repeat its mistake):",
    shown.length > 0 ? shown : "(empty)",
    "",
    "Produce the answer again, correctly this time.",
    "",
    buildAcpEnrichmentPrompt(request)
  ].join("\n");
}

/** Best-effort repair of near-JSON replies: strips JS-style line/block comments
 *  and trailing commas — both common LLM mistakes — while leaving the contents
 *  of string literals untouched. Does NOT try to fix placeholder ellipses
 *  (`[...]`); those are a missing-value problem handled by a corrective retry,
 *  not something to guess at. Exported for testing. */
export function repairJsonish(text: string): string {
  // Pass 1: drop comments (string-aware).
  let decommented = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      decommented += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      decommented += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      decommented += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1; // skip the closing "/"
      continue;
    }
    decommented += ch;
  }
  // Pass 2: drop trailing commas before } or ] (string-aware).
  let out = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < decommented.length; i += 1) {
    const ch = decommented[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < decommented.length && /\s/.test(decommented[j] ?? "")) j += 1;
      const nextNonWs = decommented[j];
      if (nextNonWs === "}" || nextNonWs === "]") continue; // drop trailing comma
    }
    out += ch;
  }
  return out;
}

/** Parse an enrichment reply leniently: extract the JSON object, then validate;
 *  on failure retry once through `repairJsonish`. Throws if neither parses. */
export function parseEnrichmentReply(rawText: string): EnrichmentResult {
  const extracted = extractJsonObject(rawText);
  try {
    return parseCaptureEnrichmentResponse(extracted);
  } catch {
    return parseCaptureEnrichmentResponse(repairJsonish(extracted));
  }
}

export class AcpCaptureEnrichmentClient {
  private readonly client: AcpOneShotClient;
  private readonly logger: ReturnType<typeof toAgentKitLogger>;

  constructor(options: AcpCaptureEnrichmentClientOptions) {
    const logger = toAgentKitLogger("pwrsnap:acp-enrichment");
    this.logger = logger;
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
    const runOnce = (prompt: string): Promise<AcpOneShotResponse> =>
      this.client.run({
        prompt,
        imagePaths: request.imagePaths,
        model: request.model ?? null,
        effort: request.effort ?? "low",
        ...(request.abortSignal !== undefined ? { abortSignal: request.abortSignal } : {})
      });

    // First attempt with the normal prompt.
    let response = await runOnce(buildAcpEnrichmentPrompt(request));
    this.logRaw("initial", response.rawText);

    // ACP agents (esp. "thinking" models like Gemini flash-preview) often wrap
    // the JSON in reasoning prose despite the JSON-only instruction, so extract
    // + leniently parse (strips comments / trailing commas) before validating.
    let result: EnrichmentResult | null = null;
    let parseError: string | null = null;
    try {
      result = parseEnrichmentReply(response.rawText);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }

    // Weak instruction-followers (Grok, Qwen) routinely fail the first attempt:
    // invalid JSON (`"textAnchors": [...]` placeholders) or an all-empty object.
    // Give them ONE corrective retry — a fresh session restating the task with
    // the bad reply quoted back — before surfacing a failure. Kimi/Gemini that
    // get it right the first time pay nothing.
    if (result === null || isEnrichmentResultEmpty(result)) {
      const reason =
        result === null
          ? `the reply was not valid JSON (${parseError ?? "parse failed"})`
          : "every field came back empty";
      this.logger.debug?.("acp enrichment retrying after bad reply", { reason });
      response = await runOnce(buildAcpEnrichmentRepairPrompt(request, response.rawText, reason));
      this.logRaw("retry", response.rawText);
      // Let a still-broken retry throw — the handler turns it into a failed run
      // so the UI shows "could not read … Regenerate" instead of a blank toast.
      result = parseEnrichmentReply(response.rawText);
    }

    return {
      result,
      threadId: response.threadId,
      turnId: response.turnId,
      userAgent: response.modelProvider,
      model: response.model,
      modelProvider: response.modelProvider,
      serviceTier: response.serviceTier,
      tokens: toBreakdown(response.tokenUsage)
    };
  }

  /** Bounded raw-reply debug log — a "completed but blank" / unparseable
   *  enrichment is otherwise undiagnosable, since only the parsed result is
   *  kept. `phase` distinguishes the first attempt from the corrective retry. */
  private logRaw(phase: "initial" | "retry", rawText: string): void {
    const raw = rawText ?? "";
    this.logger.debug?.("acp enrichment raw response", {
      phase,
      chars: raw.length,
      preview: raw.length > 600 ? `${raw.slice(0, 600)}…` : raw
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
