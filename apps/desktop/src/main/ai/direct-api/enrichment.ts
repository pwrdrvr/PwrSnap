import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { CustomModel } from "@pwrsnap/shared";
import type { CaptureEnrichmentRequest, CaptureEnrichmentResponse, EnrichmentBackend } from "../capture-enrichment-client";
import { CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS, CAPTURE_ENRICHMENT_SCHEMA, buildCaptureEnrichmentPrompt, parseCaptureEnrichmentResponse } from "../enrichment-schema";
import type { CustomModelService } from "./service";
import { DirectApiError, invokeApi } from "./transport";

export class DirectEnrichmentBackend implements EnrichmentBackend {
  constructor(private readonly model: CustomModel, private readonly service: CustomModelService) {}
  async enrichCapture(req: CaptureEnrichmentRequest): Promise<CaptureEnrichmentResponse> {
    if (!this.model.capabilities.vision) throw new DirectApiError("Enable verified image support for this custom model before using capture enrichment.");
    const images: string[] = [];
    for (const path of req.imagePaths) {
      // These paths are app-prepared bounded images, never model-supplied paths.
      const bytes = await readFile(path);
      const mime = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png";
      images.push(`data:${mime};base64,${bytes.toString("base64")}`);
    }
    const result = await invokeApi({ model: this.model, headers: await this.service.credentials.headers(this.model, req.abortSignal),
      system: `${CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS}\nReturn ONLY a JSON object conforming to this schema:\n${JSON.stringify(CAPTURE_ENRICHMENT_SCHEMA)}`,
      messages: [{ role: "user", text: buildCaptureEnrichmentPrompt(req.metadata), images }],
      ...(req.abortSignal ? { signal: req.abortSignal } : {}) });
    let parsed: CaptureEnrichmentResponse["result"];
    try { parsed = parseCaptureEnrichmentResponse(result.text); }
    catch { throw new DirectApiError("Model returned invalid enrichment JSON. Try another model or increase the output token limit."); }
    return { result: parsed, threadId: `direct-${randomUUID()}`, turnId: randomUUID(),
      userAgent: "PwrSnap Direct API", model: this.model.modelId, modelProvider: `custom:${this.model.id}`, serviceTier: null, tokens: result.tokens };
  }
  async close(): Promise<void> {}
}
