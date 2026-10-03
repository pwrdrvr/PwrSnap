import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ResolvedCustomModel } from "@pwrsnap/shared";
import type { CaptureEnrichmentRequest, CaptureEnrichmentResponse, EnrichmentBackend } from "../capture-enrichment-client";
import { CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS, CAPTURE_ENRICHMENT_SCHEMA, buildCaptureEnrichmentPrompt, parseCaptureEnrichmentResponse } from "../enrichment-schema";
import type { CustomModelService } from "./service";
import { DirectApiError, invokeApi } from "./transport";
import { DIRECT_ENRICHMENT_TIMEOUT_MS } from "./enrichment-queue";

export class DirectEnrichmentBackend implements EnrichmentBackend {
  constructor(private readonly model: ResolvedCustomModel, private readonly service: CustomModelService) {}
  async enrichCapture(req: CaptureEnrichmentRequest): Promise<CaptureEnrichmentResponse> {
    req.abortSignal?.throwIfAborted();
    if (this.model.capabilities.vision !== true) throw new DirectApiError("Captions need a model marked as accepting images. Set Image input to Yes for this model in Settings → AI Providers.");
    const images: string[] = [];
    for (const path of req.imagePaths) {
      // These paths are app-prepared bounded images, never model-supplied paths.
      const bytes = await readFile(path);
      const mime = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png";
      images.push(`data:${mime};base64,${bytes.toString("base64")}`);
    }
    const result = await this.invoke(images, req);
    let parsed: CaptureEnrichmentResponse["result"];
    try { parsed = parseCaptureEnrichmentResponse(result.text); }
    catch { throw new DirectApiError("Model returned invalid enrichment JSON. Try another model or increase the output token limit."); }
    return { result: parsed, threadId: `direct-${randomUUID()}`, turnId: randomUUID(),
      userAgent: "PwrSnap Direct API", model: this.model.modelId, modelProvider: `custom:${this.model.id}`, serviceTier: null, tokens: result.tokens };
  }
  private async invoke(images: string[], req: CaptureEnrichmentRequest): ReturnType<typeof invokeApi> {
    try {
      return await invokeApi({ model: this.model, headers: await this.service.credentials.headers(this.model, req.abortSignal),
        timeoutMs: DIRECT_ENRICHMENT_TIMEOUT_MS,
        ...(this.model.enrichmentReasoning ? { reasoningMode: this.model.enrichmentReasoning } : {}),
        system: `${CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS}\nReturn ONLY a JSON object conforming to this schema:\n${JSON.stringify(CAPTURE_ENRICHMENT_SCHEMA)}`,
        messages: [{ role: "user", text: buildCaptureEnrichmentPrompt(req.metadata), images }],
        ...(req.abortSignal ? { signal: req.abortSignal } : {}) });
    } catch (e) {
      await this.service.credentials.noteFailure(this.model, e);
      throw e;
    }
  }
  async close(): Promise<void> {}
}
