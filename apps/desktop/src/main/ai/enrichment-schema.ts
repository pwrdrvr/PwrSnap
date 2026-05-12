import { EnrichmentResultSchema, type EnrichmentResult } from "@pwrsnap/shared";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const CAPTURE_ENRICHMENT_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: ["ocrText", "description", "tags"],
  properties: {
    ocrText: {
      type: "string",
      description: "Readable text visible in the screenshot. Empty string if none is visible."
    },
    description: {
      type: "string",
      description: "One concise sentence describing the screenshot for later search."
    },
    tags: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "confidence"],
        properties: {
          label: {
            type: "string",
            minLength: 1,
            maxLength: 64
          },
          confidence: {
            anyOf: [
              {
                type: "number",
                minimum: 0,
                maximum: 1
              },
              {
                type: "null"
              }
            ]
          }
        }
      }
    }
  }
};

export const CAPTURE_ENRICHMENT_PROMPT = [
  "Analyze this screenshot for PwrSnap.",
  "Return only JSON that matches the supplied schema.",
  "Extract visible text as ocrText, preserving useful line breaks.",
  "Write a concise, neutral description for screenshot search.",
  "Suggest short lowercase tags for visible apps, UI areas, documents, charts, errors, people, or topics.",
  "Do not identify private people. Do not invent text or tags that are not supported by the image."
].join("\n");

export function parseCaptureEnrichmentResponse(rawText: string): EnrichmentResult {
  const parsed = JSON.parse(stripJsonFence(rawText)) as unknown;
  return EnrichmentResultSchema.parse(parsed);
}

function stripJsonFence(rawText: string): string {
  const trimmed = rawText.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1] ?? trimmed;
}
