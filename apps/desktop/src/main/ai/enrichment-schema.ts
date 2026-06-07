import { readFileSync } from "node:fs";
import { EnrichmentResultSchema, type EnrichmentResult } from "@pwrsnap/shared";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const CAPTURE_ENRICHMENT_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: ["ocrText", "title", "description", "filenameStem", "textAnchors", "tags"],
  properties: {
    ocrText: {
      type: "string",
      description:
        "Short visible text anchors only. Do not return full OCR. Empty string if text is not essential."
    },
    title: {
      type: "string",
      description:
        "Short headline (max 120 chars) shown above the capture. Concrete, scannable; no trailing punctuation."
    },
    description: {
      type: "string",
      description:
        "One to three sentences describing what is visible and why the capture may be useful later. Feeds the Sizzle-Reel composer."
    },
    filenameStem: {
      type: "string",
      description:
        "Lowercase kebab-case export filename stem, without a file extension. Empty string if no useful stem can be inferred."
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

/** A concrete, filled-in example of the enrichment output — REAL values, not
 *  types. Handed to ACP agents instead of the raw JSON Schema: weaker
 *  instruction-followers (e.g. Grok) echoed the schema's type names
 *  (`"ocrText": string`) when told to "conform to this JSON Schema", which
 *  isn't valid JSON. An example they can copy the SHAPE of — with their own
 *  values — produces a parseable instance. */
export const CAPTURE_ENRICHMENT_EXAMPLE: JsonValue = {
  ocrText: "Problem Details",
  title: "PwrAgent crash report — missing Electron Framework",
  description:
    "A macOS Problem Reporter window showing a crash for PwrAgent. The report points to a launch failure caused by a missing Electron Framework library.",
  filenameStem: "pwragent-crash-missing-electron-framework",
  textAnchors: ["PwrAgent quit unexpectedly", "Problem Details"],
  tags: [
    { label: "crash report", confidence: 0.9 },
    { label: "macOS", confidence: 0.8 }
  ]
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
  /** Top user-tags from the local Library, ranked by usage. Codex is
   *  asked to prefer these exact labels when its own suggestion is
   *  close in meaning. This biases the suggestion stream toward labels
   *  the user already curates, which keeps the tag taxonomy from
   *  fragmenting (e.g., "deploy" vs "deploys" vs "deployment"). */
  existingUserTags?: ReadonlyArray<string>;
  videoDurationSec?: number | null;
  videoFrameSamples?: ReadonlyArray<{
    positionPct: number;
    timestampSec: number;
  }>;
};

export function buildCaptureEnrichmentPrompt(metadata: CaptureEnrichmentPromptMetadata): string {
  const lines = [
    "Capture metadata:",
    `- Source application name: ${metadata.sourceAppName?.trim() || "unknown"}`,
    `- Source application bundle id: ${metadata.sourceAppBundleId?.trim() || "unknown"}`,
    `- Capture kind: ${metadata.captureKind}`,
    `- Dimensions: ${metadata.widthPx} x ${metadata.heightPx} px`,
    `- Captured at: ${metadata.capturedAt || "unknown"}`
  ];
  if (metadata.existingUserTags !== undefined && metadata.existingUserTags.length > 0) {
    lines.push(`- Tags this user already uses: ${metadata.existingUserTags.join(", ")}`);
  }
  if (metadata.captureKind === "video") {
    lines.push(
      `- Video duration: ${
        typeof metadata.videoDurationSec === "number"
          ? `${metadata.videoDurationSec.toFixed(3)} seconds`
          : "unknown"
      }`
    );
    if (metadata.videoFrameSamples !== undefined && metadata.videoFrameSamples.length > 0) {
      lines.push(
        `- Provided video frame samples: ${metadata.videoFrameSamples
          .map((sample) => `${sample.positionPct}% at ${sample.timestampSec.toFixed(3)}s`)
          .join(", ")}`
      );
    }
  }
  return lines.join("\n");
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
