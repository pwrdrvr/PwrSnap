import { readFileSync } from "node:fs";
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
      description:
        "Short visible text anchors only. Do not return full OCR. Empty string if text is not essential."
    },
    description: {
      type: "string",
      description:
        "One concise caption describing what is visually present and why the capture may be useful later."
    },
    filenameStem: {
      type: "string",
      description:
        "Optional lowercase kebab-case export filename stem, without a file extension."
    },
    textAnchors: {
      type: "array",
      maxItems: 5,
      items: {
        type: "string",
        minLength: 1,
        maxLength: 120
      }
    },
    tags: {
      type: "array",
      maxItems: 4,
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

export const CAPTURE_ENRICHMENT_PROMPT_FILE = new URL(
  "./prompts/capture-enrichment.md",
  import.meta.url
);

export const CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS = readFileSync(
  CAPTURE_ENRICHMENT_PROMPT_FILE,
  "utf8"
).trimEnd();

export type CaptureEnrichmentPromptMetadata = {
  sourceAppName: string | null;
  sourceAppBundleId: string | null;
  captureKind: "image" | "video";
  widthPx: number;
  heightPx: number;
  capturedAt: string;
};

export function buildCaptureEnrichmentPrompt(metadata: CaptureEnrichmentPromptMetadata): string {
  return [
    "Capture metadata:",
    `- Source application name: ${metadata.sourceAppName?.trim() || "unknown"}`,
    `- Source application bundle id: ${metadata.sourceAppBundleId?.trim() || "unknown"}`,
    `- Capture kind: ${metadata.captureKind}`,
    `- Dimensions: ${metadata.widthPx} x ${metadata.heightPx} px`,
    `- Captured at: ${metadata.capturedAt || "unknown"}`
  ].join("\n");
}

export function parseCaptureEnrichmentResponse(rawText: string): EnrichmentResult {
  const parsed = JSON.parse(stripJsonFence(rawText)) as unknown;
  return EnrichmentResultSchema.parse(parsed);
}

function stripJsonFence(rawText: string): string {
  const trimmed = rawText.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1] ?? trimmed;
}
